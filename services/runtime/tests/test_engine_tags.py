from copy import deepcopy

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.engine_tags import (
    ENGINE_TAG_TARGETS,
    EngineTagApiResponseV1,
    EngineTagDiagnosticV1,
    EngineTagDefinitionV1,
    EngineTagImpactV1,
    EngineTagMutationCommandV1,
    EngineTagOwnerV1,
    EngineTagPreviewV1,
    EngineTagSuggestionRequestV1,
    EngineTagContractModel,
    assert_unique_engine_tag_keys,
    migrate_legacy_engine_tags_v5_to_v6,
    normalize_engine_tag_key,
    suggest_engine_tag_key,
)


def test_key_grammar_and_normalization_are_strict() -> None:
    assert normalize_engine_tag_key(" Story.Main_Quest ") == "story.main_quest"
    with pytest.raises(ValueError):
        normalize_engine_tag_key("story/main")
    with pytest.raises(ValueError):
        normalize_engine_tag_key("история.main")


def test_suggestion_transliterates_and_resolves_collisions() -> None:
    request = EngineTagSuggestionRequestV1(
        project_id="project",
        owner=EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1"),
        label="Открыть дверь",
        existing_keys=["node.OtkrytDver", "node.OtkrytDver_2"],
    )
    result = suggest_engine_tag_key(request)
    assert result.key == "Node.OtkrytDver_3"
    assert result.normalized_key == "node.otkrytdver_3"
    assert result.collision_resolved is True


def test_duplicate_definitions_are_rejected() -> None:
    definition = EngineTagDefinitionV1(
        id="definition-1", project_id="project", key="Story.Main", normalized_key="story.main",
        status="active", created_at="now", updated_at="now",
    )
    duplicate = definition.model_copy(update={"id": "definition-2", "key": "story.main"})
    with pytest.raises(ValueError):
        assert_unique_engine_tag_keys([definition, duplicate])


def test_legacy_migration_is_idempotent_and_does_not_mutate_input() -> None:
    rows = [{
        "id": "legacy-1", "project_id": "project", "created_at": "now", "updated_at": "now",
        "target_type": "node", "target_id": "node-1", "engine": "unity", "key": "tag", "value": "x",
        "metadata": {"nested": {"keep": True}},
    }]
    original = deepcopy(rows)
    migrated = migrate_legacy_engine_tags_v5_to_v6(rows)
    assert migrated.document_version == 6
    assert [row.model_dump() for row in migrated.legacy_engine_tags] == rows == original
    assert migrated.legacy_engine_tags is not rows
    assert migrated.legacy_engine_tags[0].metadata is not rows[0]["metadata"]


def test_contract_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        EngineTagContractModel.model_validate({"unexpected": True})


@pytest.mark.parametrize(
    ("field", "value", "code"),
    [
        ("description", "sk-proj-1234567890abcdef", "engine_tag_secret_forbidden"),
        ("description", "unsafe\x00control", "engine_tag_control_forbidden"),
        ("value", "../../machine/settings.json", "engine_tag_path_forbidden"),
        ("description", "x" * 2_001, "engine_tag_limit_exceeded"),
    ],
)
def test_mutation_contract_rejects_hostile_authored_text(
    field: str,
    value: str,
    code: str,
) -> None:
    payload = {
        "command_id": "hostile-input",
        "action": "create_definition",
        "key": "Story.Safe",
        "expected_source_checksum": "a" * 64,
        "expected_history_revision": 0,
        field: value,
    }

    with pytest.raises(ValidationError, match=code):
        EngineTagMutationCommandV1.model_validate(payload)


def test_all_targets_and_response_variants_are_versioned() -> None:
    assert ENGINE_TAG_TARGETS == ("unreal", "unity", "ink", "yarn_spinner")
    preview = EngineTagPreviewV1(project_id="project", legacy_count=0, read_only=True)
    impact = EngineTagImpactV1(definition_id="definition", affected_owner_count=0, requires_review=True)
    diagnostic = EngineTagDiagnosticV1(code="engine_tag_key_invalid", message_key="engine_tags.key.invalid")
    for kind, payload in (("preview", preview.model_dump()), ("impact", impact.model_dump()), ("diagnostic", diagnostic.model_dump())):
        response = EngineTagApiResponseV1(kind=kind, payload=payload)
        assert response.response_version == 1
