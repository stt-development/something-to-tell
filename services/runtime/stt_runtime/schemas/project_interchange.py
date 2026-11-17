from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from .composable_story_flow import FlowExit, FlowExitBinding, FlowInvocation
from .project_document import (
    ProjectFlowInitialStateRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
)
from .story_flow import FlowTransition, SceneFlowBoundary, StoryFlow, StoryFlowNode


class ProjectStoryFlowSection(BaseModel):
    """Versioned Story Flow extension for portable project interchange."""

    model_config = ConfigDict(extra="forbid")

    section_version: Literal[1, 2] = 2
    project_id: str = Field(min_length=1)
    flows: list[StoryFlow] = Field(default_factory=list)
    nodes: list[StoryFlowNode] = Field(default_factory=list)
    transitions: list[FlowTransition] = Field(default_factory=list)
    scene_boundaries: list[SceneFlowBoundary] = Field(default_factory=list)
    invocations: list[FlowInvocation] = Field(default_factory=list)
    exits: list[FlowExit] = Field(default_factory=list)
    exit_bindings: list[FlowExitBinding] = Field(default_factory=list)


class ProjectNarrativeStateSection(BaseModel):
    """Versioned portable section for explicit initial state and authored effects."""

    model_config = ConfigDict(extra="forbid")

    section_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    initial_states: list[ProjectFlowInitialStateRecord] = Field(default_factory=list)
    effects: list[ProjectNarrativeEffectRecord] = Field(default_factory=list)
    bindings: list[ProjectNarrativeEffectBindingRecord] = Field(default_factory=list)


class ProjectInterchangeDocument(BaseModel):
    """Extensible project interchange envelope; older documents omit sections."""

    model_config = ConfigDict(extra="forbid")

    format_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    story_flows: ProjectStoryFlowSection | None = None
    narrative_state: ProjectNarrativeStateSection | None = None
