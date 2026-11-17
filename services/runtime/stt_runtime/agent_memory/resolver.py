"""Pure deterministic resolution of reviewed memory for one agent request."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from ..schemas.agent_memory import (
    AGENT_MEMORY_MAX_CONTEXT_CHARACTERS,
    AGENT_MEMORY_MAX_RESOLVED_ENTRIES,
    AgentMemoryConflictV1,
    AgentMemoryEntryV1,
    AgentMemoryOmissionReason,
    AgentMemoryOmissionV1,
    AgentMemoryResolutionRequestV1,
    AgentMemoryResolutionV1,
    AgentMemoryScopeV1,
)
from ..schemas.dialogue import DialogueChoiceElement, DialogueLineElement
from ..schemas.project_document import (
    ProjectDocument,
    ProjectNodeRecord,
    ProjectPlacementRecord,
)

OwnerState = Literal["valid", "missing_owner", "stale_owner"]


class AgentMemoryResolutionError(ValueError):
    """Stable dispatch-blocking failure containing only safe repair identifiers."""

    def __init__(self, code: str, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


@dataclass(frozen=True)
class AgentMemorySnapshot:
    """Immutable project projection used without repository or provider access."""

    project_id: str
    source_checksum: str
    history_revision: int
    entries: tuple[AgentMemoryEntryV1, ...]
    nodes: tuple[ProjectNodeRecord, ...]
    placements: tuple[ProjectPlacementRecord, ...]
    flow_ids: frozenset[str]
    flow_memberships: frozenset[tuple[str, str]]
    dialogue_fields: frozenset[tuple[str, str, str, str | None]]

    @classmethod
    def from_document(
        cls,
        document: ProjectDocument,
        *,
        history_revision: int,
    ) -> "AgentMemorySnapshot":
        """Project current authored state into the resolver's narrow read model."""

        dialogue_fields: set[tuple[str, str, str, str | None]] = set()
        for owned in document.dialogues:
            for element in owned.document.elements:
                if isinstance(element, DialogueLineElement):
                    dialogue_fields.add((owned.node_id, "line_text", element.id, None))
                    continue
                if isinstance(element, DialogueChoiceElement):
                    dialogue_fields.add((owned.node_id, "choice_prompt", element.id, None))
                    dialogue_fields.update(
                        (owned.node_id, "option_text", element.id, option.id)
                        for option in element.options
                    )
        return cls(
            project_id=document.manifest.project_id,
            source_checksum=document.checksum,
            history_revision=history_revision,
            entries=tuple(document.agent_memories),
            nodes=tuple(document.nodes),
            placements=tuple(document.placements),
            flow_ids=frozenset(flow.id for flow in document.story_flows),
            flow_memberships=frozenset(
                (membership.flow_id, membership.node_id)
                for membership in document.story_flow_nodes
            ),
            dialogue_fields=frozenset(dialogue_fields),
        )


class AgentMemoryResolver:
    """Apply scope precedence, lifecycle filtering, conflicts, and hard limits."""

    def resolve(
        self,
        snapshot: AgentMemorySnapshot,
        request: AgentMemoryResolutionRequestV1,
        *,
        max_entries: int = AGENT_MEMORY_MAX_RESOLVED_ENTRIES,
        max_characters: int = AGENT_MEMORY_MAX_CONTEXT_CHARACTERS,
    ) -> AgentMemoryResolutionV1:
        self._validate_request(snapshot, request)
        if not 0 <= max_entries <= AGENT_MEMORY_MAX_RESOLVED_ENTRIES:
            raise ValueError("max_entries is outside the contract limit")
        if not 0 <= max_characters <= AGENT_MEMORY_MAX_CONTEXT_CHARACTERS:
            raise ValueError("max_characters is outside the contract limit")

        # Namespace and locale partitions are intentionally invisible to each other.
        candidates = sorted(
            (
                entry
                for entry in snapshot.entries
                if entry.agent_id == request.agent_id
                and entry.namespace == request.namespace
                and entry.content_locale == request.content_locale
            ),
            key=lambda entry: entry.id,
        )
        superseded_ids = {
            entry.supersedes_id
            for entry in candidates
            if entry.supersedes_id is not None
        }
        applicable: list[tuple[int, AgentMemoryEntryV1]] = []
        omissions: dict[str, AgentMemoryOmissionReason] = {}
        for entry in candidates:
            reason = self._ineligible_reason(
                snapshot,
                request,
                entry,
                superseded_ids=superseded_ids,
            )
            if reason is not None:
                omissions[entry.id] = reason
                continue
            applicable.append((self._scope_rank(entry.scope, request), entry))
        applicable.sort(key=lambda item: (item[0], item[1].id))

        conflicts = self._conflicts(applicable)
        if conflicts:
            conflict_ids = {
                memory_id
                for conflict in conflicts
                for memory_id in conflict.memory_ids
            }
            for _, entry in applicable:
                omissions[entry.id] = (
                    "conflict" if entry.id in conflict_ids else "resolution_blocked"
                )
            return self._result(
                request,
                entries=(),
                omissions=omissions,
                conflicts=conflicts,
            )

        # Broken durable references must be repaired explicitly. Silently omitting
        # them would make two otherwise identical runs use different guidance.
        if any(reason in {"missing_owner", "stale_owner"} for reason in omissions.values()):
            for _, entry in applicable:
                omissions[entry.id] = "resolution_blocked"
            return self._result(
                request,
                entries=(),
                omissions=omissions,
                conflicts=(),
            )

        included: list[AgentMemoryEntryV1] = []
        included_characters = 0
        for _, entry in applicable:
            entry_characters = len(entry.title) + len(entry.instruction)
            if len(included) >= max_entries:
                omissions[entry.id] = "entry_limit"
            elif included_characters + entry_characters > max_characters:
                omissions[entry.id] = "character_limit"
            else:
                included.append(entry)
                included_characters += entry_characters
        return self._result(
            request,
            entries=tuple(included),
            omissions=omissions,
            conflicts=(),
        )

    def _validate_request(
        self,
        snapshot: AgentMemorySnapshot,
        request: AgentMemoryResolutionRequestV1,
    ) -> None:
        if (
            request.project_id != snapshot.project_id
            or request.source_checksum != snapshot.source_checksum
            or request.history_revision != snapshot.history_revision
        ):
            raise AgentMemoryResolutionError(
                "agent_memory_resolution_stale",
                project_id=snapshot.project_id,
                source_checksum=snapshot.source_checksum,
                history_revision=snapshot.history_revision,
            )
        owner_state = self._owner_state(snapshot, request.scope)
        if owner_state != "valid":
            raise AgentMemoryResolutionError(
                "agent_memory_resolution_target_missing",
                owner_state=owner_state,
                target_scope=_scope_identity(request.scope),
            )

        context = request.context_scope
        if context.kind == "project":
            scene_ids = self._scene_ids_for_scope(snapshot, request.scope)
            if len(scene_ids) > 1:
                raise AgentMemoryResolutionError(
                    "agent_memory_resolution_context_required",
                    scene_node_ids=sorted(scene_ids),
                )
            return
        if self._owner_state(snapshot, context) != "valid":
            raise AgentMemoryResolutionError(
                "agent_memory_resolution_context_invalid",
                context_scope=_scope_identity(context),
            )
        if context.kind == "scene":
            scene_ids = self._scene_ids_for_scope(snapshot, request.scope)
            if request.scope.kind == "project" or context.scene_node_id in scene_ids:
                return
        elif context.kind == "story_flow":
            target_node_id = _target_node_id(request.scope)
            if request.scope.kind == "project" or (
                request.scope.kind == "story_flow"
                and request.scope.flow_id == context.flow_id
            ) or (
                target_node_id is not None
                and (context.flow_id, target_node_id) in snapshot.flow_memberships
            ):
                return
        raise AgentMemoryResolutionError(
            "agent_memory_resolution_context_invalid",
            context_scope=_scope_identity(context),
            target_scope=_scope_identity(request.scope),
        )

    def _ineligible_reason(
        self,
        snapshot: AgentMemorySnapshot,
        request: AgentMemoryResolutionRequestV1,
        entry: AgentMemoryEntryV1,
        *,
        superseded_ids: set[str],
    ) -> AgentMemoryOmissionReason | None:
        if entry.status == "archived":
            return "archived"
        if entry.id in superseded_ids:
            return "superseded"
        owner_state = self._owner_state(snapshot, entry.scope)
        if owner_state != "valid":
            return owner_state
        if self._scope_rank(entry.scope, request) >= 3:
            return "out_of_scope"
        return None

    @staticmethod
    def _scope_rank(
        scope: AgentMemoryScopeV1,
        request: AgentMemoryResolutionRequestV1,
    ) -> int:
        if scope == request.scope:
            return 0
        if request.context_scope.kind != "project" and scope == request.context_scope:
            return 1
        if scope.kind == "project":
            return 2
        return 3

    @staticmethod
    def _conflicts(
        applicable: list[tuple[int, AgentMemoryEntryV1]],
    ) -> tuple[AgentMemoryConflictV1, ...]:
        by_topic: dict[str, list[AgentMemoryEntryV1]] = {}
        for _, entry in applicable:
            by_topic.setdefault(entry.title.strip().casefold(), []).append(entry)
        conflicts = []
        for entries in by_topic.values():
            instructions = {entry.instruction.strip().casefold() for entry in entries}
            if len(entries) > 1 and len(instructions) > 1:
                conflicts.append(
                    AgentMemoryConflictV1(
                        memory_ids=tuple(sorted(entry.id for entry in entries))
                    )
                )
        return tuple(sorted(conflicts, key=lambda conflict: conflict.memory_ids))

    @staticmethod
    def _owner_state(
        snapshot: AgentMemorySnapshot,
        scope: AgentMemoryScopeV1,
    ) -> OwnerState:
        if scope.kind == "project":
            return "valid"
        nodes = {node.id: node for node in snapshot.nodes}
        if scope.kind == "story_flow":
            return "valid" if scope.flow_id in snapshot.flow_ids else "missing_owner"
        node_id = _target_node_id(scope)
        node = nodes.get(node_id)
        if node is None:
            return "missing_owner"
        if scope.kind == "scene":
            return "valid" if node.type == "Scene" else "stale_owner"
        if scope.kind == "dialogue_field":
            key = (scope.node_id, scope.field_kind, scope.element_id, scope.option_id)
            if node.type != "Dialogue" or key not in snapshot.dialogue_fields:
                return "stale_owner"
        return "valid"

    def _scene_ids_for_scope(
        self,
        snapshot: AgentMemorySnapshot,
        scope: AgentMemoryScopeV1,
    ) -> set[str]:
        if scope.kind == "scene":
            return {scope.scene_node_id}
        node_id = _target_node_id(scope)
        if node_id is None:
            return set()
        nodes = {node.id: node for node in snapshot.nodes}
        placements_by_node: dict[str, list[ProjectPlacementRecord]] = {}
        for placement in snapshot.placements:
            placements_by_node.setdefault(placement.canonical_node_id, []).append(placement)
        result: set[str] = set()
        for placement in placements_by_node.get(node_id, []):
            result.update(
                self._scenes_for_placement(
                    placement,
                    nodes=nodes,
                    placements_by_node=placements_by_node,
                    visited=set(),
                )
            )
        return result

    def _scenes_for_placement(
        self,
        placement: ProjectPlacementRecord,
        *,
        nodes: dict[str, ProjectNodeRecord],
        placements_by_node: dict[str, list[ProjectPlacementRecord]],
        visited: set[str],
    ) -> set[str]:
        if placement.id in visited or placement.container_node_id is None:
            return set()
        container = nodes.get(placement.container_node_id)
        if container is None:
            return set()
        if container.type == "Scene":
            return {container.id}
        if container.type != "Location":
            return set()
        result: set[str] = set()
        for parent in placements_by_node.get(container.id, []):
            result.update(
                self._scenes_for_placement(
                    parent,
                    nodes=nodes,
                    placements_by_node=placements_by_node,
                    visited={*visited, placement.id},
                )
            )
        return result

    @staticmethod
    def _result(
        request: AgentMemoryResolutionRequestV1,
        *,
        entries: tuple[AgentMemoryEntryV1, ...],
        omissions: dict[str, AgentMemoryOmissionReason],
        conflicts: tuple[AgentMemoryConflictV1, ...],
    ) -> AgentMemoryResolutionV1:
        ordered_omissions = tuple(
            AgentMemoryOmissionV1(memory_id=memory_id, reason=reason)
            for memory_id, reason in sorted(omissions.items())
        )
        return AgentMemoryResolutionV1(
            project_id=request.project_id,
            agent_id=request.agent_id,
            content_locale=request.content_locale,
            source_checksum=request.source_checksum,
            history_revision=request.history_revision,
            status="blocked" if conflicts or any(
                reason in {"missing_owner", "stale_owner"}
                for reason in omissions.values()
            ) else "resolved",
            entries=entries,
            included_characters=sum(
                len(entry.title) + len(entry.instruction) for entry in entries
            ),
            omitted_entries=len(ordered_omissions),
            omissions=ordered_omissions,
            conflicts=conflicts,
        )


def _target_node_id(scope: AgentMemoryScopeV1) -> str | None:
    """Return a canonical node owner without broadening project or Flow scopes."""

    if scope.kind == "scene":
        return scope.scene_node_id
    if scope.kind in {"node", "dialogue_field"}:
        return scope.node_id
    return None


def _scope_identity(scope: AgentMemoryScopeV1) -> str:
    """Produce a stable safe identifier for repair errors, never authored prose."""

    if scope.kind == "project":
        return "project"
    if scope.kind == "scene":
        return f"scene:{scope.scene_node_id}"
    if scope.kind == "node":
        return f"node:{scope.node_id}"
    if scope.kind == "story_flow":
        return f"story_flow:{scope.flow_id}"
    option = f":{scope.option_id}" if scope.option_id is not None else ""
    return f"dialogue_field:{scope.node_id}:{scope.element_id}:{scope.field_kind}{option}"
