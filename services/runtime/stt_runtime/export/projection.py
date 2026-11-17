"""Pure ProjectDocument-to-pipeline projection for Phase 8 exports."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable

from pydantic import ValidationError

from ..engine_tags.projection import EngineTagProjectionService
from ..schemas.engine_tags import EngineTagOwnerV1
from ..schemas.export import (
    EXPORT_MAX_DIAGNOSTICS,
    EXPORT_MAX_RECORDS,
    ExportDiagnosticV1,
    ExportDialogueV1,
    ExportEngineTagsV1,
    ExportFlowExitBindingV1,
    ExportFlowExitV1,
    ExportFlowInitialStateV1,
    ExportFlowInvocationV1,
    ExportFlowTransitionV1,
    ExportInventoryV1,
    ExportManifestV1,
    ExportNarrativeEffectBindingV1,
    ExportNarrativeStateV1,
    ExportNodeAttributesV1,
    ExportNodeV1,
    ExportOptionsV1,
    ExportOutcomeV1,
    ExportOwnerV1,
    ExportPortableExtensionsV1,
    ExportProjectV1,
    ExportProjectionBuildV1,
    ExportProjectionV1,
    ExportQuestV1,
    ExportRelationshipV1,
    ExportRequirementV1,
    ExportSceneFlowBoundaryV1,
    ExportSourceIdentityV1,
    ExportStoryFlowDefinitionV1,
    ExportStoryFlowMembershipV1,
    ExportStoryFlowsV1,
)
from ..schemas.project_document import ProjectDocument

_SUPPORTED_NODE_TYPES = {
    "Character", "Quest", "Scene", "Lore", "Location", "Dialogue",
    "Faction", "Item", "Event", "Condition", "Consequence",
}
_CONTAINER_TYPES = {"Scene", "Location"}


@dataclass
class _Scope:
    """Mutable closure state kept private to one pure build call."""

    flow_ids: set[str] = field(default_factory=set)
    node_ids: set[str] = field(default_factory=set)
    relationship_ids: set[str] = field(default_factory=set)
    membership_ids: set[str] = field(default_factory=set)
    transition_ids: set[str] = field(default_factory=set)
    boundary_ids: set[str] = field(default_factory=set)
    invocation_ids: set[str] = field(default_factory=set)
    exit_ids: set[str] = field(default_factory=set)
    exit_binding_ids: set[str] = field(default_factory=set)
    initial_state_ids: set[str] = field(default_factory=set)
    effect_ids: set[str] = field(default_factory=set)
    effect_binding_ids: set[str] = field(default_factory=set)


class ExportProjectionService:
    """Build a bounded, storage-neutral projection without mutating source state."""

    def __init__(self, engine_tags: EngineTagProjectionService | None = None) -> None:
        self._engine_tags = engine_tags or EngineTagProjectionService()

    def build(
        self,
        document: ProjectDocument,
        options: ExportOptionsV1,
    ) -> ExportProjectionBuildV1:
        """Resolve scope and map only explicitly allowlisted narrative fields."""

        diagnostics: list[ExportDiagnosticV1] = []
        scope = self._whole_scope(document) if options.scope == "whole_project" else (
            self._selected_scope(document, options.story_flow_ids, diagnostics)
        )
        self._bound_scope(scope, diagnostics, document.manifest.project_id)
        placement_containers = self._placement_containers(document)

        nodes: list[ExportNodeV1] = []
        for node in self._selected(document.nodes, scope.node_ids):
            try:
                nodes.append(self._project_node(node, placement_containers, diagnostics))
            except ValidationError:
                self._diagnose(
                    diagnostics, "export.record.unsupported", "error",
                    "export.diagnostic.unsupported-record", "node", node.id,
                    {"record_type": "node"},
                )

        relationships: list[ExportRelationshipV1] = []
        for edge in self._selected(document.edges, scope.relationship_ids):
            try:
                relationships.append(ExportRelationshipV1(
                    id=edge.id,
                    source_node_id=edge.source_node_id,
                    target_node_id=edge.target_node_id,
                    type=edge.type,
                    label=edge.label,
                    condition=edge.condition,
                    extensions=self._extensions(edge.metadata, diagnostics, "relationship", edge.id),
                ))
            except ValidationError:
                self._diagnose(
                    diagnostics, "export.record.unsupported", "error",
                    "export.diagnostic.unsupported-record", "relationship", edge.id,
                    {"record_type": "relationship"},
                )

        dialogues = [
            ExportDialogueV1(node_id=item.node_id, document=item.document)
            for item in sorted(document.dialogues, key=lambda item: item.node_id)
            if item.node_id in scope.node_ids
        ]
        quests = [
            ExportQuestV1(node_id=item.node_id, document=item.document)
            for item in sorted(document.quests, key=lambda item: item.node_id)
            if item.node_id in scope.node_ids
        ]
        story_flows = self._project_story_flows(document, scope)
        narrative_state = self._project_narrative_state(document, scope)
        engine_tags = self._project_engine_tags(document, options, scope, diagnostics)
        if len(engine_tags.omitted) > EXPORT_MAX_RECORDS:
            engine_tags = engine_tags.model_copy(
                update={"omitted": engine_tags.omitted[:EXPORT_MAX_RECORDS]}
            )
            self._diagnose(
                diagnostics, "export.limit.records", "error",
                "export.diagnostic.limit-exceeded", "project", document.manifest.project_id,
                {"limit": EXPORT_MAX_RECORDS},
            )
        available_tag_diagnostics = max(0, EXPORT_MAX_DIAGNOSTICS - len(diagnostics))
        if len(engine_tags.diagnostics) > available_tag_diagnostics:
            retained = max(0, available_tag_diagnostics - 1)
            engine_tags = engine_tags.model_copy(
                update={"diagnostics": engine_tags.diagnostics[:retained]}
            )
            self._diagnose(
                diagnostics, "export.limit.diagnostics", "error",
                "export.diagnostic.limit-exceeded", "project", document.manifest.project_id,
                {"limit": EXPORT_MAX_DIAGNOSTICS},
            )
        base_record_count = self._record_count_without_tags(
            nodes, relationships, dialogues, quests, story_flows, narrative_state
        )
        if base_record_count + len(engine_tags.entries) > EXPORT_MAX_RECORDS:
            allowed = max(0, EXPORT_MAX_RECORDS - base_record_count)
            engine_tags = engine_tags.model_copy(update={"entries": engine_tags.entries[:allowed]})
            self._diagnose(
                diagnostics, "export.limit.records", "error",
                "export.diagnostic.limit-exceeded", "project", document.manifest.project_id,
                {"limit": EXPORT_MAX_RECORDS},
            )
        project_extensions = self._extensions(
            document.project_metadata, diagnostics, "project", document.manifest.project_id
        )

        self._bound_diagnostics(diagnostics)
        source = ExportSourceIdentityV1(
            project_id=document.manifest.project_id,
            project_name=document.manifest.name,
            content_locale=document.manifest.settings.content_locale,
            document_version=document.document_version,
            source_checksum=document.checksum,
        )
        projection = ExportProjectionV1(
            manifest=ExportManifestV1(
                source=source,
                scope=options.scope,
                story_flow_ids=sorted(options.story_flow_ids),
                engine_tag_target=options.engine_tag_target,
            ),
            project=ExportProjectV1(
                id=document.manifest.project_id,
                name=document.manifest.name,
                description=document.manifest.description,
                content_locale=document.manifest.settings.content_locale,
                extensions=project_extensions,
            ),
            nodes=nodes,
            relationships=relationships,
            dialogues=dialogues,
            quests=quests,
            story_flows=story_flows,
            narrative_state=narrative_state,
            engine_tags=engine_tags,
            diagnostics=diagnostics,
        )
        return ExportProjectionBuildV1(
            projection=projection,
            inventory=self._inventory(projection),
        )

    @staticmethod
    def _whole_scope(document: ProjectDocument) -> _Scope:
        """Select every allowlisted record without deriving new order or content."""

        return _Scope(
            flow_ids={item.id for item in document.story_flows},
            node_ids={item.id for item in document.nodes},
            relationship_ids={item.id for item in document.edges},
            membership_ids={item.id for item in document.story_flow_nodes},
            transition_ids={item.id for item in document.flow_transitions},
            boundary_ids={item.id for item in document.scene_flow_boundaries},
            invocation_ids={item.id for item in document.flow_invocations},
            exit_ids={item.id for item in document.flow_exits},
            exit_binding_ids={item.id for item in document.flow_exit_bindings},
            initial_state_ids={item.id for item in document.flow_initial_states},
            effect_ids={item.id for item in document.narrative_effects},
            effect_binding_ids={item.id for item in document.narrative_effect_bindings},
        )

    def _selected_scope(
        self,
        document: ProjectDocument,
        requested_flow_ids: list[str],
        diagnostics: list[ExportDiagnosticV1],
    ) -> _Scope:
        scope = _Scope()
        if not requested_flow_ids:
            self._diagnose(
                diagnostics, "export.scope.empty-selection", "error",
                "export.diagnostic.empty-selection", "project", document.manifest.project_id,
            )
            return scope

        flow_by_id = {item.id: item for item in document.story_flows}
        invocations_by_source: dict[str, list[Any]] = defaultdict(list)
        for invocation in document.flow_invocations:
            invocations_by_source[invocation.source_flow_id].append(invocation)
        for values in invocations_by_source.values():
            values.sort(key=lambda item: item.id)

        visited: set[str] = set()
        visiting: set[str] = set()

        def visit(flow_id: str) -> None:
            if flow_id in visiting:
                self._diagnose(
                    diagnostics, "export.scope.recursion", "error",
                    "export.diagnostic.flow-recursion", "story_flow", flow_id,
                )
                return
            if flow_id in visited:
                return
            if flow_id not in flow_by_id:
                self._diagnose(
                    diagnostics, "export.scope.missing-flow", "error",
                    "export.diagnostic.missing-reference", "story_flow", flow_id,
                    {"reference_type": "story_flow"},
                )
                return
            visiting.add(flow_id)
            scope.flow_ids.add(flow_id)
            for invocation in invocations_by_source.get(flow_id, []):
                scope.invocation_ids.add(invocation.id)
                scope.node_ids.add(invocation.source_node_id)
                visit(invocation.target_flow_id)
            visiting.remove(flow_id)
            visited.add(flow_id)

        for flow_id in sorted(requested_flow_ids):
            visit(flow_id)

        self._include_flow_records(document, scope, diagnostics)
        self._expand_node_closure(document, scope, diagnostics)
        self._include_effects(document, scope, diagnostics)
        self._expand_node_closure(document, scope, diagnostics)
        self._include_relationships(document, scope, diagnostics)
        return scope

    def _include_flow_records(
        self,
        document: ProjectDocument,
        scope: _Scope,
        diagnostics: list[ExportDiagnosticV1],
    ) -> None:
        for flow in document.story_flows:
            if flow.id in scope.flow_ids and flow.entry_node_id is not None:
                scope.node_ids.add(flow.entry_node_id)
        for member in document.story_flow_nodes:
            if member.flow_id in scope.flow_ids:
                scope.membership_ids.add(member.id)
                scope.node_ids.add(member.node_id)
        for transition in document.flow_transitions:
            if transition.flow_id in scope.flow_ids:
                scope.transition_ids.add(transition.id)
                scope.node_ids.update((transition.source_node_id, transition.target_node_id))
        for boundary in document.scene_flow_boundaries:
            if boundary.flow_id in scope.flow_ids:
                scope.boundary_ids.add(boundary.id)
                scope.node_ids.update(
                    (boundary.scene_node_id, boundary.entry_node_id, *boundary.exit_node_ids)
                )
        for invocation in document.flow_invocations:
            if invocation.source_flow_id in scope.flow_ids:
                scope.invocation_ids.add(invocation.id)
                scope.node_ids.add(invocation.source_node_id)
                if invocation.target_flow_id not in scope.flow_ids:
                    self._diagnose(
                        diagnostics, "export.scope.missing-invoked-flow", "error",
                        "export.diagnostic.missing-reference", "flow_invocation", invocation.id,
                        {"reference_type": "target_flow"},
                    )
        for flow_exit in document.flow_exits:
            if flow_exit.flow_id in scope.flow_ids:
                scope.exit_ids.add(flow_exit.id)
                scope.node_ids.add(flow_exit.source_node_id)
        invocation_by_id = {item.id: item for item in document.flow_invocations}
        exit_by_id = {item.id: item for item in document.flow_exits}
        for binding in document.flow_exit_bindings:
            invocation = invocation_by_id.get(binding.invocation_id)
            flow_exit = exit_by_id.get(binding.exit_id)
            if invocation is None or flow_exit is None:
                continue
            if invocation.id in scope.invocation_ids and flow_exit.id in scope.exit_ids:
                scope.exit_binding_ids.add(binding.id)
                scope.node_ids.add(binding.target_node_id)
        for state in document.flow_initial_states:
            if state.flow_id not in scope.flow_ids:
                continue
            scope.initial_state_ids.add(state.id)
            scope.node_ids.update(state.quest_statuses)
            for custody in state.item_custody:
                scope.node_ids.add(custody.item_node_id)
                if custody.holder.node_id is not None:
                    scope.node_ids.add(custody.holder.node_id)

    def _expand_node_closure(
        self,
        document: ProjectDocument,
        scope: _Scope,
        diagnostics: list[ExportDiagnosticV1],
    ) -> None:
        node_by_id = {item.id: item for item in document.nodes}
        dialogues = {item.node_id: item.document for item in document.dialogues}
        quests = {item.node_id: item.document for item in document.quests}
        children: dict[str, set[str]] = defaultdict(set)
        parents: dict[str, set[str]] = defaultdict(set)
        for placement in document.placements:
            if placement.container_node_id is None:
                continue
            children[placement.container_node_id].add(placement.canonical_node_id)
            parents[placement.canonical_node_id].add(placement.container_node_id)

        changed = True
        while changed:
            before = len(scope.node_ids)
            for node_id in sorted(tuple(scope.node_ids)):
                node = node_by_id.get(node_id)
                if node is None:
                    self._diagnose(
                        diagnostics, "export.scope.missing-node", "error",
                        "export.diagnostic.missing-reference", "node", node_id,
                        {"reference_type": "node"},
                    )
                    continue
                scope.node_ids.update(parents.get(node_id, ()))
                if node.type in _CONTAINER_TYPES:
                    scope.node_ids.update(children.get(node_id, ()))
                dialogue = dialogues.get(node_id)
                if dialogue is not None:
                    scope.node_ids.update(dialogue.participants)
                quest = quests.get(node_id)
                if quest is not None:
                    scope.node_ids.update(quest.prerequisite_node_ids)
                    scope.node_ids.update(quest.reward_node_ids)
                    if quest.quest_giver_node_id is not None:
                        scope.node_ids.add(quest.quest_giver_node_id)
                outcome = node.metadata.get("outcome")
                if isinstance(outcome, dict):
                    targets = outcome.get("targetNodeIds", [])
                    if isinstance(targets, list):
                        scope.node_ids.update(item for item in targets if isinstance(item, str))
            changed = len(scope.node_ids) != before

        self._diagnose_containment_cycles(parents, scope.node_ids, diagnostics)

    def _include_effects(
        self,
        document: ProjectDocument,
        scope: _Scope,
        diagnostics: list[ExportDiagnosticV1],
    ) -> None:
        transitions = scope.transition_ids
        invocations = scope.invocation_ids
        exits = scope.exit_ids
        for binding in document.narrative_effect_bindings:
            included = (
                (binding.owner_kind == "node_entry" and binding.owner_id in scope.node_ids)
                or (binding.owner_kind == "flow_transition" and binding.owner_id in transitions)
                or (binding.owner_kind in {"dialogue_element", "dialogue_option", "quest_branch", "quest_outcome"}
                    and binding.context_node_id in scope.node_ids)
                or (binding.owner_kind == "flow_invocation" and binding.owner_id in invocations)
                or (binding.owner_kind == "flow_exit" and binding.owner_id in exits)
            )
            if included:
                scope.effect_binding_ids.add(binding.id)
                scope.effect_ids.add(binding.effect_id)
        effect_by_id = {item.id: item for item in document.narrative_effects}
        for effect_id in sorted(scope.effect_ids):
            effect = effect_by_id.get(effect_id)
            if effect is None:
                self._diagnose(
                    diagnostics, "export.scope.missing-effect", "error",
                    "export.diagnostic.missing-reference", "narrative_effect", effect_id,
                    {"reference_type": "narrative_effect"},
                )
                continue
            self._include_effect_nodes(effect.payload, scope.node_ids)

    @staticmethod
    def _include_effect_nodes(payload: dict[str, Any], node_ids: set[str]) -> None:
        for key in ("item_node_id", "quest_node_id", "dialogue_node_id"):
            value = payload.get(key)
            if isinstance(value, str):
                node_ids.add(value)
        for key in ("from_holder", "to_holder"):
            holder = payload.get(key)
            if isinstance(holder, dict) and isinstance(holder.get("node_id"), str):
                node_ids.add(holder["node_id"])

    def _include_relationships(
        self,
        document: ProjectDocument,
        scope: _Scope,
        diagnostics: list[ExportDiagnosticV1],
    ) -> None:
        for edge in document.edges:
            source = edge.source_node_id in scope.node_ids
            target = edge.target_node_id in scope.node_ids
            if source and target:
                scope.relationship_ids.add(edge.id)
            elif source or target:
                self._diagnose(
                    diagnostics, "export.scope.relationship-omitted", "info",
                    "export.diagnostic.relationship-omitted", "relationship", edge.id,
                    {"reason": "endpoint_out_of_scope"},
                )

    @staticmethod
    def _placement_containers(document: ProjectDocument) -> dict[str, list[str]]:
        containers: dict[str, set[str]] = defaultdict(set)
        for placement in document.placements:
            if placement.container_node_id is not None:
                containers[placement.canonical_node_id].add(placement.container_node_id)
        return {key: sorted(values) for key, values in containers.items()}

    def _project_node(
        self,
        node: Any,
        placement_containers: dict[str, list[str]],
        diagnostics: list[ExportDiagnosticV1],
    ) -> ExportNodeV1:
        if node.type not in _SUPPORTED_NODE_TYPES:
            self._diagnose(
                diagnostics, "export.record.unsupported-node-type", "error",
                "export.diagnostic.unsupported-record", "node", node.id,
                {"record_type": "node", "node_type": node.type},
            )
        metadata = node.metadata
        attributes = ExportNodeAttributesV1(
            character_role=metadata.get("character_role") if isinstance(metadata.get("character_role"), str) else None,
            item_purpose=metadata.get("item_purpose") if isinstance(metadata.get("item_purpose"), str) else None,
            requirement=self._requirement(metadata.get("requirement")),
            outcome=self._outcome(metadata.get("outcome")),
        )
        tags = metadata.get("tags", [])
        if not isinstance(tags, list) or any(not isinstance(item, str) for item in tags):
            self._diagnose(
                diagnostics, "export.record.unsupported-node-metadata", "warning",
                "export.diagnostic.unsupported-record", "node", node.id,
                {"field": "tags"},
            )
            tags = []
        return ExportNodeV1(
            id=node.id,
            type=node.type,
            title=node.title,
            summary=node.summary,
            body=node.body,
            status=node.status,
            tags=sorted(set(tags)),
            container_node_ids=placement_containers.get(node.id, []),
            attributes=attributes,
            extensions=self._extensions(metadata, diagnostics, "node", node.id),
        )

    @staticmethod
    def _requirement(value: Any) -> ExportRequirementV1 | None:
        if not isinstance(value, dict):
            return None
        return ExportRequirementV1(
            subject=value.get("subject", "") if isinstance(value.get("subject", ""), str) else "",
            predicate=value.get("predicate", "") if isinstance(value.get("predicate", ""), str) else "",
            expression=value.get("expression", "") if isinstance(value.get("expression", ""), str) else "",
        )

    @staticmethod
    def _outcome(value: Any) -> ExportOutcomeV1 | None:
        if not isinstance(value, dict):
            return None
        targets = value.get("targetNodeIds", [])
        return ExportOutcomeV1(
            effect=value.get("effect", "") if isinstance(value.get("effect", ""), str) else "",
            target_node_ids=sorted(item for item in targets if isinstance(item, str))
            if isinstance(targets, list) else [],
        )

    def _extensions(
        self,
        metadata: dict[str, Any],
        diagnostics: list[ExportDiagnosticV1],
        owner_kind: str,
        owner_id: str,
    ) -> ExportPortableExtensionsV1:
        values = {key: value for key, value in metadata.items() if key.startswith("x-")}
        try:
            return ExportPortableExtensionsV1(values=values)
        except ValidationError:
            self._diagnose(
                diagnostics, "export.record.unsafe-extension", "error",
                "export.diagnostic.unsafe-extension", owner_kind, owner_id,
            )
            return ExportPortableExtensionsV1()

    @staticmethod
    def _project_story_flows(document: ProjectDocument, scope: _Scope) -> ExportStoryFlowsV1:
        return ExportStoryFlowsV1(
            definitions=[
                ExportStoryFlowDefinitionV1(
                    id=item.id, name=item.name, description=item.description, kind=item.kind,
                    status=item.status, entry_node_id=item.entry_node_id,
                ) for item in ExportProjectionService._selected(document.story_flows, scope.flow_ids)
            ],
            memberships=[
                ExportStoryFlowMembershipV1(
                    id=item.id, flow_id=item.flow_id, node_id=item.node_id,
                    presentation_order=item.presentation_order,
                ) for item in ExportProjectionService._selected(
                    document.story_flow_nodes, scope.membership_ids
                )
            ],
            transitions=[
                ExportFlowTransitionV1(
                    id=item.id, flow_id=item.flow_id, source_node_id=item.source_node_id,
                    target_node_id=item.target_node_id, priority=item.priority, kind=item.kind,
                    label=item.label, condition=item.condition, is_default=item.is_default,
                    dialogue_element_id=(
                        item.metadata.get("dialogue_element_id")
                        if isinstance(item.metadata.get("dialogue_element_id"), str) else None
                    ),
                    quest_branch_id=(
                        item.metadata.get("quest_branch_id")
                        if isinstance(item.metadata.get("quest_branch_id"), str) else None
                    ),
                ) for item in ExportProjectionService._selected(
                    document.flow_transitions, scope.transition_ids
                )
            ],
            scene_boundaries=[
                ExportSceneFlowBoundaryV1(
                    id=item.id, flow_id=item.flow_id, scene_node_id=item.scene_node_id,
                    entry_node_id=item.entry_node_id, exit_node_ids=sorted(item.exit_node_ids),
                ) for item in ExportProjectionService._selected(
                    document.scene_flow_boundaries, scope.boundary_ids
                )
            ],
            invocations=[
                ExportFlowInvocationV1(
                    id=item.id, source_flow_id=item.source_flow_id,
                    source_node_id=item.source_node_id, target_flow_id=item.target_flow_id,
                    label=item.label, condition=item.condition, priority=item.priority,
                    is_default=item.is_default,
                ) for item in ExportProjectionService._selected(
                    document.flow_invocations, scope.invocation_ids
                )
            ],
            exits=[
                ExportFlowExitV1(
                    id=item.id, flow_id=item.flow_id, key=item.key, label=item.label,
                    source_node_id=item.source_node_id,
                ) for item in ExportProjectionService._selected(document.flow_exits, scope.exit_ids)
            ],
            exit_bindings=[
                ExportFlowExitBindingV1(
                    id=item.id, invocation_id=item.invocation_id, exit_id=item.exit_id,
                    target_node_id=item.target_node_id,
                ) for item in ExportProjectionService._selected(
                    document.flow_exit_bindings, scope.exit_binding_ids
                )
            ],
        )

    @staticmethod
    def _project_narrative_state(document: ProjectDocument, scope: _Scope) -> ExportNarrativeStateV1:
        return ExportNarrativeStateV1(
            initial_states=[
                ExportFlowInitialStateV1.model_validate(
                    item.model_dump(exclude={"project_id", "created_at", "updated_at"})
                ) for item in ExportProjectionService._selected(
                    document.flow_initial_states, scope.initial_state_ids
                )
            ],
            effects=[
                {
                    "effect_version": item.effect_version,
                    "id": item.id,
                    "operation": item.operation,
                    "payload": item.payload,
                    "repeat_policy": item.repeat_policy,
                    "explanation": item.explanation,
                } for item in ExportProjectionService._selected(
                    document.narrative_effects, scope.effect_ids
                )
            ],
            bindings=[
                ExportNarrativeEffectBindingV1(
                    id=item.id, effect_id=item.effect_id, owner_kind=item.owner_kind,
                    owner_id=item.owner_id, context_node_id=item.context_node_id,
                    application_order=item.application_order,
                ) for item in ExportProjectionService._selected(
                    document.narrative_effect_bindings, scope.effect_binding_ids
                )
            ],
        )

    def _project_engine_tags(
        self,
        document: ProjectDocument,
        options: ExportOptionsV1,
        scope: _Scope,
        diagnostics: list[ExportDiagnosticV1],
    ) -> ExportEngineTagsV1:
        projection = self._engine_tags.project(
            document,
            options.engine_tag_target,
            owner_filter=lambda owner: self._owner_in_scope(document, owner, scope),
        )
        identity_matches = (
            projection.project_id == document.manifest.project_id
            and projection.source_checksum == document.checksum
            and projection.target == options.engine_tag_target
        )
        if not identity_matches:
            self._diagnose(
                diagnostics, "export.engine-tags.source-stale", "error",
                "export.diagnostic.engine-tags-source-stale", "project",
                document.manifest.project_id,
                {"expected_checksum": document.checksum},
            )
            return ExportEngineTagsV1(
                project_id=document.manifest.project_id,
                source_checksum=document.checksum,
                target=options.engine_tag_target,
            )

        severity_by_omission = {
            "archived_definition": "warning",
            "missing_target_alias": "error",
            "duplicate_target_alias": "error",
            "target_identifier_invalid": "error",
            "missing_owner": "error",
            "legacy_quarantine": "warning",
            "out_of_scope": "warning",
        }
        for omission in projection.omitted:
            parameters = {
                "definition_id": omission.definition_id or "",
                "binding_id": omission.binding_id or "",
                **omission.details,
            }
            owner = self._export_tag_owner(omission.owner)
            self._diagnose(
                diagnostics,
                f"export.engine-tags.{omission.code.replace('_', '-')}",
                severity_by_omission[omission.code],
                f"export.diagnostic.engine-tags-{omission.code.replace('_', '-')}",
                owner.kind if owner else "project",
                owner.id if owner else document.manifest.project_id,
                parameters,
            )
        for item in projection.diagnostics:
            severity = "error" if item.code in {"target_collision", "missing_owner"} else "warning"
            self._diagnose(
                diagnostics,
                f"export.engine-tags.{item.code.replace('_', '-')}",
                severity,
                f"export.diagnostic.engine-tags-{item.code.replace('_', '-')}",
                "project",
                document.manifest.project_id,
                item.details,
            )
        return ExportEngineTagsV1(
            project_id=projection.project_id,
            source_checksum=projection.source_checksum,
            target=projection.target,
            entries=projection.entries,
            omitted=projection.omitted,
            diagnostics=projection.diagnostics,
        )

    @staticmethod
    def _export_tag_owner(owner: EngineTagOwnerV1 | None) -> ExportOwnerV1 | None:
        """Preserve exact tag navigation identity in export diagnostics."""

        if owner is None:
            return None
        owner_kind = {
            "dialogue_line": "dialogue_element",
            "dialogue_choice": "dialogue_element",
        }.get(owner.kind, owner.kind)
        owner_id = next((value for value in (
            owner.node_id, owner.edge_id, owner.line_id, owner.choice_id,
            owner.option_id, owner.stage_id, owner.branch_id, owner.flow_id,
            owner.transition_id, owner.invocation_id, owner.exit_id,
            owner.effect_id, owner.project_id,
        ) if value is not None), owner.project_id)
        context_id = owner.dialogue_node_id or owner.quest_node_id
        return ExportOwnerV1(kind=owner_kind, id=owner_id, context_id=context_id)

    @staticmethod
    def _owner_in_scope(document: ProjectDocument, owner: EngineTagOwnerV1, scope: _Scope) -> bool:
        if owner.kind == "project":
            return owner.project_id == document.manifest.project_id
        if owner.kind == "node":
            return owner.node_id in scope.node_ids
        if owner.kind == "relationship":
            return owner.edge_id in scope.relationship_ids
        if owner.kind in {"dialogue_line", "dialogue_choice", "dialogue_option"}:
            return owner.dialogue_node_id in scope.node_ids
        if owner.kind in {"quest_stage", "quest_branch"}:
            return owner.quest_node_id in scope.node_ids
        if owner.kind == "story_flow":
            return owner.flow_id in scope.flow_ids
        if owner.kind == "flow_transition":
            return owner.transition_id in scope.transition_ids
        if owner.kind == "flow_invocation":
            return owner.invocation_id in scope.invocation_ids
        if owner.kind == "flow_exit":
            return owner.exit_id in scope.exit_ids
        if owner.kind == "narrative_effect":
            return owner.effect_id in scope.effect_ids
        return False

    @staticmethod
    def _inventory(projection: ExportProjectionV1) -> ExportInventoryV1:
        flows = projection.story_flows
        state = projection.narrative_state
        counts = {
            "node_count": len(projection.nodes),
            "relationship_count": len(projection.relationships),
            "dialogue_count": len(projection.dialogues),
            "quest_count": len(projection.quests),
            "story_flow_count": len(flows.definitions),
            "flow_membership_count": len(flows.memberships),
            "flow_transition_count": len(flows.transitions),
            "scene_boundary_count": len(flows.scene_boundaries),
            "flow_invocation_count": len(flows.invocations),
            "flow_exit_count": len(flows.exits),
            "flow_exit_binding_count": len(flows.exit_bindings),
            "initial_state_count": len(state.initial_states),
            "narrative_effect_count": len(state.effects),
            "narrative_effect_binding_count": len(state.bindings),
            "engine_tag_count": len(projection.engine_tags.entries),
        }
        return ExportInventoryV1(
            **counts,
            diagnostic_count=len(projection.diagnostics) + len(projection.engine_tags.diagnostics),
            record_count=sum(counts.values()),
            resolved_story_flow_ids=[item.id for item in flows.definitions],
        )

    @staticmethod
    def _record_count_without_tags(
        nodes: list[ExportNodeV1],
        relationships: list[ExportRelationshipV1],
        dialogues: list[ExportDialogueV1],
        quests: list[ExportQuestV1],
        flows: ExportStoryFlowsV1,
        state: ExportNarrativeStateV1,
    ) -> int:
        return sum((
            len(nodes), len(relationships), len(dialogues), len(quests),
            len(flows.definitions), len(flows.memberships), len(flows.transitions),
            len(flows.scene_boundaries), len(flows.invocations), len(flows.exits),
            len(flows.exit_bindings), len(state.initial_states), len(state.effects),
            len(state.bindings),
        ))

    def _bound_scope(
        self,
        scope: _Scope,
        diagnostics: list[ExportDiagnosticV1],
        project_id: str,
    ) -> None:
        """Apply one deterministic global record budget before materialization."""

        remaining = EXPORT_MAX_RECORDS
        truncated = False
        for field_name in (
            "node_ids", "relationship_ids", "flow_ids", "membership_ids",
            "transition_ids", "boundary_ids", "invocation_ids", "exit_ids",
            "exit_binding_ids", "initial_state_ids", "effect_ids", "effect_binding_ids",
        ):
            values = sorted(getattr(scope, field_name))
            retained = values[:remaining]
            truncated = truncated or len(retained) != len(values)
            setattr(scope, field_name, set(retained))
            remaining -= len(retained)
        if truncated:
            self._diagnose(
                diagnostics, "export.limit.records", "error",
                "export.diagnostic.limit-exceeded", "project", project_id,
                {"limit": EXPORT_MAX_RECORDS},
            )

    @staticmethod
    def _selected(records: Iterable[Any], identifiers: set[str]) -> list[Any]:
        return sorted((item for item in records if item.id in identifiers), key=lambda item: item.id)

    def _diagnose_containment_cycles(
        self,
        parents: dict[str, set[str]],
        included: set[str],
        diagnostics: list[ExportDiagnosticV1],
    ) -> None:
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in visiting:
                self._diagnose(
                    diagnostics, "export.scope.containment-recursion", "error",
                    "export.diagnostic.containment-recursion", "node", node_id,
                )
                return
            if node_id in visited:
                return
            visiting.add(node_id)
            for parent_id in sorted(parents.get(node_id, ())):
                if parent_id in included:
                    visit(parent_id)
            visiting.remove(node_id)
            visited.add(node_id)

        for node_id in sorted(included):
            visit(node_id)

    @staticmethod
    def _diagnose(
        diagnostics: list[ExportDiagnosticV1],
        code: str,
        severity: str,
        message_key: str,
        owner_kind: str,
        owner_id: str,
        parameters: dict[str, Any] | None = None,
    ) -> None:
        key = (code, owner_kind, owner_id, tuple(sorted((parameters or {}).items())))
        existing = {
            (item.code, item.owner.kind if item.owner else "", item.owner.id if item.owner else "",
             tuple(sorted(item.parameters.items())))
            for item in diagnostics
        }
        if key in existing or len(diagnostics) >= EXPORT_MAX_DIAGNOSTICS:
            return
        try:
            owner = ExportOwnerV1(kind=owner_kind, id=owner_id)
        except ValidationError:
            owner = None
        diagnostics.append(ExportDiagnosticV1(
            code=code,
            severity=severity,
            message_key=message_key,
            owner=owner,
            parameters=parameters or {},
        ))
        diagnostics.sort(key=lambda item: (
            item.severity, item.code, item.owner.kind if item.owner else "",
            item.owner.id if item.owner else "",
        ))

    @staticmethod
    def _bound_diagnostics(diagnostics: list[ExportDiagnosticV1]) -> None:
        if len(diagnostics) > EXPORT_MAX_DIAGNOSTICS:
            del diagnostics[EXPORT_MAX_DIAGNOSTICS:]
        if len(diagnostics) >= EXPORT_MAX_DIAGNOSTICS:
            diagnostics[-1] = ExportDiagnosticV1(
                code="export.limit.diagnostics",
                severity="error",
                message_key="export.diagnostic.limit-exceeded",
                parameters={"limit": EXPORT_MAX_DIAGNOSTICS},
            )
