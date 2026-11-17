"""Storage-neutral contracts for portable narrative style configuration."""

from __future__ import annotations

from datetime import UTC, datetime
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from pydantic_core import PydanticCustomError

STYLE_PROFILE_VERSION = 1
SCENE_STYLE_ASSIGNMENT_VERSION = 1
STYLE_CATALOG_VERSION = 1
STYLE_SYSTEM_SETTINGS_VERSION = 1
STYLE_PROFILE_FILE_VERSION = 1
STYLE_DELETION_IMPACT_VERSION = 1

STYLE_PROFILE_MAX_NAME_CHARACTERS = 120
STYLE_PROFILE_MAX_DESCRIPTION_CHARACTERS = 1_000
STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS = 12_000
STYLE_PROFILE_MAX_EXAMPLES = 12
STYLE_PROFILE_MAX_EXAMPLE_CHARACTERS = 2_000
STYLE_PROFILE_MAX_TRAITS_PER_GROUP = 12
STYLE_PROFILE_MAX_TRAIT_CHARACTERS = 120

StyleAgentMode = Literal["disabled", "configured"]
StyleContentPolicy = Literal["never", "explicit_consent"]
StyleContractErrorCode = Literal[
    "style_profile_invalid",
    "style_profile_duplicate",
    "style_profile_oversized",
    "style_profile_not_found",
    "style_profile_in_use",
    "style_profile_import_collision",
    "style_profile_import_invalid",
    "style_profile_export_failed",
    "style_project_not_found",
    "style_profile_secret_forbidden",
    "style_scene_assignment_duplicate",
    "style_scene_invalid",
]

_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SECRET_PATTERNS = (
    re.compile(r"\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b", re.IGNORECASE),
    re.compile(r"\bAIza[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~-]{20,}\b", re.IGNORECASE),
)

StyleTrait = str
StyleExample = str


class StyleContractModel(BaseModel):
    """Keep portable contracts strict and immutable after validation."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class StyleProfileTraitsV1(StyleContractModel):
    """Bounded authored traits used as provider guidance, never as a prompt template."""

    traits_version: Literal[1] = 1
    tone: tuple[StyleTrait, ...] = Field(
        default=(), max_length=STYLE_PROFILE_MAX_TRAITS_PER_GROUP
    )
    rhythm: tuple[StyleTrait, ...] = Field(
        default=(), max_length=STYLE_PROFILE_MAX_TRAITS_PER_GROUP
    )
    pacing: tuple[StyleTrait, ...] = Field(
        default=(), max_length=STYLE_PROFILE_MAX_TRAITS_PER_GROUP
    )
    vocabulary: tuple[StyleTrait, ...] = Field(
        default=(), max_length=STYLE_PROFILE_MAX_TRAITS_PER_GROUP
    )
    dramatic_intensity: StyleTrait | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_oversized_traits(cls, value: Any) -> Any:
        _validate_contract_shape(
            value,
            allowed={
                "traits_version",
                "tone",
                "rhythm",
                "pacing",
                "vocabulary",
                "dramatic_intensity",
            },
            version_field="traits_version",
            version=1,
            code="style_profile_invalid",
        )
        if not isinstance(value, dict):
            return value
        for field in ("tone", "rhythm", "pacing", "vocabulary"):
            group = value.get(field, ())
            if isinstance(group, (list, tuple)):
                if len(group) > STYLE_PROFILE_MAX_TRAITS_PER_GROUP or any(
                    isinstance(item, str)
                    and len(item.strip()) > STYLE_PROFILE_MAX_TRAIT_CHARACTERS
                    for item in group
                ):
                    raise _error("style_profile_oversized", field)
                if any(not isinstance(item, str) or not item.strip() for item in group):
                    raise _error("style_profile_invalid", field)
        intensity = value.get("dramatic_intensity")
        if isinstance(intensity, str) and len(intensity.strip()) > STYLE_PROFILE_MAX_TRAIT_CHARACTERS:
            raise _error("style_profile_oversized", "dramatic_intensity")
        if intensity is not None and (not isinstance(intensity, str) or not intensity.strip()):
            raise _error("style_profile_invalid", "dramatic_intensity")
        return value

    @field_validator("tone", "rhythm", "pacing", "vocabulary")
    @classmethod
    def normalize_trait_group(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return _normalize_unique_text(values, "style_profile_invalid")

    @field_validator("dramatic_intensity")
    @classmethod
    def normalize_intensity(cls, value: str | None) -> str | None:
        return _normalize_optional_text(value, "style_profile_invalid")


class StyleProfileV1(StyleContractModel):
    """One project-owned style identity without provider or machine configuration."""

    style_profile_version: Literal[1] = STYLE_PROFILE_VERSION
    id: str
    project_id: str
    name: str
    description: str = ""
    guidance: str
    traits: StyleProfileTraitsV1 = Field(default_factory=StyleProfileTraitsV1)
    positive_examples: tuple[StyleExample, ...] = Field(
        default=(), max_length=STYLE_PROFILE_MAX_EXAMPLES
    )
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def reject_oversized_profile(cls, value: Any) -> Any:
        _validate_contract_shape(
            value,
            allowed={
                "style_profile_version",
                "id",
                "project_id",
                "name",
                "description",
                "guidance",
                "traits",
                "positive_examples",
                "created_at",
                "updated_at",
            },
            version_field="style_profile_version",
            version=STYLE_PROFILE_VERSION,
            code="style_profile_invalid",
        )
        if not isinstance(value, dict):
            return value
        limits = {
            "name": STYLE_PROFILE_MAX_NAME_CHARACTERS,
            "description": STYLE_PROFILE_MAX_DESCRIPTION_CHARACTERS,
            "guidance": STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS,
        }
        for field, maximum in limits.items():
            candidate = value.get(field)
            if isinstance(candidate, str) and len(candidate.strip()) > maximum:
                raise _error("style_profile_oversized", field)
        if any(
            not isinstance(value.get(field), str) or not value[field].strip()
            for field in ("name", "guidance")
        ):
            raise _error("style_profile_invalid", "required_text")
        examples = value.get("positive_examples", ())
        if isinstance(examples, (list, tuple)) and (
            len(examples) > STYLE_PROFILE_MAX_EXAMPLES
            or any(
                isinstance(item, str)
                and len(item.strip()) > STYLE_PROFILE_MAX_EXAMPLE_CHARACTERS
                for item in examples
            )
        ):
            raise _error("style_profile_oversized", "positive_examples")
        if isinstance(examples, (list, tuple)) and any(
            not isinstance(item, str) or not item.strip() for item in examples
        ):
            raise _error("style_profile_invalid", "positive_examples")
        return value

    @field_validator("id", "project_id")
    @classmethod
    def validate_identity(cls, value: str) -> str:
        normalized = value.strip()
        if not _ID_PATTERN.fullmatch(normalized):
            raise _error("style_profile_invalid", value)
        return normalized

    @field_validator("name", "guidance")
    @classmethod
    def normalize_required_text(cls, value: str) -> str:
        return _normalize_required_text(value, "style_profile_invalid")

    @field_validator("description")
    @classmethod
    def normalize_description(cls, value: str) -> str:
        return value.strip()

    @field_validator("positive_examples")
    @classmethod
    def normalize_examples(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        return _normalize_unique_text(values, "style_profile_invalid")

    @field_validator("created_at", "updated_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise _error("style_profile_invalid", value)
        return value

    @model_validator(mode="after")
    def validate_profile(self) -> "StyleProfileV1":
        if self.updated_at < self.created_at:
            raise _error("style_profile_invalid", self.updated_at)
        _reject_secret_shaped_values(
            (
                self.name,
                self.description,
                self.guidance,
                *self.positive_examples,
                *self.traits.tone,
                *self.traits.rhythm,
                *self.traits.pacing,
                *self.traits.vocabulary,
                *(value for value in (self.traits.dramatic_intensity,) if value),
            )
        )
        return self


class SceneStyleAssignmentV1(StyleContractModel):
    """Assign one stable style profile to one canonical Scene node."""

    assignment_version: Literal[1] = SCENE_STYLE_ASSIGNMENT_VERSION
    id: str
    project_id: str
    scene_node_id: str
    style_profile_id: str
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="before")
    @classmethod
    def validate_shape(cls, value: Any) -> Any:
        _validate_contract_shape(
            value,
            allowed={
                "assignment_version",
                "id",
                "project_id",
                "scene_node_id",
                "style_profile_id",
                "created_at",
                "updated_at",
            },
            version_field="assignment_version",
            version=SCENE_STYLE_ASSIGNMENT_VERSION,
            code="style_scene_invalid",
        )
        return value

    @field_validator("id", "project_id", "scene_node_id", "style_profile_id")
    @classmethod
    def validate_identity(cls, value: str) -> str:
        normalized = value.strip()
        if not _ID_PATTERN.fullmatch(normalized):
            raise _error("style_scene_invalid", value)
        return normalized

    @field_validator("created_at", "updated_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise _error("style_scene_invalid", value)
        return value

    @model_validator(mode="after")
    def validate_timestamp_order(self) -> "SceneStyleAssignmentV1":
        if self.updated_at < self.created_at:
            raise _error("style_scene_invalid", self.updated_at)
        return self


class StyleSystemSettingsV1(BaseModel):
    """Portable style policy; unknown future settings survive older clients."""

    model_config = ConfigDict(extra="allow")

    style_system_version: Literal[1] = STYLE_SYSTEM_SETTINGS_VERSION
    default_style_profile_id: str | None = None
    agent_mode: StyleAgentMode = "disabled"
    content_policy: StyleContentPolicy = "never"

    @model_validator(mode="before")
    @classmethod
    def validate_version(cls, value: Any) -> Any:
        if isinstance(value, dict) and value.get(
            "style_system_version", STYLE_SYSTEM_SETTINGS_VERSION
        ) != STYLE_SYSTEM_SETTINGS_VERSION:
            raise _error("style_profile_invalid", value.get("style_system_version"))
        return value

    @field_validator("default_style_profile_id")
    @classmethod
    def normalize_default_profile(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not _ID_PATTERN.fullmatch(normalized):
            raise _error("style_profile_invalid", value)
        return normalized

    @model_validator(mode="after")
    def validate_agent_policy(self) -> "StyleSystemSettingsV1":
        valid_policy = (
            self.agent_mode == "disabled" and self.content_policy == "never"
        ) or (
            self.agent_mode == "configured"
            and self.content_policy == "explicit_consent"
        )
        if not valid_policy:
            raise _error("style_profile_invalid", self.content_policy)
        return self


class StyleCatalogV1(StyleContractModel):
    """Storage-neutral reference envelope used before repositories are introduced."""

    catalog_version: Literal[1] = STYLE_CATALOG_VERSION
    project_id: str
    default_style_profile_id: str | None = None
    profiles: tuple[StyleProfileV1, ...] = ()
    scene_assignments: tuple[SceneStyleAssignmentV1, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def validate_shape(cls, value: Any) -> Any:
        _validate_contract_shape(
            value,
            allowed={
                "catalog_version",
                "project_id",
                "default_style_profile_id",
                "profiles",
                "scene_assignments",
            },
            version_field="catalog_version",
            version=STYLE_CATALOG_VERSION,
            code="style_profile_invalid",
        )
        return value

    @field_validator("project_id")
    @classmethod
    def validate_project_id(cls, value: str) -> str:
        normalized = value.strip()
        if not _ID_PATTERN.fullmatch(normalized):
            raise _error("style_profile_invalid", value)
        return normalized

    @field_validator("default_style_profile_id")
    @classmethod
    def validate_default_profile_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not _ID_PATTERN.fullmatch(normalized):
            raise _error("style_profile_invalid", value)
        return normalized

    @model_validator(mode="after")
    def validate_references(self) -> "StyleCatalogV1":
        profile_ids = [profile.id for profile in self.profiles]
        if len(profile_ids) != len(set(profile_ids)):
            raise _error("style_profile_duplicate", profile_ids)
        assignment_ids = [assignment.id for assignment in self.scene_assignments]
        scene_ids = [assignment.scene_node_id for assignment in self.scene_assignments]
        if len(assignment_ids) != len(set(assignment_ids)) or len(scene_ids) != len(set(scene_ids)):
            raise _error("style_scene_assignment_duplicate", scene_ids)
        if any(profile.project_id != self.project_id for profile in self.profiles):
            raise _error("style_profile_invalid", self.project_id)
        if any(assignment.project_id != self.project_id for assignment in self.scene_assignments):
            raise _error("style_scene_invalid", self.project_id)
        known_profiles = set(profile_ids)
        references = [
            *(value for value in (self.default_style_profile_id,) if value is not None),
            *(assignment.style_profile_id for assignment in self.scene_assignments),
        ]
        missing = sorted(set(references) - known_profiles)
        if missing:
            raise _error("style_profile_not_found", missing[0])
        return self


class StyleProfileFileV1(StyleContractModel):
    """Project-neutral JSON interchange envelope for one authored profile."""

    file_version: Literal[1] = STYLE_PROFILE_FILE_VERSION
    id: str
    name: str
    description: str = ""
    guidance: str
    traits: StyleProfileTraitsV1 = Field(default_factory=StyleProfileTraitsV1)
    positive_examples: tuple[str, ...] = ()

    @model_validator(mode="before")
    @classmethod
    def validate_shape_and_bounds(cls, value: Any) -> Any:
        _validate_contract_shape(
            value,
            allowed={
                "file_version",
                "id",
                "name",
                "description",
                "guidance",
                "traits",
                "positive_examples",
            },
            version_field="file_version",
            version=STYLE_PROFILE_FILE_VERSION,
            code="style_profile_invalid",
        )
        if not isinstance(value, dict):
            return value
        # Reuse the canonical profile validator so file and database limits cannot drift.
        marker = datetime(2000, 1, 1, tzinfo=UTC)
        StyleProfileV1.model_validate(
            {
                "style_profile_version": STYLE_PROFILE_VERSION,
                "project_id": "portable",
                "created_at": marker,
                "updated_at": marker,
                **{key: item for key, item in value.items() if key != "file_version"},
            }
        )
        return value


class StyleProfileDeletionImpactV1(StyleContractModel):
    """References that must be replaced or cleared before profile deletion."""

    impact_version: Literal[1] = STYLE_DELETION_IMPACT_VERSION
    profile_id: str
    uses_project_default: bool
    scene_node_ids: tuple[str, ...] = ()

    @property
    def in_use(self) -> bool:
        return self.uses_project_default or bool(self.scene_node_ids)


def _normalize_required_text(value: str, code: StyleContractErrorCode) -> str:
    normalized = value.strip()
    if not normalized:
        raise _error(code, value)
    return normalized


def _validate_contract_shape(
    value: Any,
    *,
    allowed: set[str],
    version_field: str,
    version: int,
    code: StyleContractErrorCode,
) -> None:
    """Map strict-shape and future-version failures to one stable domain code."""

    if not isinstance(value, dict):
        return
    if value.get(version_field, version) != version or set(value) - allowed:
        raise _error(code, value.get(version_field, "unknown"))


def _normalize_optional_text(value: str | None, code: StyleContractErrorCode) -> str | None:
    if value is None:
        return None
    return _normalize_required_text(value, code)


def _normalize_unique_text(
    values: tuple[str, ...], code: StyleContractErrorCode
) -> tuple[str, ...]:
    normalized = tuple(_normalize_required_text(value, code) for value in values)
    folded = [value.casefold() for value in normalized]
    if len(folded) != len(set(folded)):
        raise _error(code, values)
    return normalized


def _reject_secret_shaped_values(values: tuple[str, ...]) -> None:
    if any(pattern.search(value) for value in values for pattern in _SECRET_PATTERNS):
        raise _error("style_profile_secret_forbidden", "redacted")


def _error(code: StyleContractErrorCode, value: Any) -> PydanticCustomError:
    messages = {
        "style_profile_invalid": "Style profile value is invalid",
        "style_profile_duplicate": "Style profile id is duplicated",
        "style_profile_oversized": "Style profile value exceeds its limit",
        "style_profile_not_found": "Style profile reference does not exist",
        "style_profile_in_use": "Style profile is still assigned",
        "style_profile_import_collision": "Imported style profile id already exists",
        "style_profile_import_invalid": "Imported style profile is invalid",
        "style_profile_export_failed": "Style profile export failed",
        "style_project_not_found": "Style profile project does not exist",
        "style_profile_secret_forbidden": "Style profile must not contain credentials",
        "style_scene_assignment_duplicate": "Scene style assignment is duplicated",
        "style_scene_invalid": "Scene style assignment is invalid",
    }
    return PydanticCustomError(code, messages[code], {"value": value})
