"""Strict, versioned contracts for deterministic Phase 8 exports."""

from __future__ import annotations

import math
import re
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

from .dialogue import DialogueDocument
from .engine_tags import (
    EngineTagProjectionDiagnosticV1,
    EngineTagProjectionEntryV1,
    EngineTagProjectionOmissionV1,
    EngineTagProjectionTarget,
)
from .quest import QuestDocument

EXPORT_CONTRACT_VERSION = 1
EXPORT_FORMATS = ("json", "yaml", "yarn_spinner", "ink")
EXPORT_SCOPES = ("whole_project", "story_flows")
EXPORT_MAX_SELECTED_FLOWS = 128
EXPORT_MAX_PREVIEW_BYTES = 262_144
EXPORT_MAX_DIAGNOSTICS = 2_000
EXPORT_MAX_RECORDS = 100_000
EXPORT_MAX_OUTPUT_BYTES = 52_428_800
EXPORT_MAX_NAME_LENGTH = 160
EXPORT_MAX_PATH_LENGTH = 4_096
EXPORT_MAX_TEXT_LENGTH = 1_048_576

ExportFormat = Literal["json", "yaml", "yarn_spinner", "ink"]
ExportScope = Literal["whole_project", "story_flows"]
ExportDiagnosticSeverity = Literal["error", "warning", "info"]
ExportErrorCode = Literal[
    "export_contract_invalid",
    "export_limit_exceeded",
    "export_source_stale",
    "export_plan_stale",
    "export_scope_invalid",
    "export_path_invalid",
    "export_destination_conflict",
    "export_projection_unsafe",
    "export_permission_denied",
    "export_write_failed",
    "export_format_unsupported",
]

_CHECKSUM_PATTERN = r"^[a-f0-9]{64}$"
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$")
_PORTABLE_NAME_PATTERN = re.compile(r"^[^/\\]+$")
_EXTENSION_KEY_PATTERN = re.compile(r"^x-[a-z][a-z0-9_.-]{0,126}$")
_CONTROL_PATTERN = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SECRET_PATTERNS = (
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b", re.IGNORECASE),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~-]{20,}\b", re.IGNORECASE),
)
_FORBIDDEN_EXTENSION_KEYS = {
    "api_key", "apikey", "credential", "credentials", "database_url",
    "destination", "password", "path", "provider", "secret", "storage", "token",
}


def _contract_error(code: ExportErrorCode) -> PydanticCustomError:
    """Create stable validation errors that API adapters can localize."""

    return PydanticCustomError(code, code, {})


def _validate_identifier(value: str) -> str:
    candidate = value.strip()
    if not _IDENTIFIER_PATTERN.fullmatch(candidate) or ".." in candidate:
        raise _contract_error("export_contract_invalid")
    return candidate


def _validate_text(value: str) -> str:
    if len(value) > EXPORT_MAX_TEXT_LENGTH:
        raise _contract_error("export_limit_exceeded")
    if _CONTROL_PATTERN.search(value):
        raise _contract_error("export_projection_unsafe")
    return value


def _validate_name(value: str) -> str:
    candidate = value.strip()
    if (
        not candidate
        or len(candidate) > EXPORT_MAX_NAME_LENGTH
        or not _PORTABLE_NAME_PATTERN.fullmatch(candidate)
        or candidate in {".", ".."}
        or _CONTROL_PATTERN.search(candidate)
    ):
        raise _contract_error("export_contract_invalid")
    return candidate


def _validate_nonempty_text(value: str) -> str:
    candidate = value.strip()
    if not candidate:
        raise _contract_error("export_contract_invalid")
    _validate_text(candidate)
    return candidate


def _validate_json_value(value: Any, *, depth: int = 0) -> None:
    """Bound portable extension values and reject machine/private configuration."""

    if depth > 16:
        raise _contract_error("export_limit_exceeded")
    if value is None or isinstance(value, bool) or isinstance(value, int):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise _contract_error("export_contract_invalid")
        return
    if isinstance(value, str):
        _validate_text(value)
        if any(pattern.search(value) for pattern in _SECRET_PATTERNS):
            raise _contract_error("export_projection_unsafe")
        return
    if isinstance(value, list):
        if len(value) > EXPORT_MAX_RECORDS:
            raise _contract_error("export_limit_exceeded")
        for item in value:
            _validate_json_value(item, depth=depth + 1)
        return
    if isinstance(value, dict):
        if len(value) > EXPORT_MAX_RECORDS:
            raise _contract_error("export_limit_exceeded")
        for key, item in value.items():
            if not isinstance(key, str) or _CONTROL_PATTERN.search(key):
                raise _contract_error("export_projection_unsafe")
            normalized = key.strip().lower().replace("-", "_")
            if normalized in _FORBIDDEN_EXTENSION_KEYS:
                raise _contract_error("export_projection_unsafe")
            _validate_json_value(item, depth=depth + 1)
        return
    raise _contract_error("export_contract_invalid")


class ExportContractModel(BaseModel):
    """Keep wire variants immutable and reject undeclared fields."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="after")
    def validate_common_wire_values(self) -> "ExportContractModel":
        """Apply baseline control/id checks to every nested export record."""

        for field_name, value in self.__dict__.items():
            if isinstance(value, str):
                _validate_text(value)
                if field_name == "id" or field_name.endswith("_id"):
                    _validate_identifier(value)
        return self


class ExportOptionsV1(ExportContractModel):
    options_version: Literal[1] = 1
    format: ExportFormat
    scope: ExportScope
    story_flow_ids: list[str] = Field(default_factory=list, max_length=EXPORT_MAX_SELECTED_FLOWS)
    engine_tag_target: EngineTagProjectionTarget
    preview_max_bytes: int = Field(default=65_536, ge=1, le=EXPORT_MAX_PREVIEW_BYTES)

    @field_validator("story_flow_ids")
    @classmethod
    def validate_flow_ids(cls, values: list[str]) -> list[str]:
        normalized = [_validate_identifier(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise _contract_error("export_contract_invalid")
        return normalized

    @model_validator(mode="after")
    def validate_scope_selection(self) -> "ExportOptionsV1":
        if self.scope == "whole_project" and self.story_flow_ids:
            raise _contract_error("export_scope_invalid")
        expected_target = {"yarn_spinner": "yarn_spinner", "ink": "ink"}.get(self.format)
        if expected_target is not None and self.engine_tag_target != expected_target:
            raise _contract_error("export_scope_invalid")
        return self


class ExportPlanRequestV1(ExportContractModel):
    request_version: Literal[1] = 1
    options: ExportOptionsV1


class ExportSourceIdentityV1(ExportContractModel):
    identity_version: Literal[1] = 1
    project_id: str
    project_name: str
    content_locale: str = Field(min_length=2, max_length=35)
    document_version: int = Field(ge=1)
    source_checksum: str = Field(pattern=_CHECKSUM_PATTERN)

    @field_validator("project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        return _validate_identifier(value)

    @field_validator("project_name")
    @classmethod
    def validate_project_name(cls, value: str) -> str:
        return _validate_nonempty_text(value)


class ExportOwnerV1(ExportContractModel):
    owner_version: Literal[1] = 1
    kind: Literal[
        "project", "node", "relationship", "dialogue", "dialogue_element",
        "dialogue_option", "quest", "quest_stage", "quest_branch", "story_flow",
        "flow_transition", "flow_invocation", "flow_exit", "narrative_effect",
    ]
    id: str
    context_id: str | None = None

    @field_validator("id", "context_id")
    @classmethod
    def validate_owner_ids(cls, value: str | None) -> str | None:
        return None if value is None else _validate_identifier(value)


class ExportDiagnosticV1(ExportContractModel):
    diagnostic_version: Literal[1] = 1
    code: str = Field(pattern=r"^export\.[a-z0-9_.-]+$", max_length=160)
    severity: ExportDiagnosticSeverity
    message_key: str = Field(pattern=r"^export\.[a-z0-9_.-]+$", max_length=200)
    owner: ExportOwnerV1 | None = None
    parameters: dict[str, Any] = Field(default_factory=dict, max_length=32)

    @field_validator("parameters")
    @classmethod
    def validate_parameters(cls, value: dict[str, Any]) -> dict[str, Any]:
        _validate_json_value(value)
        return value


class ExportInventoryV1(ExportContractModel):
    inventory_version: Literal[1] = 1
    node_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    relationship_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    dialogue_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    quest_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    story_flow_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    flow_membership_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    flow_transition_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    scene_boundary_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    flow_invocation_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    flow_exit_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    flow_exit_binding_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    initial_state_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    narrative_effect_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    narrative_effect_binding_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    engine_tag_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    diagnostic_count: int = Field(ge=0, le=EXPORT_MAX_DIAGNOSTICS)
    record_count: int = Field(ge=0, le=EXPORT_MAX_RECORDS)
    resolved_story_flow_ids: list[str] = Field(
        default_factory=list, max_length=EXPORT_MAX_RECORDS
    )

    @field_validator("resolved_story_flow_ids")
    @classmethod
    def validate_resolved_flow_ids(cls, values: list[str]) -> list[str]:
        normalized = [_validate_identifier(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise _contract_error("export_contract_invalid")
        return normalized

    @model_validator(mode="after")
    def validate_record_count(self) -> "ExportInventoryV1":
        counted = sum(
            getattr(self, field_name)
            for field_name in self.__class__.model_fields
            if field_name.endswith("_count") and field_name not in {"diagnostic_count", "record_count"}
        )
        if counted != self.record_count:
            raise _contract_error("export_contract_invalid")
        return self


class ExportPreviewV1(ExportContractModel):
    preview_version: Literal[1] = 1
    media_type: Literal[
        "application/json", "application/yaml", "text/x-yarnspinner", "text/x-ink"
    ]
    text: str
    preview_bytes: int = Field(ge=0, le=EXPORT_MAX_PREVIEW_BYTES)
    total_bytes: int = Field(ge=0, le=EXPORT_MAX_OUTPUT_BYTES)
    truncated: bool

    @field_validator("text")
    @classmethod
    def validate_preview_text(cls, value: str) -> str:
        return _validate_text(value)

    @model_validator(mode="after")
    def validate_byte_counts(self) -> "ExportPreviewV1":
        actual = len(self.text.encode("utf-8"))
        if actual != self.preview_bytes or self.preview_bytes > self.total_bytes:
            raise _contract_error("export_contract_invalid")
        if self.truncated != (self.preview_bytes < self.total_bytes):
            raise _contract_error("export_contract_invalid")
        return self


class ExportPortableExtensionsV1(ExportContractModel):
    """Namespaced unknown metadata is preserved only through this explicit field."""

    extension_version: Literal[1] = 1
    values: dict[str, Any] = Field(default_factory=dict, max_length=64)

    @field_validator("values")
    @classmethod
    def validate_values(cls, value: dict[str, Any]) -> dict[str, Any]:
        if any(not _EXTENSION_KEY_PATTERN.fullmatch(key) for key in value):
            raise _contract_error("export_projection_unsafe")
        _validate_json_value(value)
        return value


class ExportRequirementV1(ExportContractModel):
    """Allowlisted authored Condition fields formerly stored in node metadata."""

    subject: str = ""
    predicate: str = ""
    expression: str = ""


class ExportOutcomeV1(ExportContractModel):
    """Allowlisted authored Consequence fields with stable canonical targets."""

    effect: str = ""
    target_node_ids: list[str] = Field(default_factory=list, max_length=EXPORT_MAX_RECORDS)

    @field_validator("target_node_ids")
    @classmethod
    def validate_target_ids(cls, values: list[str]) -> list[str]:
        normalized = [_validate_identifier(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise _contract_error("export_contract_invalid")
        return normalized


class ExportNodeAttributesV1(ExportContractModel):
    """Known narrative node metadata; canvas and editor fields are absent."""

    attributes_version: Literal[1] = 1
    character_role: str | None = None
    item_purpose: str | None = None
    requirement: ExportRequirementV1 | None = None
    outcome: ExportOutcomeV1 | None = None


class ExportManifestV1(ExportContractModel):
    schema_version: Literal[1] = 1
    kind: Literal["narrative_export"] = "narrative_export"
    source: ExportSourceIdentityV1
    scope: ExportScope
    story_flow_ids: list[str] = Field(default_factory=list, max_length=EXPORT_MAX_SELECTED_FLOWS)
    engine_tag_target: EngineTagProjectionTarget

    @field_validator("story_flow_ids")
    @classmethod
    def validate_story_flow_ids(cls, values: list[str]) -> list[str]:
        normalized = [_validate_identifier(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise _contract_error("export_contract_invalid")
        return normalized


class ExportProjectV1(ExportContractModel):
    project_version: Literal[1] = 1
    id: str
    name: str
    description: str = ""
    content_locale: str = Field(min_length=2, max_length=35)
    extensions: ExportPortableExtensionsV1 = Field(default_factory=ExportPortableExtensionsV1)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return _validate_identifier(value)

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_nonempty_text(value)

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        return _validate_text(value)


class ExportNodeV1(ExportContractModel):
    node_version: Literal[1] = 1
    id: str
    type: str = Field(min_length=1, max_length=64)
    title: str
    summary: str = ""
    body: str = ""
    status: str = Field(min_length=1, max_length=64)
    tags: list[str] = Field(default_factory=list, max_length=256)
    container_node_ids: list[str] = Field(default_factory=list, max_length=EXPORT_MAX_RECORDS)
    attributes: ExportNodeAttributesV1 = Field(default_factory=ExportNodeAttributesV1)
    extensions: ExportPortableExtensionsV1 = Field(default_factory=ExportPortableExtensionsV1)

    @field_validator("id")
    @classmethod
    def validate_id(cls, value: str) -> str:
        return _validate_identifier(value)

    @field_validator("title")
    @classmethod
    def validate_title(cls, value: str) -> str:
        return _validate_nonempty_text(value)

    @field_validator("summary", "body")
    @classmethod
    def validate_authored_text(cls, value: str) -> str:
        return _validate_text(value)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, values: list[str]) -> list[str]:
        normalized = [_validate_nonempty_text(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise _contract_error("export_contract_invalid")
        return normalized

    @field_validator("container_node_ids")
    @classmethod
    def validate_container_ids(cls, values: list[str]) -> list[str]:
        normalized = [_validate_identifier(value) for value in values]
        if len(normalized) != len(set(normalized)):
            raise _contract_error("export_contract_invalid")
        return normalized


class ExportRelationshipV1(ExportContractModel):
    relationship_version: Literal[1] = 1
    id: str
    source_node_id: str
    target_node_id: str
    type: str = Field(min_length=1, max_length=64)
    label: str = ""
    condition: str = ""
    extensions: ExportPortableExtensionsV1 = Field(default_factory=ExportPortableExtensionsV1)

    @field_validator("id", "source_node_id", "target_node_id")
    @classmethod
    def validate_ids(cls, value: str) -> str:
        return _validate_identifier(value)

    @field_validator("label", "condition")
    @classmethod
    def validate_authored_text(cls, value: str) -> str:
        return _validate_text(value)


class ExportDialogueV1(ExportContractModel):
    aggregate_version: Literal[1] = 1
    node_id: str
    document: DialogueDocument

    @model_validator(mode="after")
    def validate_nested_ids(self) -> "ExportDialogueV1":
        for participant in self.document.participants:
            _validate_identifier(participant)
        for element in self.document.elements:
            _validate_identifier(element.id)
            if hasattr(element, "speaker_node_id"):
                _validate_identifier(element.speaker_node_id)
            if hasattr(element, "next_element_id") and element.next_element_id is not None:
                _validate_identifier(element.next_element_id)
            for option in getattr(element, "options", []):
                _validate_identifier(option.id)
                if option.next_element_id is not None:
                    _validate_identifier(option.next_element_id)
        return self


class ExportQuestV1(ExportContractModel):
    aggregate_version: Literal[1] = 1
    node_id: str
    document: QuestDocument

    @model_validator(mode="after")
    def validate_nested_ids(self) -> "ExportQuestV1":
        optional_ids = (
            self.document.quest_giver_node_id,
            self.document.entry_stage_id,
            *self.document.prerequisite_node_ids,
            *self.document.reward_node_ids,
        )
        for identifier in optional_ids:
            if identifier is not None:
                _validate_identifier(identifier)
        for stage in self.document.stages:
            _validate_identifier(stage.id)
            for branch in stage.branches:
                _validate_identifier(branch.id)
                if branch.target_stage_id is not None:
                    _validate_identifier(branch.target_stage_id)
        return self


class ExportStoryFlowDefinitionV1(ExportContractModel):
    id: str
    name: str
    description: str = ""
    kind: str
    status: str
    entry_node_id: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        return _validate_nonempty_text(value)


class ExportStoryFlowMembershipV1(ExportContractModel):
    id: str
    flow_id: str
    node_id: str
    presentation_order: int = Field(ge=0)


class ExportFlowTransitionV1(ExportContractModel):
    id: str
    flow_id: str
    source_node_id: str
    target_node_id: str
    priority: int = Field(ge=0)
    kind: str
    label: str = ""
    condition: str = ""
    is_default: bool = False
    dialogue_element_id: str | None = None
    quest_branch_id: str | None = None


class ExportSceneFlowBoundaryV1(ExportContractModel):
    id: str
    flow_id: str
    scene_node_id: str
    entry_node_id: str
    exit_node_ids: list[str] = Field(default_factory=list)


class ExportFlowInvocationV1(ExportContractModel):
    id: str
    source_flow_id: str
    source_node_id: str
    target_flow_id: str
    label: str = ""
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False


class ExportFlowExitV1(ExportContractModel):
    id: str
    flow_id: str
    key: str
    label: str = ""
    source_node_id: str

    @field_validator("key")
    @classmethod
    def validate_key(cls, value: str) -> str:
        return _validate_identifier(value)


class ExportFlowExitBindingV1(ExportContractModel):
    id: str
    invocation_id: str
    exit_id: str
    target_node_id: str


class ExportStoryFlowsV1(ExportContractModel):
    story_flows_version: Literal[1] = 1
    definitions: list[ExportStoryFlowDefinitionV1] = Field(default_factory=list)
    memberships: list[ExportStoryFlowMembershipV1] = Field(default_factory=list)
    transitions: list[ExportFlowTransitionV1] = Field(default_factory=list)
    scene_boundaries: list[ExportSceneFlowBoundaryV1] = Field(default_factory=list)
    invocations: list[ExportFlowInvocationV1] = Field(default_factory=list)
    exits: list[ExportFlowExitV1] = Field(default_factory=list)
    exit_bindings: list[ExportFlowExitBindingV1] = Field(default_factory=list)


class ExportStateHolderV1(ExportContractModel):
    holder_version: Literal[1] = 1
    kind: Literal["character", "location", "faction", "player", "party", "unowned"]
    node_id: str | None = None

    @model_validator(mode="after")
    def validate_holder_shape(self) -> "ExportStateHolderV1":
        needs_node = self.kind in {"character", "location", "faction"}
        if needs_node != (self.node_id is not None):
            raise _contract_error("export_contract_invalid")
        return self


class ExportItemCustodyV1(ExportContractModel):
    custody_version: Literal[1] = 1
    item_node_id: str
    holder: ExportStateHolderV1


class ExportFlowInitialStateV1(ExportContractModel):
    state_version: Literal[1] = 1
    id: str
    flow_id: str
    flags: dict[str, bool] = Field(default_factory=dict)
    item_custody: list[ExportItemCustodyV1] = Field(default_factory=list)
    quest_statuses: dict[str, Literal["inactive", "active", "completed", "failed"]] = Field(
        default_factory=dict
    )


class ExportTransferItemPayloadV1(ExportContractModel):
    item_node_id: str
    from_holder: ExportStateHolderV1
    to_holder: ExportStateHolderV1


class ExportFlagEffectPayloadV1(ExportContractModel):
    flag: str = Field(min_length=1, max_length=128)


class ExportQuestStatusEffectPayloadV1(ExportContractModel):
    quest_node_id: str
    status: Literal["inactive", "active", "completed", "failed"]


class ExportDialogueChoiceEffectPayloadV1(ExportContractModel):
    dialogue_node_id: str
    choice_id: str


class ExportNarrativeEffectBaseV1(ExportContractModel):
    effect_version: Literal[1] = 1
    id: str
    repeat_policy: Literal["once", "per_visit"]
    explanation: str


class ExportTransferItemEffectV1(ExportNarrativeEffectBaseV1):
    operation: Literal["transfer_item"]
    payload: ExportTransferItemPayloadV1


class ExportSetFlagEffectV1(ExportNarrativeEffectBaseV1):
    operation: Literal["set_flag"]
    payload: ExportFlagEffectPayloadV1


class ExportClearFlagEffectV1(ExportNarrativeEffectBaseV1):
    operation: Literal["clear_flag"]
    payload: ExportFlagEffectPayloadV1


class ExportSetQuestStatusEffectV1(ExportNarrativeEffectBaseV1):
    operation: Literal["set_quest_status"]
    payload: ExportQuestStatusEffectPayloadV1


class ExportRecordDialogueChoiceEffectV1(ExportNarrativeEffectBaseV1):
    operation: Literal["record_dialogue_choice"]
    payload: ExportDialogueChoiceEffectPayloadV1


ExportNarrativeEffectV1 = Annotated[
    ExportTransferItemEffectV1
    | ExportSetFlagEffectV1
    | ExportClearFlagEffectV1
    | ExportSetQuestStatusEffectV1
    | ExportRecordDialogueChoiceEffectV1,
    Field(discriminator="operation"),
]


class ExportNarrativeEffectBindingV1(ExportContractModel):
    binding_version: Literal[1] = 1
    id: str
    effect_id: str
    owner_kind: Literal[
        "node_entry", "flow_transition", "dialogue_element", "dialogue_option",
        "quest_branch", "quest_outcome", "flow_invocation", "flow_exit",
    ]
    owner_id: str
    context_node_id: str | None = None
    application_order: int = Field(ge=0)


class ExportNarrativeStateV1(ExportContractModel):
    narrative_state_version: Literal[1] = 1
    initial_states: list[ExportFlowInitialStateV1] = Field(default_factory=list)
    effects: list[ExportNarrativeEffectV1] = Field(default_factory=list)
    bindings: list[ExportNarrativeEffectBindingV1] = Field(default_factory=list)


class ExportEngineTagsV1(ExportContractModel):
    engine_tags_version: Literal[1] = 1
    project_id: str
    source_checksum: str = Field(pattern=_CHECKSUM_PATTERN)
    target: EngineTagProjectionTarget
    entries: list[EngineTagProjectionEntryV1] = Field(default_factory=list)
    omitted: list[EngineTagProjectionOmissionV1] = Field(default_factory=list)
    diagnostics: list[EngineTagProjectionDiagnosticV1] = Field(default_factory=list)


class ExportProjectionV1(ExportContractModel):
    """External allowlist; it intentionally does not inherit ProjectDocument."""

    projection_version: Literal[1] = 1
    manifest: ExportManifestV1
    project: ExportProjectV1
    nodes: list[ExportNodeV1] = Field(default_factory=list)
    relationships: list[ExportRelationshipV1] = Field(default_factory=list)
    dialogues: list[ExportDialogueV1] = Field(default_factory=list)
    quests: list[ExportQuestV1] = Field(default_factory=list)
    story_flows: ExportStoryFlowsV1 = Field(default_factory=ExportStoryFlowsV1)
    narrative_state: ExportNarrativeStateV1 = Field(default_factory=ExportNarrativeStateV1)
    engine_tags: ExportEngineTagsV1
    diagnostics: list[ExportDiagnosticV1] = Field(
        default_factory=list, max_length=EXPORT_MAX_DIAGNOSTICS
    )

    @model_validator(mode="after")
    def validate_inventory_shape(self) -> "ExportProjectionV1":
        if self.project.id != self.manifest.source.project_id:
            raise _contract_error("export_contract_invalid")
        if self.engine_tags.target != self.manifest.engine_tag_target:
            raise _contract_error("export_contract_invalid")
        if self.engine_tags.project_id != self.manifest.source.project_id:
            raise _contract_error("export_contract_invalid")
        if self.engine_tags.source_checksum != self.manifest.source.source_checksum:
            raise _contract_error("export_contract_invalid")
        collections: tuple[tuple[str, list[Any]], ...] = (
            ("nodes", list(self.nodes)),
            ("relationships", list(self.relationships)),
            ("dialogues", list(self.dialogues)),
            ("quests", list(self.quests)),
            ("story flows", list(self.story_flows.definitions)),
            ("memberships", list(self.story_flows.memberships)),
            ("transitions", list(self.story_flows.transitions)),
            ("scene boundaries", list(self.story_flows.scene_boundaries)),
            ("invocations", list(self.story_flows.invocations)),
            ("flow exits", list(self.story_flows.exits)),
            ("exit bindings", list(self.story_flows.exit_bindings)),
            ("initial states", list(self.narrative_state.initial_states)),
            ("effects", list(self.narrative_state.effects)),
            ("effect bindings", list(self.narrative_state.bindings)),
        )
        total = 0
        for label, records in collections:
            total += len(records)
            ids = [getattr(record, "id", getattr(record, "node_id", "")) for record in records]
            if len(ids) != len(set(ids)):
                raise ValueError(f"{label} contains duplicate ids")
        if total > EXPORT_MAX_RECORDS:
            raise _contract_error("export_limit_exceeded")
        return self


class ExportProjectionBuildV1(ExportContractModel):
    """Pure planner output consumed later by preview and serialization tasks."""

    build_version: Literal[1] = 1
    projection: ExportProjectionV1
    inventory: ExportInventoryV1


class ExportPlanV1(ExportContractModel):
    plan_version: Literal[1] = 1
    options: ExportOptionsV1
    source: ExportSourceIdentityV1
    inventory: ExportInventoryV1
    diagnostics: list[ExportDiagnosticV1] = Field(
        default_factory=list, max_length=EXPORT_MAX_DIAGNOSTICS
    )
    preview: ExportPreviewV1
    suggested_filename: str
    plan_fingerprint: str = Field(pattern=_CHECKSUM_PATTERN)
    can_write: bool

    @field_validator("suggested_filename")
    @classmethod
    def validate_filename(cls, value: str) -> str:
        return _validate_name(value)

    @model_validator(mode="after")
    def validate_write_gate(self) -> "ExportPlanV1":
        has_error = any(item.severity == "error" for item in self.diagnostics)
        if self.can_write == has_error:
            raise _contract_error("export_contract_invalid")
        return self


class ExportWriteRequestV1(ExportContractModel):
    request_version: Literal[1] = 1
    options: ExportOptionsV1
    expected_source_checksum: str = Field(pattern=_CHECKSUM_PATTERN)
    expected_plan_fingerprint: str = Field(pattern=_CHECKSUM_PATTERN)
    destination_directory: str | None = Field(
        default=None, min_length=1, max_length=EXPORT_MAX_PATH_LENGTH
    )
    overwrite: bool = False

    @field_validator("destination_directory")
    @classmethod
    def validate_destination(cls, value: str | None) -> str | None:
        if value is None:
            return None
        segments = [segment for segment in re.split(r"[\\/]", value) if segment]
        if _CONTROL_PATTERN.search(value) or "\x00" in value or ".." in segments:
            raise _contract_error("export_path_invalid")
        return value


class ExportArtifactV1(ExportContractModel):
    artifact_version: Literal[1] = 1
    format: ExportFormat
    filename: str
    installed_path: str = Field(min_length=1, max_length=EXPORT_MAX_PATH_LENGTH)
    artifact_checksum: str = Field(pattern=_CHECKSUM_PATTERN)
    source_checksum: str = Field(pattern=_CHECKSUM_PATTERN)
    bytes_written: int = Field(ge=0, le=EXPORT_MAX_OUTPUT_BYTES)

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, value: str) -> str:
        return _validate_name(value)


class ExportWriteResultV1(ExportContractModel):
    result_version: Literal[1] = 1
    artifact: ExportArtifactV1


class ExportErrorV1(ExportContractModel):
    error_version: Literal[1] = 1
    code: ExportErrorCode
    message_key: str = Field(pattern=r"^export\.error\.[a-z0-9_.-]+$")
    parameters: dict[str, Any] = Field(default_factory=dict, max_length=32)
