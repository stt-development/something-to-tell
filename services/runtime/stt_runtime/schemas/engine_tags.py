"""Versioned, storage-neutral contracts for stable engine tags (Phase 7)."""

from __future__ import annotations

from copy import deepcopy
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

ENGINE_TAG_VERSION = 1
ENGINE_TAG_DOCUMENT_VERSION = 6
ENGINE_TAG_TARGETS = ("unreal", "unity", "ink", "yarn_spinner")
# Keep legacy wire variants portable while limiting current authoring readiness.
ENGINE_TAG_AUTHORING_TARGETS = ("ink", "yarn_spinner")
ENGINE_TAG_MAX_KEY_LENGTH = 160
ENGINE_TAG_MAX_DEFINITIONS = 2_000
ENGINE_TAG_MAX_TEXT_LENGTH = 2_000
EngineTagTarget = Literal["unreal", "unity", "ink", "yarn_spinner"]
EngineTagProjectionTarget = Literal["generic", "unreal", "unity", "ink", "yarn_spinner"]
EngineTagStatus = Literal["active", "archived"]
EngineTagCommandAction = Literal[
    "create_definition", "create_and_bind", "update_definition", "rename_definition", "archive_definition",
    "restore_definition", "set_alias", "remove_alias", "bind", "batch_bind", "batch_unbind", "unbind",
    "merge", "delete_definition", "convert_legacy",
]
EngineTagOwnerKind = Literal[
    "project", "node", "relationship", "dialogue_line", "dialogue_choice", "dialogue_option",
    "quest_stage", "quest_branch", "story_flow", "flow_transition", "flow_invocation",
    "flow_exit", "narrative_effect"
]
EngineTagErrorCode = Literal[
    "engine_tag_key_invalid", "engine_tag_key_collision", "engine_tag_owner_invalid",
    "engine_tag_alias_invalid", "engine_tag_limit_exceeded", "engine_tag_version_unsupported",
    "engine_tag_identity_stale", "engine_tag_secret_forbidden", "engine_tag_control_forbidden",
    "engine_tag_path_forbidden"
]
_KEY_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$")
_CONTROL_PATTERN = re.compile(r"[\x00-\x1f\x7f]")
_PATH_PATTERN = re.compile(r"(?:^|[\\/])\.?(?:\.?[\\/])")
_SECRET_PATTERNS = (
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b", re.IGNORECASE),
    re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~-]{20,}\b", re.IGNORECASE),
)
_CYRILLIC = str.maketrans({"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"e","ж":"zh","з":"z","и":"i","й":"i","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"h","ц":"c","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"})


def _error(code: EngineTagErrorCode) -> PydanticCustomError:
    return PydanticCustomError(code, code, {})


def normalize_engine_tag_key(value: str) -> str:
    candidate = value.strip()
    if not _KEY_PATTERN.fullmatch(candidate) or len(candidate) > ENGINE_TAG_MAX_KEY_LENGTH:
        raise _error("engine_tag_key_invalid")
    return candidate.lower()


def _validate_authored_text(value: str) -> str:
    """Reject machine-local paths, controls, and credential-shaped authored data."""

    normalized = value.strip()
    if len(normalized) > ENGINE_TAG_MAX_TEXT_LENGTH:
        raise _error("engine_tag_limit_exceeded")
    if _CONTROL_PATTERN.search(normalized):
        raise _error("engine_tag_control_forbidden")
    if _PATH_PATTERN.search(normalized):
        raise _error("engine_tag_path_forbidden")
    if any(pattern.search(normalized) for pattern in _SECRET_PATTERNS):
        raise _error("engine_tag_secret_forbidden")
    return normalized


class EngineTagContractModel(BaseModel):
    """Reject extensions so the registry evolves through explicit versions."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class EngineTagOwnerV1(EngineTagContractModel):
    kind: EngineTagOwnerKind
    project_id: str = Field(min_length=1)
    node_id: str | None = None
    edge_id: str | None = None
    dialogue_node_id: str | None = None
    line_id: str | None = None
    choice_id: str | None = None
    option_id: str | None = None
    quest_node_id: str | None = None
    stage_id: str | None = None
    branch_id: str | None = None
    flow_id: str | None = None
    transition_id: str | None = None
    invocation_id: str | None = None
    exit_id: str | None = None
    effect_id: str | None = None


class EngineTagTargetAliasV1(EngineTagContractModel):
    tag_version: Literal[1] = 1
    target: EngineTagTarget
    external_identifier: str = Field(min_length=1, max_length=240)

    @field_validator("external_identifier")
    @classmethod
    def validate_external_identifier(cls, value: str) -> str:
        return _validate_authored_text(value)


class EngineTagDefinitionV1(EngineTagContractModel):
    tag_version: Literal[1] = 1
    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    key: str = Field(min_length=1, max_length=ENGINE_TAG_MAX_KEY_LENGTH)
    normalized_key: str = Field(min_length=1, max_length=ENGINE_TAG_MAX_KEY_LENGTH)
    description: str = ""
    status: EngineTagStatus
    aliases: list[EngineTagTargetAliasV1] = Field(default_factory=list)
    created_at: str = Field(min_length=1)
    updated_at: str = Field(min_length=1)

    @field_validator("key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        return value.strip()

    @field_validator("normalized_key")
    @classmethod
    def validate_normalized_key(cls, value: str) -> str:
        return normalize_engine_tag_key(value)

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return _validate_authored_text(value)


class EngineTagBindingV1(EngineTagContractModel):
    tag_version: Literal[1] = 1
    id: str = Field(min_length=1)
    project_id: str = Field(min_length=1)
    definition_id: str = Field(min_length=1)
    owner: EngineTagOwnerV1
    value: str = ""
    created_at: str = Field(min_length=1)
    updated_at: str = Field(min_length=1)

    @field_validator("value")
    @classmethod
    def validate_value(cls, value: str) -> str:
        return _validate_authored_text(value)


class LegacyEngineTagRecordV1(EngineTagContractModel):
    """Exact v5 generic row retained without attempting semantic inference."""

    id: str
    project_id: str
    created_at: str
    updated_at: str
    target_type: str
    target_id: str
    engine: str
    key: str
    value: str
    metadata: dict[str, Any]


class EngineTagProjectExtensionV6(EngineTagContractModel):
    document_version: Literal[6] = 6
    engine_tag_definitions: list[EngineTagDefinitionV1] = Field(default_factory=list)
    engine_tag_bindings: list[EngineTagBindingV1] = Field(default_factory=list)
    legacy_engine_tags: list[LegacyEngineTagRecordV1] = Field(default_factory=list)


class EngineTagSuggestionRequestV1(EngineTagContractModel):
    request_version: Literal[1] = 1
    project_id: str
    owner: EngineTagOwnerV1
    label: str = Field(min_length=1)
    existing_keys: list[str] = Field(default_factory=list)


class EngineTagSuggestionV1(EngineTagContractModel):
    suggestion_version: Literal[1] = 1
    key: str
    normalized_key: str
    collision_resolved: bool


class EngineTagCatalogV1(EngineTagContractModel):
    catalog_version: Literal[1] = 1
    project_id: str
    definitions: list[EngineTagDefinitionV1] = Field(default_factory=list)
    bindings: list[EngineTagBindingV1] = Field(default_factory=list)
    legacy_count: int = Field(ge=0)


class EngineTagProjectionRequestV1(EngineTagContractModel):
    """Read-only target selection; no filesystem or exporter options are accepted."""

    target: EngineTagProjectionTarget


class EngineTagProjectionEntryV1(EngineTagContractModel):
    """One stable definition/owner identity projected for a target."""

    definition_id: str
    normalized_key: str
    owner: EngineTagOwnerV1
    identifier: str


class EngineTagProjectionOmissionV1(EngineTagContractModel):
    """Explicitly explain why a source record is absent from a target view."""

    definition_id: str | None = None
    binding_id: str | None = None
    owner: EngineTagOwnerV1 | None = None
    code: Literal[
        "archived_definition", "missing_target_alias", "duplicate_target_alias",
        "target_identifier_invalid", "missing_owner", "legacy_quarantine",
        "out_of_scope",
    ]
    details: dict[str, str] = Field(default_factory=dict)


class EngineTagProjectionDiagnosticV1(EngineTagContractModel):
    """Target-level diagnostic that does not mutate or become a Canon issue."""

    code: Literal["target_collision", "legacy_quarantine", "missing_owner"]
    message_key: str = Field(pattern=r"^engine_tags\.projection\.[a-z0-9_.-]+$")
    details: dict[str, str] = Field(default_factory=dict)


class EngineTagProjectionV1(EngineTagContractModel):
    """Checksum-bound compatibility read model consumed by future exporters."""

    projection_version: Literal[1] = 1
    project_id: str
    source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    target: EngineTagProjectionTarget
    entries: list[EngineTagProjectionEntryV1] = Field(default_factory=list)
    omitted: list[EngineTagProjectionOmissionV1] = Field(default_factory=list)
    diagnostics: list[EngineTagProjectionDiagnosticV1] = Field(default_factory=list)


class EngineTagImpactV1(EngineTagContractModel):
    impact_version: Literal[1] = 1
    definition_id: str
    affected_owner_count: int = Field(ge=0)
    affected_targets: list[EngineTagTarget] = Field(default_factory=list)
    requires_review: Literal[True] = True


class EngineTagDiagnosticV1(EngineTagContractModel):
    diagnostic_version: Literal[1] = 1
    code: EngineTagErrorCode
    message_key: str = Field(pattern=r"^engine_tags\.[a-z0-9_.-]+$")
    owner: EngineTagOwnerV1 | None = None
    definition_id: str | None = None
    details: dict[str, str] = Field(default_factory=dict)


class EngineTagIntegrityFindingV1(EngineTagContractModel):
    """One navigable registry finding, kept outside the Canon issue model."""

    finding_version: Literal[1] = 1
    code: Literal[
        "missing_owner", "duplicate_normalized_key", "duplicate_alias",
        "archived_binding", "legacy_unreviewed", "target_incompatibility",
    ]
    severity: Literal["error", "warning", "info"]
    message_key: str = Field(pattern=r"^engine_tags\.integrity\.[a-z0-9_.-]+$")
    definition_id: str | None = None
    binding_id: str | None = None
    owner: EngineTagOwnerV1 | None = None
    details: dict[str, str] = Field(default_factory=dict)


class EngineTagIntegrityReportV1(EngineTagContractModel):
    """Checksum-bound diagnostics for registry maintenance and navigation."""

    report_version: Literal[1] = 1
    project_id: str
    source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    findings: list[EngineTagIntegrityFindingV1] = Field(default_factory=list)
    error_count: int = Field(ge=0)
    warning_count: int = Field(ge=0)
    info_count: int = Field(ge=0)


class EngineTagMutationCommandV1(EngineTagContractModel):
    """One optimistic registry mutation; all writes pass through this command."""

    command_version: Literal[1] = 1
    command_id: str = Field(min_length=1, max_length=128)
    action: EngineTagCommandAction
    definition_id: str | None = None
    target_definition_id: str | None = None
    key: str | None = None
    description: str | None = None
    alias: EngineTagTargetAliasV1 | None = None
    owner: EngineTagOwnerV1 | None = None
    owners: list[EngineTagOwnerV1] = Field(default_factory=list, max_length=500)
    value: str | None = None
    legacy_id: str | None = None
    expected_source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_history_revision: int = Field(ge=0)
    reviewed_impact_fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")

    @field_validator("description", "value")
    @classmethod
    def validate_authored_text(cls, value: str | None) -> str | None:
        return None if value is None else _validate_authored_text(value)

    @model_validator(mode="after")
    def validate_payload(self) -> "EngineTagMutationCommandV1":
        requires_definition = self.action not in {"create_definition", "create_and_bind", "convert_legacy"}
        if requires_definition and not self.definition_id:
            raise _error("engine_tag_identity_stale")
        if self.action in {"create_definition", "create_and_bind"} and self.definition_id:
            raise _error("engine_tag_identity_stale")
        if self.action in {"bind", "unbind"} and self.owner is None:
            raise _error("engine_tag_owner_invalid")
        if self.action in {"batch_bind", "batch_unbind"} and not self.owners:
            raise _error("engine_tag_owner_invalid")
        if self.action == "create_and_bind" and (self.owner is None) == (not self.owners):
            raise _error("engine_tag_owner_invalid")
        if self.action in {"set_alias", "remove_alias"} and self.alias is None:
            raise _error("engine_tag_alias_invalid")
        if self.action == "merge" and not self.target_definition_id:
            raise _error("engine_tag_identity_stale")
        if self.action == "convert_legacy" and not self.legacy_id:
            raise _error("engine_tag_identity_stale")
        if self.action in {"merge", "delete_definition"} and self.reviewed_impact_fingerprint is None:
            raise _error("engine_tag_identity_stale")
        return self


class EngineTagMutationResponseV1(EngineTagContractModel):
    """Result tied to the new checksum and history revision."""

    response_version: Literal[1] = 1
    catalog: EngineTagCatalogV1
    source_checksum: str = Field(pattern=r"^[a-f0-9]{64}$")
    history_revision: int = Field(ge=0)
    impact_fingerprint: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class EngineTagPreviewV1(EngineTagContractModel):
    preview_version: Literal[1] = 1
    project_id: str
    definitions: list[EngineTagDefinitionV1] = Field(default_factory=list)
    bindings: list[EngineTagBindingV1] = Field(default_factory=list)
    legacy_count: int = Field(ge=0)
    read_only: Literal[True] = True


class EngineTagApiResponseV1(EngineTagContractModel):
    """Safe response envelope; every payload is explicit and versioned."""

    response_version: Literal[1] = 1
    kind: Literal["catalog", "suggestion", "preview", "impact", "diagnostic"]
    payload: dict[str, Any]


def assert_unique_engine_tag_keys(definitions: list[EngineTagDefinitionV1]) -> None:
    if len(definitions) > ENGINE_TAG_MAX_DEFINITIONS:
        raise _error("engine_tag_limit_exceeded")
    keys = set()
    for definition in definitions:
        key = normalize_engine_tag_key(definition.key)
        if key in keys:
            raise _error("engine_tag_key_collision")
        keys.add(key)


_OWNER_ROOT = {
    "project": "Project", "node": "Node", "relationship": "Relationship", "dialogue_line": "DialogueLine",
    "dialogue_choice": "DialogueChoice", "dialogue_option": "DialogueOption", "quest_stage": "QuestStage",
    "quest_branch": "QuestBranch", "story_flow": "StoryFlow", "flow_transition": "FlowTransition",
    "flow_invocation": "FlowInvocation", "flow_exit": "FlowExit", "narrative_effect": "NarrativeEffect",
}


def _segment(value: str) -> str:
    words = re.sub(r"[^A-Za-z0-9]+", " ", value.lower().translate(_CYRILLIC)).strip().split()
    return "".join(word[:1].upper() + word[1:] for word in words) or "Unnamed"


def suggest_engine_tag_key(request: EngineTagSuggestionRequestV1) -> EngineTagSuggestionV1:
    root = f"{_OWNER_ROOT[request.owner.kind]}."
    base = f"{root}{_segment(request.label)[:ENGINE_TAG_MAX_KEY_LENGTH - len(root)]}"
    used = {normalize_engine_tag_key(key) for key in request.existing_keys}
    key, suffix = base, 2
    while normalize_engine_tag_key(key) in used:
        ending = f"_{suffix}"
        key, suffix = f"{base[:ENGINE_TAG_MAX_KEY_LENGTH - len(ending)]}{ending}", suffix + 1
    return EngineTagSuggestionV1(key=key, normalized_key=normalize_engine_tag_key(key), collision_resolved=key != base)


def migrate_legacy_engine_tags_v5_to_v6(rows: list[LegacyEngineTagRecordV1]) -> EngineTagProjectExtensionV6:
    """Quarantine legacy rows idempotently while leaving caller-owned input untouched."""

    return EngineTagProjectExtensionV6(legacy_engine_tags=deepcopy(rows))
