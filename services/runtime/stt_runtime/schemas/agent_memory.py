"""Strict storage-neutral contracts for reviewed, project-owned agent memory."""

from __future__ import annotations

from datetime import datetime
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

AGENT_MEMORY_VERSION = 1
AGENT_MEMORY_SCOPE_VERSION = 1
AGENT_MEMORY_CANDIDATE_VERSION = 1
AGENT_MEMORY_ACCEPTANCE_VERSION = 1
AGENT_MEMORY_RESOLUTION_VERSION = 1
AGENT_MEMORY_COMMAND_VERSION = 1
AGENT_MEMORY_RESPONSE_VERSION = 1

AGENT_MEMORY_MAX_TITLE_CHARACTERS = 120
AGENT_MEMORY_MAX_INSTRUCTION_CHARACTERS = 4_000
AGENT_MEMORY_MAX_RATIONALE_CHARACTERS = 2_000
AGENT_MEMORY_MAX_ENTRIES = 1_000
AGENT_MEMORY_MAX_RESOLVED_ENTRIES = 32
AGENT_MEMORY_MAX_CONTEXT_CHARACTERS = 16_000

AgentMemoryAgentId = Literal["canon_checker", "impact_resolver", "style_rewriter"]
AgentMemoryLocale = Literal["en", "ru"]
AgentMemoryStatus = Literal["active", "archived"]
AgentMemoryResolutionStatus = Literal["resolved", "blocked"]
AgentMemoryOmissionReason = Literal[
    "archived",
    "superseded",
    "missing_owner",
    "stale_owner",
    "out_of_scope",
    "conflict",
    "resolution_blocked",
    "entry_limit",
    "character_limit",
]
AgentMemoryErrorCode = Literal[
    "agent_memory_invalid",
    "agent_memory_version_unsupported",
    "agent_memory_agent_unsupported",
    "agent_memory_locale_unsupported",
    "agent_memory_scope_invalid",
    "agent_memory_duplicate",
    "agent_memory_supersession_cycle",
    "agent_memory_secret_forbidden",
    "agent_memory_control_payload_forbidden",
    "agent_memory_injection_forbidden",
    "agent_memory_oversized",
    "agent_memory_resolution_stale",
    "agent_memory_resolution_target_missing",
    "agent_memory_resolution_context_required",
    "agent_memory_resolution_context_invalid",
    "agent_memory_not_found",
    "agent_memory_delete_review_required",
    "agent_memory_delete_impact_stale",
]

_AGENTS = {"canon_checker", "impact_resolver", "style_rewriter"}
_LOCALES = {"en", "ru"}
_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CHECKSUM_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SECRET_PATTERNS = (
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b", re.IGNORECASE),
    re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~-]{20,}\b", re.IGNORECASE),
)
_INJECTION_PATTERNS = (
    re.compile(r"\bignore\s+(?:all\s+)?(?:previous|system|developer)\s+instructions?\b", re.IGNORECASE),
    re.compile(r"\b(?:reveal|print|return)\b.{0,48}\b(?:system|developer)\s+(?:prompt|message)\b", re.IGNORECASE),
    re.compile(r"\bbypass\b.{0,48}\b(?:policy|safety|permission)\b", re.IGNORECASE),
)


def _error(code: AgentMemoryErrorCode, value: Any) -> PydanticCustomError:
    messages = {
        "agent_memory_invalid": "Agent memory value is invalid",
        "agent_memory_version_unsupported": "Agent memory version is unsupported",
        "agent_memory_agent_unsupported": "Agent memory agent is unsupported",
        "agent_memory_locale_unsupported": "Agent memory locale is unsupported",
        "agent_memory_scope_invalid": "Agent memory scope is invalid",
        "agent_memory_duplicate": "Agent memory identity is duplicated",
        "agent_memory_supersession_cycle": "Agent memory supersession contains a cycle",
        "agent_memory_secret_forbidden": "Agent memory must not contain credentials",
        "agent_memory_control_payload_forbidden": "Agent memory contains forbidden controls",
        "agent_memory_injection_forbidden": "Agent memory contains a policy override instruction",
        "agent_memory_oversized": "Agent memory value exceeds its limit",
        "agent_memory_resolution_stale": "Agent memory resolution is stale",
        "agent_memory_resolution_target_missing": "Agent memory target is missing",
        "agent_memory_resolution_context_required": "Agent memory requires explicit context",
        "agent_memory_resolution_context_invalid": "Agent memory context is invalid",
        "agent_memory_not_found": "Agent memory record was not found",
        "agent_memory_delete_review_required": "Agent memory deletion requires review",
        "agent_memory_delete_impact_stale": "Agent memory deletion impact is stale",
    }
    return PydanticCustomError(code, messages[code], {"value": value})


def _validate_id_value(value: str) -> str:
    normalized = value.strip()
    if not _ID_PATTERN.fullmatch(normalized):
        raise _error("agent_memory_invalid", value)
    return normalized


def _validate_optional_id_value(value: str | None) -> str | None:
    return None if value is None else _validate_id_value(value)


def _validate_scope_id_value(value: str) -> str:
    normalized = value.strip()
    if not _ID_PATTERN.fullmatch(normalized):
        raise _error("agent_memory_scope_invalid", value)
    return normalized


def _validate_optional_scope_id_value(value: str | None) -> str | None:
    return None if value is None else _validate_scope_id_value(value)


def _validate_checksum(value: str) -> str:
    normalized = value.strip().lower()
    if not _CHECKSUM_PATTERN.fullmatch(normalized):
        raise _error("agent_memory_invalid", "checksum")
    return normalized


def validate_agent_memory_text(value: str | None) -> str | None:
    """Normalize reviewed prose while rejecting secrets and policy-override payloads."""

    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        raise _error("agent_memory_invalid", "text")
    if _CONTROL_PATTERN.search(normalized):
        raise _error("agent_memory_control_payload_forbidden", "redacted")
    if any(pattern.search(normalized) for pattern in _SECRET_PATTERNS):
        raise _error("agent_memory_secret_forbidden", "redacted")
    if any(pattern.search(normalized) for pattern in _INJECTION_PATTERNS):
        raise _error("agent_memory_injection_forbidden", "redacted")
    return normalized


def _check_text_limits(value: Any) -> None:
    if not isinstance(value, dict):
        return
    limits = {
        "title": AGENT_MEMORY_MAX_TITLE_CHARACTERS,
        "instruction": AGENT_MEMORY_MAX_INSTRUCTION_CHARACTERS,
        "rationale": AGENT_MEMORY_MAX_RATIONALE_CHARACTERS,
    }
    for field, limit in limits.items():
        candidate = value.get(field)
        if isinstance(candidate, str) and len(candidate.strip()) > limit:
            raise _error("agent_memory_oversized", field)


def _require_version(value: Any, field: str, expected: int) -> None:
    if isinstance(value, dict) and value.get(field, expected) != expected:
        raise _error("agent_memory_version_unsupported", value.get(field))


def _validate_scope_payload(value: Any) -> None:
    """Preflight discriminated scopes so Pydantic internals never leak as API codes."""

    if not isinstance(value, dict):
        raise _error("agent_memory_scope_invalid", "scope")
    if value.get("scope_version", AGENT_MEMORY_SCOPE_VERSION) != AGENT_MEMORY_SCOPE_VERSION:
        raise _error("agent_memory_version_unsupported", value.get("scope_version"))
    allowed_by_kind = {
        "project": {"scope_version", "kind"},
        "scene": {"scope_version", "kind", "scene_node_id"},
        "node": {"scope_version", "kind", "node_id"},
        "dialogue_field": {
            "scope_version", "kind", "node_id", "field_kind", "element_id", "option_id"
        },
        "story_flow": {"scope_version", "kind", "flow_id"},
    }
    allowed = allowed_by_kind.get(value.get("kind"))
    required_by_kind = {
        "project": {"kind"},
        "scene": {"kind", "scene_node_id"},
        "node": {"kind", "node_id"},
        "dialogue_field": {"kind", "node_id", "field_kind", "element_id", "option_id"},
        "story_flow": {"kind", "flow_id"},
    }
    required = required_by_kind.get(value.get("kind"))
    if allowed is None or required is None or set(value) - allowed or required - set(value):
        raise _error("agent_memory_scope_invalid", value.get("kind"))


class AgentMemoryContractModel(BaseModel):
    """Reject extensions so persisted and wire contracts evolve by version only."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class ProjectMemoryScopeV1(AgentMemoryContractModel):
    """Project-wide guidance with no inferred owner."""

    scope_version: Literal[1] = AGENT_MEMORY_SCOPE_VERSION
    kind: Literal["project"] = "project"


class SceneMemoryScopeV1(AgentMemoryContractModel):
    """Guidance owned by one canonical Scene node."""

    scope_version: Literal[1] = AGENT_MEMORY_SCOPE_VERSION
    kind: Literal["scene"] = "scene"
    scene_node_id: str

    _validate_id = field_validator("scene_node_id")(_validate_scope_id_value)


class NodeMemoryScopeV1(AgentMemoryContractModel):
    """Guidance owned by one canonical narrative node."""

    scope_version: Literal[1] = AGENT_MEMORY_SCOPE_VERSION
    kind: Literal["node"] = "node"
    node_id: str

    _validate_id = field_validator("node_id")(_validate_scope_id_value)


class DialogueFieldMemoryScopeV1(AgentMemoryContractModel):
    """Guidance for one stable Dialogue line, choice, or option field."""

    scope_version: Literal[1] = AGENT_MEMORY_SCOPE_VERSION
    kind: Literal["dialogue_field"] = "dialogue_field"
    node_id: str
    field_kind: Literal["line_text", "choice_prompt", "option_text"]
    element_id: str
    option_id: str | None = None

    _validate_ids = field_validator("node_id", "element_id", "option_id")(
        _validate_optional_scope_id_value
    )

    @model_validator(mode="after")
    def validate_option_identity(self) -> "DialogueFieldMemoryScopeV1":
        if (self.field_kind == "option_text") != (self.option_id is not None):
            raise _error("agent_memory_scope_invalid", self.field_kind)
        return self


class StoryFlowMemoryScopeV1(AgentMemoryContractModel):
    """Guidance owned by one composable Story Flow."""

    scope_version: Literal[1] = AGENT_MEMORY_SCOPE_VERSION
    kind: Literal["story_flow"] = "story_flow"
    flow_id: str

    _validate_id = field_validator("flow_id")(_validate_scope_id_value)


AgentMemoryScopeV1 = Annotated[
    ProjectMemoryScopeV1
    | SceneMemoryScopeV1
    | NodeMemoryScopeV1
    | DialogueFieldMemoryScopeV1
    | StoryFlowMemoryScopeV1,
    Field(discriminator="kind"),
]


class AgentMemoryIdentityModel(AgentMemoryContractModel):
    """Common project and agent identity shared by durable and process-local data."""

    project_id: str
    agent_id: AgentMemoryAgentId
    namespace: AgentMemoryAgentId
    scope: AgentMemoryScopeV1
    content_locale: AgentMemoryLocale

    @model_validator(mode="before")
    @classmethod
    def validate_scope_shape(cls, value: Any) -> Any:
        if isinstance(value, dict):
            _validate_scope_payload(value.get("scope"))
        return value

    @field_validator("project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        return _validate_id_value(value)

    @field_validator("agent_id", mode="before")
    @classmethod
    def validate_agent(cls, value: str) -> str:
        normalized = value.strip()
        if normalized not in _AGENTS:
            raise _error("agent_memory_agent_unsupported", normalized)
        return normalized

    @field_validator("namespace", mode="before")
    @classmethod
    def validate_namespace(cls, value: str) -> str:
        normalized = value.strip()
        if normalized not in _AGENTS:
            raise _error("agent_memory_agent_unsupported", normalized)
        return normalized

    @field_validator("content_locale", mode="before")
    @classmethod
    def validate_locale(cls, value: str) -> str:
        normalized = value.strip().lower()
        if normalized not in _LOCALES:
            raise _error("agent_memory_locale_unsupported", normalized)
        return normalized

    @model_validator(mode="after")
    def validate_namespace_owner(self) -> "AgentMemoryIdentityModel":
        if self.namespace != self.agent_id:
            raise _error("agent_memory_agent_unsupported", self.namespace)
        return self


class AgentMemoryEntryV1(AgentMemoryIdentityModel):
    """One reviewed durable instruction; provider payloads are deliberately absent."""

    memory_version: Literal[1] = AGENT_MEMORY_VERSION
    id: str
    title: str
    instruction: str
    rationale: str | None = None
    status: AgentMemoryStatus = "active"
    supersedes_id: str | None = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def validate_version_and_size(cls, value: Any) -> Any:
        _require_version(value, "memory_version", AGENT_MEMORY_VERSION)
        _check_text_limits(value)
        return value

    _validate_ids = field_validator("id", "supersedes_id")(_validate_optional_id_value)

    @field_validator("title", "instruction", "rationale")
    @classmethod
    def validate_text(cls, value: str | None) -> str | None:
        return validate_agent_memory_text(value)

    @field_validator("created_at", "updated_at")
    @classmethod
    def validate_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise _error("agent_memory_invalid", value)
        return value

    @model_validator(mode="after")
    def validate_lifecycle(self) -> "AgentMemoryEntryV1":
        if self.id == self.supersedes_id:
            raise _error("agent_memory_supersession_cycle", self.id)
        if self.updated_at < self.created_at:
            raise _error("agent_memory_invalid", self.updated_at)
        return self


class AgentMemoryCandidateV1(AgentMemoryIdentityModel):
    """Process-local reviewed candidate bound to exact source and history state."""

    candidate_version: Literal[1] = AGENT_MEMORY_CANDIDATE_VERSION
    id: str
    title: str
    instruction: str
    rationale: str | None = None
    source_checksum: str
    history_revision: int = Field(ge=0)
    semantic_fingerprint: str
    created_at: datetime

    @model_validator(mode="before")
    @classmethod
    def validate_version_and_size(cls, value: Any) -> Any:
        _require_version(value, "candidate_version", AGENT_MEMORY_CANDIDATE_VERSION)
        _check_text_limits(value)
        return value

    _validate_id = field_validator("id")(_validate_id_value)
    _validate_hashes = field_validator("source_checksum", "semantic_fingerprint")(
        _validate_checksum
    )
    _validate_text = field_validator("title", "instruction", "rationale")(
        validate_agent_memory_text
    )

    @field_validator("created_at")
    @classmethod
    def validate_timestamp(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise _error("agent_memory_invalid", value)
        return value


class AgentMemoryCandidateAcceptanceV1(AgentMemoryIdentityModel):
    """Revalidation token for turning one process-local candidate into history."""

    acceptance_version: Literal[1] = AGENT_MEMORY_ACCEPTANCE_VERSION
    candidate_id: str
    source_checksum: str
    expected_history_revision: int = Field(ge=0)
    semantic_fingerprint: str
    supersedes_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "acceptance_version", AGENT_MEMORY_ACCEPTANCE_VERSION)
        return value

    _validate_id = field_validator("candidate_id")(_validate_id_value)
    _validate_supersedes_id = field_validator("supersedes_id")(_validate_optional_id_value)
    _validate_hashes = field_validator("source_checksum", "semantic_fingerprint")(
        _validate_checksum
    )


class AgentMemoryCatalogV1(AgentMemoryContractModel):
    """Ordered durable collection with global duplicate and supersession checks."""

    catalog_version: Literal[1] = AGENT_MEMORY_VERSION
    project_id: str
    entries: tuple[AgentMemoryEntryV1, ...] = Field(
        default=(), max_length=AGENT_MEMORY_MAX_ENTRIES
    )

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "catalog_version", AGENT_MEMORY_VERSION)
        if isinstance(value, dict) and isinstance(value.get("entries"), (list, tuple)):
            if len(value["entries"]) > AGENT_MEMORY_MAX_ENTRIES:
                raise _error("agent_memory_oversized", "entries")
        return value

    _validate_project_id = field_validator("project_id")(_validate_id_value)

    @model_validator(mode="after")
    def validate_collection(self) -> "AgentMemoryCatalogV1":
        by_id = {entry.id: entry for entry in self.entries}
        if len(by_id) != len(self.entries):
            raise _error("agent_memory_duplicate", "id")
        if any(entry.project_id != self.project_id for entry in self.entries):
            raise _error("agent_memory_invalid", self.project_id)
        for entry in self.entries:
            if entry.supersedes_id is not None and entry.supersedes_id not in by_id:
                raise _error("agent_memory_invalid", entry.supersedes_id)
        identities = [
            (
                entry.agent_id,
                entry.content_locale,
                _scope_identity(entry.scope),
                entry.title.casefold(),
            )
            for entry in self.entries
            if entry.status == "active"
        ]
        if len(identities) != len(set(identities)):
            raise _error("agent_memory_duplicate", "active_identity")
        for entry in self.entries:
            if entry.supersedes_id is None:
                continue
            superseded = by_id[entry.supersedes_id]
            if (
                superseded.agent_id != entry.agent_id
                or superseded.content_locale != entry.content_locale
            ):
                raise _error("agent_memory_invalid", entry.supersedes_id)
        _reject_supersession_cycles(by_id)
        return self


class AgentMemoryResolutionRequestV1(AgentMemoryIdentityModel):
    """Deterministic resolver input bound to an explicit target and project state."""

    resolution_version: Literal[1] = AGENT_MEMORY_RESOLUTION_VERSION
    context_scope: ProjectMemoryScopeV1 | SceneMemoryScopeV1 | StoryFlowMemoryScopeV1
    source_checksum: str
    history_revision: int = Field(ge=0)

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "resolution_version", AGENT_MEMORY_RESOLUTION_VERSION)
        if isinstance(value, dict):
            context_scope = value.get("context_scope")
            _validate_scope_payload(context_scope)
            if context_scope.get("kind") not in {"project", "scene", "story_flow"}:
                raise _error("agent_memory_scope_invalid", context_scope.get("kind"))
        return value

    _validate_checksum = field_validator("source_checksum")(_validate_checksum)


class AgentMemoryOmissionV1(AgentMemoryContractModel):
    """One inspectable durable identity excluded for a deterministic reason."""

    memory_id: str
    reason: AgentMemoryOmissionReason

    _validate_id = field_validator("memory_id")(_validate_id_value)


class AgentMemoryConflictV1(AgentMemoryContractModel):
    """A conflicting active topic and the explicit lifecycle repairs it permits."""

    memory_ids: tuple[str, ...] = Field(min_length=2)
    repair_actions: tuple[Literal["archive", "supersede"], ...] = (
        "archive",
        "supersede",
    )

    @model_validator(mode="after")
    def validate_identity_set(self) -> "AgentMemoryConflictV1":
        normalized = tuple(_validate_id_value(value) for value in self.memory_ids)
        if normalized != tuple(sorted(set(normalized))):
            raise _error("agent_memory_invalid", "conflict_ids")
        if self.repair_actions != ("archive", "supersede"):
            raise _error("agent_memory_invalid", "repair_actions")
        return self


class AgentMemoryResolutionV1(AgentMemoryContractModel):
    """Safe bounded resolver output suitable for disclosure and context assembly."""

    resolution_version: Literal[1] = AGENT_MEMORY_RESOLUTION_VERSION
    project_id: str
    agent_id: AgentMemoryAgentId
    content_locale: AgentMemoryLocale
    source_checksum: str
    history_revision: int = Field(ge=0)
    status: AgentMemoryResolutionStatus
    entries: tuple[AgentMemoryEntryV1, ...] = Field(
        default=(), max_length=AGENT_MEMORY_MAX_RESOLVED_ENTRIES
    )
    included_characters: int = Field(ge=0, le=AGENT_MEMORY_MAX_CONTEXT_CHARACTERS)
    omitted_entries: int = Field(ge=0)
    omissions: tuple[AgentMemoryOmissionV1, ...] = ()
    conflicts: tuple[AgentMemoryConflictV1, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def validate_version_and_bounds(cls, value: Any) -> Any:
        _require_version(value, "resolution_version", AGENT_MEMORY_RESOLUTION_VERSION)
        if isinstance(value, dict):
            if value.get("agent_id") not in _AGENTS:
                raise _error("agent_memory_agent_unsupported", value.get("agent_id"))
            if value.get("content_locale") not in _LOCALES:
                raise _error("agent_memory_locale_unsupported", value.get("content_locale"))
        if isinstance(value, dict) and isinstance(value.get("entries"), (list, tuple)):
            if len(value["entries"]) > AGENT_MEMORY_MAX_RESOLVED_ENTRIES:
                raise _error("agent_memory_oversized", "entries")
        return value

    _validate_ids = field_validator("project_id")(_validate_id_value)
    _validate_checksum = field_validator("source_checksum")(_validate_checksum)

    @model_validator(mode="after")
    def validate_entries(self) -> "AgentMemoryResolutionV1":
        if any(
            entry.project_id != self.project_id
            or entry.agent_id != self.agent_id
            or entry.content_locale != self.content_locale
            or entry.status != "active"
            for entry in self.entries
        ):
            raise _error("agent_memory_invalid", "resolution_entries")
        actual = sum(len(entry.title) + len(entry.instruction) for entry in self.entries)
        if actual != self.included_characters:
            raise _error("agent_memory_invalid", "included_characters")
        if self.omitted_entries != len(self.omissions):
            raise _error("agent_memory_invalid", "omitted_entries")
        included_ids = {entry.id for entry in self.entries}
        omitted_ids = [omission.memory_id for omission in self.omissions]
        if (
            omitted_ids != sorted(set(omitted_ids))
            or included_ids.intersection(omitted_ids)
        ):
            raise _error("agent_memory_invalid", "resolution_identity")
        flattened_conflict_ids = [
            memory_id
            for conflict in self.conflicts
            for memory_id in conflict.memory_ids
        ]
        conflict_ids = set(flattened_conflict_ids)
        if (
            len(flattened_conflict_ids) != len(conflict_ids)
            or list(self.conflicts) != sorted(self.conflicts, key=lambda item: item.memory_ids)
        ):
            raise _error("agent_memory_invalid", "conflict_identity")
        if any(
            omission.reason != "conflict"
            for omission in self.omissions
            if omission.memory_id in conflict_ids
        ) or not conflict_ids.issubset(set(omitted_ids)):
            raise _error("agent_memory_invalid", "conflict_omissions")
        blocking_owner_ids = {
            omission.memory_id
            for omission in self.omissions
            if omission.reason in {"missing_owner", "stale_owner"}
        }
        if (self.status == "blocked") != bool(self.conflicts or blocking_owner_ids):
            raise _error("agent_memory_invalid", "resolution_status")
        if self.status == "blocked" and self.entries:
            raise _error("agent_memory_invalid", "blocked_entries")
        return self


class ApprovedAgentMemoryEntryV1(AgentMemoryContractModel):
    """Minimal reviewed instruction serialized as provider-visible data."""

    memory_id: str
    title: str
    instruction: str
    scope: AgentMemoryScopeV1

    @model_validator(mode="before")
    @classmethod
    def validate_size(cls, value: Any) -> Any:
        _check_text_limits(value)
        return value

    _validate_id = field_validator("memory_id")(_validate_id_value)

    @field_validator("title", "instruction")
    @classmethod
    def validate_text(cls, value: str) -> str:
        return validate_agent_memory_text(value) or ""


class ApprovedAgentMemoryV1(AgentMemoryContractModel):
    """Typed provider data that cannot carry or replace a system policy."""

    approved_memory_version: Literal[1] = 1
    agent_id: AgentMemoryAgentId
    content_locale: AgentMemoryLocale
    entries: tuple[ApprovedAgentMemoryEntryV1, ...] = Field(
        default=(), max_length=AGENT_MEMORY_MAX_RESOLVED_ENTRIES
    )


class AgentMemoryProviderDataV1(AgentMemoryContractModel):
    """Dedicated provider envelope; memory stays quoted under one data key."""

    approved_memory: ApprovedAgentMemoryV1


class AgentMemoryMutationCommandV1(AgentMemoryContractModel):
    """One optimistic history command for create, update, lifecycle, or delete."""

    command_version: Literal[1] = AGENT_MEMORY_COMMAND_VERSION
    command_id: str
    action: Literal["create", "update", "archive", "restore", "delete"]
    memory_id: str
    entry: AgentMemoryEntryV1 | None = None
    expected_source_checksum: str
    expected_history_revision: int = Field(ge=0)
    reviewed_impact_fingerprint: str | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "command_version", AGENT_MEMORY_COMMAND_VERSION)
        return value

    _validate_ids = field_validator("command_id", "memory_id")(_validate_id_value)
    _validate_checksum = field_validator("expected_source_checksum")(_validate_checksum)

    @field_validator("reviewed_impact_fingerprint")
    @classmethod
    def validate_optional_fingerprint(cls, value: str | None) -> str | None:
        return None if value is None else _validate_checksum(value)

    @model_validator(mode="after")
    def validate_payload(self) -> "AgentMemoryMutationCommandV1":
        requires_entry = self.action in {"create", "update"}
        if requires_entry != (self.entry is not None):
            raise _error("agent_memory_invalid", self.action)
        if self.entry is not None and self.entry.id != self.memory_id:
            raise _error("agent_memory_invalid", self.memory_id)
        if (self.action == "delete") != (self.reviewed_impact_fingerprint is not None):
            raise _error("agent_memory_delete_review_required", self.memory_id)
        return self


class AgentMemoryDeletionImpactV1(AgentMemoryContractModel):
    """Reviewed dependency projection required before deleting one memory entry."""

    impact_version: Literal[1] = 1
    project_id: str
    memory_id: str
    direct_successor_ids: tuple[str, ...] = ()
    rebase_to_id: str | None = None
    impact_fingerprint: str

    _validate_ids = field_validator("project_id", "memory_id", "rebase_to_id")(
        _validate_optional_id_value
    )
    _validate_fingerprint = field_validator("impact_fingerprint")(_validate_checksum)

    @field_validator("direct_successor_ids")
    @classmethod
    def validate_successors(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(_validate_id_value(item) for item in value)
        if normalized != tuple(sorted(set(normalized))):
            raise _error("agent_memory_invalid", "direct_successor_ids")
        return normalized


class AgentMemoryListResponseV1(AgentMemoryContractModel):
    """Safe list response containing only portable durable entries."""

    response_version: Literal[1] = AGENT_MEMORY_RESPONSE_VERSION
    catalog: AgentMemoryCatalogV1
    source_checksum: str
    history_revision: int = Field(ge=0)

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION)
        return value

    _validate_checksum = field_validator("source_checksum")(_validate_checksum)


class AgentMemoryCandidateResponseV1(AgentMemoryContractModel):
    """Safe process-local candidate response without raw provider data."""

    response_version: Literal[1] = AGENT_MEMORY_RESPONSE_VERSION
    candidate: AgentMemoryCandidateV1

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION)
        return value


class AgentMemoryMutationResponseV1(AgentMemoryContractModel):
    """Safe mutation acknowledgement tied to the resulting project state."""

    response_version: Literal[1] = AGENT_MEMORY_RESPONSE_VERSION
    entry: AgentMemoryEntryV1 | None
    source_checksum: str
    history_revision: int = Field(ge=0)

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        _require_version(value, "response_version", AGENT_MEMORY_RESPONSE_VERSION)
        return value

    _validate_checksum = field_validator("source_checksum")(_validate_checksum)


def _scope_identity(scope: AgentMemoryScopeV1) -> tuple[str, ...]:
    if scope.kind == "project":
        return (scope.kind,)
    if scope.kind == "scene":
        return (scope.kind, scope.scene_node_id)
    if scope.kind == "node":
        return (scope.kind, scope.node_id)
    if scope.kind == "story_flow":
        return (scope.kind, scope.flow_id)
    return (
        scope.kind,
        scope.node_id,
        scope.field_kind,
        scope.element_id,
        scope.option_id or "",
    )


def _reject_supersession_cycles(entries: dict[str, AgentMemoryEntryV1]) -> None:
    for entry_id in entries:
        visited: set[str] = set()
        current_id: str | None = entry_id
        while current_id is not None:
            if current_id in visited:
                raise _error("agent_memory_supersession_cycle", current_id)
            visited.add(current_id)
            current = entries.get(current_id)
            current_id = current.supersedes_id if current is not None else None
