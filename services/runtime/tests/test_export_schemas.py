"""Contract tests for the Phase 8 deterministic export boundary."""

from copy import deepcopy
import json
import math
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.export import (
    EXPORT_CONTRACT_VERSION,
    EXPORT_FORMATS,
    EXPORT_MAX_DIAGNOSTICS,
    EXPORT_MAX_NAME_LENGTH,
    EXPORT_MAX_OUTPUT_BYTES,
    EXPORT_MAX_PATH_LENGTH,
    EXPORT_MAX_PREVIEW_BYTES,
    EXPORT_MAX_RECORDS,
    EXPORT_MAX_SELECTED_FLOWS,
    EXPORT_MAX_TEXT_LENGTH,
    EXPORT_SCOPES,
    ExportDiagnosticV1,
    ExportDialogueV1,
    ExportEngineTagsV1,
    ExportInventoryV1,
    ExportManifestV1,
    ExportNodeV1,
    ExportOptionsV1,
    ExportPlanV1,
    ExportPortableExtensionsV1,
    ExportPreviewV1,
    ExportProjectV1,
    ExportProjectionV1,
    ExportSourceIdentityV1,
    ExportWriteRequestV1,
)

CHECKSUM = "a" * 64


def _source() -> ExportSourceIdentityV1:
    return ExportSourceIdentityV1(
        project_id="project-aurora",
        project_name="Project Aurora",
        content_locale="ru",
        document_version=6,
        source_checksum=CHECKSUM,
    )


def _options(**changes: object) -> ExportOptionsV1:
    payload = {
        "format": "json",
        "scope": "whole_project",
        "story_flow_ids": [],
        "engine_tag_target": "generic",
        "preview_max_bytes": 65_536,
        **changes,
    }
    return ExportOptionsV1.model_validate(payload)


def _projection(**changes: object) -> ExportProjectionV1:
    source = _source()
    payload = {
        "manifest": ExportManifestV1(
            source=source,
            scope="whole_project",
            story_flow_ids=[],
            engine_tag_target="generic",
        ),
        "project": ExportProjectV1(
            id="project-aurora",
            name="Project Aurora",
            description="Русский и English content.\nSecond line.",
            content_locale="ru",
            extensions={"values": {"x-studio-note": "Сохраняется"}},
        ),
        "nodes": [],
        "relationships": [],
        "dialogues": [],
        "quests": [],
        "engine_tags": ExportEngineTagsV1(
            project_id=source.project_id,
            source_checksum=source.source_checksum,
            target="generic",
        ),
        **changes,
    }
    return ExportProjectionV1.model_validate(payload)


def test_contract_versions_limits_and_typescript_mirror_stay_aligned() -> None:
    assert EXPORT_CONTRACT_VERSION == 1
    assert EXPORT_FORMATS == ("json", "yaml", "yarn_spinner", "ink")
    assert EXPORT_SCOPES == ("whole_project", "story_flows")
    assert (
        EXPORT_MAX_SELECTED_FLOWS,
        EXPORT_MAX_PREVIEW_BYTES,
        EXPORT_MAX_DIAGNOSTICS,
        EXPORT_MAX_RECORDS,
        EXPORT_MAX_OUTPUT_BYTES,
        EXPORT_MAX_NAME_LENGTH,
        EXPORT_MAX_PATH_LENGTH,
        EXPORT_MAX_TEXT_LENGTH,
    ) == (128, 262_144, 2_000, 100_000, 52_428_800, 160, 4_096, 1_048_576)

    # The mirror is intentionally checked until schema generation replaces it.
    source = Path("packages/contracts/src/export.ts").read_text(encoding="utf-8")
    for declaration in (
        "EXPORT_CONTRACT_VERSION = 1",
        "EXPORT_MAX_SELECTED_FLOWS = 128",
        "EXPORT_MAX_PREVIEW_BYTES = 262_144",
        "EXPORT_MAX_DIAGNOSTICS = 2_000",
        "EXPORT_MAX_RECORDS = 100_000",
        "EXPORT_MAX_OUTPUT_BYTES = 52_428_800",
        "EXPORT_MAX_NAME_LENGTH = 160",
        "EXPORT_MAX_PATH_LENGTH = 4_096",
        "EXPORT_MAX_TEXT_LENGTH = 1_048_576",
    ):
        assert declaration in source


def test_scope_and_format_variants_are_strict() -> None:
    scoped = _options(
        format="ink",
        scope="story_flows",
        story_flow_ids=["flow-main"],
        engine_tag_target="ink",
    )
    assert scoped.story_flow_ids == ["flow-main"]
    assert _options(scope="story_flows", story_flow_ids=[]).story_flow_ids == []
    assert _options(format="json", engine_tag_target="unity").engine_tag_target == "unity"

    for payload in (
        {"format": "pdf"},
        {"scope": "selection"},
        {"story_flow_ids": ["flow-main"]},
        {"format": "ink", "engine_tag_target": "generic"},
        {"scope": "story_flows", "story_flow_ids": ["flow-main", "flow-main"]},
    ):
        with pytest.raises(ValidationError):
            _options(**payload)


@pytest.mark.parametrize("identifier", ["../flow", "flow/child", " flow id ", "\x00flow"])
def test_malformed_identifiers_are_rejected(identifier: str) -> None:
    with pytest.raises(ValidationError):
        _options(
            scope="story_flows",
            story_flow_ids=[identifier],
        )


def test_projection_is_an_explicit_allowlist_and_rejects_duplicate_ids() -> None:
    node = ExportNodeV1(
        id="node-1",
        type="Scene",
        title="Начало",
        summary="",
        body="A" * 16_384,
        status="canon",
        tags=[],
        attributes={},
    )
    projection = _projection(nodes=[node])
    dumped = projection.model_dump(mode="json")
    assert set(dumped) == {
        "projection_version", "manifest", "project", "nodes", "relationships",
        "dialogues", "quests", "story_flows", "narrative_state", "engine_tags",
        "diagnostics",
    }
    assert dumped["project"]["extensions"]["values"]["x-studio-note"] == "Сохраняется"
    assert "placements" not in dumped and "storage" not in dumped and "providers" not in dumped

    with pytest.raises(ValidationError, match="duplicate"):
        _projection(nodes=[node, deepcopy(node)])
    with pytest.raises(ValidationError):
        ExportProjectionV1.model_validate({**dumped, "history": []})


def test_engine_tag_section_must_match_projection_source_identity() -> None:
    payload = _projection().model_dump(mode="json")
    for field, value in (("project_id", "other-project"), ("source_checksum", "b" * 64)):
        changed = deepcopy(payload)
        changed["engine_tags"][field] = value
        with pytest.raises(ValidationError):
            ExportProjectionV1.model_validate(changed)


def test_nested_ids_and_discriminated_effect_variants_are_strict() -> None:
    with pytest.raises(ValidationError):
        ExportDialogueV1(
            node_id="dialogue",
            document={
                "participants": ["character/unsafe"],
                "entry_element_id": "line-1",
                "elements": [{
                    "id": "line-1", "kind": "line",
                    "speaker_node_id": "character/unsafe", "text": "Hello",
                }],
            },
        )

    payload = _projection().model_dump(mode="json")
    payload["narrative_state"]["effects"] = [{
        "effect_version": 1,
        "id": "effect-1",
        "operation": "execute_shell",
        "payload": {},
        "repeat_policy": "once",
        "explanation": "Unsupported variant",
    }]
    with pytest.raises(ValidationError):
        ExportProjectionV1.model_validate(payload)


def test_inventory_requires_an_exact_bounded_record_total() -> None:
    payload = {
        "node_count": 1, "relationship_count": 0, "dialogue_count": 0,
        "quest_count": 0, "story_flow_count": 0, "flow_membership_count": 0,
        "flow_transition_count": 0, "scene_boundary_count": 0,
        "flow_invocation_count": 0, "flow_exit_count": 0,
        "flow_exit_binding_count": 0, "initial_state_count": 0,
        "narrative_effect_count": 0, "narrative_effect_binding_count": 0,
        "engine_tag_count": 0, "diagnostic_count": 0, "record_count": 1,
    }
    assert ExportInventoryV1(**payload).record_count == 1
    with pytest.raises(ValidationError):
        ExportInventoryV1(**{**payload, "record_count": 0})


@pytest.mark.parametrize(
    "values",
    [
        {"note": "not namespaced"},
        {"x-note": {"storage": "postgres"}},
        {"x-note": {"api_key": "hidden"}},
        {"x-note": "sk-proj-1234567890abcdef"},
        {"x-note": "unsafe\x00control"},
        {"x-score": math.inf},
        {"x-score": math.nan},
    ],
)
def test_portable_extensions_reject_unsafe_or_non_json_values(values: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        ExportPortableExtensionsV1(values=values)


def test_unicode_multiline_empty_collections_and_unknown_extensions_round_trip() -> None:
    projection = _projection()
    restored = ExportProjectionV1.model_validate_json(projection.model_dump_json())
    assert restored == projection
    assert restored.nodes == []
    assert restored.project.description == "Русский и English content.\nSecond line."


def test_bilingual_long_text_golden_projection_remains_valid() -> None:
    fixture_path = Path("services/runtime/tests/fixtures/export_projection_v1.golden.json")
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))
    projection = ExportProjectionV1.model_validate(payload)
    assert "Русская строка" in projection.project.description
    assert "English opening line" in projection.project.description
    assert len(projection.project.description) > 256
    assert projection.nodes == []
    assert projection.project.extensions.values == {
        "x-studio-note": "Portable unknown metadata"
    }


def test_preview_counts_utf8_bytes_and_enforces_truncation_state() -> None:
    text = "Привет\nHello"
    encoded = len(text.encode("utf-8"))
    preview = ExportPreviewV1(
        media_type="application/json",
        text=text,
        preview_bytes=encoded,
        total_bytes=encoded + 10,
        truncated=True,
    )
    assert preview.preview_bytes == encoded

    with pytest.raises(ValidationError):
        ExportPreviewV1(
            media_type="application/json",
            text=text,
            preview_bytes=len(text),
            total_bytes=encoded,
            truncated=False,
        )


def test_plan_write_gate_tracks_blocking_diagnostics() -> None:
    preview = ExportPreviewV1(
        media_type="application/json", text="{}\n", preview_bytes=3, total_bytes=3,
        truncated=False,
    )
    diagnostic = ExportDiagnosticV1(
        code="export.scope.missing-reference",
        severity="error",
        message_key="export.diagnostic.missing-reference",
    )
    blocked = ExportPlanV1(
        options=_options(), source=_source(), inventory={
            "node_count": 0, "relationship_count": 0, "dialogue_count": 0,
            "quest_count": 0, "story_flow_count": 0, "flow_membership_count": 0,
            "flow_transition_count": 0, "scene_boundary_count": 0,
            "flow_invocation_count": 0, "flow_exit_count": 0,
            "flow_exit_binding_count": 0, "initial_state_count": 0,
            "narrative_effect_count": 0, "narrative_effect_binding_count": 0,
            "engine_tag_count": 0, "diagnostic_count": 1, "record_count": 0,
        }, diagnostics=[diagnostic], preview=preview,
        suggested_filename="project-aurora.json", plan_fingerprint="b" * 64,
        can_write=False,
    )
    assert blocked.can_write is False
    with pytest.raises(ValidationError):
        blocked.model_copy(update={"can_write": True}).model_validate(
            blocked.model_copy(update={"can_write": True}).model_dump()
        )


def test_write_request_keeps_paths_transient_but_rejects_traversal_and_controls() -> None:
    request = ExportWriteRequestV1(
        options=_options(),
        expected_source_checksum=CHECKSUM,
        expected_plan_fingerprint="b" * 64,
        destination_directory="/tmp/exports",
    )
    assert request.destination_directory == "/tmp/exports"
    assert ExportWriteRequestV1(
        options=_options(),
        expected_source_checksum=CHECKSUM,
        expected_plan_fingerprint="b" * 64,
    ).destination_directory is None
    assert "destination_directory" not in _projection().model_dump()

    for destination in ("/tmp/../private", "unsafe\x00path"):
        with pytest.raises(ValidationError):
            request.model_copy(update={"destination_directory": destination}).model_validate(
                {**request.model_dump(), "destination_directory": destination}
            )
