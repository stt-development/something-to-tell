from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .engine_tags import EngineTagBindingV1, EngineTagDefinitionV1, LegacyEngineTagRecordV1
from .playback import PlaybackTypedEffect
from .agent_memory import AgentMemoryEntryV1
from .project_document import (
    OwnedDialogueDocument,
    OwnedQuestDocument,
    ProjectEdgeRecord,
    ProjectEngineTagRecord,
    ProjectFlowExitBindingRecord,
    ProjectFlowExitRecord,
    ProjectFlowInvocationRecord,
    ProjectFlowInitialStateRecord,
    ProjectFlowTransitionRecord,
    ProjectIssueRecord,
    ProjectNodeRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
    ProjectPlacementRecord,
    ProjectSceneFlowBoundaryRecord,
    ProjectStoryFlowNodeRecord,
    ProjectStoryFlowRecord,
    ProjectSuggestionRecord,
)
from ..project_format.manifest import ProjectManifestV2
from .style_system import SceneStyleAssignmentV1, StyleProfileV1


class ProjectFixtureValidation(BaseModel):
    """Expected stable counts used to detect truncated or stale sample files."""

    model_config = ConfigDict(extra="forbid")

    canonical_node_count: int = Field(ge=0)
    edge_count: int = Field(ge=0)
    issue_count: int = Field(ge=0)
    placement_count: int = Field(ge=0)
    story_flow_count: int = Field(ge=0)
    dialogue_count: int = Field(ge=0)
    quest_count: int = Field(ge=0)
    flow_invocation_count: int = Field(default=0, ge=0)
    flow_exit_count: int = Field(default=0, ge=0)
    flow_exit_binding_count: int = Field(default=0, ge=0)
    flow_initial_state_count: int = Field(default=0, ge=0)
    narrative_effect_count: int = Field(default=0, ge=0)
    narrative_effect_binding_count: int = Field(default=0, ge=0)
    style_profile_count: int = Field(default=0, ge=0)
    scene_style_assignment_count: int = Field(default=0, ge=0)
    agent_memory_count: int = Field(default=0, ge=0)
    engine_tag_definition_count: int = Field(default=0, ge=0)
    engine_tag_binding_count: int = Field(default=0, ge=0)
    legacy_engine_tag_count: int = Field(default=0, ge=0)


class ProjectFixtureEnvelope(BaseModel):
    """Portable source fixture; generated databases and lock files are excluded."""

    model_config = ConfigDict(extra="forbid")

    fixture_version: Literal[1] = 1
    slug: str = Field(min_length=1)
    manifest: ProjectManifestV2
    project_metadata: dict[str, object] = Field(default_factory=dict)
    nodes: list[ProjectNodeRecord] = Field(default_factory=list)
    edges: list[ProjectEdgeRecord] = Field(default_factory=list)
    issues: list[ProjectIssueRecord] = Field(default_factory=list)
    suggestions: list[ProjectSuggestionRecord] = Field(default_factory=list)
    engine_tags: list[ProjectEngineTagRecord] = Field(default_factory=list)
    # Stable registry collections are explicit fixture data; import must never synthesize them.
    engine_tag_definitions: list[EngineTagDefinitionV1] = Field(default_factory=list)
    engine_tag_bindings: list[EngineTagBindingV1] = Field(default_factory=list)
    legacy_engine_tags: list[LegacyEngineTagRecordV1] = Field(default_factory=list)
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
    playback_effects: list[PlaybackTypedEffect] = Field(default_factory=list)
    expected_validation: ProjectFixtureValidation
