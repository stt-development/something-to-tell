from copy import deepcopy
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.project_format.manifest import (
    DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
    PROJECT_FORMAT_VERSION,
    PROJECT_SETTINGS_VERSION,
    ProjectManifestError,
    ProjectManifestV2,
    ProjectSettings,
    create_project_manifest,
    migrate_project_manifest_v1,
    parse_project_manifest,
)

NOW = datetime(2026, 7, 28, 10, 30, tzinfo=UTC)


def _manifest_payload() -> dict[str, object]:
    return {
        "format_version": PROJECT_FORMAT_VERSION,
        "project_id": "project-1",
        "name": "Citadel Branch",
        "description": "A branching citadel story.",
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
        "saved_revision": 4,
        "settings_version": PROJECT_SETTINGS_VERSION,
        "settings": {
            "ui_locale": "en",
            "content_locale": "ru",
            "autosave": {
                "enabled": True,
                "interval_seconds": DEFAULT_AUTOSAVE_INTERVAL_SECONDS,
            },
            "storage": {
                "mode": "local_sqlite",
                "connection_profile_id": None,
            },
        },
        "asset_paths": ["assets/citadel/map.png"],
    }


def test_create_project_manifest_uses_portable_defaults() -> None:
    manifest = create_project_manifest(
        project_id="project-1",
        name="Citadel Branch",
        now=NOW,
    )

    assert manifest.format_version == 2
    assert manifest.saved_revision == 0
    assert manifest.settings.ui_locale == "en"
    assert manifest.settings.content_locale == "en"
    assert manifest.settings.autosave.interval_seconds == 300
    assert manifest.settings.storage.mode == "local_sqlite"
    assert manifest.settings.storage.connection_profile_id is None
    assert manifest.settings.canon_check.deterministic_enabled is True
    assert manifest.settings.canon_check.agent_mode == "disabled"
    assert manifest.settings.canon_check.content_policy == "never"
    assert manifest.settings.style_system.default_style_profile_id is None
    assert manifest.settings.style_system.agent_mode == "disabled"
    assert manifest.settings.agent_providers.agents.style_rewriter.model_id is None
    assert manifest.created_at == manifest.updated_at == NOW


def test_direct_legacy_canon_settings_project_into_shared_provider_namespace() -> None:
    settings = ProjectSettings.model_validate({
        "canon_check": {
            "agent_mode": "configured",
            "content_policy": "evidence_only",
            "provider_profile_id": "legacy-profile",
            "model_preference": "legacy-model",
        },
    })

    assert settings.agent_providers.default_provider_profile_id == "legacy-profile"
    assert settings.agent_providers.agents.canon_checker.model_id == "legacy-model"
    assert settings.impact_resolver.agent_mode == "disabled"


def test_manifest_round_trip_preserves_unknown_optional_extensions() -> None:
    payload = _manifest_payload()
    payload["plugin_metadata"] = {"owner": "test-plugin", "schema_version": 3}
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["future_setting"] = {"enabled": True}

    parsed = parse_project_manifest(payload)
    reparsed = ProjectManifestV2.model_validate(parsed.model_dump(mode="json"))

    assert reparsed.model_dump(mode="json") == parsed.model_dump(mode="json")
    assert reparsed.model_extra == {
        "plugin_metadata": {"owner": "test-plugin", "schema_version": 3}
    }
    assert reparsed.settings.model_extra == {"future_setting": {"enabled": True}}


def test_parse_manifest_does_not_modify_input() -> None:
    payload = _manifest_payload()
    before = deepcopy(payload)

    parse_project_manifest(payload)

    assert payload == before


def test_migrate_settings_v1_adds_canon_defaults_and_preserves_extensions() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 1
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["future_setting"] = {"enabled": True}
    before = deepcopy(payload)

    parsed = parse_project_manifest(payload)

    assert payload == before
    assert parsed.settings_version == PROJECT_SETTINGS_VERSION
    assert parsed.settings.canon_check.model_dump(mode="json") == {
        "canon_check_version": 1,
        "deterministic_enabled": True,
        "enabled_rules": {},
        "severity_overrides": {},
        "agent_mode": "disabled",
        "content_policy": "never",
        "model_preference": None,
        "provider_profile_id": None,
    }
    assert parsed.settings.model_extra == {"future_setting": {"enabled": True}}


def test_settings_migration_preserves_unknown_canon_fields() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 1
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["canon_check"] = {
        "deterministic_enabled": False,
        "future_policy": {"mode": "strict"},
    }

    parsed = parse_project_manifest(payload)

    assert parsed.settings.canon_check.deterministic_enabled is False
    assert parsed.settings.canon_check.model_extra == {
        "future_policy": {"mode": "strict"}
    }


def test_settings_migration_rejects_non_object_canon_namespace() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 1
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["canon_check"] = "invalid"

    with pytest.raises(ProjectManifestError, match="canon_check settings must be an object"):
        parse_project_manifest(payload)


def test_migrate_v1_is_deterministic_and_preserves_optional_metadata() -> None:
    legacy = {
        "format_version": 1,
        "name": "Legacy Story",
        "created_at": "2026-05-27T00:00:00+00:00",
        "updated_at": "2026-06-01T00:00:00+00:00",
        "legacy_plugin": {"mode": "strict"},
        "settings": {"editor_extension": {"line_width": 88}},
    }
    before = deepcopy(legacy)

    first = migrate_project_manifest_v1(
        legacy,
        project_id="migrated-project",
        migration_time=NOW,
    )
    second = migrate_project_manifest_v1(
        legacy,
        project_id="migrated-project",
        migration_time=NOW,
    )

    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert legacy == before
    assert first.project_id == "migrated-project"
    assert first.model_extra == {"legacy_plugin": {"mode": "strict"}}
    assert first.settings.model_extra == {"editor_extension": {"line_width": 88}}
    assert first.settings.autosave.interval_seconds == 300
    assert first.settings.storage.mode == "local_sqlite"


def test_migrate_v1_uses_explicit_time_for_missing_legacy_dates() -> None:
    migrated = migrate_project_manifest_v1(
        {"format_version": 1, "name": "Undated"},
        project_id="project-undated",
        migration_time=NOW,
    )

    assert migrated.created_at == NOW
    assert migrated.updated_at == NOW


def test_future_version_is_rejected_without_modifying_input() -> None:
    payload = {**_manifest_payload(), "format_version": PROJECT_FORMAT_VERSION + 1}
    before = deepcopy(payload)

    with pytest.raises(ProjectManifestError, match="Unsupported future"):
        parse_project_manifest(payload)

    assert payload == before


def test_future_settings_version_is_rejected_without_modifying_input() -> None:
    payload = {**_manifest_payload(), "settings_version": PROJECT_SETTINGS_VERSION + 1}
    before = deepcopy(payload)

    with pytest.raises(ProjectManifestError, match="future project settings"):
        parse_project_manifest(payload)

    assert payload == before


@pytest.mark.parametrize("field", ["ui_locale", "content_locale"])
def test_manifest_rejects_unsupported_locales(field: str) -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings[field] = "es"

    with pytest.raises(ValidationError):
        parse_project_manifest(payload)


def test_manifest_rejects_short_autosave_interval() -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    autosave = settings["autosave"]
    assert isinstance(autosave, dict)
    autosave["interval_seconds"] = 59

    with pytest.raises(ValidationError, match="greater than or equal to 60"):
        parse_project_manifest(payload)


@pytest.mark.parametrize(
    ("mode", "profile_id"),
    [
        ("local_sqlite", "machine-profile"),
        ("postgresql", None),
        ("postgresql", "   "),
    ],
)
def test_manifest_rejects_invalid_storage_combinations(
    mode: str,
    profile_id: str | None,
) -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    storage = settings["storage"]
    assert isinstance(storage, dict)
    storage.update({"mode": mode, "connection_profile_id": profile_id})

    with pytest.raises(ValidationError):
        parse_project_manifest(payload)


def test_manifest_accepts_opaque_postgresql_profile_reference() -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    storage = settings["storage"]
    assert isinstance(storage, dict)
    storage.update({"mode": "postgresql", "connection_profile_id": "studio-primary"})

    manifest = parse_project_manifest(payload)

    assert manifest.settings.storage.connection_profile_id == "studio-primary"


def test_manifest_accepts_valid_canon_rule_and_provider_configuration() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 2
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings.pop("agent_providers", None)
    settings.pop("impact_resolver", None)
    settings["canon_check"] = {
        "canon_check_version": 1,
        "deterministic_enabled": True,
        "enabled_rules": {"flow.unresolved-condition": False},
        "severity_overrides": {"quest.required-outcome": "critical"},
        "agent_mode": "configured",
        "content_policy": "evidence_only",
        "model_preference": "provider-model-v1",
        "provider_profile_id": "studio-canon",
    }

    manifest = parse_project_manifest(payload)

    assert manifest.settings.canon_check.provider_profile_id == "studio-canon"
    assert manifest.settings.agent_providers.default_provider_profile_id == "studio-canon"
    assert manifest.settings.agent_providers.agents.canon_checker.model_id == "provider-model-v1"
    assert manifest.settings.canon_check.severity_overrides == {
        "quest.required-outcome": "critical"
    }


def test_v2_agent_provider_migration_is_idempotent_and_preserves_canon_policy() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 2
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["canon_check"] = ProjectSettings().canon_check.model_dump(mode="json")
    canon = settings["canon_check"]
    assert isinstance(canon, dict)
    canon.update({
        "provider_profile_id": "legacy-provider",
        "model_preference": "legacy-canon-model",
        "future_policy": {"strict": True},
    })
    before = deepcopy(payload)

    first = parse_project_manifest(payload)
    second = parse_project_manifest(first.model_dump(mode="json"))

    assert payload == before
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert first.settings.agent_providers.default_provider_profile_id == "legacy-provider"
    assert first.settings.agent_providers.agents.canon_checker.model_id == "legacy-canon-model"
    assert first.settings.agent_providers.agents.impact_resolver.model_id is None
    assert first.settings.impact_resolver.agent_mode == "disabled"
    assert first.settings.style_system.default_style_profile_id is None
    assert first.settings.canon_check.model_extra == {"future_policy": {"strict": True}}


def test_v3_style_settings_migration_is_idempotent_and_preserves_extensions() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 3
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings.pop("style_system", None)
    settings["future_setting"] = {"mode": "strict"}
    before = deepcopy(payload)

    first = parse_project_manifest(payload)
    second = parse_project_manifest(first.model_dump(mode="json"))

    assert payload == before
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert first.settings.style_system.model_dump(mode="json") == {
        "style_system_version": 1,
        "default_style_profile_id": None,
        "agent_mode": "disabled",
        "content_policy": "never",
    }
    assert first.settings.model_extra == {"future_setting": {"mode": "strict"}}


def test_v4_provider_migration_adds_disabled_style_rewriter_idempotently() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 4
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["agent_providers"] = ProjectSettings().agent_providers.model_dump(mode="json")
    providers = settings["agent_providers"]
    assert isinstance(providers, dict)
    agents = providers["agents"]
    assert isinstance(agents, dict)
    agents.pop("style_rewriter")
    settings["style_system"] = ProjectSettings().style_system.model_dump(mode="json")
    before = deepcopy(payload)

    first = parse_project_manifest(payload)
    second = parse_project_manifest(first.model_dump(mode="json"))

    assert payload == before
    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert first.settings.agent_providers.agents.style_rewriter.model_dump(mode="json") == {
        "provider_source": "project_default",
        "provider_profile_override_id": None,
        "model_id": None,
    }
    assert first.settings.style_system.agent_mode == "disabled"


def test_v3_style_settings_migration_preserves_unknown_style_fields() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 3
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["style_system"] = {"future_policy": {"mode": "strict"}}

    parsed = parse_project_manifest(payload)

    assert parsed.settings.style_system.model_extra == {
        "future_policy": {"mode": "strict"}
    }


def test_v3_style_settings_migration_rejects_non_object_namespace() -> None:
    payload = _manifest_payload()
    payload["settings_version"] = 3
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["style_system"] = "invalid"

    with pytest.raises(ProjectManifestError, match="style_system settings must be an object"):
        parse_project_manifest(payload)


def test_agent_provider_default_and_agent_overrides_are_independent() -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["canon_check"] = ProjectSettings().canon_check.model_dump(mode="json")
    settings["agent_providers"] = {
        "agent_providers_version": 1,
        "default_provider_profile_id": "shared-openai",
        "agents": {
            "canon_checker": {
                "provider_source": "project_default",
                "provider_profile_override_id": None,
                "model_id": "canon-model",
            },
            "impact_resolver": {
                "provider_source": "override",
                "provider_profile_override_id": "impact-anthropic",
                "model_id": "impact-model",
            },
            "style_rewriter": {
                "provider_source": "override",
                "provider_profile_override_id": "style-anthropic",
                "model_id": "style-model",
            },
        },
    }
    settings["canon_check"] = {
        **settings["canon_check"],
        "agent_mode": "configured",
        "content_policy": "evidence_only",
    }
    settings["impact_resolver"] = {
        "impact_resolver_version": 1,
        "agent_mode": "configured",
        "content_policy": "bounded_evidence",
    }
    settings["style_system"] = {
        "style_system_version": 1,
        "default_style_profile_id": None,
        "agent_mode": "configured",
        "content_policy": "explicit_consent",
    }

    manifest = parse_project_manifest(payload)

    assert manifest.settings.canon_check.provider_profile_id == "shared-openai"
    assert manifest.settings.canon_check.model_preference == "canon-model"
    assert (
        manifest.settings.agent_providers.agents.impact_resolver.provider_profile_override_id
        == "impact-anthropic"
    )
    assert (
        manifest.settings.agent_providers.agents.style_rewriter.provider_profile_override_id
        == "style-anthropic"
    )
    assert manifest.settings.agent_providers.agents.style_rewriter.model_id == "style-model"


def test_configured_impact_resolver_requires_effective_profile_and_model() -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["impact_resolver"] = {
        "impact_resolver_version": 1,
        "agent_mode": "configured",
        "content_policy": "bounded_evidence",
    }

    with pytest.raises(ValidationError, match="effective provider and model"):
        parse_project_manifest(payload)


def test_configured_style_rewriter_requires_effective_profile_and_model() -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["style_system"] = {
        "style_system_version": 1,
        "default_style_profile_id": None,
        "agent_mode": "configured",
        "content_policy": "explicit_consent",
    }

    with pytest.raises(ValidationError, match="Style Rewriter requires"):
        parse_project_manifest(payload)


def test_agent_provider_namespace_rejects_secret_fields() -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["agent_providers"] = ProjectSettings().agent_providers.model_dump(mode="json")
    settings["agent_providers"]["api_key"] = "must-not-be-portable"

    with pytest.raises(ValidationError, match="secret field"):
        parse_project_manifest(payload)


@pytest.mark.parametrize(
    "canon_check",
    [
        {"enabled_rules": {"Not valid": True}},
        {"severity_overrides": {"flow.rule": "fatal"}},
        {"agent_mode": "disabled", "content_policy": "evidence_only"},
        {"agent_mode": "configured", "content_policy": "never"},
        {"agent_mode": "configured", "content_policy": "evidence_only"},
        {
            "agent_mode": "configured",
            "content_policy": "evidence_only",
            "provider_profile_id": " ",
            "model_preference": "model",
        },
    ],
)
def test_manifest_rejects_invalid_canon_configuration(
    canon_check: dict[str, object],
) -> None:
    payload = _manifest_payload()
    settings = payload["settings"]
    assert isinstance(settings, dict)
    settings["canon_check"] = canon_check

    with pytest.raises(ValidationError):
        parse_project_manifest(payload)


def test_project_settings_reject_secrets_without_manifest_wrapper() -> None:
    with pytest.raises(ValidationError, match="must not contain secret field"):
        ProjectSettings.model_validate({
            "canon_check": {"provider_profile_id": "safe", "provider_api_key": "secret"}
        })


@pytest.mark.parametrize(
    "secret_field",
    [
        "password",
        "api_key",
        "access-token",
        "refresh_token",
        "credentials",
        "provider_api_key",
        "database-password",
        "signing_private_key",
    ],
)
def test_manifest_rejects_secrets_at_any_depth(secret_field: str) -> None:
    payload = _manifest_payload()
    payload["plugin_metadata"] = {"provider": {secret_field: "must-not-be-saved"}}

    with pytest.raises(ValidationError, match="must not contain secret field"):
        parse_project_manifest(payload)


@pytest.mark.parametrize(
    "path",
    [
        "/tmp/map.png",
        "C:\\Users\\writer\\map.png",
        "assets/../outside.png",
        "../assets/map.png",
        "styles/map.png",
        "",
    ],
)
def test_manifest_rejects_nonportable_asset_paths(path: str) -> None:
    payload = _manifest_payload()
    payload["asset_paths"] = [path]

    with pytest.raises(ValidationError):
        parse_project_manifest(payload)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("created_at", "2026-07-28T10:30:00"),
        ("updated_at", "2026-07-27T10:30:00+00:00"),
    ],
)
def test_manifest_rejects_invalid_timestamps(field: str, value: str) -> None:
    payload = _manifest_payload()
    payload[field] = value

    with pytest.raises(ValidationError):
        parse_project_manifest(payload)
