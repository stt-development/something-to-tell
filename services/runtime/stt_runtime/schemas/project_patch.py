from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..project_format.manifest import ProjectManifestV2
from .project_document import (
    OwnedDialogueDocument,
    OwnedQuestDocument,
    ProjectEdgeRecord,
    ProjectEngineTagRecord,
    ProjectFlowExitBindingRecord,
    ProjectFlowExitRecord,
    ProjectFlowInitialStateRecord,
    ProjectFlowInvocationRecord,
    ProjectFlowTransitionRecord,
    ProjectIssueRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
    ProjectNodeRecord,
    ProjectPlacementRecord,
    ProjectSceneFlowBoundaryRecord,
    ProjectStoryFlowNodeRecord,
    ProjectStoryFlowRecord,
    ProjectSuggestionRecord,
)
from .style_system import SceneStyleAssignmentV1, StyleProfileV1
from .agent_memory import AgentMemoryEntryV1
from .engine_tags import (
    EngineTagBindingV1,
    EngineTagDefinitionV1,
    LegacyEngineTagRecordV1,
)

PROJECT_PATCH_VERSION = 1
PROJECT_RECORD_COLLECTIONS = (
    "nodes",
    "edges",
    "issues",
    "suggestions",
    "engine_tags",
    "engine_tag_definitions",
    "engine_tag_bindings",
    "legacy_engine_tags",
    "placements",
    "dialogues",
    "quests",
    "story_flows",
    "story_flow_nodes",
    "flow_transitions",
    "scene_flow_boundaries",
    "flow_invocations",
    "flow_exits",
    "flow_exit_bindings",
    "flow_initial_states",
    "narrative_effects",
    "narrative_effect_bindings",
    "style_profiles",
    "scene_style_assignments",
    "agent_memories",
)

ProjectRecordCollection = Literal[
    "nodes",
    "edges",
    "issues",
    "suggestions",
    "engine_tags",
    "engine_tag_definitions",
    "engine_tag_bindings",
    "legacy_engine_tags",
    "placements",
    "dialogues",
    "quests",
    "story_flows",
    "story_flow_nodes",
    "flow_transitions",
    "scene_flow_boundaries",
    "flow_invocations",
    "flow_exits",
    "flow_exit_bindings",
    "flow_initial_states",
    "narrative_effects",
    "narrative_effect_bindings",
    "style_profiles",
    "scene_style_assignments",
    "agent_memories",
]

# This adapter map is owned by ProjectDocument. Keeping it beside the patch
# schema makes every mirrored collection validate before history can retain it.
PROJECT_RECORD_MODELS = {
    "nodes": ProjectNodeRecord,
    "edges": ProjectEdgeRecord,
    "issues": ProjectIssueRecord,
    "suggestions": ProjectSuggestionRecord,
    "engine_tags": ProjectEngineTagRecord,
    "engine_tag_definitions": EngineTagDefinitionV1,
    "engine_tag_bindings": EngineTagBindingV1,
    "legacy_engine_tags": LegacyEngineTagRecordV1,
    "placements": ProjectPlacementRecord,
    "dialogues": OwnedDialogueDocument,
    "quests": OwnedQuestDocument,
    "story_flows": ProjectStoryFlowRecord,
    "story_flow_nodes": ProjectStoryFlowNodeRecord,
    "flow_transitions": ProjectFlowTransitionRecord,
    "scene_flow_boundaries": ProjectSceneFlowBoundaryRecord,
    "flow_invocations": ProjectFlowInvocationRecord,
    "flow_exits": ProjectFlowExitRecord,
    "flow_exit_bindings": ProjectFlowExitBindingRecord,
    "flow_initial_states": ProjectFlowInitialStateRecord,
    "narrative_effects": ProjectNarrativeEffectRecord,
    "narrative_effect_bindings": ProjectNarrativeEffectBindingRecord,
    "style_profiles": StyleProfileV1,
    "scene_style_assignments": SceneStyleAssignmentV1,
    "agent_memories": AgentMemoryEntryV1,
}


def project_record_id(collection: ProjectRecordCollection, record: dict[str, Any]) -> str:
    """Return the stable owner key used by one ProjectDocument collection."""

    key = "node_id" if collection in ("dialogues", "quests") else "id"
    value = record.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{collection} record requires a non-empty {key}")
    return value


class PutProjectRecordOperation(BaseModel):
    """Create or replace one typed record at its stable collection key."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["put_record"] = "put_record"
    collection: ProjectRecordCollection
    record_id: str = Field(min_length=1)
    record: dict[str, Any]

    @model_validator(mode="after")
    def validate_record(self) -> "PutProjectRecordOperation":
        model = PROJECT_RECORD_MODELS[self.collection]
        normalized = model.model_validate(self.record).model_dump(mode="json")
        if project_record_id(self.collection, normalized) != self.record_id:
            raise ValueError("record_id does not match the typed record identity")
        return self


class RemoveProjectRecordOperation(BaseModel):
    """Remove one typed record by its stable collection key."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["remove_record"] = "remove_record"
    collection: ProjectRecordCollection
    record_id: str = Field(min_length=1)


class ReplaceProjectMetadataOperation(BaseModel):
    """Replace the complete storage-neutral project metadata object."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["replace_project_metadata"] = "replace_project_metadata"
    value: dict[str, Any]


class ReplaceManifestOperation(BaseModel):
    """Replace only manifest fields accepted as reversible authoring state."""

    model_config = ConfigDict(extra="forbid")

    op: Literal["replace_manifest"] = "replace_manifest"
    manifest: ProjectManifestV2


ProjectPatchOperation = Annotated[
    PutProjectRecordOperation
    | RemoveProjectRecordOperation
    | ReplaceProjectMetadataOperation
    | ReplaceManifestOperation,
    Field(discriminator="op"),
]


class ProjectPatch(BaseModel):
    """Deterministic storage-neutral delta between two complete project documents."""

    model_config = ConfigDict(extra="forbid")

    patch_version: Literal[1] = PROJECT_PATCH_VERSION
    patch_id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    source_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    target_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    operations: list[ProjectPatchOperation] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_operation_order(self) -> "ProjectPatch":
        keys = [_operation_sort_key(operation) for operation in self.operations]
        if keys != sorted(keys):
            raise ValueError("project patch operations must use deterministic ordering")
        if len(keys) != len(set(keys)):
            raise ValueError("project patch contains duplicate operation targets")
        if bool(self.operations) == (self.source_checksum == self.target_checksum):
            raise ValueError("project patch operations and checksums disagree about a no-op")
        return self


def _operation_sort_key(operation: ProjectPatchOperation) -> tuple[int, str]:
    if isinstance(operation, ReplaceManifestOperation):
        return (0, "")
    if isinstance(operation, ReplaceProjectMetadataOperation):
        return (1, "")
    return (2 + PROJECT_RECORD_COLLECTIONS.index(operation.collection), operation.record_id)
