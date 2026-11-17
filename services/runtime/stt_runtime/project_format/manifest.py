import re
from copy import deepcopy
from datetime import datetime
from pathlib import PurePosixPath, PureWindowsPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from ..schemas.style_system import StyleSystemSettingsV1

PROJECT_FORMAT_VERSION = 2
PROJECT_SETTINGS_VERSION = 5
CANON_CHECK_SETTINGS_VERSION = 1
AGENT_PROVIDERS_VERSION = 1
IMPACT_RESOLVER_SETTINGS_VERSION = 1
DEFAULT_AUTOSAVE_INTERVAL_SECONDS = 300
SUPPORTED_PROJECT_LOCALES = ("en", "ru")

ProjectLocale = Literal["en", "ru"]
StorageMode = Literal["local_sqlite", "postgresql"]
CanonAgentMode = Literal["disabled", "configured"]
CanonContentPolicy = Literal["never", "evidence_only"]
CanonSeverity = Literal["info", "warning", "critical"]
AgentProviderSource = Literal["project_default", "override"]
ImpactResolverMode = Literal["disabled", "configured"]
ImpactResolverContentPolicy = Literal["never", "bounded_evidence"]

_RULE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")

_FORBIDDEN_SECRET_KEYS = {
    "access_token",
    "api_key",
    "credential",
    "credentials",
    "password",
    "private_key",
    "refresh_token",
    "secret",
    "token",
}
_FORBIDDEN_SECRET_SUFFIXES = (
    "_api_key",
    "_credentials",
    "_password",
    "_private_key",
    "_secret",
    "_token",
)


class ProjectManifestError(ValueError):
    """Reports a manifest compatibility or migration failure."""


class AutosaveSettings(BaseModel):
    """Portable autosave policy; future optional fields survive round trips."""

    model_config = ConfigDict(extra="allow")

    enabled: bool = True
    interval_seconds: int = Field(default=DEFAULT_AUTOSAVE_INTERVAL_SECONDS, ge=60)


class StorageSettings(BaseModel):
    """Selects storage without exposing machine-local connection credentials."""

    model_config = ConfigDict(extra="allow")

    mode: StorageMode = "local_sqlite"
    connection_profile_id: str | None = None

    @field_validator("connection_profile_id")
    @classmethod
    def normalize_profile_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("connection_profile_id must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_storage_combination(self) -> "StorageSettings":
        if self.mode == "local_sqlite" and self.connection_profile_id is not None:
            raise ValueError("local_sqlite must not reference a connection profile")
        if self.mode == "postgresql" and self.connection_profile_id is None:
            raise ValueError("postgresql requires connection_profile_id")
        return self


class AgentProviderAssignment(BaseModel):
    """One agent's portable provider source and independent model choice."""

    model_config = ConfigDict(extra="allow")

    provider_source: AgentProviderSource = "project_default"
    provider_profile_override_id: str | None = None
    model_id: str | None = None

    @field_validator("provider_profile_override_id", "model_id")
    @classmethod
    def normalize_optional_reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("agent provider and model references must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_source(self) -> "AgentProviderAssignment":
        if self.provider_source == "project_default" and self.provider_profile_override_id is not None:
            raise ValueError("project_default agent must not retain an override profile")
        if self.provider_source == "override" and self.provider_profile_override_id is None:
            raise ValueError("override agent requires a provider profile")
        return self


class AgentProviderAssignments(BaseModel):
    """Known agents are explicit while future agent assignments survive round trips."""

    model_config = ConfigDict(extra="allow")

    canon_checker: AgentProviderAssignment = Field(default_factory=AgentProviderAssignment)
    impact_resolver: AgentProviderAssignment = Field(default_factory=AgentProviderAssignment)
    style_rewriter: AgentProviderAssignment = Field(default_factory=AgentProviderAssignment)


class AgentProvidersSettings(BaseModel):
    """Portable references into the encrypted machine-local provider registry."""

    model_config = ConfigDict(extra="allow")

    agent_providers_version: Literal[1] = AGENT_PROVIDERS_VERSION
    default_provider_profile_id: str | None = None
    agents: AgentProviderAssignments = Field(default_factory=AgentProviderAssignments)

    @field_validator("default_provider_profile_id")
    @classmethod
    def normalize_default_profile(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("default provider profile must not be blank")
        return normalized


class ImpactResolverSettings(BaseModel):
    """Agent-specific mode and content policy; provider assignment stays shared."""

    model_config = ConfigDict(extra="allow")

    impact_resolver_version: Literal[1] = IMPACT_RESOLVER_SETTINGS_VERSION
    agent_mode: ImpactResolverMode = "disabled"
    content_policy: ImpactResolverContentPolicy = "never"

    @model_validator(mode="after")
    def validate_policy(self) -> "ImpactResolverSettings":
        if self.agent_mode == "disabled" and self.content_policy != "never":
            raise ValueError("disabled Impact Resolver requires the never content policy")
        if self.agent_mode == "configured" and self.content_policy != "bounded_evidence":
            raise ValueError("configured Impact Resolver requires bounded_evidence")
        return self


class CanonCheckSettings(BaseModel):
    """Portable Phase 4 policy containing references but never credentials."""

    model_config = ConfigDict(extra="allow")

    canon_check_version: Literal[1] = CANON_CHECK_SETTINGS_VERSION
    deterministic_enabled: bool = True
    enabled_rules: dict[str, bool] = Field(default_factory=dict)
    severity_overrides: dict[str, CanonSeverity] = Field(default_factory=dict)
    agent_mode: CanonAgentMode = "disabled"
    content_policy: CanonContentPolicy = "never"
    model_preference: str | None = None
    provider_profile_id: str | None = None

    @field_validator("enabled_rules", "severity_overrides")
    @classmethod
    def validate_rule_ids(cls, value: dict[str, Any]) -> dict[str, Any]:
        invalid = sorted(
            rule_id for rule_id in value if not _RULE_ID_PATTERN.fullmatch(rule_id)
        )
        if invalid:
            raise ValueError(f"invalid canon rule id: {invalid[0]}")
        return value

    @field_validator("model_preference", "provider_profile_id")
    @classmethod
    def normalize_optional_reference(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("canon provider and model references must not be blank")
        return normalized

    @model_validator(mode="after")
    def validate_agent_policy(self) -> "CanonCheckSettings":
        if self.agent_mode == "disabled" and self.content_policy != "never":
            raise ValueError("disabled canon agent requires the never content policy")
        if self.agent_mode == "configured":
            if self.content_policy != "evidence_only":
                raise ValueError("configured canon agent requires evidence_only content policy")
            if self.provider_profile_id is None or self.model_preference is None:
                raise ValueError("configured canon agent requires provider and model references")
        return self


class ProjectSettings(BaseModel):
    """Versioned writer-facing settings stored with the portable project."""

    model_config = ConfigDict(extra="allow")

    ui_locale: ProjectLocale = "en"
    content_locale: ProjectLocale = "en"
    autosave: AutosaveSettings = Field(default_factory=AutosaveSettings)
    storage: StorageSettings = Field(default_factory=StorageSettings)
    canon_check: CanonCheckSettings = Field(default_factory=CanonCheckSettings)
    agent_providers: AgentProvidersSettings = Field(default_factory=AgentProvidersSettings)
    impact_resolver: ImpactResolverSettings = Field(default_factory=ImpactResolverSettings)
    style_system: StyleSystemSettingsV1 = Field(default_factory=StyleSystemSettingsV1)

    @model_validator(mode="before")
    @classmethod
    def reject_embedded_secrets(cls, value: Any) -> Any:
        # Settings also arrive through the update API without a manifest wrapper.
        _reject_secret_keys(value)
        return _project_canon_compatibility(value)

    @model_validator(mode="after")
    def validate_effective_agent_profiles(self) -> "ProjectSettings":
        canon = self.agent_providers.agents.canon_checker
        impact = self.agent_providers.agents.impact_resolver
        style = self.agent_providers.agents.style_rewriter
        if self.canon_check.agent_mode == "configured" and (
            _effective_profile(self.agent_providers, canon) is None or canon.model_id is None
        ):
            raise ValueError("configured Canon agent requires an effective provider and model")
        if self.impact_resolver.agent_mode == "configured" and (
            _effective_profile(self.agent_providers, impact) is None or impact.model_id is None
        ):
            raise ValueError("configured Impact Resolver requires an effective provider and model")
        if self.style_system.agent_mode == "configured" and (
            _effective_profile(self.agent_providers, style) is None or style.model_id is None
        ):
            raise ValueError("configured Style Rewriter requires an effective provider and model")
        return self


class ProjectManifestV2(BaseModel):
    """Canonical portable metadata contract for a `.narrative` workspace."""

    model_config = ConfigDict(extra="allow")

    format_version: Literal[2] = PROJECT_FORMAT_VERSION
    project_id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    description: str = ""
    created_at: datetime
    updated_at: datetime
    saved_revision: int = Field(default=0, ge=0)
    settings_version: Literal[5] = PROJECT_SETTINGS_VERSION
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    asset_paths: list[str] = Field(default_factory=list)

    @field_validator("project_id", "name")
    @classmethod
    def normalize_nonempty_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("value must not be blank")
        return normalized

    @field_validator("created_at", "updated_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("project timestamps must include a timezone")
        return value

    @field_validator("asset_paths")
    @classmethod
    def validate_asset_paths(cls, paths: list[str]) -> list[str]:
        for path in paths:
            _validate_portable_asset_path(path)
        return paths

    @model_validator(mode="before")
    @classmethod
    def reject_embedded_secrets(cls, value: Any) -> Any:
        _reject_secret_keys(value)
        return value

    @model_validator(mode="after")
    def validate_timestamp_order(self) -> "ProjectManifestV2":
        if self.updated_at < self.created_at:
            raise ValueError("updated_at must not be earlier than created_at")
        return self


def create_project_manifest(
    *,
    project_id: str,
    name: str,
    now: datetime,
    description: str = "",
    settings: ProjectSettings | None = None,
) -> ProjectManifestV2:
    """Create a new v2 manifest with one caller-owned timestamp."""

    return ProjectManifestV2(
        project_id=project_id,
        name=name,
        description=description,
        created_at=now,
        updated_at=now,
        settings=settings or ProjectSettings(),
    )


def parse_project_manifest(payload: dict[str, Any]) -> ProjectManifestV2:
    """Validate v2 and migrate older settings without modifying the caller."""

    raw = deepcopy(payload)
    version = _manifest_version(raw)
    if version != PROJECT_FORMAT_VERSION:
        if version > PROJECT_FORMAT_VERSION:
            raise ProjectManifestError(f"Unsupported future project format version: {version}")
        raise ProjectManifestError(
            f"Project format version {version} requires migration to {PROJECT_FORMAT_VERSION}"
        )
    return ProjectManifestV2.model_validate(_migrate_project_settings(raw))


def migrate_project_manifest_v1(
    payload: dict[str, Any],
    *,
    project_id: str,
    migration_time: datetime,
) -> ProjectManifestV2:
    """Upgrade v1 metadata deterministically while preserving optional fields."""

    raw = deepcopy(payload)
    version = _manifest_version(raw)
    if version != 1:
        raise ProjectManifestError(f"Expected project format version 1, got {version}")
    if "name" not in raw:
        raise ProjectManifestError("Project config is missing required key: name")

    created_at = raw.get("created_at", migration_time)
    updated_at = raw.get("updated_at", created_at)
    legacy_settings = raw.get("settings", {})
    if not isinstance(legacy_settings, dict):
        raise ProjectManifestError("Legacy project settings must be an object")

    migrated = {
        **raw,
        "format_version": PROJECT_FORMAT_VERSION,
        "project_id": project_id,
        "description": raw.get("description", ""),
        "created_at": created_at,
        "updated_at": updated_at,
        "saved_revision": raw.get("saved_revision", 0),
        "settings_version": 1,
        "settings": {
            "ui_locale": "en",
            "content_locale": "en",
            "autosave": {
                "enabled": True,
                "interval_seconds": DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
            },
            "storage": {
                "mode": "local_sqlite",
                "connection_profile_id": None,
            },
            **legacy_settings,
        },
    }
    return ProjectManifestV2.model_validate(_migrate_project_settings(migrated))


def _migrate_project_settings(payload: dict[str, Any]) -> dict[str, Any]:
    """Upgrade only the portable settings namespace for a v2 project."""

    version = payload.get("settings_version", 1)
    if isinstance(version, bool) or not isinstance(version, int):
        raise ProjectManifestError("Project settings_version must be an integer")
    if version > PROJECT_SETTINGS_VERSION:
        raise ProjectManifestError(f"Unsupported future project settings version: {version}")
    if version < 1:
        raise ProjectManifestError(f"Unsupported project settings version: {version}")
    settings = payload.get("settings", {})
    if not isinstance(settings, dict):
        raise ProjectManifestError("Project settings must be an object")
    if version < 2:
        legacy_canon = settings.get("canon_check", {})
        if not isinstance(legacy_canon, dict):
            raise ProjectManifestError("Project canon_check settings must be an object")
        settings = {
            **settings,
            "canon_check": {
                **CanonCheckSettings().model_dump(mode="json"),
                **legacy_canon,
            },
        }
    if version < 3:
        legacy_canon = settings.get("canon_check", {})
        if not isinstance(legacy_canon, dict):
            raise ProjectManifestError("Project canon_check settings must be an object")
        profile_id = legacy_canon.get("provider_profile_id")
        model_id = legacy_canon.get("model_preference")
        settings = {
            **settings,
            "agent_providers": {
                **AgentProvidersSettings().model_dump(mode="json"),
                "default_provider_profile_id": profile_id,
                "agents": {
                    "canon_checker": {
                        "provider_source": "project_default",
                        "provider_profile_override_id": None,
                        "model_id": model_id,
                    },
                    "impact_resolver": AgentProviderAssignment().model_dump(mode="json"),
                    "style_rewriter": AgentProviderAssignment().model_dump(mode="json"),
                },
            },
            "impact_resolver": ImpactResolverSettings().model_dump(mode="json"),
        }
    if version < 4:
        legacy_style = settings.get("style_system", {})
        if not isinstance(legacy_style, dict):
            raise ProjectManifestError("Project style_system settings must be an object")
        settings = {
            **settings,
            "style_system": {
                **StyleSystemSettingsV1().model_dump(mode="json"),
                **legacy_style,
            },
        }
    if version < 5:
        legacy_providers = settings.get("agent_providers", {})
        if not isinstance(legacy_providers, dict):
            raise ProjectManifestError("Project agent_providers settings must be an object")
        legacy_agents = legacy_providers.get("agents", {})
        if not isinstance(legacy_agents, dict):
            raise ProjectManifestError("Project provider agents settings must be an object")
        settings = {
            **settings,
            "agent_providers": {
                **legacy_providers,
                "agents": {
                    **legacy_agents,
                    "style_rewriter": AgentProviderAssignment().model_dump(mode="json"),
                },
            },
        }
    payload["settings"] = settings
    payload["settings_version"] = PROJECT_SETTINGS_VERSION
    return payload


def _project_canon_compatibility(value: Any) -> Any:
    """Project the shared Canon assignment into legacy coordinator fields."""

    if not isinstance(value, dict):
        return value
    settings = deepcopy(value)
    providers = settings.get("agent_providers")
    canon = settings.get("canon_check")
    if not isinstance(canon, dict):
        return settings
    if not isinstance(providers, dict):
        # Direct Create/Settings API requests do not carry settings_version;
        # project legacy Canon references into the v3 namespace once.
        settings["agent_providers"] = {
            **AgentProvidersSettings().model_dump(mode="json"),
            "default_provider_profile_id": canon.get("provider_profile_id"),
            "agents": {
                "canon_checker": {
                    "provider_source": "project_default",
                    "provider_profile_override_id": None,
                    "model_id": canon.get("model_preference"),
                },
                "impact_resolver": AgentProviderAssignment().model_dump(mode="json"),
                "style_rewriter": AgentProviderAssignment().model_dump(mode="json"),
            },
        }
        return settings
    agents = providers.get("agents")
    assignment = agents.get("canon_checker") if isinstance(agents, dict) else None
    if not isinstance(assignment, dict):
        return settings
    source = assignment.get("provider_source", "project_default")
    profile_id = (
        assignment.get("provider_profile_override_id")
        if source == "override"
        else providers.get("default_provider_profile_id")
    )
    settings["canon_check"] = {
        **canon,
        "provider_profile_id": profile_id,
        "model_preference": assignment.get("model_id"),
    }
    return settings


def _effective_profile(
    providers: AgentProvidersSettings,
    assignment: AgentProviderAssignment,
) -> str | None:
    if assignment.provider_source == "override":
        return assignment.provider_profile_override_id
    return providers.default_provider_profile_id


def _manifest_version(payload: dict[str, Any]) -> int:
    version = payload.get("format_version")
    if isinstance(version, bool) or not isinstance(version, int):
        raise ProjectManifestError("Project config format_version must be an integer")
    return version


def _validate_portable_asset_path(path: str) -> None:
    if not path or not path.strip():
        raise ValueError("asset path must not be blank")
    posix_path = PurePosixPath(path)
    windows_path = PureWindowsPath(path)
    if posix_path.is_absolute() or windows_path.is_absolute():
        raise ValueError(f"asset path must be project-relative: {path}")
    if ".." in posix_path.parts or ".." in windows_path.parts:
        raise ValueError(f"asset path must not traverse outside the project: {path}")
    if posix_path.parts[0] != "assets":
        raise ValueError(f"asset path must be located under assets/: {path}")


def _reject_secret_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized_key = str(key).strip().casefold().replace("-", "_")
            if normalized_key in _FORBIDDEN_SECRET_KEYS or normalized_key.endswith(
                _FORBIDDEN_SECRET_SUFFIXES
            ):
                raise ValueError(f"project manifest must not contain secret field: {key}")
            _reject_secret_keys(child)
    elif isinstance(value, list):
        for child in value:
            _reject_secret_keys(child)
