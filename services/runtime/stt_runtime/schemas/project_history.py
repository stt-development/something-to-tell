from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .project_session import ProjectSessionResponse

PROJECT_HISTORY_VERSION = 1
PROJECT_HISTORY_CAPACITY = 10


class ProjectHistoryCommandRef(BaseModel):
    """Localized public identity of one reversible user command."""

    model_config = ConfigDict(extra="forbid")

    command_id: str = Field(min_length=1, max_length=128)
    command_kind: str = Field(min_length=1, max_length=64)
    label_key: str = Field(
        min_length=1,
        max_length=128,
        pattern=r"^history\.command\.[A-Za-z0-9_.-]+$",
    )
    label_parameters: dict[str, Any] = Field(default_factory=dict)


class ProjectHistorySummary(BaseModel):
    """Bounded session-local history state safe to expose to the frontend."""

    model_config = ConfigDict(extra="forbid")

    history_version: Literal[1] = PROJECT_HISTORY_VERSION
    history_revision: int = Field(ge=0)
    capacity: Literal[10] = PROJECT_HISTORY_CAPACITY
    undo_depth: int = Field(ge=0, le=PROJECT_HISTORY_CAPACITY)
    redo_depth: int = Field(ge=0, le=PROJECT_HISTORY_CAPACITY)
    next_undo: ProjectHistoryCommandRef | None = None
    next_redo: ProjectHistoryCommandRef | None = None

    @model_validator(mode="after")
    def validate_bounded_depths(self) -> "ProjectHistorySummary":
        if self.undo_depth + self.redo_depth > self.capacity:
            raise ValueError("project history depths exceed bounded capacity")
        if (self.undo_depth == 0) != (self.next_undo is None):
            raise ValueError("next_undo must describe the top undo command")
        if (self.redo_depth == 0) != (self.next_redo is None):
            raise ValueError("next_redo must describe the top redo command")
        return self


class ProjectHistoryMutation(BaseModel):
    """Applies one caller-observed undo or redo boundary."""

    model_config = ConfigDict(extra="forbid")

    expected_history_revision: int = Field(ge=0)


class ProjectHistoryMutationResponse(BaseModel):
    """Returns authoritative project and history state after reversal."""

    model_config = ConfigDict(extra="forbid")

    project: ProjectSessionResponse
    history: ProjectHistorySummary
