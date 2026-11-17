from copy import deepcopy
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.style_system import (
    STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS,
    STYLE_PROFILE_MAX_TRAITS_PER_GROUP,
    SceneStyleAssignmentV1,
    StyleCatalogV1,
    StyleProfileV1,
    StyleSystemSettingsV1,
)

NOW = datetime(2026, 9, 4, 10, 0, tzinfo=UTC)


def _profile(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "style_profile_version": 1,
        "id": "style-noir",
        "project_id": "project-aurora",
        "name": "Harbor noir",
        "description": "Restrained narration for the harbor investigation.",
        "guidance": "Use concrete sensory details and short declarative sentences.",
        "traits": {
            "traits_version": 1,
            "tone": ["restrained", "suspicious"],
            "rhythm": ["short sentences"],
            "pacing": ["deliberate"],
            "vocabulary": ["concrete maritime language"],
            "dramatic_intensity": "controlled",
        },
        "positive_examples": ["Rain traced the ledger's salt-stiffened spine."],
        "created_at": NOW,
        "updated_at": NOW,
    }
    payload.update(overrides)
    return payload


def _assignment(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "assignment_version": 1,
        "id": "scene-style-docks",
        "project_id": "project-aurora",
        "scene_node_id": "scene-docks",
        "style_profile_id": "style-noir",
        "created_at": NOW,
        "updated_at": NOW,
    }
    payload.update(overrides)
    return payload


def _error_type(error: ValidationError) -> str:
    return str(error.errors()[0]["type"])


def test_profile_normalizes_bounded_portable_content() -> None:
    profile = StyleProfileV1.model_validate(_profile(name="  Harbor noir  "))

    assert profile.name == "Harbor noir"
    assert profile.traits.tone == ("restrained", "suspicious")
    assert profile.positive_examples == (
        "Rain traced the ledger's salt-stiffened spine.",
    )
    assert profile.model_dump(mode="json")["style_profile_version"] == 1


@pytest.mark.parametrize(
    ("overrides", "code"),
    [
        ({"name": "   "}, "style_profile_invalid"),
        (
            {"guidance": "x" * (STYLE_PROFILE_MAX_GUIDANCE_CHARACTERS + 1)},
            "style_profile_oversized",
        ),
        (
            {
                "traits": {
                    "traits_version": 1,
                    "tone": [f"tone-{index}" for index in range(STYLE_PROFILE_MAX_TRAITS_PER_GROUP + 1)],
                }
            },
            "style_profile_oversized",
        ),
        (
            {"positive_examples": ["Same example", " same example "]},
            "style_profile_invalid",
        ),
        (
            {"guidance": "Use this provider key sk-proj-abcdefghijklmnopqrstuv"},
            "style_profile_secret_forbidden",
        ),
    ],
)
def test_profile_rejects_invalid_oversized_duplicate_and_secret_values(
    overrides: dict[str, object], code: str
) -> None:
    with pytest.raises(ValidationError) as raised:
        StyleProfileV1.model_validate(_profile(**overrides))

    assert _error_type(raised.value) == code


def test_profile_rejects_unknown_versions_and_fields() -> None:
    with pytest.raises(ValidationError) as future:
        StyleProfileV1.model_validate(_profile(style_profile_version=2))
    with pytest.raises(ValidationError) as unknown:
        StyleProfileV1.model_validate(_profile(provider_profile_id="machine-secret"))

    assert _error_type(future.value) == "style_profile_invalid"
    assert _error_type(unknown.value) == "style_profile_invalid"


def test_catalog_validates_default_and_scene_references() -> None:
    catalog = StyleCatalogV1.model_validate({
        "catalog_version": 1,
        "project_id": "project-aurora",
        "default_style_profile_id": "style-noir",
        "profiles": [_profile()],
        "scene_assignments": [_assignment()],
    })

    assert catalog.default_style_profile_id == "style-noir"
    assert catalog.scene_assignments[0].scene_node_id == "scene-docks"


@pytest.mark.parametrize(
    ("profiles", "assignments", "default_profile", "code"),
    [
        ([_profile(), _profile()], [], "style-noir", "style_profile_duplicate"),
        (
            [_profile()],
            [_assignment(), _assignment(id="scene-style-docks-copy")],
            "style-noir",
            "style_scene_assignment_duplicate",
        ),
        ([_profile()], [], "style-missing", "style_profile_not_found"),
        (
            [_profile()],
            [_assignment(style_profile_id="style-missing")],
            None,
            "style_profile_not_found",
        ),
    ],
)
def test_catalog_rejects_duplicate_and_missing_references(
    profiles: list[dict[str, object]],
    assignments: list[dict[str, object]],
    default_profile: str | None,
    code: str,
) -> None:
    with pytest.raises(ValidationError) as raised:
        StyleCatalogV1.model_validate({
            "catalog_version": 1,
            "project_id": "project-aurora",
            "default_style_profile_id": default_profile,
            "profiles": profiles,
            "scene_assignments": assignments,
        })

    assert _error_type(raised.value) == code


def test_scene_assignment_is_strict_and_project_owned() -> None:
    assignment = SceneStyleAssignmentV1.model_validate(_assignment())
    assert assignment.style_profile_id == "style-noir"

    with pytest.raises(ValidationError) as raised:
        StyleCatalogV1.model_validate({
            "catalog_version": 1,
            "project_id": "project-aurora",
            "profiles": [_profile()],
            "scene_assignments": [_assignment(project_id="another-project")],
        })
    assert _error_type(raised.value) == "style_scene_invalid"


def test_style_settings_preserve_extensions_and_enforce_policy() -> None:
    payload = {
        "style_system_version": 1,
        "default_style_profile_id": "style-noir",
        "agent_mode": "configured",
        "content_policy": "explicit_consent",
        "future_setting": {"enabled": True},
    }
    before = deepcopy(payload)

    settings = StyleSystemSettingsV1.model_validate(payload)

    assert payload == before
    assert settings.model_extra == {"future_setting": {"enabled": True}}
    with pytest.raises(ValidationError) as raised:
        StyleSystemSettingsV1.model_validate({
            "agent_mode": "disabled",
            "content_policy": "explicit_consent",
        })
    assert _error_type(raised.value) == "style_profile_invalid"
