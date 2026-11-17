"""Runtime-owned Phase 4 canon contracts mirrored by packages/contracts."""

from __future__ import annotations

from datetime import datetime
from hashlib import sha256
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .project_document import ProjectDocument
from .project_history import ProjectHistorySummary
from .project_patch import ProjectPatch
from .project_session import ProjectSessionResponse
from .remote_storage import RemoteStorageHeadV1

CANON_RUN_VERSION = 1
CANON_FACT_VERSION = 1
CANON_RULE_DESCRIPTOR_VERSION = 1
CANON_CANDIDATE_VERSION = 1
CANON_ISSUE_VERSION = 1
CANON_DIAGNOSTIC_VERSION = 1
CANON_REPAIR_CAPABILITY_VERSION = 1
CANON_FIX_SUGGESTION_VERSION = 1

CanonDomain = Literal[
    "graph",
    "composition",
    "flow",
    "dialogue",
    "quest",
    "temporal",
    "playback",
]
CanonFactLevel = Literal["info", "warning", "error"]
CanonIssueSeverity = Literal["info", "warning", "critical"]
CanonIssueStatus = Literal["open", "review", "ignored", "resolved"]
CanonIssueOrigin = Literal["canon_rule", "canon_agent"]
CanonIssueResolutionReason = Literal[
    "candidate_absent",
    "rule_disabled",
    "suggestion_approved",
]
CanonRunMode = Literal["deterministic", "configured_agent"]
CanonRunStatus = Literal[
    "queued",
    "running",
    "reconciling",
    "completed",
    "failed",
    "cancelled",
    "stale",
]
CanonFixSuggestionStatus = Literal["pending", "approved", "rejected"]
CanonRepairKind = Literal["deterministic_patch", "agent_review", "navigate_only", "none"]
CanonRepairAction = Literal["request_fix", "explore_solutions", "open_source", "none"]

_STABLE_ID = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
_CHECKSUM = re.compile(r"^[0-9a-f]{64}$")


class CanonContractModel(BaseModel):
    """Forbids silent contract extensions and assignment after validation."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class CanonFixSuggestion(CanonContractModel):
    """Immutable checksum-bound forward proposal pending explicit review."""

    suggestion_version: Literal[1] = CANON_FIX_SUGGESTION_VERSION
    id: str = Field(min_length=1)
    issue_id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    status: CanonFixSuggestionStatus = "pending"
    why: str | None = Field(default=None, min_length=1, max_length=4000)
    how: str | None = Field(default=None, min_length=1, max_length=4000)
    patch: ProjectPatch

    @model_validator(mode="after")
    def validate_project_identity(self) -> "CanonFixSuggestion":
        if self.patch.project_id != self.project_id:
            raise ValueError("canon suggestion patch belongs to another project")
        return self


class CanonOwnerRef(CanonContractModel):
    """Stable resource identity independent of UI projection or localized text."""

    owner_type: str = Field(min_length=1)
    owner_id: str = Field(min_length=1)
    context_type: str | None = Field(default=None, min_length=1)
    context_id: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_context_pair(self) -> "CanonOwnerRef":
        if (self.context_type is None) != (self.context_id is None):
            raise ValueError("canon owner context type and id must be provided together")
        return self

    def stable_key(self) -> tuple[str, str, str, str]:
        return (
            self.owner_type,
            self.owner_id,
            self.context_type or "",
            self.context_id or "",
        )


class CanonEvidenceRef(CanonContractModel):
    """Evidence pointer plus localization key; excerpts never define identity."""

    owner: CanonOwnerRef
    field_path: str | None = Field(default=None, min_length=1)
    message_key: str = Field(min_length=1)
    message_parameters: dict[str, Any] = Field(default_factory=dict)
    excerpt: str | None = None

    def stable_key(self) -> tuple[str, ...]:
        return (
            *self.owner.stable_key(),
            self.field_path or "",
            self.message_key,
            _canonical_json(self.message_parameters),
            self.excerpt or "",
        )


class CanonFact(CanonContractModel):
    """Normalized immutable output from one Phase 3 domain adapter."""

    fact_version: Literal[1] = CANON_FACT_VERSION
    code: str = Field(pattern=_STABLE_ID.pattern)
    domain: CanonDomain
    level: CanonFactLevel
    scope: CanonOwnerRef
    owners: tuple[CanonOwnerRef, ...] = ()
    evidence: tuple[CanonEvidenceRef, ...] = ()
    parameters: dict[str, Any] = Field(default_factory=dict)
    source_revision: int = Field(ge=0)

    @field_validator("owners")
    @classmethod
    def order_owners(cls, owners: tuple[CanonOwnerRef, ...]) -> tuple[CanonOwnerRef, ...]:
        return _ordered_unique_owners(owners)

    @field_validator("evidence")
    @classmethod
    def order_evidence(
        cls,
        evidence: tuple[CanonEvidenceRef, ...],
    ) -> tuple[CanonEvidenceRef, ...]:
        return tuple(sorted(evidence, key=CanonEvidenceRef.stable_key))


class CanonDiagnosticV1(CanonContractModel):
    """Safe concrete domain diagnostic retained independently of display prose."""

    diagnostic_version: Literal[1] = CANON_DIAGNOSTIC_VERSION
    fact_code: str = Field(pattern=_STABLE_ID.pattern)
    domain: CanonDomain
    parameters: dict[str, str | int | float | bool] = Field(default_factory=dict)
    identity_parameters: dict[str, str | int | float | bool] = Field(
        default_factory=dict
    )
    targets: tuple[CanonOwnerRef, ...]
    evidence: tuple[CanonEvidenceRef, ...]

    @field_validator("parameters", "identity_parameters")
    @classmethod
    def normalize_parameters(
        cls,
        values: dict[str, str | int | float | bool],
    ) -> dict[str, str | int | float | bool]:
        if any(_STABLE_ID.fullmatch(key) is None for key in values):
            raise ValueError("canon diagnostic parameter keys must be stable ids")
        if any(isinstance(value, str) and len(value) > 512 for value in values.values()):
            raise ValueError("canon diagnostic string parameters are bounded")
        return dict(sorted(values.items()))

    @field_validator("targets")
    @classmethod
    def normalize_diagnostic_targets(
        cls,
        targets: tuple[CanonOwnerRef, ...],
    ) -> tuple[CanonOwnerRef, ...]:
        if not targets:
            raise ValueError("canon diagnostic requires at least one target")
        return _ordered_unique_owners(targets)

    @field_validator("evidence")
    @classmethod
    def normalize_diagnostic_evidence(
        cls,
        evidence: tuple[CanonEvidenceRef, ...],
    ) -> tuple[CanonEvidenceRef, ...]:
        if not evidence:
            raise ValueError("canon diagnostic requires evidence")
        return tuple(sorted(evidence, key=CanonEvidenceRef.stable_key))


class CanonRuleDescriptor(CanonContractModel):
    """Discoverable rule metadata; executable behavior is added in P4-004."""

    descriptor_version: Literal[1] = CANON_RULE_DESCRIPTOR_VERSION
    id: str = Field(pattern=_STABLE_ID.pattern)
    version: int = Field(ge=1)
    category: str = Field(pattern=_STABLE_ID.pattern)
    default_severity: CanonIssueSeverity
    input_domains: tuple[CanonDomain, ...]
    supported_severity_overrides: tuple[CanonIssueSeverity, ...] = (
        "info",
        "warning",
        "critical",
    )

    @field_validator("input_domains")
    @classmethod
    def normalize_domains(cls, domains: tuple[CanonDomain, ...]) -> tuple[CanonDomain, ...]:
        if not domains:
            raise ValueError("canon rule requires at least one input domain")
        return tuple(sorted(set(domains)))

    @field_validator("supported_severity_overrides")
    @classmethod
    def normalize_supported_severities(
        cls,
        severities: tuple[CanonIssueSeverity, ...],
    ) -> tuple[CanonIssueSeverity, ...]:
        return tuple(sorted(set(severities), key=_severity_order))


class ResolvedCanonRule(CanonContractModel):
    """Registry result after project enablement and severity policy."""

    descriptor: CanonRuleDescriptor
    severity: CanonIssueSeverity


class CanonIssueCandidate(CanonContractModel):
    """One deterministic rule result before durable Issue reconciliation."""

    candidate_version: Literal[1] = CANON_CANDIDATE_VERSION
    rule_id: str = Field(pattern=_STABLE_ID.pattern)
    rule_version: int = Field(ge=1)
    category: str = Field(pattern=_STABLE_ID.pattern)
    severity: CanonIssueSeverity
    scope: CanonOwnerRef
    message_key: str = Field(min_length=1)
    message_parameters: dict[str, Any] = Field(default_factory=dict)
    recommendation_key: str | None = Field(default=None, min_length=1)
    recommendation_parameters: dict[str, Any] = Field(default_factory=dict)
    targets: tuple[CanonOwnerRef, ...]
    evidence: tuple[CanonEvidenceRef, ...]
    fingerprint: str = Field(pattern=_CHECKSUM.pattern)
    diagnostic: CanonDiagnosticV1 | None = None
    agent_explanation: str | None = Field(default=None, min_length=1, max_length=4000)
    agent_recommendation: str | None = Field(default=None, min_length=1, max_length=4000)

    @field_validator("targets")
    @classmethod
    def normalize_targets(
        cls,
        targets: tuple[CanonOwnerRef, ...],
    ) -> tuple[CanonOwnerRef, ...]:
        if not targets:
            raise ValueError("canon candidate requires at least one target")
        return _ordered_unique_owners(targets)

    @field_validator("evidence")
    @classmethod
    def normalize_evidence(
        cls,
        evidence: tuple[CanonEvidenceRef, ...],
    ) -> tuple[CanonEvidenceRef, ...]:
        if not evidence:
            raise ValueError("canon candidate requires evidence")
        return tuple(sorted(evidence, key=CanonEvidenceRef.stable_key))

    @model_validator(mode="after")
    def validate_fingerprint(self) -> "CanonIssueCandidate":
        expected = canon_issue_fingerprint(
            rule_id=self.rule_id,
            rule_version=self.rule_version,
            scope=self.scope,
            targets=self.targets,
            diagnostic=self.diagnostic,
        )
        if self.fingerprint != expected:
            raise ValueError("canon candidate fingerprint does not match stable identity")
        return self


class CanonIssueMetadataV1(CanonContractModel):
    """Typed metadata envelope stored only on generated canon Issues."""

    issue_version: Literal[1] = CANON_ISSUE_VERSION
    origin: CanonIssueOrigin
    rule_id: str = Field(pattern=_STABLE_ID.pattern)
    rule_version: int = Field(ge=1)
    fingerprint: str = Field(pattern=_CHECKSUM.pattern)
    category: str = Field(pattern=_STABLE_ID.pattern)
    scope: CanonOwnerRef | None = None
    message_key: str = Field(min_length=1)
    message_parameters: dict[str, Any] = Field(default_factory=dict)
    recommendation_key: str | None = Field(default=None, min_length=1)
    recommendation_parameters: dict[str, Any] = Field(default_factory=dict)
    targets: tuple[CanonOwnerRef, ...]
    evidence: tuple[CanonEvidenceRef, ...]
    agent_explanation: str | None = Field(default=None, min_length=1, max_length=4000)
    agent_recommendation: str | None = Field(default=None, min_length=1, max_length=4000)
    saved_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    first_seen_at: datetime
    last_seen_at: datetime
    resolved_at: datetime | None = None
    resolution_reason: CanonIssueResolutionReason | None = None

    @field_validator("targets")
    @classmethod
    def order_targets(
        cls,
        targets: tuple[CanonOwnerRef, ...],
    ) -> tuple[CanonOwnerRef, ...]:
        if not targets:
            raise ValueError("canon issue requires at least one target")
        return _ordered_unique_owners(targets)

    @field_validator("evidence")
    @classmethod
    def order_issue_evidence(
        cls,
        evidence: tuple[CanonEvidenceRef, ...],
    ) -> tuple[CanonEvidenceRef, ...]:
        if not evidence:
            raise ValueError("canon issue requires evidence")
        return tuple(sorted(evidence, key=CanonEvidenceRef.stable_key))

    @field_validator("first_seen_at", "last_seen_at", "resolved_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("canon issue timestamps must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_lifecycle(self) -> "CanonIssueMetadataV1":
        if self.last_seen_at < self.first_seen_at:
            raise ValueError("last_seen_at must not precede first_seen_at")
        if self.resolved_at is not None and self.resolved_at < self.first_seen_at:
            raise ValueError("resolved_at must not precede first_seen_at")
        if (self.resolved_at is None) != (self.resolution_reason is None):
            raise ValueError("resolved canon issues require a resolution reason")
        return self


class CanonIssueMetadataV2(CanonIssueMetadataV1):
    """Generated Issue metadata with a concrete normalized domain diagnostic."""

    issue_version: Literal[2] = 2
    diagnostic: CanonDiagnosticV1


class CanonRepairCapability(CanonContractModel):
    """Checksum-bound runtime action projection; never persisted with an Issue."""

    capability_version: Literal[1] = CANON_REPAIR_CAPABILITY_VERSION
    kind: CanonRepairKind
    action: CanonRepairAction
    available: bool
    unavailable_reason: str | None = Field(default=None, min_length=1)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)

    @model_validator(mode="after")
    def validate_action_state(self) -> "CanonRepairCapability":
        expected_action = {
            "deterministic_patch": "request_fix",
            "agent_review": "explore_solutions",
            "navigate_only": "open_source",
            "none": "none",
        }[self.kind]
        if self.action != expected_action:
            raise ValueError("canon repair kind and action disagree")
        if self.available == (self.unavailable_reason is not None):
            raise ValueError("unavailable canon repair requires one reason")
        if self.kind == "none" and self.available:
            raise ValueError("none canon repair cannot be available")
        return self


class CanonIssueProjection(CanonContractModel):
    """Typed API view; legacy/manual ProjectIssueRecord remains unchanged."""

    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str = ""
    severity: CanonIssueSeverity
    status: CanonIssueStatus
    metadata: CanonIssueMetadataV1 | CanonIssueMetadataV2
    repair: CanonRepairCapability


class CanonIssueCounts(CanonContractModel):
    """Stable non-sparse counts for run and review summaries."""

    info: int = Field(default=0, ge=0)
    warning: int = Field(default=0, ge=0)
    critical: int = Field(default=0, ge=0)


class CanonRunSummary(CanonContractModel):
    fact_count: int = Field(default=0, ge=0)
    candidate_count: int = Field(default=0, ge=0)
    opened_count: int = Field(default=0, ge=0)
    retained_count: int = Field(default=0, ge=0)
    resolved_count: int = Field(default=0, ge=0)
    severity: CanonIssueCounts = Field(default_factory=CanonIssueCounts)


class CanonRunDiagnostic(CanonContractModel):
    code: str = Field(pattern=_STABLE_ID.pattern)
    message_key: str = Field(min_length=1)
    parameters: dict[str, Any] = Field(default_factory=dict)


class CanonCheckRun(CanonContractModel):
    """Process-local run state; this model is never stored in ProjectDocument."""

    run_version: Literal[1] = CANON_RUN_VERSION
    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    rule_pack_version: int = Field(ge=1)
    mode: CanonRunMode
    scope: tuple[CanonOwnerRef, ...] = ()
    status: CanonRunStatus
    started_at: datetime
    completed_at: datetime | None = None
    summary: CanonRunSummary = Field(default_factory=CanonRunSummary)
    diagnostics: tuple[CanonRunDiagnostic, ...] = ()

    @field_validator("scope")
    @classmethod
    def order_scope(cls, scope: tuple[CanonOwnerRef, ...]) -> tuple[CanonOwnerRef, ...]:
        return _ordered_unique_owners(scope)

    @field_validator("started_at", "completed_at")
    @classmethod
    def require_run_timezone(cls, value: datetime | None) -> datetime | None:
        if value is not None and (value.tzinfo is None or value.utcoffset() is None):
            raise ValueError("canon run timestamps must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_completion(self) -> "CanonCheckRun":
        terminal = self.status in {"completed", "failed", "cancelled", "stale"}
        if terminal != (self.completed_at is not None):
            raise ValueError("canon terminal run states require completed_at")
        if self.completed_at is not None and self.completed_at < self.started_at:
            raise ValueError("completed_at must not precede started_at")
        return self


class CanonRunStart(CanonContractModel):
    """Explicit saved-revision command; provider credentials are never accepted."""

    session_id: str = Field(min_length=1)
    observed_saved_revision: int = Field(ge=0)
    expected_history_revision: int = Field(ge=0)
    mode: CanonRunMode = "deterministic"
    remote_consent: bool = False
    scope: tuple[CanonOwnerRef, ...] = ()
    enabled_rule_overrides: dict[str, bool] = Field(default_factory=dict)
    severity_overrides: dict[str, CanonIssueSeverity] = Field(default_factory=dict)

    @field_validator("scope")
    @classmethod
    def order_requested_scope(
        cls,
        scope: tuple[CanonOwnerRef, ...],
    ) -> tuple[CanonOwnerRef, ...]:
        return _ordered_unique_owners(scope)

    @field_validator("enabled_rule_overrides", "severity_overrides")
    @classmethod
    def validate_rule_ids(cls, values: dict[str, Any]) -> dict[str, Any]:
        unknown = next((key for key in values if _STABLE_ID.fullmatch(key) is None), None)
        if unknown is not None:
            raise ValueError(f"invalid canon rule id: {unknown}")
        return dict(sorted(values.items()))


class CanonIssueListResponse(CanonContractModel):
    """Generated canon Issues plus active severity totals for one open project."""

    project_id: str = Field(min_length=1)
    issues: tuple[CanonIssueProjection, ...] = ()
    active_count: int = Field(default=0, ge=0)
    severity: CanonIssueCounts = Field(default_factory=CanonIssueCounts)


class CanonIssueStatusChange(CanonContractModel):
    """Human review command routed through bounded authoring history."""

    session_id: str = Field(min_length=1)
    expected_history_revision: int = Field(ge=0)
    status: Literal["open", "review", "ignored"]


class CanonIssueSuggestionRequest(CanonContractModel):
    """Suggestion request shape reserved for the reviewed P4-009 workflow."""

    session_id: str = Field(min_length=1)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)


class CanonIssueImpactRequest(CanonContractModel):
    """Snapshot tokens required to seed deterministic Impact from one Issue."""

    session_id: str = Field(min_length=1)
    expected_history_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)


class CanonIssueSuggestionResponse(CanonContractModel):
    """Returns either no proposal or the complete immutable forward preview."""

    issue_id: str = Field(min_length=1)
    status: Literal["unavailable", "created"]
    suggestion_id: str | None = None
    message_key: str = Field(min_length=1)
    suggestion: CanonFixSuggestion | None = None

    @model_validator(mode="after")
    def validate_suggestion_presence(self) -> "CanonIssueSuggestionResponse":
        created = self.status == "created"
        if created != (self.suggestion is not None):
            raise ValueError("created canon suggestion requires a proposal")
        if created != (self.suggestion_id is not None):
            raise ValueError("created canon suggestion requires its id")
        if self.suggestion is not None and self.suggestion.id != self.suggestion_id:
            raise ValueError("canon suggestion response ids disagree")
        return self


class CanonFixSuggestionDecision(CanonContractModel):
    """One caller-observed approval or rejection boundary."""

    session_id: str = Field(min_length=1)
    expected_history_revision: int = Field(ge=0)


class CanonFixSuggestionDecisionResponse(CanonContractModel):
    """Authoritative document and history after a durable review decision."""

    suggestion: CanonFixSuggestion
    project: ProjectSessionResponse
    history: ProjectHistorySummary


class CanonCheckInput(CanonContractModel):
    """Immutable working-document snapshot plus its normalized Phase 3 facts."""

    input_version: Literal[1] = 1
    remote_storage: "RemoteStorageHeadV1 | None" = Field(default=None, exclude_if=lambda value: value is None)
    project_id: str = Field(min_length=1)
    saved_revision: int = Field(ge=0)
    source_checksum: str = Field(pattern=_CHECKSUM.pattern)
    rule_pack_version: int = Field(ge=1)
    document: ProjectDocument
    facts: tuple[CanonFact, ...] = ()

    @field_validator("facts")
    @classmethod
    def order_facts(cls, facts: tuple[CanonFact, ...]) -> tuple[CanonFact, ...]:
        return tuple(sorted(facts, key=_fact_key))

    @model_validator(mode="after")
    def validate_saved_identity(self) -> "CanonCheckInput":
        if self.document.manifest.project_id != self.project_id:
            raise ValueError("canon input project identity does not match its document")
        if self.document.manifest.saved_revision != self.saved_revision:
            raise ValueError("canon input revision does not match its document")
        if self.document.checksum != self.source_checksum:
            raise ValueError("canon input checksum does not match its document")
        if any(fact.source_revision != self.saved_revision for fact in self.facts):
            raise ValueError("canon facts must use the captured saved revision")
        return self


def canon_issue_fingerprint(
    *,
    rule_id: str,
    rule_version: int,
    scope: CanonOwnerRef,
    targets: tuple[CanonOwnerRef, ...] | list[CanonOwnerRef],
    diagnostic: CanonDiagnosticV1 | None = None,
) -> str:
    """Hash only stable identity fields; never mutate caller-owned collections."""

    signature = {
        "rule_id": rule_id,
        "rule_version": rule_version,
        "scope": _owner_payload(scope),
        "targets": [
            json.loads(item)
            for item in sorted({_canonical_json(_owner_payload(target)) for target in targets})
        ],
    }
    if diagnostic is not None:
        signature["diagnostic"] = {
            "domain": diagnostic.domain,
            "fact_code": diagnostic.fact_code,
            "identity_parameters": diagnostic.identity_parameters,
        }
    return sha256(_canonical_json(signature).encode("utf-8")).hexdigest()


def parse_canon_issue_metadata(
    metadata: dict[str, Any],
) -> CanonIssueMetadataV1 | CanonIssueMetadataV2 | None:
    """Return None for legacy/manual metadata and validate recognized envelopes."""

    if "issue_version" not in metadata:
        return None
    if metadata.get("issue_version") == 2:
        return CanonIssueMetadataV2.model_validate(metadata)
    return CanonIssueMetadataV1.model_validate(metadata)


def _ordered_unique_owners(owners: tuple[CanonOwnerRef, ...]) -> tuple[CanonOwnerRef, ...]:
    keyed = {owner.stable_key(): owner for owner in owners}
    return tuple(keyed[key] for key in sorted(keyed))


def _owner_payload(owner: CanonOwnerRef) -> dict[str, str]:
    return owner.model_dump(mode="json", exclude_none=True)


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _severity_order(value: CanonIssueSeverity) -> int:
    return {"info": 0, "warning": 1, "critical": 2}[value]


def _fact_key(fact: CanonFact) -> tuple[str, ...]:
    return (
        fact.domain,
        fact.code,
        *fact.scope.stable_key(),
        _canonical_json(fact.parameters),
        _canonical_json([owner.model_dump(mode="json") for owner in fact.owners]),
    )
