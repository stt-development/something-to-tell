"""Saved ProjectDocument adapters for the deterministic canon fact boundary."""

from __future__ import annotations

from typing import Any, Generic, Iterable, TypeVar

from pydantic import ValidationError

from ..dialogue.integrity_service import DialogueIntegrityService
from ..dialogue.service import DIALOGUE_METADATA_KEY
from ..domain.entities import (
    EdgeEntity,
    FlowExitBindingEntity,
    FlowExitEntity,
    FlowInitialStateEntity,
    FlowInvocationEntity,
    FlowTransitionEntity,
    NarrativeEffectBindingEntity,
    NarrativeEffectEntity,
    NodeEntity,
    ProjectEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    VisualPlacementEntity,
)
from ..narrative_state.service import NarrativeStateAuthoringService
from ..playback.definition_builder import build_playback_definition
from ..quest.service import QUEST_METADATA_KEY
from ..schemas.canon_check import (
    CanonCheckInput,
    CanonDomain,
    CanonEvidenceRef,
    CanonFact,
    CanonOwnerRef,
)
from ..schemas.project_document import ProjectDocument
from ..schemas.story_flow import StoryFlowSnapshot
from ..story_flow.composable_service import ComposableStoryFlowService
from ..story_flow.integrity_service import StoryFlowIntegrityService
from ..story_flow.service import StoryFlowService

EntityT = TypeVar("EntityT")


class CanonFactProjector:
    """Projects one validated saved document without repository or UI state."""

    def project(
        self,
        document: ProjectDocument,
        *,
        rule_pack_version: int = 1,
    ) -> CanonCheckInput:
        snapshot = ProjectDocument.model_validate(document.model_dump(mode="json"))
        revision = snapshot.manifest.saved_revision
        uow = _DocumentUnitOfWork(snapshot)
        facts = [
            *self._graph_facts(snapshot, revision),
            *self._composition_facts(snapshot, revision),
            *self._flow_facts(uow, snapshot, revision),
            *self._dialogue_facts(uow, snapshot, revision),
            *self._quest_facts(snapshot, revision),
            *self._temporal_facts(uow, snapshot, revision),
            *self._playback_facts(uow, snapshot, revision),
        ]
        return CanonCheckInput(
            project_id=snapshot.manifest.project_id,
            saved_revision=revision,
            source_checksum=snapshot.checksum,
            rule_pack_version=rule_pack_version,
            document=snapshot,
            facts=_dedupe_facts(facts),
        )

    def _graph_facts(self, document: ProjectDocument, revision: int) -> list[CanonFact]:
        facts = [
            _fact(
                "graph",
                "graph.node",
                "info",
                _owner("node", node.id),
                revision,
                parameters={"node_type": node.type, "status": node.status},
                field_path="title",
                excerpt=node.title,
            )
            for node in document.nodes
        ]
        facts.extend(
            _fact(
                "graph",
                "graph.relationship",
                "info",
                _owner("edge", edge.id),
                revision,
                owners=(
                    _owner("node", edge.source_node_id),
                    _owner("node", edge.target_node_id),
                ),
                parameters={"relationship_type": edge.type},
                field_path="label",
                excerpt=edge.label,
            )
            for edge in document.edges
        )
        return facts

    def _composition_facts(
        self,
        document: ProjectDocument,
        revision: int,
    ) -> list[CanonFact]:
        return [
            _fact(
                "composition",
                "composition.placement",
                "info",
                _owner("placement", placement.id),
                revision,
                owners=tuple(
                    [
                        _owner("node", placement.canonical_node_id),
                        *(
                            [_owner("node", placement.container_node_id)]
                            if placement.container_node_id is not None
                            else []
                        ),
                    ]
                ),
                parameters={
                    "scope_key": placement.scope_key,
                    "is_primary": placement.is_primary,
                },
                field_path="scope_key",
                excerpt=placement.scope_key,
            )
            for placement in document.placements
        ]

    def _flow_facts(
        self,
        uow: _DocumentUnitOfWork,
        document: ProjectDocument,
        revision: int,
    ) -> list[CanonFact]:
        facts: list[CanonFact] = []
        composition_codes = {
            "dangling_placement",
            "missing_canonical_node",
            "invalid_child_kind",
            "duplicate_placement",
            "containment_cycle",
            "stale_membership",
        }
        for flow in document.story_flows:
            report = StoryFlowIntegrityService().inspect(uow, flow.id)
            for item in report.facts:
                domain: CanonDomain = (
                    "composition" if item.code in composition_codes else "flow"
                )
                facts.append(
                    _report_fact(
                        domain,
                        item.code,
                        item.level,
                        revision,
                        flow_id=(item.flow_id or flow.id) if domain == "flow" else None,
                        node_id=item.node_id,
                        transition_id=item.transition_id,
                        placement_id=item.placement_id,
                        edge_id=item.relationship_id,
                        parameters=(
                            {"scene_node_id": item.scene_node_id}
                            if item.scene_node_id
                            else {}
                        ),
                        excerpt=item.message,
                    )
                )

        invoked = {item.target_flow_id for item in document.flow_invocations}
        roots = [flow for flow in document.story_flows if flow.id not in invoked]
        if not roots:
            roots = list(document.story_flows)
        composed = ComposableStoryFlowService()
        for root in roots:
            report = composed.integrity(uow, document.manifest.project_id, root.id)
            facts.extend(
                _report_fact(
                    "flow",
                    item.code,
                    item.level,
                    revision,
                    flow_id=item.flow_id or root.id,
                    node_id=item.node_id,
                    invocation_id=item.invocation_id,
                    exit_id=item.exit_id,
                    binding_id=item.binding_id,
                    parameters={"root_flow_id": root.id, **item.parameters},
                )
                for item in report.facts
            )
        return facts

    def _dialogue_facts(
        self,
        uow: _DocumentUnitOfWork,
        document: ProjectDocument,
        revision: int,
    ) -> list[CanonFact]:
        facts: list[CanonFact] = []
        for owned in document.dialogues:
            dialogue_owner = _owner("node", owned.node_id)
            facts.append(
                _fact(
                    "dialogue",
                    "dialogue.document",
                    "info",
                    dialogue_owner,
                    revision,
                    parameters={
                        "entry_element_id": owned.document.entry_element_id,
                        "participant_ids": list(owned.document.participants),
                    },
                )
            )
            for element in owned.document.elements:
                element_owner = _owner(
                    "dialogue_element",
                    element.id,
                    context=dialogue_owner,
                )
                raw = element.model_dump(mode="json")
                facts.append(
                    _fact(
                        "dialogue",
                        "dialogue.element",
                        "info",
                        element_owner,
                        revision,
                        owners=(dialogue_owner,),
                        parameters={"kind": raw["kind"]},
                        field_path="text" if "text" in raw else "prompt",
                        excerpt=raw.get("text", raw.get("prompt")),
                    )
                )
                for option in raw.get("options", []):
                    facts.append(
                        _fact(
                            "dialogue",
                            "dialogue.option",
                            "info",
                            _owner(
                                "dialogue_option",
                                option["id"],
                                context=element_owner,
                            ),
                            revision,
                            owners=(dialogue_owner, element_owner),
                            field_path="text",
                            excerpt=option.get("text"),
                        )
                    )
            report = DialogueIntegrityService().inspect(uow, owned.node_id)
            facts.extend(
                _report_fact(
                    "dialogue",
                    item.code,
                    "error",
                    revision,
                    node_id=owned.node_id,
                    dialogue_element_id=item.element_id,
                    edge_id=item.edge_id,
                    parameters={"reference_id": item.reference_id} if item.reference_id else {},
                    excerpt=item.message,
                )
                for item in report.facts
            )
            facts.extend(
                _fact(
                    "dialogue",
                    "dialogue.valid-cycle",
                    "info",
                    _owner("node", owned.node_id),
                    revision,
                    owners=tuple(_owner("dialogue_element", item) for item in cycle.element_ids),
                    parameters={"element_ids": list(cycle.element_ids)},
                    excerpt=cycle.message,
                )
                for cycle in report.cycles
            )
        return facts

    def _quest_facts(self, document: ProjectDocument, revision: int) -> list[CanonFact]:
        facts: list[CanonFact] = []
        for owned in document.quests:
            quest_owner = _owner("node", owned.node_id)
            facts.append(
                _fact(
                    "quest",
                    "quest.document",
                    "info",
                    quest_owner,
                    revision,
                    parameters={"entry_stage_id": owned.document.entry_stage_id},
                    field_path="objective",
                    excerpt=owned.document.objective,
                )
            )
            for stage in owned.document.stages:
                stage_owner = _owner("quest_stage", stage.id, context=quest_owner)
                facts.append(
                    _fact(
                        "quest",
                        "quest.stage",
                        "info",
                        stage_owner,
                        revision,
                        owners=(quest_owner,),
                        parameters={"branch_ids": [branch.id for branch in stage.branches]},
                        field_path="title",
                        excerpt=stage.title,
                    )
                )
                for branch in stage.branches:
                    facts.append(
                        _fact(
                            "quest",
                            "quest.branch",
                            "info",
                            _owner("quest_branch", branch.id, context=stage_owner),
                            revision,
                            owners=tuple(
                                [
                                    quest_owner,
                                    stage_owner,
                                    *(
                                        [
                                            _owner(
                                                "quest_stage",
                                                branch.target_stage_id,
                                                context=quest_owner,
                                            )
                                        ]
                                        if branch.target_stage_id is not None
                                        else []
                                    ),
                                ]
                            ),
                            parameters={
                                "target_stage_id": branch.target_stage_id,
                                "has_condition": bool(branch.condition.strip()),
                            },
                            field_path="label",
                            excerpt=branch.label,
                        )
                    )
        return facts

    def _temporal_facts(
        self,
        uow: _DocumentUnitOfWork,
        document: ProjectDocument,
        revision: int,
    ) -> list[CanonFact]:
        facts = [
            _fact(
                "temporal",
                "temporal.initial-state",
                "info",
                _owner("initial_state", state.id),
                revision,
                owners=(_owner("flow", state.flow_id),),
                parameters={
                    "flag_count": len(state.flags),
                    "custody_count": len(state.item_custody),
                    "quest_status_count": len(state.quest_statuses),
                },
            )
            for state in document.flow_initial_states
        ]
        facts.extend(
            _fact(
                "temporal",
                "temporal.effect",
                "info",
                _owner("effect", effect.id),
                revision,
                parameters={
                    "operation": effect.operation,
                    "repeat_policy": effect.repeat_policy,
                },
                field_path="explanation",
                excerpt=effect.explanation,
            )
            for effect in document.narrative_effects
        )
        facts.extend(
            _fact(
                "temporal",
                "temporal.effect-binding",
                "info",
                _owner("effect_binding", binding.id),
                revision,
                owners=(
                    _owner("effect", binding.effect_id),
                    _owner(binding.owner_kind, binding.owner_id),
                ),
                parameters={"application_order": binding.application_order},
            )
            for binding in document.narrative_effect_bindings
        )
        report = NarrativeStateAuthoringService().integrity(
            uow,
            document.manifest.project_id,
        )
        facts.extend(
            _report_fact(
                "temporal",
                item.code,
                item.level,
                revision,
                effect_id=item.effect_id,
                node_id=item.node_id,
                parameters=dict(item.parameters),
            )
            for item in report.facts
        )
        return facts

    def _playback_facts(
        self,
        uow: _DocumentUnitOfWork,
        document: ProjectDocument,
        revision: int,
    ) -> list[CanonFact]:
        if not document.story_flows:
            return []
        snapshots = _story_snapshots(uow, document)
        roots = _root_flow_ids(document)
        facts: list[CanonFact] = []
        for root_id in roots:
            reachable_ids = _reachable_flow_ids(document, root_id)
            reachable = [snapshot for snapshot in snapshots if snapshot.flow.id in reachable_ids]
            if not reachable:
                facts.append(
                    _fact(
                        "playback",
                        "playback.invalid-definition",
                        "error",
                        _owner("flow", root_id),
                        revision,
                        parameters={"reason": "missing_root_snapshot"},
                    )
                )
                continue
            root = next(
                (snapshot for snapshot in reachable if snapshot.flow.id == root_id),
                None,
            )
            if root is None:
                facts.append(
                    _fact(
                        "playback",
                        "playback.invalid-definition",
                        "error",
                        _owner("flow", root_id),
                        revision,
                        parameters={"reason": "missing_root_snapshot"},
                    )
                )
                continue
            effects = _playback_effects(document, reachable)
            member_ids = {
                membership.node_id
                for snapshot in reachable
                for membership in snapshot.nodes
            }
            initial = _playback_initial_state(document, root_id)
            referenced_ids = {
                *initial.get("item_holders", {}).keys(),
                *initial.get("quest_states", {}).keys(),
            }
            referenced_ids.update(
                holder["node_id"]
                for holder in initial.get("item_holders", {}).values()
                if holder.get("node_id") is not None
            )
            for effect in effects:
                referenced_ids.update(_effect_node_ids(effect))
            nodes = [
                node
                for node in uow.nodes.list(project_id=document.manifest.project_id)
                if node.id in member_ids or node.id in referenced_ids
            ]
            preparation = build_playback_definition(
                _playback_snapshot(root, document),
                nodes,
                {
                    owned.node_id: owned.document
                    for owned in document.dialogues
                    if owned.node_id in member_ids
                },
                {
                    owned.node_id: owned.document
                    for owned in document.quests
                    if owned.node_id in member_ids
                },
                effects,
                initial,
                source_revision=document.checksum,
                snapshots=[_playback_snapshot(item, document) for item in reachable],
            )
            if not preparation.facts:
                facts.append(
                    _fact(
                        "playback",
                        "playback.definition-ready",
                        "info",
                        _owner("flow", root_id),
                        revision,
                        parameters={"reachable_flow_ids": sorted(reachable_ids)},
                    )
                )
                continue
            facts.extend(
                _report_fact(
                    "playback",
                    item.code,
                    item.level,
                    revision,
                    flow_id=item.flow_id or root_id,
                    node_id=item.node_id,
                    transition_id=item.transition_id,
                    effect_id=item.effect_id,
                    invocation_id=item.invocation_id,
                    exit_id=item.exit_id,
                    parameters={
                        "item_node_id": item.item_node_id,
                        "holder_kind": item.holder_kind,
                        "holder_node_id": item.holder_node_id,
                    },
                    excerpt=item.message,
                )
                for item in preparation.facts
            )
        return facts


class _ReadRepository(Generic[EntityT]):
    def __init__(self, records: Iterable[EntityT]) -> None:
        self._records = tuple(records)
        self._by_id = {str(getattr(item, "id")): item for item in self._records}

    def get(self, entity_id: str) -> EntityT | None:
        return self._by_id.get(entity_id)

    def list(self, **filters: object) -> list[EntityT]:
        return [
            item
            for item in self._records
            if all(getattr(item, key) == value for key, value in filters.items())
        ]

    def get_for_node(self, *, flow_id: str, node_id: str) -> EntityT | None:
        return next(
            (
                item
                for item in self._records
                if getattr(item, "flow_id", None) == flow_id
                and getattr(item, "node_id", None) == node_id
            ),
            None,
        )


class _DocumentUnitOfWork:
    """Read-only repository facade over one already validated ProjectDocument."""

    def __init__(self, document: ProjectDocument) -> None:
        dialogue_by_id = {
            item.node_id: item.document.model_dump(mode="json") for item in document.dialogues
        }
        quest_by_id = {
            item.node_id: item.document.model_dump(mode="json") for item in document.quests
        }
        nodes = []
        for record in document.nodes:
            metadata = dict(record.metadata)
            if record.id in dialogue_by_id:
                metadata[DIALOGUE_METADATA_KEY] = dialogue_by_id[record.id]
            if record.id in quest_by_id:
                metadata[QUEST_METADATA_KEY] = quest_by_id[record.id]
            nodes.append(
                NodeEntity(
                    **record.model_dump(mode="python", exclude={"metadata"}),
                    metadata=metadata,
                )
            )
        self.projects = _ReadRepository([
            ProjectEntity(
                id=document.manifest.project_id,
                name=document.manifest.name,
                path="",
                format_version=document.manifest.format_version,
                metadata=document.project_metadata,
                created_at=document.manifest.created_at,
                updated_at=document.manifest.updated_at,
            )
        ])
        self.nodes = _ReadRepository(nodes)
        self.edges = _records(document.edges, EdgeEntity)
        self.visual_placements = _records(document.placements, VisualPlacementEntity)
        self.story_flows = _records(document.story_flows, StoryFlowEntity)
        self.story_flow_nodes = _records(document.story_flow_nodes, StoryFlowNodeEntity)
        self.flow_transitions = _records(document.flow_transitions, FlowTransitionEntity)
        self.scene_flow_boundaries = _records(
            document.scene_flow_boundaries,
            SceneFlowBoundaryEntity,
        )
        self.flow_invocations = _records(document.flow_invocations, FlowInvocationEntity)
        self.flow_exits = _records(document.flow_exits, FlowExitEntity)
        self.flow_exit_bindings = _records(
            document.flow_exit_bindings,
            FlowExitBindingEntity,
        )
        self.flow_initial_states = _records(document.flow_initial_states, FlowInitialStateEntity)
        self.narrative_effects = _records(document.narrative_effects, NarrativeEffectEntity)
        self.narrative_effect_bindings = _records(
            document.narrative_effect_bindings,
            NarrativeEffectBindingEntity,
        )


def _records(records: Iterable[Any], entity_type: type[EntityT]) -> _ReadRepository[EntityT]:
    return _ReadRepository(
        entity_type(**record.model_dump(mode="python")) for record in records
    )


def _owner(
    owner_type: str,
    owner_id: str,
    *,
    context: CanonOwnerRef | None = None,
) -> CanonOwnerRef:
    return CanonOwnerRef(
        owner_type=owner_type,
        owner_id=owner_id,
        context_type=context.owner_type if context else None,
        context_id=context.owner_id if context else None,
    )


def _fact(
    domain: CanonDomain,
    code: str,
    level: str,
    scope: CanonOwnerRef,
    revision: int,
    *,
    owners: tuple[CanonOwnerRef, ...] = (),
    parameters: dict[str, Any] | None = None,
    field_path: str | None = None,
    excerpt: str | None = None,
) -> CanonFact:
    evidence_owner = owners[0] if owners else scope
    return CanonFact(
        code=code,
        domain=domain,
        level=level,
        scope=scope,
        owners=owners,
        evidence=(
            CanonEvidenceRef(
                owner=evidence_owner,
                field_path=field_path,
                message_key=f"canon.evidence.{code}",
                message_parameters=parameters or {},
                excerpt=excerpt,
            ),
        ),
        parameters=parameters or {},
        source_revision=revision,
    )


def _report_fact(
    domain: CanonDomain,
    code: str,
    level: str,
    revision: int,
    *,
    flow_id: str | None = None,
    node_id: str | None = None,
    transition_id: str | None = None,
    placement_id: str | None = None,
    edge_id: str | None = None,
    invocation_id: str | None = None,
    exit_id: str | None = None,
    binding_id: str | None = None,
    effect_id: str | None = None,
    dialogue_element_id: str | None = None,
    parameters: dict[str, Any] | None = None,
    excerpt: str | None = None,
) -> CanonFact:
    refs = tuple(
        _owner(kind, value)
        for kind, value in (
            ("flow", flow_id),
            ("node", node_id),
            ("flow_transition", transition_id),
            ("placement", placement_id),
            ("edge", edge_id),
            ("flow_invocation", invocation_id),
            ("flow_exit", exit_id),
            ("flow_exit_binding", binding_id),
            ("effect", effect_id),
            ("dialogue_element", dialogue_element_id),
        )
        if value is not None
    )
    scope = refs[0] if refs else _owner("project", "project")
    return _fact(
        domain,
        f"{domain}.{code}",
        level,
        scope,
        revision,
        owners=refs,
        parameters={key: value for key, value in (parameters or {}).items() if value is not None},
        excerpt=excerpt,
    )


def _story_snapshots(
    uow: _DocumentUnitOfWork,
    document: ProjectDocument,
) -> list[StoryFlowSnapshot]:
    service = StoryFlowService()
    snapshots: list[StoryFlowSnapshot] = []
    for flow in document.story_flows:
        try:
            snapshots.append(service.snapshot(uow, flow.id))
        except (ValidationError, ValueError):
            continue
    return snapshots


def _playback_snapshot(
    snapshot: StoryFlowSnapshot,
    document: ProjectDocument,
) -> dict[str, Any]:
    flow_ids = {snapshot.flow.id}
    invocation_ids = {
        item.id for item in document.flow_invocations if item.source_flow_id in flow_ids
    }
    return {
        **snapshot.model_dump(mode="json"),
        "invocations": [
            item.model_dump(mode="json")
            for item in document.flow_invocations
            if item.source_flow_id in flow_ids
        ],
        "exits": [
            item.model_dump(mode="json")
            for item in document.flow_exits
            if item.flow_id in flow_ids
        ],
        "bindings": [
            item.model_dump(mode="json")
            for item in document.flow_exit_bindings
            if item.invocation_id in invocation_ids
        ],
    }


def _root_flow_ids(document: ProjectDocument) -> list[str]:
    invoked = {item.target_flow_id for item in document.flow_invocations}
    roots = sorted(flow.id for flow in document.story_flows if flow.id not in invoked)
    return roots or sorted(flow.id for flow in document.story_flows)


def _reachable_flow_ids(document: ProjectDocument, root_id: str) -> set[str]:
    outgoing: dict[str, set[str]] = {}
    for item in document.flow_invocations:
        outgoing.setdefault(item.source_flow_id, set()).add(item.target_flow_id)
    reached: set[str] = set()
    pending = [root_id]
    while pending:
        flow_id = pending.pop(0)
        if flow_id in reached:
            continue
        reached.add(flow_id)
        pending.extend(sorted(outgoing.get(flow_id, set()) - reached))
    return reached


def _playback_effects(
    document: ProjectDocument,
    snapshots: list[StoryFlowSnapshot],
) -> list[dict[str, Any]]:
    effect_by_id = {item.id: item for item in document.narrative_effects}
    owner_flows: dict[tuple[str, str], set[str]] = {}
    for snapshot in snapshots:
        for member in snapshot.nodes:
            owner_flows.setdefault(("node_entry", member.node_id), set()).add(snapshot.flow.id)
        for transition in snapshot.transitions:
            owner_flows.setdefault(("flow_transition", transition.id), set()).add(snapshot.flow.id)
    for invocation in document.flow_invocations:
        owner_flows.setdefault(("flow_invocation", invocation.id), set()).add(
            invocation.source_flow_id
        )
    for flow_exit in document.flow_exits:
        owner_flows.setdefault(("flow_exit", flow_exit.id), set()).add(flow_exit.flow_id)

    member_flows: dict[str, set[str]] = {}
    for snapshot in snapshots:
        for member in snapshot.nodes:
            member_flows.setdefault(member.node_id, set()).add(snapshot.flow.id)

    projected: list[dict[str, Any]] = []
    for binding in document.narrative_effect_bindings:
        effect = effect_by_id.get(binding.effect_id)
        if effect is None:
            continue
        flow_ids = (
            member_flows.get(binding.context_node_id, set())
            if binding.context_node_id is not None
            else owner_flows.get((binding.owner_kind, binding.owner_id), set())
        )
        for flow_id in sorted(flow_ids):
            contextual = binding.context_node_id is not None
            projected.append({
                "effect_version": effect.effect_version,
                "id": binding.id if len(flow_ids) == 1 else f"{binding.id}:{flow_id}",
                "project_id": effect.project_id,
                "flow_id": flow_id,
                "owner_node_id": (
                    binding.context_node_id
                    if contextual
                    else binding.owner_id if binding.owner_kind == "node_entry" else None
                ),
                "owner_transition_id": (
                    binding.owner_id
                    if binding.owner_kind in {"flow_transition", "flow_invocation", "flow_exit"}
                    else None
                ),
                "review_status": "accepted",
                "repeatable": effect.repeat_policy == "per_visit",
                "explanation": effect.explanation,
                "authored_effect_id": effect.id,
                "owner_kind": binding.owner_kind,
                "owner_id": binding.owner_id,
                "context_node_id": binding.context_node_id,
                "application_order": binding.application_order,
                "operation": effect.operation,
                "payload": effect.payload,
            })
    return sorted(projected, key=lambda item: (str(item["flow_id"]), str(item["id"])))


def _playback_initial_state(document: ProjectDocument, flow_id: str) -> dict[str, Any]:
    state = next((item for item in document.flow_initial_states if item.flow_id == flow_id), None)
    if state is None:
        return {}
    holders = {
        item.item_node_id: item.holder.model_dump(mode="json")
        for item in state.item_custody
    }
    return {
        "flags": dict(state.flags),
        "inventory_node_ids": sorted(
            item_id for item_id, holder in holders.items() if holder["kind"] == "player"
        ),
        "item_holders": holders,
        "quest_states": dict(state.quest_statuses),
    }


def _effect_node_ids(effect: dict[str, Any]) -> set[str]:
    ids = {
        str(value)
        for key, value in effect.get("payload", {}).items()
        if key in {"node_id", "item_node_id", "quest_node_id", "dialogue_node_id"}
        and isinstance(value, str)
    }
    if isinstance(effect.get("owner_node_id"), str):
        ids.add(str(effect["owner_node_id"]))
    for key in ("from_holder", "to_holder"):
        holder = effect.get("payload", {}).get(key)
        if isinstance(holder, dict) and isinstance(holder.get("node_id"), str):
            ids.add(holder["node_id"])
    return ids


def _dedupe_facts(facts: list[CanonFact]) -> list[CanonFact]:
    result: list[CanonFact] = []
    seen: set[str] = set()
    for fact in facts:
        key = fact.model_dump_json(exclude={"evidence": {"__all__": {"excerpt"}}})
        if key in seen:
            continue
        seen.add(key)
        result.append(fact)
    return result
