"""Read-only contracts for runtime-owned effective Style resolution."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

STYLE_RESOLUTION_VERSION = 1
STYLE_CONTEXT_VERSION = 1

StyleResolutionStatus = Literal[
    "resolved",
    "unconfigured",
    "context_required",
    "unavailable",
]
StyleResolutionSource = Literal["scene_override", "project_default", "unconfigured"]
StyleResolutionUnavailableReason = Literal["style_profile_missing"]


class StyleResolutionContract(BaseModel):
    """Keep resolver wire values immutable and reject accidental extensions."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class StyleContextRefV1(StyleResolutionContract):
    """Select one Scene, optionally proving the exact originating placement."""

    context_version: Literal[1] = STYLE_CONTEXT_VERSION
    scene_node_id: str = Field(min_length=1)
    placement_id: str | None = Field(default=None, min_length=1)


class StyleSceneContextV1(StyleResolutionContract):
    """Safe Scene metadata shown when the author must disambiguate context."""

    scene_node_id: str = Field(min_length=1)
    scene_title: str = Field(min_length=1, max_length=255)


class EffectiveStyleProfileV1(StyleResolutionContract):
    """Secret-free profile identity returned without provider configuration."""

    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""


class StyleResolutionRequestV1(StyleResolutionContract):
    """Resolve one canonical node through an open project session."""

    request_version: Literal[1] = STYLE_RESOLUTION_VERSION
    session_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    context: StyleContextRefV1 | None = None


class EffectiveStyleResolutionV1(StyleResolutionContract):
    """Complete decision; frontend code must not recompute inheritance."""

    resolution_version: Literal[1] = STYLE_RESOLUTION_VERSION
    target_node_id: str = Field(min_length=1)
    status: StyleResolutionStatus
    source: StyleResolutionSource | None
    scene_context: StyleSceneContextV1 | None = None
    candidate_contexts: tuple[StyleSceneContextV1, ...] = ()
    style_profile_id: str | None = None
    profile: EffectiveStyleProfileV1 | None = None
    unavailable_reason: StyleResolutionUnavailableReason | None = None

    @model_validator(mode="after")
    def validate_state(self) -> "EffectiveStyleResolutionV1":
        """Prevent contradictory states from crossing the runtime boundary."""

        candidate_ids = [item.scene_node_id for item in self.candidate_contexts]
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError("effective style contains duplicate Scene contexts")
        if self.scene_context is not None and self.scene_context.scene_node_id not in candidate_ids:
            raise ValueError("selected Scene must remain in candidate contexts")
        if self.status == "resolved":
            if self.source not in {"scene_override", "project_default"}:
                raise ValueError("resolved style requires an authored source")
            if self.style_profile_id is None or self.profile is None:
                raise ValueError("resolved style requires profile metadata")
            if self.profile.id != self.style_profile_id:
                raise ValueError("resolved profile identity does not match its reference")
        elif self.status == "unconfigured":
            if self.source != "unconfigured" or self.style_profile_id is not None:
                raise ValueError("unconfigured style must not reference a profile")
        elif self.status == "context_required":
            if self.source is not None or self.scene_context is not None:
                raise ValueError("ambiguous style must not choose a context")
            if len(self.candidate_contexts) < 2:
                raise ValueError("ambiguous style requires multiple Scene contexts")
        elif self.status == "unavailable":
            if self.source not in {"scene_override", "project_default"}:
                raise ValueError("unavailable style requires its authored source")
            if self.style_profile_id is None or self.profile is not None:
                raise ValueError("unavailable style must preserve only the missing id")
            if self.unavailable_reason != "style_profile_missing":
                raise ValueError("unavailable style requires a repair reason")
        return self
