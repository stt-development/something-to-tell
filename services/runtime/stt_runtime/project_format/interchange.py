from ..domain.entities import (
    FlowExitBindingEntity,
    FlowExitEntity,
    FlowInvocationEntity,
    FlowInitialStateEntity,
    FlowTransitionEntity,
    SceneFlowBoundaryEntity,
    NarrativeEffectBindingEntity,
    NarrativeEffectEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
)
from ..repositories.interfaces import UnitOfWork
from ..schemas.dialogue import DialogueDocument
from ..schemas.narrative_state import (
    FlowInitialState,
    NarrativeEffectBinding,
    NarrativeEffectOwnerRecordRef,
    NarrativeEffectOwnerRef,
    NarrativeStateCanonicalNodeRef,
    NarrativeStateContract,
    NarrativeStateFlowRef,
)
from ..schemas.project_document import (
    NARRATIVE_EFFECT_ADAPTER,
    ProjectFlowInitialStateRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
)
from ..schemas.project_interchange import (
    ProjectInterchangeDocument,
    ProjectNarrativeStateSection,
    ProjectStoryFlowSection,
)
from ..schemas.composable_story_flow import (
    ComposableFlowGraph,
    FlowExit,
    FlowExitBinding,
    FlowInvocation,
)
from ..schemas.story_flow import FlowTransition, SceneFlowBoundary, StoryFlow, StoryFlowNode
from ..schemas.quest import QuestDocument


class ProjectInterchangeError(ValueError):
    """Rejects malformed cross-record imports before any persistence write."""


def normalize_story_flow_name(name: str) -> str:
    """Normalize a display name for project-local storage uniqueness."""

    return " ".join(name.split()).casefold()


def export_project_interchange(uow: UnitOfWork, project_id: str) -> ProjectInterchangeDocument:
    """Export the versioned Story Flow project section through repository protocols."""

    if uow.projects.get(project_id) is None:
        raise ProjectInterchangeError(f"Project not found: {project_id}")

    flows = sorted(uow.story_flows.list(project_id=project_id), key=lambda item: (item.created_at, item.id))
    memberships = sorted(
        uow.story_flow_nodes.list(project_id=project_id),
        key=lambda item: (item.flow_id, item.presentation_order, item.id),
    )
    transitions = sorted(
        uow.flow_transitions.list(project_id=project_id),
        key=lambda item: (item.flow_id, item.source_node_id, item.priority, item.id),
    )
    boundaries = sorted(
        uow.scene_flow_boundaries.list(project_id=project_id),
        key=lambda item: (item.flow_id, item.scene_node_id, item.id),
    )
    invocations = sorted(
        uow.flow_invocations.list(project_id=project_id),
        key=lambda item: (item.source_flow_id, item.source_node_id, item.priority, item.id),
    )
    exits = sorted(
        uow.flow_exits.list(project_id=project_id),
        key=lambda item: (item.flow_id, item.key, item.id),
    )
    bindings = sorted(
        uow.flow_exit_bindings.list(project_id=project_id),
        key=lambda item: (item.invocation_id, item.exit_id, item.id),
    )
    initial_states = sorted(
        uow.flow_initial_states.list(project_id=project_id), key=lambda item: item.id
    )
    effects = sorted(uow.narrative_effects.list(project_id=project_id), key=lambda item: item.id)
    effect_bindings = sorted(
        uow.narrative_effect_bindings.list(project_id=project_id), key=lambda item: item.id
    )
    return ProjectInterchangeDocument(
        project_id=project_id,
        story_flows=ProjectStoryFlowSection(
            project_id=project_id,
            flows=[_flow_contract(item) for item in flows],
            nodes=[_membership_contract(item) for item in memberships],
            transitions=[_transition_contract(item) for item in transitions],
            scene_boundaries=[_boundary_contract(item) for item in boundaries],
            invocations=[_invocation_contract(item) for item in invocations],
            exits=[_exit_contract(item) for item in exits],
            exit_bindings=[_binding_contract(item) for item in bindings],
        ),
        narrative_state=ProjectNarrativeStateSection(
            project_id=project_id,
            initial_states=[
                _record_contract(item, ProjectFlowInitialStateRecord)
                for item in initial_states
            ],
            effects=[
                _record_contract(item, ProjectNarrativeEffectRecord) for item in effects
            ],
            bindings=[
                _record_contract(item, ProjectNarrativeEffectBindingRecord)
                for item in effect_bindings
            ],
        ),
    )


def import_project_interchange(uow: UnitOfWork, document: ProjectInterchangeDocument) -> int:
    """Import Story Flow records atomically while preserving stable record ids."""

    if uow.projects.get(document.project_id) is None:
        raise ProjectInterchangeError(f"Project not found: {document.project_id}")
    section = document.story_flows
    state_section = document.narrative_state
    if section is None and state_section is None:
        # Version 1 projects created before Phase 3.7 have no section and must
        # remain unordered instead of receiving an inferred Story Flow.
        return 0
    if section is not None:
        _validate_section(uow, document.project_id, section)
    if state_section is not None:
        _validate_state_section(uow, document.project_id, state_section, section)

    try:
        for flow in section.flows if section is not None else []:
            uow.story_flows.add(
                StoryFlowEntity(
                    id=flow.id,
                    project_id=flow.project_id,
                    name=flow.name,
                    normalized_name=normalize_story_flow_name(flow.name),
                    description=flow.description,
                    kind=flow.kind,
                    status=flow.status,
                    entry_node_id=flow.entry_node_id,
                    metadata=flow.metadata,
                    created_at=flow.created_at,
                    updated_at=flow.updated_at,
                )
            )
        for membership in section.nodes if section is not None else []:
            uow.story_flow_nodes.add(
                StoryFlowNodeEntity(
                    id=membership.id,
                    project_id=membership.project_id,
                    flow_id=membership.flow_id,
                    node_id=membership.node_id,
                    presentation_order=membership.presentation_order,
                    metadata=membership.metadata,
                    created_at=membership.created_at,
                    updated_at=membership.updated_at,
                )
            )
        for transition in section.transitions if section is not None else []:
            uow.flow_transitions.add(
                FlowTransitionEntity(
                    id=transition.id,
                    project_id=transition.project_id,
                    flow_id=transition.flow_id,
                    source_node_id=transition.source_node_id,
                    target_node_id=transition.target_node_id,
                    kind=transition.kind,
                    label=transition.label,
                    condition=transition.condition,
                    priority=transition.priority,
                    is_default=transition.is_default,
                    metadata=transition.metadata,
                    created_at=transition.created_at,
                    updated_at=transition.updated_at,
                )
            )
        for boundary in section.scene_boundaries if section is not None else []:
            uow.scene_flow_boundaries.add(
                SceneFlowBoundaryEntity(
                    id=boundary.id,
                    project_id=boundary.project_id,
                    flow_id=boundary.flow_id,
                    scene_node_id=boundary.scene_node_id,
                    entry_node_id=boundary.entry_node_id,
                    exit_node_ids=boundary.exit_node_ids,
                    metadata=boundary.metadata,
                    created_at=boundary.created_at,
                    updated_at=boundary.updated_at,
                )
            )
        for invocation in section.invocations if section is not None else []:
            uow.flow_invocations.add(
                FlowInvocationEntity(
                    **invocation.model_dump(
                        mode="python", exclude={"invocation_version"}
                    )
                )
            )
        for flow_exit in section.exits if section is not None else []:
            uow.flow_exits.add(
                FlowExitEntity(
                    **flow_exit.model_dump(mode="python", exclude={"exit_version"})
                )
            )
        for binding in section.exit_bindings if section is not None else []:
            uow.flow_exit_bindings.add(
                FlowExitBindingEntity(
                    **binding.model_dump(mode="python", exclude={"binding_version"})
                )
            )
        for state in state_section.initial_states if state_section is not None else []:
            uow.flow_initial_states.add(
                FlowInitialStateEntity(**state.model_dump(mode="python"))
            )
        for effect in state_section.effects if state_section is not None else []:
            uow.narrative_effects.add(
                NarrativeEffectEntity(**effect.model_dump(mode="python"))
            )
        for binding in state_section.bindings if state_section is not None else []:
            uow.narrative_effect_bindings.add(
                NarrativeEffectBindingEntity(**binding.model_dump(mode="python"))
            )
        uow.commit()
    except Exception:
        # A partially imported flow would make membership and order ambiguous.
        uow.rollback()
        raise
    return len(section.flows) if section is not None else 0


def _validate_section(uow: UnitOfWork, project_id: str, section: ProjectStoryFlowSection) -> None:
    if section.project_id != project_id:
        raise ProjectInterchangeError("Story Flow section belongs to another project")
    flow_ids = {flow.id for flow in section.flows}
    if len(flow_ids) != len(section.flows):
        raise ProjectInterchangeError("Story Flow section contains duplicate flow ids")

    node_ids = {node.id for node in uow.nodes.list(project_id=project_id)}
    for flow in section.flows:
        _require_project(flow.project_id, project_id, f"Story Flow {flow.id}")
        if flow.entry_node_id is not None and flow.entry_node_id not in node_ids:
            raise ProjectInterchangeError(f"Story Flow entry node not found: {flow.entry_node_id}")
    for record in [*section.nodes, *section.transitions, *section.scene_boundaries]:
        _require_project(record.project_id, project_id, f"Story Flow record {record.id}")
        if record.flow_id not in flow_ids:
            raise ProjectInterchangeError(f"Story Flow record references missing flow: {record.flow_id}")
    for membership in section.nodes:
        if membership.node_id not in node_ids:
            raise ProjectInterchangeError(f"Story Flow membership node not found: {membership.node_id}")
    for transition in section.transitions:
        if transition.source_node_id not in node_ids or transition.target_node_id not in node_ids:
            raise ProjectInterchangeError(f"Flow transition endpoint not found: {transition.id}")
    for boundary in section.scene_boundaries:
        references = {boundary.scene_node_id, boundary.entry_node_id, *boundary.exit_node_ids}
        if not references.issubset(node_ids):
            raise ProjectInterchangeError(f"Scene Flow boundary node not found: {boundary.id}")
    try:
        ComposableFlowGraph(
            project_id=project_id,
            flows=section.flows,
            memberships=section.nodes,
            transitions=section.transitions,
            invocations=section.invocations,
            exits=section.exits,
            bindings=section.exit_bindings,
        )
    except ValueError as error:
        raise ProjectInterchangeError(f"Composable Story Flow section is invalid: {error}") from error


def _validate_state_section(
    uow: UnitOfWork,
    project_id: str,
    state: ProjectNarrativeStateSection,
    flows: ProjectStoryFlowSection | None,
) -> None:
    """Validate imported state against existing and simultaneously imported owners."""

    if state.project_id != project_id:
        raise ProjectInterchangeError("Narrative state section belongs to another project")
    nodes = list(uow.nodes.list(project_id=project_id))
    owner_records: list[NarrativeEffectOwnerRecordRef] = [
        _state_owner(project_id, "node_entry", node.id) for node in nodes
    ]
    transitions = [
        *uow.flow_transitions.list(project_id=project_id),
        *(flows.transitions if flows is not None else []),
    ]
    invocations = [
        *uow.flow_invocations.list(project_id=project_id),
        *(flows.invocations if flows is not None else []),
    ]
    exits = [
        *uow.flow_exits.list(project_id=project_id),
        *(flows.exits if flows is not None else []),
    ]
    owner_records.extend(
        _state_owner(project_id, "flow_transition", item.id) for item in transitions
    )
    owner_records.extend(
        _state_owner(project_id, "flow_invocation", item.id) for item in invocations
    )
    owner_records.extend(_state_owner(project_id, "flow_exit", item.id) for item in exits)
    for node in nodes:
        if node.type == "Dialogue":
            document = DialogueDocument.model_validate(node.metadata.get("dialogue_document", {}))
            for element in document.elements:
                owner_records.append(
                    _state_owner(project_id, "dialogue_element", element.id, node.id)
                )
                owner_records.extend(
                    _state_owner(project_id, "dialogue_option", option.id, node.id)
                    for option in getattr(element, "options", [])
                )
        elif node.type == "Quest":
            document = QuestDocument.model_validate(node.metadata.get("quest_document", {}))
            for stage in document.stages:
                for branch in stage.branches:
                    owner_records.append(
                        _state_owner(project_id, "quest_branch", branch.id, node.id)
                    )
                    if branch.target_stage_id is None:
                        owner_records.append(
                            _state_owner(project_id, "quest_outcome", branch.id, node.id)
                        )

    existing_states = [
        _record_contract(item, ProjectFlowInitialStateRecord)
        for item in uow.flow_initial_states.list(project_id=project_id)
    ]
    existing_effects = [
        _record_contract(item, ProjectNarrativeEffectRecord)
        for item in uow.narrative_effects.list(project_id=project_id)
    ]
    existing_bindings = [
        _record_contract(item, ProjectNarrativeEffectBindingRecord)
        for item in uow.narrative_effect_bindings.list(project_id=project_id)
    ]
    flow_records = [
        *uow.story_flows.list(project_id=project_id),
        *(flows.flows if flows is not None else []),
    ]
    try:
        NarrativeStateContract(
            project_id=project_id,
            canonical_nodes=[
                NarrativeStateCanonicalNodeRef(
                    id=node.id, project_id=node.project_id, type=node.type
                )
                for node in nodes
            ],
            flows=[
                NarrativeStateFlowRef(id=flow.id, project_id=flow.project_id)
                for flow in flow_records
            ],
            owners=owner_records,
            initial_states=[
                FlowInitialState.model_validate(
                    record.model_dump(exclude={"id", "created_at", "updated_at"})
                )
                for record in [*existing_states, *state.initial_states]
            ],
            effects=[
                NARRATIVE_EFFECT_ADAPTER.validate_python(
                    record.model_dump(exclude={"created_at", "updated_at"})
                )
                for record in [*existing_effects, *state.effects]
            ],
            bindings=[
                _state_binding(record)
                for record in [*existing_bindings, *state.bindings]
            ],
        )
    except ValueError as error:
        raise ProjectInterchangeError(f"Narrative state section is invalid: {error}") from error


def _require_project(record_project_id: str, project_id: str, label: str) -> None:
    if record_project_id != project_id:
        raise ProjectInterchangeError(f"{label} belongs to another project")


def _flow_contract(entity: StoryFlowEntity) -> StoryFlow:
    return StoryFlow(
        id=entity.id,
        project_id=entity.project_id,
        name=entity.name,
        description=entity.description,
        kind=entity.kind,
        status=entity.status,
        entry_node_id=entity.entry_node_id,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def _membership_contract(entity: StoryFlowNodeEntity) -> StoryFlowNode:
    return StoryFlowNode(
        id=entity.id,
        project_id=entity.project_id,
        flow_id=entity.flow_id,
        node_id=entity.node_id,
        presentation_order=entity.presentation_order,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def _transition_contract(entity: FlowTransitionEntity) -> FlowTransition:
    return FlowTransition(
        id=entity.id,
        project_id=entity.project_id,
        flow_id=entity.flow_id,
        source_node_id=entity.source_node_id,
        target_node_id=entity.target_node_id,
        kind=entity.kind,
        label=entity.label,
        condition=entity.condition,
        priority=entity.priority,
        is_default=entity.is_default,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def _boundary_contract(entity: SceneFlowBoundaryEntity) -> SceneFlowBoundary:
    return SceneFlowBoundary(
        id=entity.id,
        project_id=entity.project_id,
        flow_id=entity.flow_id,
        scene_node_id=entity.scene_node_id,
        entry_node_id=entity.entry_node_id,
        exit_node_ids=entity.exit_node_ids,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def _invocation_contract(entity: FlowInvocationEntity) -> FlowInvocation:
    return FlowInvocation.model_validate(entity, from_attributes=True)


def _exit_contract(entity: FlowExitEntity) -> FlowExit:
    return FlowExit.model_validate(entity, from_attributes=True)


def _binding_contract(entity: FlowExitBindingEntity) -> FlowExitBinding:
    return FlowExitBinding.model_validate(entity, from_attributes=True)


def _record_contract(entity: object, record_type: type) -> object:
    """Convert a repository entity into its storage-neutral Pydantic record."""

    return record_type.model_validate(entity, from_attributes=True)


def _state_owner(
    project_id: str,
    owner_kind: str,
    owner_id: str,
    context_node_id: str | None = None,
) -> NarrativeEffectOwnerRecordRef:
    return NarrativeEffectOwnerRecordRef(
        project_id=project_id,
        owner=NarrativeEffectOwnerRef(
            owner_kind=owner_kind,
            owner_id=owner_id,
            context_node_id=context_node_id,
        ),
    )


def _state_binding(record: ProjectNarrativeEffectBindingRecord) -> NarrativeEffectBinding:
    return NarrativeEffectBinding(
        binding_version=record.binding_version,
        id=record.id,
        project_id=record.project_id,
        effect_id=record.effect_id,
        owner=NarrativeEffectOwnerRef(
            owner_kind=record.owner_kind,
            owner_id=record.owner_id,
            context_node_id=record.context_node_id,
        ),
        application_order=record.application_order,
    )
