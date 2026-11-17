"""Runtime-owned Phase 5.5 contracts mirrored by packages/contracts."""

from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from .agent_memory import ApprovedAgentMemoryV1
from .canon_check import CanonEvidenceRef, CanonOwnerRef
from .impact_analysis import ImpactFinding, ImpactSummary
from .project_patch import ProjectPatch

IMPACT_RESOLUTION_LIMITS_VERSION = 1
IMPACT_RESOLUTION_REQUEST_VERSION = 1
IMPACT_RESOLUTION_CONTEXT_VERSION = 1
IMPACT_RESOLUTION_EXPLANATION_VERSION = 1
IMPACT_RESOLUTION_ALTERNATIVE_VERSION = 1
IMPACT_RESOLUTION_VALIDATION_VERSION = 1
IMPACT_RESOLUTION_COMPARISON_VERSION = 1
IMPACT_RESOLUTION_DIAGNOSTIC_VERSION = 1
IMPACT_RESOLUTION_RUN_VERSION = 1
IMPACT_RESOLUTION_RESPONSE_VERSION = 1
IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION = 1
IMPACT_RESOLUTION_VISUAL_PROJECTION_VERSION = 1
IMPACT_RESOLUTION_DECISION_VERSION = 1
IMPACT_RESOLUTION_REVIEW_COMMAND_VERSION = 1
IMPACT_RESOLUTION_DRAFT_EDIT_VERSION = 1

IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES = 3
IMPACT_RESOLUTION_MAX_ALTERNATIVES = 3
IMPACT_RESOLUTION_MAX_FINDINGS = 50
IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES = 200
IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS = 120_000
IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS = 200
IMPACT_RESOLUTION_MAX_VISUAL_CHANGES = 500

_CHECKSUM = re.compile(r"^[0-9a-f]{64}$")
_FIELD_PATH = re.compile(r"^[a-zA-Z0-9_]+(?:[.\[][a-zA-Z0-9_\]-]+)*$")

ImpactResolutionProviderSource = Literal["project_default", "override"]
ImpactResolutionRunStatus = Literal[
    "queued", "running", "completed", "failed", "cancelled", "stale"
]
ImpactSolutionValidationStatus = Literal[
    "pending", "valid", "invalid", "explanation_only"
]
ImpactResolutionDiagnosticSeverity = Literal["info", "warning", "error"]
ImpactResolutionDecisionValue = Literal["approved", "rejected"]
ImpactVisualChangeKind = Literal["add", "remove", "modify", "move", "unchanged"]
ImpactVisualSurface = Literal[
    "graph",
    "composition",
    "flow",
    "story",
    "dialogue",
    "quest",
    "temporal",
    "canon",
]
ImpactVisualMode = Literal["before", "after", "changes"]
ImpactResolutionErrorCode = Literal[
    "impact_resolution_limit_invalid",
    "impact_resolution_consent_required",
    "impact_resolution_provider_invalid",
    "impact_resolution_provider_unavailable",
    "impact_resolution_provider_timeout",
    "impact_resolution_model_incompatible",
    "impact_resolution_run_not_found",
    "impact_resolution_run_capacity_reached",
    "impact_resolution_owner_invalid",
    "impact_resolution_finding_invalid",
    "impact_resolution_patch_invalid",
    "impact_resolution_patch_stale",
    "impact_resolution_operation_unsupported",
    "impact_resolution_response_invalid",
    "impact_resolution_visual_diff_invalid",
    "impact_resolution_run_stale",
    "impact_resolution_run_cancelled",
    "impact_resolution_run_failed",
]

ResolutionText = Annotated[str, Field(min_length=1, max_length=2_000)]
ResolutionTitle = Annotated[str, Field(min_length=1, max_length=200)]
ResolutionFieldPath = Annotated[str, Field(min_length=1, max_length=256)]


class ImpactResolutionContractModel(BaseModel):
    """Reject unknown provider fields and prevent post-validation mutation."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ImpactResolutionLimits(ImpactResolutionContractModel):
    """Versioned hard limits applied before any provider request is assembled."""

    limits_version: Literal[1] = IMPACT_RESOLUTION_LIMITS_VERSION
    max_findings: int = IMPACT_RESOLUTION_MAX_FINDINGS
    max_context_resources: int = IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES
    max_context_characters: int = IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS
    max_patch_operations: int = IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS
    max_visual_changes: int = IMPACT_RESOLUTION_MAX_VISUAL_CHANGES

    @field_validator(
        "max_findings",
        "max_context_resources",
        "max_context_characters",
        "max_patch_operations",
        "max_visual_changes",
        mode="before",
    )
    @classmethod
    def validate_bound(cls, value: Any, info: Any) -> int:
        maxima = {
            "max_findings": IMPACT_RESOLUTION_MAX_FINDINGS,
            "max_context_resources": IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
            "max_context_characters": IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
            "max_patch_operations": IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
            "max_visual_changes": IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
        }
        return _bounded_integer(value, 1, maxima[info.field_name], info.field_name)


class ImpactResolutionRequest(ImpactResolutionContractModel):
    """Explicit request for optional enrichment of one completed Impact run."""

    request_version: Literal[1] = IMPACT_RESOLUTION_REQUEST_VERSION
    impact_run_id: str = Field(min_length=1, max_length=128)
    finding_ids: tuple[str, ...] = Field(
        min_length=1, max_length=IMPACT_RESOLUTION_MAX_FINDINGS
    )
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    provider_source: ImpactResolutionProviderSource
    provider_profile_id: str | None = Field(default=None, min_length=1, max_length=128)
    model_id: str = Field(min_length=1, max_length=256)
    content_consent: Literal[True]
    requested_alternative_count: int = IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES
    include_rejected: bool = False
    limits: ImpactResolutionLimits = Field(default_factory=ImpactResolutionLimits)

    @field_validator("finding_ids")
    @classmethod
    def normalize_findings(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(_CHECKSUM.fullmatch(value) is None for value in values):
            raise _error("impact_resolution_finding_invalid", values)
        return tuple(sorted(set(values)))

    @field_validator("content_consent", mode="before")
    @classmethod
    def require_consent(cls, value: Any) -> Any:
        if value is not True:
            raise _error("impact_resolution_consent_required", value)
        return value

    @field_validator("requested_alternative_count", mode="before")
    @classmethod
    def validate_alternative_count(cls, value: Any) -> int:
        return _bounded_integer(
            value,
            1,
            IMPACT_RESOLUTION_MAX_ALTERNATIVES,
            "requested_alternative_count",
        )

    @model_validator(mode="after")
    def validate_provider_source(self) -> "ImpactResolutionRequest":
        if self.provider_source == "override" and self.provider_profile_id is None:
            raise _error("impact_resolution_provider_invalid", self.provider_source)
        if self.provider_source == "project_default" and self.provider_profile_id is not None:
            raise _error("impact_resolution_provider_invalid", self.provider_source)
        if len(self.finding_ids) > self.limits.max_findings:
            raise _error("impact_resolution_limit_invalid", len(self.finding_ids), field="finding_ids")
        return self


class ImpactResolutionContextResource(ImpactResolutionContractModel):
    """Minimal authored fields for one resource cited by deterministic evidence."""

    resource: CanonOwnerRef
    domain: Literal[
        "graph", "composition", "flow", "dialogue", "quest", "temporal", "playback", "canon"
    ]
    title: str | None = Field(default=None, min_length=1, max_length=500)
    authored_fields: dict[str, Any] = Field(default_factory=dict)
    evidence: tuple[CanonEvidenceRef, ...] = ()

    @field_validator("evidence")
    @classmethod
    def normalize_evidence(
        cls, values: tuple[CanonEvidenceRef, ...]
    ) -> tuple[CanonEvidenceRef, ...]:
        return tuple(sorted(values, key=CanonEvidenceRef.stable_key))

    @model_validator(mode="after")
    def bound_authored_fields(self) -> "ImpactResolutionContextResource":
        if len(_canonical_json(self.authored_fields)) > 8_000:
            raise _error(
                "impact_resolution_limit_invalid",
                len(_canonical_json(self.authored_fields)),
                field="authored_fields",
            )
        return self


class ImpactResolutionGlossaryEntry(ImpactResolutionContractModel):
    resource: CanonOwnerRef
    label: str = Field(min_length=1, max_length=500)
    kind: str = Field(min_length=1, max_length=100)


class ImpactResolutionContextPackage(ImpactResolutionContractModel):
    """Inspectable provider payload that deliberately excludes ProjectDocument."""

    context_version: Literal[1] = IMPACT_RESOLUTION_CONTEXT_VERSION
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    history_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    approved_memory: ApprovedAgentMemoryV1
    request: ImpactResolutionRequest
    findings: tuple[ImpactFinding, ...] = Field(
        min_length=1, max_length=IMPACT_RESOLUTION_MAX_FINDINGS
    )
    resources: tuple[ImpactResolutionContextResource, ...] = Field(
        max_length=IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES
    )
    glossary: tuple[ImpactResolutionGlossaryEntry, ...] = Field(
        default=(), max_length=IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES
    )
    omitted_resource_count: int = Field(default=0, ge=0)
    omitted_domains: tuple[str, ...] = ()

    @field_validator("findings")
    @classmethod
    def normalize_finding_order(
        cls, values: tuple[ImpactFinding, ...]
    ) -> tuple[ImpactFinding, ...]:
        keyed = {item.id: item for item in values}
        if len(keyed) != len(values):
            raise _error("impact_resolution_finding_invalid", "duplicate")
        return tuple(sorted(values, key=ImpactFinding.stable_order_key))

    @field_validator("resources")
    @classmethod
    def normalize_resources(
        cls, values: tuple[ImpactResolutionContextResource, ...]
    ) -> tuple[ImpactResolutionContextResource, ...]:
        return tuple(sorted(values, key=lambda item: (item.domain, item.resource.stable_key())))

    @field_validator("glossary")
    @classmethod
    def normalize_glossary(
        cls, values: tuple[ImpactResolutionGlossaryEntry, ...]
    ) -> tuple[ImpactResolutionGlossaryEntry, ...]:
        return tuple(sorted(values, key=lambda item: item.resource.stable_key()))

    @field_validator("omitted_domains")
    @classmethod
    def normalize_omitted_domains(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        allowed = {"graph", "composition", "flow", "dialogue", "quest", "temporal", "playback", "canon"}
        if any(value not in allowed for value in values):
            raise _error("impact_resolution_response_invalid", values)
        return tuple(sorted(set(values)))

    @model_validator(mode="after")
    def validate_context_identity_and_limits(self) -> "ImpactResolutionContextPackage":
        if self.source_checksum != self.request.source_checksum:
            raise _error("impact_resolution_run_stale", self.source_checksum)
        if {item.id for item in self.findings} != set(self.request.finding_ids):
            raise _error("impact_resolution_finding_invalid", "selection_mismatch")
        resource_keys = [item.resource.stable_key() for item in self.resources]
        if len(resource_keys) != len(set(resource_keys)):
            raise _error("impact_resolution_owner_invalid", "duplicate")
        if len(self.resources) > self.request.limits.max_context_resources:
            raise _error(
                "impact_resolution_limit_invalid",
                len(self.resources),
                field="resources",
            )
        character_count = len(_canonical_json(self.model_dump(mode="json")))
        if character_count > self.request.limits.max_context_characters:
            raise _error(
                "impact_resolution_limit_invalid",
                character_count,
                field="context_characters",
            )
        return self


class ImpactResolutionExplanation(ImpactResolutionContractModel):
    explanation_version: Literal[1] = IMPACT_RESOLUTION_EXPLANATION_VERSION
    summary: str = Field(min_length=1, max_length=4_000)
    why_it_matters: tuple[ResolutionText, ...] = Field(default=(), max_length=20)
    assumptions: tuple[ResolutionText, ...] = Field(default=(), max_length=20)
    limitations: tuple[ResolutionText, ...] = Field(default=(), max_length=20)
    cited_evidence: tuple[CanonEvidenceRef, ...] = Field(default=(), max_length=100)

    @field_validator("cited_evidence")
    @classmethod
    def normalize_citations(
        cls, values: tuple[CanonEvidenceRef, ...]
    ) -> tuple[CanonEvidenceRef, ...]:
        keyed = {item.stable_key(): item for item in values}
        return tuple(keyed[key] for key in sorted(keyed))


class ImpactResolutionDiagnostic(ImpactResolutionContractModel):
    diagnostic_version: Literal[1] = IMPACT_RESOLUTION_DIAGNOSTIC_VERSION
    code: ImpactResolutionErrorCode
    severity: ImpactResolutionDiagnosticSeverity = "error"
    message_key: str = Field(min_length=1, max_length=300)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ImpactResolutionDeltaCounts(ImpactResolutionContractModel):
    added: int = Field(default=0, ge=0)
    removed: int = Field(default=0, ge=0)
    changed: int = Field(default=0, ge=0)


class ImpactResolutionComparison(ImpactResolutionContractModel):
    """Deterministic before/after summary attached only to a validated patch."""

    comparison_version: Literal[1] = IMPACT_RESOLUTION_COMPARISON_VERSION
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    target_checksum: str = Field(pattern=_CHECKSUM.pattern)
    impact_before: ImpactSummary
    impact_after: ImpactSummary
    dependencies: ImpactResolutionDeltaCounts = Field(
        default_factory=ImpactResolutionDeltaCounts
    )
    reachability: ImpactResolutionDeltaCounts = Field(
        default_factory=ImpactResolutionDeltaCounts
    )
    state_paths: ImpactResolutionDeltaCounts = Field(
        default_factory=ImpactResolutionDeltaCounts
    )
    canon_facts: ImpactResolutionDeltaCounts = Field(
        default_factory=ImpactResolutionDeltaCounts
    )
    affected_issue_count: int = Field(default=0, ge=0)


class ImpactSolutionValidation(ImpactResolutionContractModel):
    validation_version: Literal[1] = IMPACT_RESOLUTION_VALIDATION_VERSION
    status: ImpactSolutionValidationStatus
    diagnostics: tuple[ImpactResolutionDiagnostic, ...] = ()

    @model_validator(mode="after")
    def validate_diagnostic_state(self) -> "ImpactSolutionValidation":
        has_error = any(item.severity == "error" for item in self.diagnostics)
        if self.status == "invalid" and not has_error:
            raise ValueError("invalid impact solution requires an error diagnostic")
        if self.status in {"valid", "explanation_only"} and has_error:
            raise ValueError("actionable impact solution cannot retain error diagnostics")
        return self


class ImpactSolutionAlternative(ImpactResolutionContractModel):
    """One independently reviewable solution; provider wording is not identity."""

    alternative_version: Literal[1] = IMPACT_RESOLUTION_ALTERNATIVE_VERSION
    id: str = Field(min_length=1, max_length=128)
    finding_ids: tuple[str, ...] = Field(
        min_length=1, max_length=IMPACT_RESOLUTION_MAX_FINDINGS
    )
    semantic_fingerprint: str | None = Field(default=None, pattern=_CHECKSUM.pattern)
    title: ResolutionTitle
    rationale: str = Field(min_length=1, max_length=4_000)
    tradeoffs: tuple[ResolutionText, ...] = Field(default=(), max_length=20)
    expected_outcomes: tuple[ResolutionText, ...] = Field(default=(), max_length=20)
    patch: ProjectPatch | None = None
    validation: ImpactSolutionValidation
    comparison: ImpactResolutionComparison | None = None

    @field_validator("finding_ids")
    @classmethod
    def normalize_finding_ids(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(_CHECKSUM.fullmatch(value) is None for value in values):
            raise _error("impact_resolution_finding_invalid", values)
        return tuple(sorted(set(values)))

    @model_validator(mode="after")
    def validate_patch_boundary(self) -> "ImpactSolutionAlternative":
        if self.patch is None:
            if self.semantic_fingerprint is not None or self.comparison is not None:
                raise _error("impact_resolution_patch_invalid", "explanation_only")
            if self.validation.status != "explanation_only":
                raise _error("impact_resolution_patch_invalid", self.validation.status)
            return self
        if not self.patch.operations:
            raise _error("impact_resolution_patch_invalid", "no_op")
        expected = impact_solution_fingerprint(self.finding_ids, self.patch)
        if self.semantic_fingerprint != expected:
            raise _error("impact_resolution_patch_invalid", "fingerprint")
        if len(self.patch.operations) > IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS:
            raise _error("impact_resolution_limit_invalid", len(self.patch.operations), field="patch_operations")
        if self.validation.status == "explanation_only":
            raise _error("impact_resolution_patch_invalid", self.validation.status)
        if self.validation.status == "valid":
            if self.comparison is None:
                raise _error("impact_resolution_patch_invalid", "comparison_missing")
            if (
                self.comparison.source_checksum != self.patch.source_checksum
                or self.comparison.target_checksum != self.patch.target_checksum
            ):
                raise _error("impact_resolution_patch_stale", self.patch.patch_id)
        elif self.comparison is not None:
            raise _error("impact_resolution_patch_invalid", "comparison_unvalidated")
        return self


class ImpactPreviewPlacement(ImpactResolutionContractModel):
    x: float
    y: float
    width: float = Field(gt=0, le=10_000)
    height: float = Field(gt=0, le=10_000)
    preview_only: bool = False


class ImpactVisualFieldChange(ImpactResolutionContractModel):
    path: ResolutionFieldPath = Field(pattern=_FIELD_PATH.pattern)
    before: Any = None
    after: Any = None

    @model_validator(mode="after")
    def bound_values(self) -> "ImpactVisualFieldChange":
        if len(_canonical_json({"before": self.before, "after": self.after})) > 16_000:
            raise _error("impact_resolution_limit_invalid", self.path, field="visual_field")
        if self.before == self.after:
            raise _error("impact_resolution_visual_diff_invalid", self.path)
        return self


class ImpactVisualChange(ImpactResolutionContractModel):
    """One pure source/candidate projection change with runtime-owned identity."""

    visual_change_version: Literal[1] = IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION
    id: str = Field(pattern=_CHECKSUM.pattern)
    kind: ImpactVisualChangeKind
    surface: ImpactVisualSurface
    before_resource: CanonOwnerRef | None = None
    after_resource: CanonOwnerRef | None = None
    field_changes: tuple[ImpactVisualFieldChange, ...] = Field(default=(), max_length=50)
    before_placement: ImpactPreviewPlacement | None = None
    after_placement: ImpactPreviewPlacement | None = None

    @field_validator("field_changes")
    @classmethod
    def normalize_field_changes(
        cls, values: tuple[ImpactVisualFieldChange, ...]
    ) -> tuple[ImpactVisualFieldChange, ...]:
        keyed = {item.path: item for item in values}
        if len(keyed) != len(values):
            raise _error("impact_resolution_visual_diff_invalid", "duplicate_field")
        return tuple(keyed[key] for key in sorted(keyed))

    @model_validator(mode="after")
    def validate_shape_and_identity(self) -> "ImpactVisualChange":
        if self.kind == "add" and (self.before_resource is not None or self.after_resource is None):
            raise _error("impact_resolution_visual_diff_invalid", self.kind)
        if self.kind == "remove" and (self.before_resource is None or self.after_resource is not None):
            raise _error("impact_resolution_visual_diff_invalid", self.kind)
        if self.kind in {"modify", "move", "unchanged"} and (
            self.before_resource is None or self.after_resource is None
        ):
            raise _error("impact_resolution_visual_diff_invalid", self.kind)
        if self.kind == "modify" and not self.field_changes:
            raise _error("impact_resolution_visual_diff_invalid", "missing_fields")
        if self.kind == "move" and (
            self.before_placement is None or self.after_placement is None
        ):
            raise _error("impact_resolution_visual_diff_invalid", "missing_placement")
        if self.kind == "unchanged" and (
            self.field_changes
            or self.before_placement != self.after_placement
        ):
            raise _error("impact_resolution_visual_diff_invalid", self.kind)
        expected = impact_visual_change_fingerprint(
            kind=self.kind,
            surface=self.surface,
            before_resource=self.before_resource,
            after_resource=self.after_resource,
            field_paths=tuple(item.path for item in self.field_changes),
        )
        if self.id != expected:
            raise _error("impact_resolution_visual_diff_invalid", "fingerprint")
        return self

    def stable_order_key(self) -> tuple[Any, ...]:
        return (
            ("add", "remove", "modify", "move", "unchanged").index(self.kind),
            self.surface,
            _owner_key(self.before_resource),
            _owner_key(self.after_resource),
            self.id,
        )


class ImpactVisualDiffProjection(ImpactResolutionContractModel):
    """Transient visual changes; UI mode and viewport are intentionally absent."""

    projection_version: Literal[1] = IMPACT_RESOLUTION_VISUAL_PROJECTION_VERSION
    alternative_fingerprint: str = Field(pattern=_CHECKSUM.pattern)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    target_checksum: str = Field(pattern=_CHECKSUM.pattern)
    changes: tuple[ImpactVisualChange, ...] = Field(
        default=(), max_length=IMPACT_RESOLUTION_MAX_VISUAL_CHANGES
    )

    @field_validator("changes")
    @classmethod
    def normalize_changes(
        cls, values: tuple[ImpactVisualChange, ...]
    ) -> tuple[ImpactVisualChange, ...]:
        keyed = {item.id: item for item in values}
        if len(keyed) != len(values):
            raise _error("impact_resolution_visual_diff_invalid", "duplicate_change")
        return tuple(sorted(values, key=ImpactVisualChange.stable_order_key))

    @model_validator(mode="after")
    def require_candidate_difference(self) -> "ImpactVisualDiffProjection":
        if self.source_checksum == self.target_checksum:
            raise _error("impact_resolution_visual_diff_invalid", "no_op")
        if not self.changes:
            raise _error("impact_resolution_visual_diff_invalid", "missing_changes")
        return self


class ImpactResolutionDecision(ImpactResolutionContractModel):
    """Minimal durable review memory; provider prose is deliberately impossible."""

    decision_version: Literal[1] = IMPACT_RESOLUTION_DECISION_VERSION
    finding_fingerprints: tuple[str, ...] = Field(
        min_length=1, max_length=IMPACT_RESOLUTION_MAX_FINDINGS
    )
    proposal_semantic_fingerprint: str = Field(pattern=_CHECKSUM.pattern)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    decision: ImpactResolutionDecisionValue
    decided_at: datetime

    @field_validator("finding_fingerprints")
    @classmethod
    def normalize_fingerprints(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if any(_CHECKSUM.fullmatch(value) is None for value in values):
            raise _error("impact_resolution_finding_invalid", values)
        return tuple(sorted(set(values)))

    @field_validator("decided_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("impact resolution decision timestamp must include a timezone")
        return value


class ImpactResolutionReviewCommand(ImpactResolutionContractModel):
    """Exact browser-observed identity required for approve or reject."""

    command_version: Literal[1] = IMPACT_RESOLUTION_REVIEW_COMMAND_VERSION
    alternative_id: str = Field(min_length=1, max_length=128)
    proposal_semantic_fingerprint: str = Field(pattern=_CHECKSUM.pattern)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    expected_history_revision: int = Field(ge=0)


class ImpactResolutionDraftEdit(ImpactResolutionContractModel):
    """A local patch edit that must traverse the same validation pipeline."""

    edit_version: Literal[1] = IMPACT_RESOLUTION_DRAFT_EDIT_VERSION
    alternative_id: str = Field(min_length=1, max_length=128)
    patch: ProjectPatch


class ImpactResolutionDecisionResponse(ImpactResolutionContractModel):
    response_version: Literal[1] = IMPACT_RESOLUTION_RESPONSE_VERSION
    decision: ImpactResolutionDecision
    run: "ImpactResolutionRun"


class ImpactResolutionRun(ImpactResolutionContractModel):
    """Process-local provider result with optional stale-readable alternatives."""

    run_version: Literal[1] = IMPACT_RESOLUTION_RUN_VERSION
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    history_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    request: ImpactResolutionRequest
    status: ImpactResolutionRunStatus
    explanation: ImpactResolutionExplanation | None = None
    alternatives: tuple[ImpactSolutionAlternative, ...] = ()
    visual_projections: tuple[ImpactVisualDiffProjection, ...] = ()
    diagnostics: tuple[ImpactResolutionDiagnostic, ...] = ()
    started_at: datetime
    completed_at: datetime | None = None

    @field_validator("started_at", "completed_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("impact resolution timestamps must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_lifecycle(self) -> "ImpactResolutionRun":
        terminal = self.status in {"completed", "failed", "cancelled", "stale"}
        if terminal != (self.completed_at is not None):
            raise ValueError("impact resolution terminal states require completed_at")
        if self.completed_at is not None and self.completed_at < self.started_at:
            raise ValueError("impact resolution completion cannot precede start")
        if self.source_checksum != self.request.source_checksum:
            raise _error("impact_resolution_run_stale", self.source_checksum)
        if self.status in {"queued", "running", "failed", "cancelled"} and (
            self.explanation is not None or self.alternatives or self.visual_projections
        ):
            raise ValueError("only completed or stale resolution runs may publish output")
        if len(self.alternatives) > self.request.requested_alternative_count:
            raise _error("impact_resolution_limit_invalid", len(self.alternatives), field="alternatives")
        if any(not set(item.finding_ids) <= set(self.request.finding_ids) for item in self.alternatives):
            raise _error("impact_resolution_finding_invalid", "alternative_scope")
        for alternative in self.alternatives:
            if alternative.patch is None:
                continue
            if alternative.patch.project_id != self.project_id:
                raise _error("impact_resolution_patch_invalid", alternative.patch.project_id)
            if alternative.patch.source_checksum != self.source_checksum:
                raise _error("impact_resolution_patch_stale", alternative.patch.patch_id)
            if len(alternative.patch.operations) > self.request.limits.max_patch_operations:
                raise _error(
                    "impact_resolution_limit_invalid",
                    len(alternative.patch.operations),
                    field="patch_operations",
                )
        ids = [item.id for item in self.alternatives]
        fingerprints = [
            item.semantic_fingerprint
            for item in self.alternatives
            if item.semantic_fingerprint is not None
        ]
        if len(ids) != len(set(ids)) or len(fingerprints) != len(set(fingerprints)):
            raise _error("impact_resolution_response_invalid", "duplicate_alternative")
        projection_fingerprints = [item.alternative_fingerprint for item in self.visual_projections]
        valid_fingerprints = {
            item.semantic_fingerprint
            for item in self.alternatives
            if item.validation.status == "valid" and item.semantic_fingerprint is not None
        }
        if len(projection_fingerprints) != len(set(projection_fingerprints)):
            raise _error("impact_resolution_visual_diff_invalid", "duplicate_projection")
        if set(projection_fingerprints) != valid_fingerprints:
            raise _error("impact_resolution_visual_diff_invalid", "alternative_projection_mismatch")
        for projection in self.visual_projections:
            if projection.source_checksum != self.source_checksum:
                raise _error("impact_resolution_visual_diff_invalid", "source_checksum")
            alternative = next(
                item for item in self.alternatives
                if item.semantic_fingerprint == projection.alternative_fingerprint
            )
            if alternative.patch is None or projection.target_checksum != alternative.patch.target_checksum:
                raise _error("impact_resolution_visual_diff_invalid", "target_checksum")
            if len(projection.changes) > self.request.limits.max_visual_changes:
                raise _error(
                    "impact_resolution_limit_invalid",
                    len(projection.changes),
                    field="visual_changes",
                )
        return self


class ImpactResolutionResponse(ImpactResolutionContractModel):
    response_version: Literal[1] = IMPACT_RESOLUTION_RESPONSE_VERSION
    run: ImpactResolutionRun


def impact_solution_fingerprint(
    finding_ids: tuple[str, ...] | list[str], patch: ProjectPatch
) -> str:
    """Hash deterministic proposal semantics without provider wording or patch id."""

    payload = patch.model_dump(mode="json", exclude={"patch_id"})
    signature = {
        "alternative_version": IMPACT_RESOLUTION_ALTERNATIVE_VERSION,
        "finding_ids": sorted(set(finding_ids)),
        "patch": payload,
    }
    return sha256(_canonical_json(signature).encode("utf-8")).hexdigest()


def impact_visual_change_fingerprint(
    *,
    kind: ImpactVisualChangeKind,
    surface: ImpactVisualSurface,
    before_resource: CanonOwnerRef | None,
    after_resource: CanonOwnerRef | None,
    field_paths: tuple[str, ...] | list[str] = (),
) -> str:
    """Identify a visual delta without authored values or preview coordinates."""

    signature = {
        "visual_change_version": IMPACT_RESOLUTION_VISUAL_CHANGE_VERSION,
        "kind": kind,
        "surface": surface,
        "before": _owner_payload(before_resource),
        "after": _owner_payload(after_resource),
        "field_paths": sorted(set(field_paths)),
    }
    return sha256(_canonical_json(signature).encode("utf-8")).hexdigest()


def _owner_payload(owner: CanonOwnerRef | None) -> dict[str, str] | None:
    return owner.model_dump(mode="json", exclude_none=True) if owner is not None else None


def _owner_key(owner: CanonOwnerRef | None) -> tuple[str, ...]:
    return owner.stable_key() if owner is not None else ()


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _bounded_integer(value: Any, minimum: int, maximum: int, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise _error(
            "impact_resolution_limit_invalid",
            value,
            field=field,
            minimum=minimum,
            maximum=maximum,
        )
    return value


def _error(code: str, value: Any, **context: Any) -> PydanticCustomError:
    return PydanticCustomError(code, code, {"value": str(value), **context})
