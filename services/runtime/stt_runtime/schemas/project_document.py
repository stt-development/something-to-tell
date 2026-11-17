from copy import deepcopy
from datetime import datetime
from hashlib import sha256
import json
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationInfo, model_validator

from ..project_format.manifest import ProjectManifestV2
from .agent_memory import AgentMemoryCatalogV1, AgentMemoryEntryV1
from .engine_tags import EngineTagBindingV1, EngineTagDefinitionV1, LegacyEngineTagRecordV1
from .composable_story_flow import (
    ComposableFlowGraph,
    FlowExit,
    FlowExitBinding,
    FlowInvocation,
)
from .dialogue import DialogueChoiceElement, DialogueDocument, DialogueLineElement
from .narrative_state import (
    FlowInitialState,
    ItemCustody,
    NarrativeEffectBinding,
    NarrativeEffectDefinition,
    NarrativeEffectOwnerRecordRef,
    NarrativeEffectOwnerRef,
    NarrativeStateCanonicalNodeRef,
    NarrativeStateContract,
    NarrativeStateFlowRef,
    QuestStateStatus,
)
from .quest import QuestDocument
from .story_flow import FlowTransition, StoryFlow, StoryFlowNode
from .style_system import SceneStyleAssignmentV1, StyleCatalogV1, StyleProfileV1

PROJECT_DOCUMENT_VERSION = 5
DIALOGUE_METADATA_KEY = "dialogue_document"
QUEST_METADATA_KEY = "quest_document"
NARRATIVE_EFFECT_ADAPTER = TypeAdapter(NarrativeEffectDefinition)
DOCUMENT_INPUT_ADAPTER = TypeAdapter(dict[str, Any])


class PersistedRecord(BaseModel):
    """Fields shared by every durable repository record."""

    model_config = ConfigDict(extra="forbid", from_attributes=True)

    id: str = Field(min_length=1)
    created_at: datetime
    updated_at: datetime


class ProjectOwnedRecord(PersistedRecord):
    """A durable record constrained to the document's project."""

    project_id: str = Field(min_length=1)


class ProjectNodeRecord(ProjectOwnedRecord):
    """Canonical node data without embedded specialized aggregate documents."""

    type: str = Field(min_length=1)
    title: str = Field(min_length=1)
    summary: str = ""
    body: str = ""
    status: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def reject_duplicate_specialized_documents(self) -> "ProjectNodeRecord":
        reserved = {DIALOGUE_METADATA_KEY, QUEST_METADATA_KEY}.intersection(self.metadata)
        if reserved:
            raise ValueError(
                f"specialized documents must use owned sections: {', '.join(sorted(reserved))}"
            )
        return self


class ProjectEdgeRecord(ProjectOwnedRecord):
    """Semantic relationship, including faction and outcome ownership edges."""

    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    type: str = Field(min_length=1)
    label: str = ""
    condition: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectIssueRecord(ProjectOwnedRecord):
    """Persisted issue; generated analysis previews are intentionally absent."""

    title: str = Field(min_length=1)
    node_id: str | None = None
    edge_id: str | None = None
    description: str = ""
    severity: str = Field(min_length=1)
    status: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectSuggestionRecord(ProjectOwnedRecord):
    """Suggestion and accepted/rejected decision history."""

    title: str = Field(min_length=1)
    description: str = ""
    status: str = Field(min_length=1)
    patch: dict[str, Any] = Field(default_factory=dict)
    created_by: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectEngineTagRecord(ProjectOwnedRecord):
    """Project-owned engine metadata attached to a stable target id."""

    target_type: str = Field(min_length=1)
    target_id: str = Field(min_length=1)
    engine: str = Field(min_length=1)
    key: str = Field(min_length=1)
    value: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectPlacementRecord(ProjectOwnedRecord):
    """Storage-neutral visual instance with complete persisted geometry."""

    canonical_node_id: str = Field(min_length=1)
    scope_key: str = Field(min_length=1)
    x: float = Field(allow_inf_nan=False)
    y: float = Field(allow_inf_nan=False)
    width: float = Field(gt=0, allow_inf_nan=False)
    height: float = Field(gt=0, allow_inf_nan=False)
    container_node_id: str | None = None
    is_primary: bool = False
    presentation_state: str = Field(min_length=1)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectStoryFlowRecord(ProjectOwnedRecord):
    """Named author-owned ordering aggregate."""

    name: str = Field(min_length=1)
    normalized_name: str = Field(min_length=1)
    description: str = ""
    kind: str = Field(min_length=1)
    status: str = Field(min_length=1)
    entry_node_id: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectStoryFlowNodeRecord(ProjectOwnedRecord):
    """Explicit membership of one canonical node in one Story Flow."""

    flow_id: str = Field(min_length=1)
    node_id: str = Field(min_length=1)
    presentation_order: int = Field(ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectFlowTransitionRecord(ProjectOwnedRecord):
    """Directed Story Flow transition, separate from semantic relationships."""

    flow_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    priority: int = Field(ge=0)
    kind: str = Field(min_length=1)
    label: str = ""
    condition: str = ""
    is_default: bool = False
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectSceneFlowBoundaryRecord(ProjectOwnedRecord):
    """Detailed Scene entry and exits owned by one Story Flow."""

    flow_id: str = Field(min_length=1)
    scene_node_id: str = Field(min_length=1)
    entry_node_id: str = Field(min_length=1)
    exit_node_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ProjectFlowInvocationRecord(ProjectOwnedRecord):
    """Storage-neutral explicit route from a caller node into another flow."""

    source_flow_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_flow_id: str = Field(min_length=1)
    label: str = ""
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False


class ProjectFlowExitRecord(ProjectOwnedRecord):
    """Storage-neutral named terminal route exposed by one flow."""

    flow_id: str = Field(min_length=1)
    key: str = Field(min_length=1)
    label: str = ""
    source_node_id: str = Field(min_length=1)


class ProjectFlowExitBindingRecord(ProjectOwnedRecord):
    """Storage-neutral call-site return target in the immediate caller flow."""

    invocation_id: str = Field(min_length=1)
    exit_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)


class ProjectFlowInitialStateRecord(ProjectOwnedRecord):
    """Storage-neutral explicit root state for one Story Flow."""

    state_version: Literal[1] = 1
    flow_id: str = Field(min_length=1)
    flags: dict[str, bool] = Field(default_factory=dict)
    item_custody: list[ItemCustody] = Field(default_factory=list)
    quest_statuses: dict[str, QuestStateStatus] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_initial_state(self) -> "ProjectFlowInitialStateRecord":
        FlowInitialState.model_validate(
            self.model_dump(exclude={"id", "created_at", "updated_at"})
        )
        return self


class ProjectNarrativeEffectRecord(ProjectOwnedRecord):
    """Storage-neutral reusable effect definition with a validated typed payload."""

    effect_version: Literal[1] = 1
    operation: str = Field(min_length=1, max_length=64)
    payload: dict[str, Any]
    repeat_policy: str = Field(min_length=1, max_length=32)
    explanation: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_typed_effect(self) -> "ProjectNarrativeEffectRecord":
        NARRATIVE_EFFECT_ADAPTER.validate_python(
            self.model_dump(exclude={"created_at", "updated_at"})
        )
        return self


class ProjectNarrativeEffectBindingRecord(ProjectOwnedRecord):
    """Storage-neutral deterministic binding to a stable temporal owner."""

    binding_version: Literal[1] = 1
    effect_id: str = Field(min_length=1)
    owner_kind: str = Field(min_length=1, max_length=64)
    owner_id: str = Field(min_length=1)
    context_node_id: str | None = Field(default=None, min_length=1)
    application_order: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_typed_binding(self) -> "ProjectNarrativeEffectBindingRecord":
        NarrativeEffectBinding.model_validate(
            {
                "binding_version": self.binding_version,
                "id": self.id,
                "project_id": self.project_id,
                "effect_id": self.effect_id,
                "owner": {
                    "owner_version": 1,
                    "owner_kind": self.owner_kind,
                    "owner_id": self.owner_id,
                    "context_node_id": self.context_node_id,
                },
                "application_order": self.application_order,
            }
        )
        return self


class OwnedDialogueDocument(BaseModel):
    """Typed Dialogue aggregate owned by one canonical Dialogue node."""

    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(min_length=1)
    document: DialogueDocument


class OwnedQuestDocument(BaseModel):
    """Typed Quest aggregate owned by one canonical Quest node."""

    model_config = ConfigDict(extra="forbid")

    node_id: str = Field(min_length=1)
    document: QuestDocument


class ProjectDocument(BaseModel):
    """Complete deterministic durable state for one explicitly opened project."""

    model_config = ConfigDict(extra="forbid")

    document_version: Literal[5] = PROJECT_DOCUMENT_VERSION
    checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    manifest: ProjectManifestV2
    project_metadata: dict[str, Any] = Field(default_factory=dict)
    nodes: list[ProjectNodeRecord] = Field(default_factory=list)
    edges: list[ProjectEdgeRecord] = Field(default_factory=list)
    issues: list[ProjectIssueRecord] = Field(default_factory=list)
    suggestions: list[ProjectSuggestionRecord] = Field(default_factory=list)
    engine_tags: list[ProjectEngineTagRecord] = Field(default_factory=list)
    # Empty extension fields are omitted from v5 checksums while old snapshots migrate.
    engine_tag_definitions: list[EngineTagDefinitionV1] = Field(
        default_factory=list, exclude_if=lambda value: not value
    )
    engine_tag_bindings: list[EngineTagBindingV1] = Field(
        default_factory=list, exclude_if=lambda value: not value
    )
    legacy_engine_tags: list[LegacyEngineTagRecordV1] = Field(
        default_factory=list, exclude_if=lambda value: not value
    )
    placements: list[ProjectPlacementRecord] = Field(default_factory=list)
    dialogues: list[OwnedDialogueDocument] = Field(default_factory=list)
    quests: list[OwnedQuestDocument] = Field(default_factory=list)
    story_flows: list[ProjectStoryFlowRecord] = Field(default_factory=list)
    story_flow_nodes: list[ProjectStoryFlowNodeRecord] = Field(default_factory=list)
    flow_transitions: list[ProjectFlowTransitionRecord] = Field(default_factory=list)
    scene_flow_boundaries: list[ProjectSceneFlowBoundaryRecord] = Field(default_factory=list)
    flow_invocations: list[ProjectFlowInvocationRecord] = Field(default_factory=list)
    flow_exits: list[ProjectFlowExitRecord] = Field(default_factory=list)
    flow_exit_bindings: list[ProjectFlowExitBindingRecord] = Field(default_factory=list)
    flow_initial_states: list[ProjectFlowInitialStateRecord] = Field(default_factory=list)
    narrative_effects: list[ProjectNarrativeEffectRecord] = Field(default_factory=list)
    narrative_effect_bindings: list[ProjectNarrativeEffectBindingRecord] = Field(
        default_factory=list
    )
    style_profiles: list[StyleProfileV1] = Field(default_factory=list)
    scene_style_assignments: list[SceneStyleAssignmentV1] = Field(default_factory=list)
    agent_memories: list[AgentMemoryEntryV1] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_complete_document(self, info: ValidationInfo) -> "ProjectDocument":
        project_id = self.manifest.project_id
        collections: tuple[tuple[str, list[Any]], ...] = (
            ("nodes", list(self.nodes)),
            ("edges", list(self.edges)),
            ("issues", list(self.issues)),
            ("suggestions", list(self.suggestions)),
            ("engine_tags", list(self.engine_tags)),
            ("engine_tag_definitions", list(self.engine_tag_definitions)),
            ("engine_tag_bindings", list(self.engine_tag_bindings)),
            ("legacy_engine_tags", list(self.legacy_engine_tags)),
            ("placements", list(self.placements)),
            ("story_flows", list(self.story_flows)),
            ("story_flow_nodes", list(self.story_flow_nodes)),
            ("flow_transitions", list(self.flow_transitions)),
            ("scene_flow_boundaries", list(self.scene_flow_boundaries)),
            ("flow_invocations", list(self.flow_invocations)),
            ("flow_exits", list(self.flow_exits)),
            ("flow_exit_bindings", list(self.flow_exit_bindings)),
            ("flow_initial_states", list(self.flow_initial_states)),
            ("narrative_effects", list(self.narrative_effects)),
            ("narrative_effect_bindings", list(self.narrative_effect_bindings)),
            ("style_profiles", list(self.style_profiles)),
            ("scene_style_assignments", list(self.scene_style_assignments)),
            ("agent_memories", list(self.agent_memories)),
        )
        for label, records in collections:
            self._require_unique_ids(label, records)
            self._require_sorted_ids(label, records)
            if any(record.project_id != project_id for record in records):
                raise ValueError(f"{label} contains a record from another project")

        definition_ids = {record.id for record in self.engine_tag_definitions}
        if any(record.definition_id not in definition_ids for record in self.engine_tag_bindings):
            raise ValueError("engine tag binding references a missing definition")
        normalized_keys = [record.normalized_key for record in self.engine_tag_definitions]
        if len(normalized_keys) != len(set(normalized_keys)):
            raise ValueError("engine tag definitions contain duplicate normalized keys")

        node_by_id = {node.id: node for node in self.nodes}
        edge_ids = {edge.id for edge in self.edges}
        flow_ids = {flow.id for flow in self.story_flows}
        self._validate_graph_references(node_by_id, edge_ids)
        self._validate_specialized_documents(node_by_id)
        self._validate_flow_references(node_by_id, flow_ids)
        self._validate_narrative_state(node_by_id)
        self._validate_styles(node_by_id)
        self._validate_agent_memories(node_by_id, flow_ids)

        if not (info.context or {}).get("skip_checksum"):
            expected_checksum = project_document_checksum(self)
            if self.checksum != expected_checksum:
                raise ValueError("project document checksum does not match its content")
        return self

    def _validate_styles(self, node_by_id: dict[str, ProjectNodeRecord]) -> None:
        """Validate portable profile references and require canonical Scene owners."""

        StyleCatalogV1(
            project_id=self.manifest.project_id,
            # A project default may temporarily dangle after Discard because
            # settings are durable immediately while profile edits follow Save.
            # P6-004 resolves that state as visible/unconfigured. Explicit Scene
            # assignments remain strict and must always resolve here.
            default_style_profile_id=None,
            profiles=tuple(self.style_profiles),
            scene_assignments=tuple(self.scene_style_assignments),
        )
        for assignment in self.scene_style_assignments:
            scene = node_by_id.get(assignment.scene_node_id)
            if scene is None or scene.type != "Scene":
                raise ValueError(
                    f"Scene style assignment references a non-Scene node: {assignment.id}"
                )

    def _validate_agent_memories(
        self,
        node_by_id: dict[str, ProjectNodeRecord],
        flow_ids: set[str],
    ) -> None:
        """Require every durable scope to resolve without inferred ownership."""

        AgentMemoryCatalogV1(
            project_id=self.manifest.project_id,
            entries=tuple(self.agent_memories),
        )
        dialogue_by_node = {owned.node_id: owned.document for owned in self.dialogues}
        for memory in self.agent_memories:
            scope = memory.scope
            if scope.kind == "project":
                continue
            if scope.kind == "story_flow":
                if scope.flow_id not in flow_ids:
                    raise ValueError(f"agent memory references a missing Story Flow: {memory.id}")
                continue
            owner_id = scope.scene_node_id if scope.kind == "scene" else scope.node_id
            owner = node_by_id.get(owner_id)
            if owner is None:
                raise ValueError(f"agent memory references a missing node: {memory.id}")
            if scope.kind == "scene" and owner.type != "Scene":
                raise ValueError(f"agent memory Scene scope is not a Scene: {memory.id}")
            if scope.kind != "dialogue_field":
                continue
            dialogue = dialogue_by_node.get(scope.node_id)
            if owner.type != "Dialogue" or dialogue is None:
                raise ValueError(f"agent memory Dialogue scope is not a Dialogue: {memory.id}")
            element = next(
                (item for item in dialogue.elements if item.id == scope.element_id),
                None,
            )
            valid_line = scope.field_kind == "line_text" and isinstance(
                element, DialogueLineElement
            )
            valid_prompt = scope.field_kind == "choice_prompt" and isinstance(
                element, DialogueChoiceElement
            )
            valid_option = (
                scope.field_kind == "option_text"
                and isinstance(element, DialogueChoiceElement)
                and any(option.id == scope.option_id for option in element.options)
            )
            if not (valid_line or valid_prompt or valid_option):
                raise ValueError(f"agent memory references a missing Dialogue field: {memory.id}")

    def _validate_graph_references(
        self,
        node_by_id: dict[str, ProjectNodeRecord],
        edge_ids: set[str],
    ) -> None:
        for edge in self.edges:
            if edge.source_node_id not in node_by_id or edge.target_node_id not in node_by_id:
                raise ValueError(f"edge references a missing node: {edge.id}")
        for issue in self.issues:
            if issue.node_id is not None and issue.node_id not in node_by_id:
                raise ValueError(f"issue references a missing node: {issue.id}")
            if issue.edge_id is not None and issue.edge_id not in edge_ids:
                raise ValueError(f"issue references a missing edge: {issue.id}")
        for placement in self.placements:
            if placement.canonical_node_id not in node_by_id:
                raise ValueError(f"placement references a missing canonical node: {placement.id}")
            if (
                placement.container_node_id is not None
                and placement.container_node_id not in node_by_id
            ):
                raise ValueError(f"placement references a missing container: {placement.id}")

    def _validate_specialized_documents(
        self,
        node_by_id: dict[str, ProjectNodeRecord],
    ) -> None:
        self._require_unique_owner_ids("dialogues", self.dialogues)
        self._require_unique_owner_ids("quests", self.quests)
        self._require_sorted_owner_ids("dialogues", self.dialogues)
        self._require_sorted_owner_ids("quests", self.quests)
        dialogue_owner_ids = {owned.node_id for owned in self.dialogues}
        quest_owner_ids = {owned.node_id for owned in self.quests}
        if dialogue_owner_ids != {
            node.id for node in node_by_id.values() if node.type == "Dialogue"
        }:
            raise ValueError("every Dialogue node requires exactly one owned document")
        if quest_owner_ids != {node.id for node in node_by_id.values() if node.type == "Quest"}:
            raise ValueError("every Quest node requires exactly one owned document")
        for owned in self.dialogues:
            node = node_by_id.get(owned.node_id)
            if node is None or node.type != "Dialogue":
                raise ValueError(f"dialogue document owner is not a Dialogue node: {owned.node_id}")
            if any(
                participant_id not in node_by_id
                or node_by_id[participant_id].type != "Character"
                for participant_id in owned.document.participants
            ):
                raise ValueError(f"dialogue document has an invalid participant: {owned.node_id}")
        for owned in self.quests:
            node = node_by_id.get(owned.node_id)
            if node is None or node.type != "Quest":
                raise ValueError(f"quest document owner is not a Quest node: {owned.node_id}")
            typed_references = [
                *(
                    [(owned.document.quest_giver_node_id, "Character")]
                    if owned.document.quest_giver_node_id is not None
                    else []
                ),
                *((reference_id, "Condition") for reference_id in owned.document.prerequisite_node_ids),
                *((reference_id, "Item") for reference_id in owned.document.reward_node_ids),
            ]
            if any(
                reference_id not in node_by_id
                or node_by_id[reference_id].type != expected_type
                for reference_id, expected_type in typed_references
            ):
                raise ValueError(f"quest document has an invalid reference: {owned.node_id}")

    def _validate_flow_references(
        self,
        node_by_id: dict[str, ProjectNodeRecord],
        flow_ids: set[str],
    ) -> None:
        member_pairs = {(member.flow_id, member.node_id) for member in self.story_flow_nodes}
        if len(member_pairs) != len(self.story_flow_nodes):
            raise ValueError("Story Flow contains duplicate node membership")
        presentation_slots = {
            (member.flow_id, member.presentation_order) for member in self.story_flow_nodes
        }
        if len(presentation_slots) != len(self.story_flow_nodes):
            raise ValueError("Story Flow contains duplicate presentation order")
        for flow in self.story_flows:
            if (
                flow.entry_node_id is not None
                and (flow.id, flow.entry_node_id) not in member_pairs
            ):
                raise ValueError(f"Story Flow entry is not a member: {flow.id}")
        for member in self.story_flow_nodes:
            if member.flow_id not in flow_ids or member.node_id not in node_by_id:
                raise ValueError(f"Story Flow membership has a missing owner: {member.id}")
        for transition in self.flow_transitions:
            if transition.flow_id not in flow_ids:
                raise ValueError(f"flow transition references a missing flow: {transition.id}")
            endpoints = {
                (transition.flow_id, transition.source_node_id),
                (transition.flow_id, transition.target_node_id),
            }
            if not endpoints.issubset(member_pairs):
                raise ValueError(f"flow transition endpoints are not members: {transition.id}")
        priority_slots = {
            (transition.flow_id, transition.source_node_id, transition.priority)
            for transition in self.flow_transitions
        }
        if len(priority_slots) != len(self.flow_transitions):
            raise ValueError("Story Flow contains duplicate transition priority")
        boundary_slots = {
            (boundary.flow_id, boundary.scene_node_id)
            for boundary in self.scene_flow_boundaries
        }
        if len(boundary_slots) != len(self.scene_flow_boundaries):
            raise ValueError("Story Flow contains duplicate Scene boundary")
        for boundary in self.scene_flow_boundaries:
            if boundary.flow_id not in flow_ids:
                raise ValueError(f"Scene boundary references a missing flow: {boundary.id}")
            node_ids = {boundary.scene_node_id, boundary.entry_node_id, *boundary.exit_node_ids}
            if not all((boundary.flow_id, node_id) in member_pairs for node_id in node_ids):
                raise ValueError(f"Scene boundary references a non-member: {boundary.id}")

        # P3.10 persistence reuses the strict multi-flow contract rather than
        # creating a second set of call, exit, binding, and cycle invariants.
        ComposableFlowGraph(
            project_id=self.manifest.project_id,
            flows=[
                StoryFlow.model_validate(
                    flow.model_dump(exclude={"normalized_name"})
                )
                for flow in self.story_flows
            ],
            memberships=[
                StoryFlowNode.model_validate(member.model_dump())
                for member in self.story_flow_nodes
            ],
            transitions=[
                FlowTransition.model_validate(transition.model_dump())
                for transition in self.flow_transitions
            ],
            invocations=[
                FlowInvocation.model_validate(invocation.model_dump())
                for invocation in self.flow_invocations
            ],
            exits=[
                FlowExit.model_validate(flow_exit.model_dump())
                for flow_exit in self.flow_exits
            ],
            bindings=[
                FlowExitBinding.model_validate(binding.model_dump())
                for binding in self.flow_exit_bindings
            ],
        )

    def _validate_narrative_state(
        self,
        node_by_id: dict[str, ProjectNodeRecord],
    ) -> None:
        """Reuse the Phase 3.11 cross-record contract for every durable checkpoint."""

        owners: list[NarrativeEffectOwnerRecordRef] = []
        for node in self.nodes:
            owners.append(self._state_owner("node_entry", node.id))
        for transition in self.flow_transitions:
            owners.append(self._state_owner("flow_transition", transition.id))
        for owned in self.dialogues:
            for element in owned.document.elements:
                owners.append(
                    self._state_owner("dialogue_element", element.id, owned.node_id)
                )
                for option in getattr(element, "options", []):
                    owners.append(
                        self._state_owner("dialogue_option", option.id, owned.node_id)
                    )
        for owned in self.quests:
            for stage in owned.document.stages:
                for branch in stage.branches:
                    owners.append(
                        self._state_owner("quest_branch", branch.id, owned.node_id)
                    )
                    if branch.target_stage_id is None:
                        owners.append(
                            self._state_owner("quest_outcome", branch.id, owned.node_id)
                        )
        for invocation in self.flow_invocations:
            owners.append(self._state_owner("flow_invocation", invocation.id))
        for flow_exit in self.flow_exits:
            owners.append(self._state_owner("flow_exit", flow_exit.id))

        NarrativeStateContract(
            project_id=self.manifest.project_id,
            canonical_nodes=[
                NarrativeStateCanonicalNodeRef(
                    id=node.id,
                    project_id=node.project_id,
                    type=node.type,
                )
                for node in self.nodes
            ],
            flows=[
                NarrativeStateFlowRef(id=flow.id, project_id=flow.project_id)
                for flow in self.story_flows
            ],
            owners=owners,
            initial_states=[
                FlowInitialState.model_validate(
                    record.model_dump(exclude={"id", "created_at", "updated_at"})
                )
                for record in self.flow_initial_states
            ],
            effects=[
                NARRATIVE_EFFECT_ADAPTER.validate_python(
                    record.model_dump(exclude={"created_at", "updated_at"})
                )
                for record in self.narrative_effects
            ],
            bindings=[
                NarrativeEffectBinding(
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
                for record in self.narrative_effect_bindings
            ],
        )

    def _state_owner(
        self,
        owner_kind: str,
        owner_id: str,
        context_node_id: str | None = None,
    ) -> NarrativeEffectOwnerRecordRef:
        return NarrativeEffectOwnerRecordRef(
            project_id=self.manifest.project_id,
            owner=NarrativeEffectOwnerRef(
                owner_kind=owner_kind,
                owner_id=owner_id,
                context_node_id=context_node_id,
            ),
        )

    @staticmethod
    def _require_unique_ids(label: str, records: list[Any]) -> None:
        ids = [record.id for record in records]
        if len(ids) != len(set(ids)):
            raise ValueError(f"{label} contains duplicate ids")

    @staticmethod
    def _require_sorted_ids(label: str, records: list[Any]) -> None:
        ids = [record.id for record in records]
        if ids != sorted(ids):
            raise ValueError(f"{label} must use stable id ordering")

    @staticmethod
    def _require_unique_owner_ids(
        label: str,
        records: list[OwnedDialogueDocument] | list[OwnedQuestDocument],
    ) -> None:
        owner_ids = [record.node_id for record in records]
        if len(owner_ids) != len(set(owner_ids)):
            raise ValueError(f"{label} contains duplicate node owners")

    @staticmethod
    def _require_sorted_owner_ids(
        label: str,
        records: list[OwnedDialogueDocument] | list[OwnedQuestDocument],
    ) -> None:
        owner_ids = [record.node_id for record in records]
        if owner_ids != sorted(owner_ids):
            raise ValueError(f"{label} must use stable node ordering")


def project_document_checksum(
    document: ProjectDocument | dict[str, Any],
) -> str:
    """Hash canonical JSON so insertion and dictionary key order cannot affect identity."""

    if isinstance(document, ProjectDocument):
        payload = document.model_dump(mode="json", exclude={"checksum"})
    else:
        payload = dict(document)
        payload.pop("checksum", None)
    encoded = json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256(encoded).hexdigest()


def parse_project_document(payload: dict[str, Any]) -> ProjectDocument:
    """Validate v5 or sequentially migrate intact legacy checkpoints."""

    raw = deepcopy(payload)
    version = raw.get("document_version")
    if version == PROJECT_DOCUMENT_VERSION:
        return ProjectDocument.model_validate(raw)
    if version not in (1, 2, 3, 4):
        raise ValueError(f"unsupported project document version: {version}")
    if raw.get("checksum") != project_document_checksum(raw):
        raise ValueError("legacy project document checksum does not match its content")

    if version == 1:
        for collection in ("flow_invocations", "flow_exits", "flow_exit_bindings"):
            if raw.get(collection):
                raise ValueError(f"project document v1 cannot contain {collection}")
            raw[collection] = []
    if version in (1, 2):
        for collection in (
            "flow_initial_states",
            "narrative_effects",
            "narrative_effect_bindings",
        ):
            if raw.get(collection):
                raise ValueError(f"project document v{version} cannot contain {collection}")
            raw[collection] = []
    if version in (1, 2, 3):
        for collection in ("style_profiles", "scene_style_assignments"):
            if raw.get(collection):
                raise ValueError(f"project document v{version} cannot contain {collection}")
            raw[collection] = []
    if raw.get("agent_memories"):
        raise ValueError(f"project document v{version} cannot contain agent_memories")
    raw["agent_memories"] = []
    raw["document_version"] = PROJECT_DOCUMENT_VERSION
    raw.pop("checksum", None)
    return create_project_document(**raw)


def create_project_document(**payload: Any) -> ProjectDocument:
    """Build and validate a document after deriving its checksum from canonical content."""

    unsigned = {"document_version": PROJECT_DOCUMENT_VERSION, **payload}
    unsigned.pop("checksum", None)
    # Serialize even nested model instances before validation: callers can pass
    # unchecked model_copy/model_construct values that Pydantic would otherwise
    # trust. This replaces the old second complete dump/parse, not its checks.
    raw = DOCUMENT_INPUT_ADAPTER.dump_python(unsigned, mode="python", warnings="error")
    normalized = ProjectDocument.model_validate(
        {**raw, "checksum": "0" * 64},
        context={"skip_checksum": True},
    )
    # Only this derived field bypasses another parse; all caller content and
    # aggregate references above have already passed the complete contract.
    return normalized.model_copy(update={"checksum": project_document_checksum(normalized)})
