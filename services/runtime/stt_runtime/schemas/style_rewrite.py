"""Strict process-local contracts for bounded Style Rewriter runs."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .agent_memory import ApprovedAgentMemoryV1
from .project_history import ProjectHistoryMutationResponse
from .project_patch import ProjectPatch

STYLE_REWRITE_VERSION = 1
STYLE_REWRITE_MAX_SOURCE_CHARACTERS = 32_000
STYLE_REWRITE_MAX_INSTRUCTION_CHARACTERS = 4_000
STYLE_REWRITE_MAX_EXPLANATION_CHARACTERS = 4_000
STYLE_REWRITE_MAX_RISKS = 12
STYLE_REWRITE_MAX_TRAITS = 48
StyleRewriteTrait = Annotated[str, Field(min_length=1, max_length=200)]
StyleRewriteRisk = Annotated[str, Field(min_length=1, max_length=1_000)]


class StyleRewriteContract(BaseModel):
    """Reject unknown fields so provider and browser boundaries stay explicit."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class NodeTextTargetV1(StyleRewriteContract):
    """Address the common Text projection of one canonical node."""

    kind: Literal["node_text"]
    node_id: str = Field(min_length=1, max_length=128)


class DialogueFieldTargetV1(StyleRewriteContract):
    """Address exactly one authored Dialogue line, prompt, or option."""

    kind: Literal["dialogue_field"]
    node_id: str = Field(min_length=1, max_length=128)
    field_kind: Literal["line_text", "choice_prompt", "option_text"]
    element_id: str = Field(min_length=1, max_length=128)
    option_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_option_identity(self) -> "DialogueFieldTargetV1":
        requires_option = self.field_kind == "option_text"
        if requires_option != (self.option_id is not None):
            raise ValueError("option_text alone requires option_id")
        return self


class QuestFieldTargetV1(StyleRewriteContract):
    """Address the objective or one exact stage description in a Quest document."""

    kind: Literal["quest_field"]
    node_id: str = Field(min_length=1, max_length=128)
    field_kind: Literal["objective", "stage_description"]
    stage_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_stage_identity(self) -> "QuestFieldTargetV1":
        requires_stage = self.field_kind == "stage_description"
        if requires_stage != (self.stage_id is not None):
            raise ValueError("stage_description alone requires stage_id")
        return self


StyleRewriteTargetV1 = Annotated[
    NodeTextTargetV1 | DialogueFieldTargetV1 | QuestFieldTargetV1,
    Field(discriminator="kind"),
]


class StyleRewriteRequestV1(StyleRewriteContract):
    """Checksum-bound author consent to send one bounded text target."""

    request_version: Literal[1] = STYLE_REWRITE_VERSION
    session_id: str = Field(min_length=1)
    target: StyleRewriteTargetV1
    style_context: "StyleContextRefV1 | None" = None
    observed_source_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_history_revision: int = Field(ge=0)
    additional_instructions: str = Field(
        default="", max_length=STYLE_REWRITE_MAX_INSTRUCTION_CHARACTERS
    )
    content_consent: Literal[True]


class StyleRewriteRetryV1(StyleRewriteContract):
    """Fresh author intent for a new run linked to an immutable predecessor."""

    retry_version: Literal[1] = STYLE_REWRITE_VERSION
    observed_source_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_history_revision: int = Field(ge=0)
    additional_instructions: str = Field(
        default="", max_length=STYLE_REWRITE_MAX_INSTRUCTION_CHARACTERS
    )
    content_consent: Literal[True]


class StyleRewriteAdjacentLineV1(StyleRewriteContract):
    """Small ordered Dialogue excerpt around the exact target."""

    element_id: str
    kind: Literal["line", "choice"]
    speaker_name: str | None = None
    text: str = Field(max_length=1_000)


class StyleRewriteContextPackageV1(StyleRewriteContract):
    """Inspectable provider payload that cannot contain the project document."""

    context_version: Literal[1] = STYLE_REWRITE_VERSION
    project_id: str
    content_locale: Literal["en", "ru"]
    target: StyleRewriteTargetV1
    source_text: str = Field(min_length=1, max_length=STYLE_REWRITE_MAX_SOURCE_CHARACTERS)
    source_text_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    document_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    history_revision: int = Field(ge=0)
    target_title: str = Field(min_length=1, max_length=500)
    scene_title: str | None = Field(default=None, max_length=500)
    speaker_name: str | None = Field(default=None, max_length=500)
    participant_names: tuple[str, ...] = Field(default=(), max_length=24)
    adjacent_lines: tuple[StyleRewriteAdjacentLineV1, ...] = Field(
        default=(), max_length=8
    )
    style_profile_id: str
    style_profile_name: str = Field(min_length=1, max_length=120)
    style_guidance: str = Field(min_length=1, max_length=12_000)
    style_traits: tuple[str, ...] = Field(default=(), max_length=STYLE_REWRITE_MAX_TRAITS)
    positive_examples: tuple[str, ...] = Field(default=(), max_length=12)
    approved_memory: ApprovedAgentMemoryV1
    additional_instructions: str = Field(max_length=STYLE_REWRITE_MAX_INSTRUCTION_CHARACTERS)
    omitted_adjacent_line_count: int = Field(default=0, ge=0)


class StyleProviderDisclosureV1(StyleRewriteContract):
    """Secret-free machine configuration recorded with generated prose."""

    provider: Literal["openai", "google_gemini", "anthropic"]
    provider_profile_id: str
    model_id: str
    content_locale: Literal["en", "ru"]


class StyleProtectedValueResultV1(StyleRewriteContract):
    """One authored fact-like token checked independently from agent claims."""

    kind: Literal["name", "state_reference", "quantity", "quoted_term"]
    value: str = Field(min_length=1, max_length=500)
    preserved: bool


class StyleTextDiffSegmentV1(StyleRewriteContract):
    """Ordered text fragment for a safe Before/After/Changes presentation."""

    kind: Literal["equal", "delete", "insert"]
    text: str = Field(min_length=1, max_length=32_000)


class StyleRewriteValidationDiagnosticV1(StyleRewriteContract):
    """Localized validator-owned reason separate from provider explanation."""

    code: str = Field(min_length=1, max_length=128)
    message_key: str = Field(min_length=1, max_length=160)
    blocking: bool
    parameters: dict[str, object] = Field(default_factory=dict)


class StyleRecommendationV1(StyleRewriteContract):
    """Provider result before factual and patch validation in P6-006."""

    recommendation_version: Literal[1] = STYLE_REWRITE_VERSION
    id: str
    source_text: str = Field(max_length=STYLE_REWRITE_MAX_SOURCE_CHARACTERS)
    rewritten_text: str = Field(min_length=1, max_length=STYLE_REWRITE_MAX_SOURCE_CHARACTERS)
    explanation: str = Field(min_length=1, max_length=STYLE_REWRITE_MAX_EXPLANATION_CHARACTERS)
    applied_traits: tuple[StyleRewriteTrait, ...] = Field(default=(), max_length=STYLE_REWRITE_MAX_TRAITS)
    factual_risks: tuple[StyleRewriteRisk, ...] = Field(default=(), max_length=STYLE_REWRITE_MAX_RISKS)
    protected_value_results: tuple[StyleProtectedValueResultV1, ...] = ()
    provider_disclosure: StyleProviderDisclosureV1
    patch: ProjectPatch | None = None
    diff: tuple[StyleTextDiffSegmentV1, ...] = ()
    validation_status: Literal["pending", "valid", "blocked"] = "pending"
    validation_diagnostics: tuple[StyleRewriteValidationDiagnosticV1, ...] = ()

    @model_validator(mode="after")
    def validate_reviewability(self) -> "StyleRecommendationV1":
        """Only a locally validated recommendation may expose an approvable patch."""

        blocking = any(item.blocking for item in self.validation_diagnostics)
        if self.validation_status == "pending" and (
            self.patch is not None or self.diff or self.protected_value_results
        ):
            raise ValueError("pending style recommendation cannot expose validation output")
        if self.validation_status == "valid" and (self.patch is None or blocking):
            raise ValueError("valid style recommendation requires a non-blocked patch")
        if self.validation_status == "blocked" and (self.patch is not None or not blocking):
            raise ValueError("blocked style recommendation requires blocking diagnostics")
        return self


StyleRewriteRunStatus = Literal[
    "queued", "running", "completed", "failed", "cancelled", "stale"
]


class StyleRewriteRunV1(StyleRewriteContract):
    """Observable immutable-snapshot operation retained only for an open session."""

    run_version: Literal[1] = STYLE_REWRITE_VERSION
    id: str
    project_id: str
    request: StyleRewriteRequestV1
    style_profile_id: str
    style_profile_name: str
    source_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_text_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    history_revision: int = Field(ge=0)
    predecessor_run_id: str | None = None
    status: StyleRewriteRunStatus
    progress: int = Field(ge=0, le=100)
    recommendation: StyleRecommendationV1 | None = None
    error_code: str | None = None
    started_at: datetime
    completed_at: datetime | None = None

    @model_validator(mode="after")
    def validate_lifecycle(self) -> "StyleRewriteRunV1":
        """Keep progress, result, and terminal metadata mutually consistent."""

        terminal = self.status in {"completed", "failed", "cancelled", "stale"}
        if terminal != (self.completed_at is not None) or terminal != (self.progress == 100):
            raise ValueError("style rewrite lifecycle metadata is inconsistent")
        if self.status == "completed" and (
            self.recommendation is None or self.error_code is not None
        ):
            raise ValueError("completed style rewrite requires only a recommendation")
        if self.status in {"failed", "cancelled"} and (
            self.recommendation is not None or self.error_code is None
        ):
            raise ValueError("failed style rewrite requires only an error")
        if not terminal and (self.recommendation is not None or self.error_code is not None):
            raise ValueError("active style rewrite cannot contain terminal output")
        return self


class StyleRewriteResponseV1(StyleRewriteContract):
    response_version: Literal[1] = STYLE_REWRITE_VERSION
    run: StyleRewriteRunV1


class StyleRewriteApprovalV1(StyleRewriteContract):
    """Bind approval to the exact validated recommendation and history head."""

    approval_version: Literal[1] = STYLE_REWRITE_VERSION
    recommendation_id: str = Field(min_length=1, max_length=160)
    source_checksum: str = Field(pattern=r"^[0-9a-f]{64}$")
    expected_history_revision: int = Field(ge=0)


class StyleRewriteApprovalResponseV1(StyleRewriteContract):
    """Return canonical authoring state and explicitly suggest, never run, Canon."""

    response_version: Literal[1] = STYLE_REWRITE_VERSION
    result: ProjectHistoryMutationResponse
    run: StyleRewriteRunV1
    canon_check_recommended: Literal[True] = True


# Resolve the cross-module type only after all local contracts exist.
from .style_resolution import StyleContextRefV1  # noqa: E402

StyleRewriteRequestV1.model_rebuild()
