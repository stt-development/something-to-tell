"""Runtime-owned Phase 5 Impact Analysis contracts mirrored by packages/contracts."""

from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from .canon_check import CanonEvidenceRef, CanonOwnerRef
from .project_document import ProjectDocument
from .project_patch import ProjectPatch
from .remote_storage import RemoteStorageHeadV1

IMPACT_DEPENDENCY_VERSION = 1
IMPACT_SEED_VERSION = 1
IMPACT_SCENARIO_VERSION = 1
IMPACT_PATH_VERSION = 1
IMPACT_FINDING_VERSION = 1
IMPACT_SUMMARY_VERSION = 1
IMPACT_DIAGNOSTIC_VERSION = 1
IMPACT_LIMITS_VERSION = 1
IMPACT_REQUEST_VERSION = 1
IMPACT_RUN_VERSION = 1
IMPACT_RESPONSE_VERSION = 1
IMPACT_INPUT_VERSION = 1

IMPACT_DEFAULT_DEPTH = 3
IMPACT_MAX_DEPTH = 10
IMPACT_DEFAULT_PATHS_PER_TARGET = 3
IMPACT_MAX_PATHS_PER_TARGET = 3
IMPACT_DEFAULT_TARGETS = 500
IMPACT_MAX_TARGETS = 500

ImpactResourceRef = CanonOwnerRef
ImpactEvidenceRef = CanonEvidenceRef
ImpactDomain = Literal[
    "graph",
    "composition",
    "flow",
    "dialogue",
    "quest",
    "temporal",
    "playback",
    "canon",
]
ImpactRequestDirection = Literal["upstream", "downstream", "both"]
ImpactPathDirection = Literal["upstream", "downstream"]
ImpactPropagation = Literal["required", "conditional", "contextual"]
ImpactSelectionIntent = Literal["modify", "delete"]
ImpactType = Literal["structural", "execution", "state", "ownership", "reference", "integrity"]
ImpactRunStatus = Literal["queued", "running", "completed", "failed", "cancelled", "stale"]
ImpactErrorCode = Literal[
    "impact_direction_invalid",
    "impact_domain_invalid",
    "impact_propagation_invalid",
    "impact_depth_invalid",
    "impact_path_limit_invalid",
    "impact_target_limit_invalid",
    "impact_seed_not_found",
    "impact_patch_invalid",
    "impact_patch_stale",
    "impact_run_stale",
    "impact_run_cancelled",
    "impact_run_failed",
    "impact_result_limit_reached",
]

_STABLE_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_CHECKSUM = re.compile(r"^[0-9a-f]{64}$")
_DOMAINS: tuple[ImpactDomain, ...] = (
    "graph",
    "composition",
    "flow",
    "dialogue",
    "quest",
    "temporal",
    "playback",
    "canon",
)
_REQUEST_DIRECTIONS = ("upstream", "downstream", "both")
_PATH_DIRECTIONS = ("upstream", "downstream")
_PROPAGATIONS = ("required", "conditional", "contextual")


class ImpactContractModel(BaseModel):
    """Rejects unknown transport fields and prevents post-validation mutation."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ImpactSeed(ImpactContractModel):
    """One stable authoring resource selected as traversal depth zero."""

    seed_version: Literal[1] = IMPACT_SEED_VERSION
    resource: ImpactResourceRef

    def stable_key(self) -> tuple[str, ...]:
        return self.resource.stable_key()


class SelectionImpactScenario(ImpactContractModel):
    """Prospective intent when no concrete field-level patch exists yet."""

    scenario_version: Literal[1] = IMPACT_SCENARIO_VERSION
    type: Literal["selection"] = "selection"
    intent: ImpactSelectionIntent
    seeds: tuple[ImpactSeed, ...] = Field(min_length=1)

    @field_validator("seeds")
    @classmethod
    def normalize_seeds(cls, seeds: tuple[ImpactSeed, ...]) -> tuple[ImpactSeed, ...]:
        return _ordered_unique_seeds(seeds)


class PatchImpactScenario(ImpactContractModel):
    """Concrete hypothetical ProjectPatch that analysis must never apply durably."""

    scenario_version: Literal[1] = IMPACT_SCENARIO_VERSION
    type: Literal["patch"] = "patch"
    patch: ProjectPatch


ImpactScenario = Annotated[
    SelectionImpactScenario | PatchImpactScenario,
    Field(discriminator="type"),
]


class ImpactDependency(ImpactContractModel):
    """One typed domain-owned relationship in the immutable dependency index."""

    dependency_version: Literal[1] = IMPACT_DEPENDENCY_VERSION
    source: ImpactResourceRef
    target: ImpactResourceRef
    domain: ImpactDomain
    kind: str = Field(pattern=_STABLE_ID.pattern)
    propagation: ImpactPropagation
    message_key: str = Field(min_length=1)
    message_parameters: dict[str, Any] = Field(default_factory=dict)
    evidence: tuple[ImpactEvidenceRef, ...] = ()

    @field_validator("domain", mode="before")
    @classmethod
    def validate_domain(cls, value: Any) -> Any:
        return _validate_choice(value, _DOMAINS, "impact_domain_invalid")

    @field_validator("propagation", mode="before")
    @classmethod
    def validate_propagation(cls, value: Any) -> Any:
        return _validate_choice(value, _PROPAGATIONS, "impact_propagation_invalid")

    @field_validator("evidence")
    @classmethod
    def normalize_evidence(
        cls,
        evidence: tuple[ImpactEvidenceRef, ...],
    ) -> tuple[ImpactEvidenceRef, ...]:
        return tuple(sorted(evidence, key=ImpactEvidenceRef.stable_key))

    def stable_key(self) -> tuple[str, ...]:
        """Exclude localized explanation and evidence wording from ordering."""

        return (
            self.domain,
            self.kind,
            self.propagation,
            *self.source.stable_key(),
            *self.target.stable_key(),
        )


class ImpactPath(ImpactContractModel):
    """One bounded seed-to-target explanation path in traversal order."""

    path_version: Literal[1] = IMPACT_PATH_VERSION
    direction: ImpactPathDirection
    propagation: ImpactPropagation
    resources: tuple[ImpactResourceRef, ...] = Field(min_length=2, max_length=IMPACT_MAX_DEPTH + 1)
    dependencies: tuple[ImpactDependency, ...] = Field(min_length=1, max_length=IMPACT_MAX_DEPTH)

    @field_validator("direction", mode="before")
    @classmethod
    def validate_direction(cls, value: Any) -> Any:
        return _validate_choice(value, _PATH_DIRECTIONS, "impact_direction_invalid")

    @field_validator("propagation", mode="before")
    @classmethod
    def validate_propagation(cls, value: Any) -> Any:
        return _validate_choice(value, _PROPAGATIONS, "impact_propagation_invalid")

    @model_validator(mode="after")
    def validate_chain(self) -> "ImpactPath":
        if len(self.dependencies) != len(self.resources) - 1:
            raise ValueError("impact path dependency count must connect every resource")
        if len({resource.stable_key() for resource in self.resources}) != len(self.resources):
            raise ValueError("impact path must not repeat a resource")
        for index, dependency in enumerate(self.dependencies):
            adjacent = {
                self.resources[index].stable_key(),
                self.resources[index + 1].stable_key(),
            }
            endpoints = {dependency.source.stable_key(), dependency.target.stable_key()}
            if adjacent != endpoints:
                raise ValueError("impact path dependency does not connect adjacent resources")
        strongest = min(
            (dependency.propagation for dependency in self.dependencies),
            key=_propagation_order,
        )
        if self.propagation != strongest:
            raise ValueError("impact path propagation must match its strongest dependency")
        return self

    def stable_key(self) -> tuple[Any, ...]:
        return (
            len(self.dependencies),
            _propagation_order(self.propagation),
            self.direction,
            tuple(resource.stable_key() for resource in self.resources),
            tuple(dependency.stable_key() for dependency in self.dependencies),
        )


class ImpactFinding(ImpactContractModel):
    """Coalesced affected target with stable identity and bounded alternate paths."""

    finding_version: Literal[1] = IMPACT_FINDING_VERSION
    id: str = Field(pattern=_CHECKSUM.pattern)
    seeds: tuple[ImpactSeed, ...] = Field(min_length=1)
    target: ImpactResourceRef
    domain: ImpactDomain
    direction: ImpactPathDirection
    impact_type: ImpactType
    propagation: ImpactPropagation
    distance: int = Field(ge=1, le=IMPACT_MAX_DEPTH)
    message_key: str = Field(min_length=1)
    message_parameters: dict[str, Any] = Field(default_factory=dict)
    paths: tuple[ImpactPath, ...] = Field(min_length=1, max_length=IMPACT_MAX_PATHS_PER_TARGET)

    @field_validator("seeds")
    @classmethod
    def normalize_seeds(cls, seeds: tuple[ImpactSeed, ...]) -> tuple[ImpactSeed, ...]:
        return _ordered_unique_seeds(seeds)

    @field_validator("domain", mode="before")
    @classmethod
    def validate_domain(cls, value: Any) -> Any:
        return _validate_choice(value, _DOMAINS, "impact_domain_invalid")

    @field_validator("direction", mode="before")
    @classmethod
    def validate_direction(cls, value: Any) -> Any:
        return _validate_choice(value, _PATH_DIRECTIONS, "impact_direction_invalid")

    @field_validator("propagation", mode="before")
    @classmethod
    def validate_propagation(cls, value: Any) -> Any:
        return _validate_choice(value, _PROPAGATIONS, "impact_propagation_invalid")

    @field_validator("paths")
    @classmethod
    def normalize_paths(cls, paths: tuple[ImpactPath, ...]) -> tuple[ImpactPath, ...]:
        keyed = {path.stable_key(): path for path in paths}
        return tuple(keyed[key] for key in sorted(keyed))

    @model_validator(mode="after")
    def validate_identity_and_paths(self) -> "ImpactFinding":
        expected = impact_finding_fingerprint(
            seeds=self.seeds,
            target=self.target,
            domain=self.domain,
            direction=self.direction,
        )
        if self.id != expected:
            raise ValueError("impact finding id does not match stable identity")
        seed_keys = {seed.resource.stable_key() for seed in self.seeds}
        if any(path.resources[0].stable_key() not in seed_keys for path in self.paths):
            raise ValueError("impact finding path must start at one of its seeds")
        if any(path.resources[-1] != self.target for path in self.paths):
            raise ValueError("impact finding path must end at its target")
        if any(path.direction != self.direction for path in self.paths):
            raise ValueError("impact finding paths must use its direction")
        if self.distance != min(len(path.dependencies) for path in self.paths):
            raise ValueError("impact finding distance must use its shortest path")
        strongest = min((path.propagation for path in self.paths), key=_propagation_order)
        if self.propagation != strongest:
            raise ValueError("impact finding propagation must match its strongest path")
        return self

    def stable_order_key(self) -> tuple[Any, ...]:
        """Order without localized messages, evidence excerpts, or run timestamps."""

        return (
            self.distance,
            _propagation_order(self.propagation),
            _DOMAINS.index(self.domain),
            *self.target.stable_key(),
            self.direction,
            self.impact_type,
            self.id,
        )


class ImpactCounts(ImpactContractModel):
    required: int = Field(default=0, ge=0)
    conditional: int = Field(default=0, ge=0)
    contextual: int = Field(default=0, ge=0)


class ImpactSummary(ImpactContractModel):
    """Non-sparse run totals suitable for stable loading and empty states."""

    summary_version: Literal[1] = IMPACT_SUMMARY_VERSION
    finding_count: int = Field(default=0, ge=0)
    direct_count: int = Field(default=0, ge=0)
    transitive_count: int = Field(default=0, ge=0)
    propagation: ImpactCounts = Field(default_factory=ImpactCounts)
    truncated: bool = False
    omitted_count: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def validate_counts(self) -> "ImpactSummary":
        if self.direct_count + self.transitive_count != self.finding_count:
            raise ValueError("impact direct and transitive counts must equal finding count")
        propagation_total = (
            self.propagation.required
            + self.propagation.conditional
            + self.propagation.contextual
        )
        if propagation_total != self.finding_count:
            raise ValueError("impact propagation counts must equal finding count")
        if self.truncated != (self.omitted_count > 0):
            raise ValueError("impact truncation requires a non-zero omitted count")
        return self


class ImpactDiagnostic(ImpactContractModel):
    diagnostic_version: Literal[1] = IMPACT_DIAGNOSTIC_VERSION
    code: ImpactErrorCode
    message_key: str = Field(min_length=1)
    parameters: dict[str, Any] = Field(default_factory=dict)


class ImpactAnalysisLimits(ImpactContractModel):
    """Hard-bounded request controls; defaults are part of the public contract."""

    limits_version: Literal[1] = IMPACT_LIMITS_VERSION
    max_depth: int = IMPACT_DEFAULT_DEPTH
    max_paths_per_target: int = IMPACT_DEFAULT_PATHS_PER_TARGET
    max_targets: int = IMPACT_DEFAULT_TARGETS

    @field_validator("max_depth", mode="before")
    @classmethod
    def validate_depth(cls, value: Any) -> Any:
        return _validate_bounded_integer(value, 1, IMPACT_MAX_DEPTH, "impact_depth_invalid")

    @field_validator("max_paths_per_target", mode="before")
    @classmethod
    def validate_path_limit(cls, value: Any) -> Any:
        return _validate_bounded_integer(
            value,
            1,
            IMPACT_MAX_PATHS_PER_TARGET,
            "impact_path_limit_invalid",
        )

    @field_validator("max_targets", mode="before")
    @classmethod
    def validate_target_limit(cls, value: Any) -> Any:
        return _validate_bounded_integer(
            value,
            1,
            IMPACT_MAX_TARGETS,
            "impact_target_limit_invalid",
        )


class ImpactAnalysisRequest(ImpactContractModel):
    """Explicit operational request; session identity belongs to the API path."""

    request_version: Literal[1] = IMPACT_REQUEST_VERSION
    observed_saved_revision: int = Field(ge=0)
    expected_history_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    scenario: ImpactScenario
    direction: ImpactRequestDirection = "downstream"
    domains: tuple[ImpactDomain, ...] = _DOMAINS
    limits: ImpactAnalysisLimits = Field(default_factory=ImpactAnalysisLimits)

    @field_validator("direction", mode="before")
    @classmethod
    def validate_direction(cls, value: Any) -> Any:
        return _validate_choice(value, _REQUEST_DIRECTIONS, "impact_direction_invalid")

    @field_validator("domains", mode="before")
    @classmethod
    def validate_domains(cls, value: Any) -> Any:
        if not isinstance(value, (list, tuple)) or not value:
            raise _contract_error("impact_domain_invalid", value)
        for domain in value:
            _validate_choice(domain, _DOMAINS, "impact_domain_invalid")
        return value

    @field_validator("domains")
    @classmethod
    def normalize_domains(cls, domains: tuple[ImpactDomain, ...]) -> tuple[ImpactDomain, ...]:
        selected = set(domains)
        return tuple(domain for domain in _DOMAINS if domain in selected)

    @model_validator(mode="after")
    def validate_patch_checksum(self) -> "ImpactAnalysisRequest":
        if (
            isinstance(self.scenario, PatchImpactScenario)
            and self.scenario.patch.source_checksum != self.source_checksum
        ):
            raise _contract_error("impact_patch_stale", self.scenario.patch.source_checksum)
        return self


class ImpactAnalysisRun(ImpactContractModel):
    """Process-local result envelope excluded from project persistence and history."""

    run_version: Literal[1] = IMPACT_RUN_VERSION
    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    history_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    status: ImpactRunStatus
    request: ImpactAnalysisRequest
    findings: tuple[ImpactFinding, ...] = ()
    summary: ImpactSummary = Field(default_factory=ImpactSummary)
    diagnostics: tuple[ImpactDiagnostic, ...] = ()
    started_at: datetime
    completed_at: datetime | None = None

    @field_validator("findings")
    @classmethod
    def normalize_findings(
        cls,
        findings: tuple[ImpactFinding, ...],
    ) -> tuple[ImpactFinding, ...]:
        keyed = {finding.id: finding for finding in findings}
        if len(keyed) != len(findings):
            raise ValueError("impact run contains duplicate finding ids")
        return tuple(sorted(findings, key=ImpactFinding.stable_order_key))

    @field_validator("diagnostics")
    @classmethod
    def normalize_diagnostics(
        cls,
        diagnostics: tuple[ImpactDiagnostic, ...],
    ) -> tuple[ImpactDiagnostic, ...]:
        return tuple(sorted(diagnostics, key=lambda item: (item.code, _canonical_json(item.parameters))))

    @field_validator("started_at", "completed_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("impact run timestamps must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_lifecycle(self) -> "ImpactAnalysisRun":
        terminal = self.status in {"completed", "failed", "cancelled", "stale"}
        if terminal != (self.completed_at is not None):
            raise ValueError("impact terminal run states require completed_at")
        if self.completed_at is not None and self.completed_at < self.started_at:
            raise ValueError("impact completed_at must not precede started_at")
        if self.saved_revision != self.request.observed_saved_revision:
            raise ValueError("impact run saved revision must match its request")
        if self.history_revision != self.request.expected_history_revision:
            raise ValueError("impact run history revision must match its request")
        if self.source_checksum != self.request.source_checksum:
            raise ValueError("impact run checksum must match its request")
        if self.status == "completed" and self.summary.finding_count != len(self.findings):
            raise ValueError("completed impact run summary must match its findings")
        if self.status != "completed" and self.findings:
            raise ValueError("only a completed impact run may publish findings")
        return self


class ImpactAnalysisResponse(ImpactContractModel):
    response_version: Literal[1] = IMPACT_RESPONSE_VERSION
    run: ImpactAnalysisRun


class ImpactAnalysisInput(ImpactContractModel):
    """One immutable working document captured for a validated request."""

    input_version: Literal[1] = IMPACT_INPUT_VERSION
    remote_storage: "RemoteStorageHeadV1 | None" = Field(default=None, exclude_if=lambda value: value is None)
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    history_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    document: ProjectDocument
    request: ImpactAnalysisRequest

    @model_validator(mode="after")
    def validate_snapshot_identity(self) -> "ImpactAnalysisInput":
        if self.document.manifest.project_id != self.project_id:
            raise ValueError("impact input project identity does not match its document")
        if self.document.manifest.saved_revision != self.saved_revision:
            raise ValueError("impact input revision does not match its document")
        if self.document.checksum != self.source_checksum:
            raise ValueError("impact input checksum does not match its document")
        if self.request.observed_saved_revision != self.saved_revision:
            raise ValueError("impact input revision does not match its request")
        if self.request.expected_history_revision != self.history_revision:
            raise ValueError("impact input history revision does not match its request")
        if self.request.source_checksum != self.source_checksum:
            raise ValueError("impact input checksum does not match its request")
        if (
            isinstance(self.request.scenario, PatchImpactScenario)
            and self.request.scenario.patch.project_id != self.project_id
        ):
            raise _contract_error("impact_patch_invalid", self.request.scenario.patch.project_id)
        return self


def impact_finding_fingerprint(
    *,
    seeds: tuple[ImpactSeed, ...] | list[ImpactSeed],
    target: ImpactResourceRef,
    domain: ImpactDomain,
    direction: ImpactPathDirection,
) -> str:
    """Hash only stable resource identity; localized explanation never participates."""

    signature = {
        "finding_version": IMPACT_FINDING_VERSION,
        "seeds": [
            _owner_payload(seed.resource)
            for seed in sorted(seeds, key=ImpactSeed.stable_key)
        ],
        "target": _owner_payload(target),
        "domain": domain,
        "direction": direction,
    }
    return sha256(_canonical_json(signature).encode("utf-8")).hexdigest()


def _ordered_unique_seeds(seeds: tuple[ImpactSeed, ...]) -> tuple[ImpactSeed, ...]:
    keyed = {seed.stable_key(): seed for seed in seeds}
    return tuple(keyed[key] for key in sorted(keyed))


def _owner_payload(owner: ImpactResourceRef) -> dict[str, str]:
    return owner.model_dump(mode="json", exclude_none=True)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _propagation_order(value: ImpactPropagation) -> int:
    return {"required": 0, "conditional": 1, "contextual": 2}[value]


def _validate_choice(value: Any, choices: tuple[Any, ...], code: str) -> Any:
    if value not in choices:
        raise _contract_error(code, value)
    return value


def _validate_bounded_integer(value: Any, minimum: int, maximum: int, code: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise _contract_error(code, value, minimum=minimum, maximum=maximum)
    return value


def _contract_error(
    code: str,
    value: Any,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> PydanticCustomError:
    context = {"value": str(value)}
    if minimum is not None:
        context["minimum"] = minimum
    if maximum is not None:
        context["maximum"] = maximum
    return PydanticCustomError(code, code, context)
