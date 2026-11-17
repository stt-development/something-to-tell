from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .playback import (
    PlaybackCanonicalNode,
    PlaybackDefinition,
    PlaybackState,
)


class PlaybackPrepareCommand(BaseModel):
    """Explicit raw inputs for the all-or-nothing definition builder."""

    model_config = ConfigDict(extra="forbid")

    command_version: Literal[1] = 1
    snapshot: dict[str, Any]
    snapshots: list[dict[str, Any]] = Field(default_factory=list)
    canonical_nodes: list[PlaybackCanonicalNode]
    dialogue_documents: dict[str, Any] = Field(default_factory=dict)
    quest_documents: dict[str, Any] = Field(default_factory=dict)
    typed_effects: list[dict[str, Any]] = Field(default_factory=list)
    initial_state: PlaybackState = Field(default_factory=PlaybackState)
    source_revision: str = Field(min_length=1, max_length=128)


class PlaybackStartCommand(BaseModel):
    """Start one ephemeral session from an immutable prepared definition."""

    model_config = ConfigDict(extra="forbid")

    command_version: Literal[1] = 1
    definition: PlaybackDefinition
    initial_state: PlaybackState | None = None
    visit_threshold: int = Field(default=3, ge=1, le=1000)


class PlaybackRevisionCommand(BaseModel):
    """Caller-observed revision required by state-reading session commands."""

    model_config = ConfigDict(extra="forbid")

    command_version: Literal[1] = 1
    source_revision: str = Field(min_length=1, max_length=128)


class PlaybackChooseCommand(PlaybackRevisionCommand):
    transition_id: str | None = Field(default=None, min_length=1)
    dialogue_option_id: str | None = Field(default=None, min_length=1)
    allow_visit_threshold: bool = False

    @model_validator(mode="after")
    def validate_single_choice(self) -> "PlaybackChooseCommand":
        if (self.transition_id is None) == (self.dialogue_option_id is None):
            raise ValueError("playback command requires exactly one transition or Dialogue option")
        return self


class PlaybackRestartCommand(BaseModel):
    """Reset a session, optionally replacing it with a fresh source revision."""

    model_config = ConfigDict(extra="forbid")

    command_version: Literal[1] = 1
    definition: PlaybackDefinition
    initial_state: PlaybackState | None = None
    visit_threshold: int | None = Field(default=None, ge=1, le=1000)
