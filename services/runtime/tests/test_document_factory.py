"""Single-normalization factory must match the original two-pass contract."""

from pathlib import Path

import pytest

from services.runtime.scripts.scale_fixture import document_for
from services.runtime.scripts.scale_fixture_files import load_scale_fixture
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.export.serialization import JsonExportAdapter
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas import project_document as schema

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures/projects"


def _document(name="project-aurora.v1.json"):
    return document_for(load_project_fixture(FIXTURES / name))


def _original_factory(payload):
    """Frozen pre-R5 oracle: do not derive expected bytes from the new factory."""
    unsigned = {"document_version": schema.PROJECT_DOCUMENT_VERSION, **payload}
    unsigned.pop("checksum", None)
    normalized = schema.ProjectDocument.model_validate(
        {**unsigned, "checksum": "0" * 64}, context={"skip_checksum": True},
    )
    checksum = schema.project_document_checksum(normalized)
    return schema.ProjectDocument.model_validate(
        {**normalized.model_dump(mode="python"), "checksum": checksum}
    )


@pytest.mark.parametrize("name", ["project-aurora.v1.json", "citadel-branch.v1.json", "1000"])
def test_factory_preserves_complete_document_and_canonical_bytes(name):
    original = document_for(load_scale_fixture(1000)) if name == "1000" else _document(name)
    for mode in ("python", "json"):
        payload = original.model_dump(mode=mode)
        expected = _original_factory(payload)
        actual = schema.create_project_document(**payload)
        assert actual == expected
        assert actual.model_dump_json() == expected.model_dump_json()
        assert schema.ProjectDocument.model_validate_json(actual.model_dump_json()) == actual
        assert actual.checksum == original.checksum


@pytest.mark.parametrize("target", ["node", "dialogue", "manifest"])
def test_factory_revalidates_untrusted_nested_model_instances(target):
    document = _document()
    payload = document.model_dump(mode="python")
    if target == "node":
        payload["nodes"][0] = document.nodes[0].model_copy(update={"title": None})
    elif target == "dialogue":
        owned = document.dialogues[0]
        line = next(item for item in owned.document.elements if item.kind == "line")
        broken = line.model_copy(update={"text": None})
        dialogue = owned.document.model_copy(update={"elements": [
            broken if item.id == line.id else item for item in owned.document.elements
        ]})
        payload["dialogues"][0] = owned.model_copy(update={"document": dialogue})
    else:
        payload["manifest"] = document.manifest.model_copy(update={"name": None})
    with pytest.raises(ValueError):
        _original_factory(payload)
    with pytest.raises(ValueError):
        schema.create_project_document(**payload)


@pytest.mark.parametrize("failure", ["ordering", "missing_reference", "extra_field"])
def test_factory_keeps_complete_document_rejections(failure):
    payload = _document().model_dump(mode="python")
    if failure == "ordering":
        payload["nodes"].reverse()
    elif failure == "missing_reference":
        payload["edges"][0]["source_node_id"] = "missing-node"
    else:
        payload["unknown"] = True
    with pytest.raises(ValueError):
        schema.create_project_document(**payload)


def test_factory_derives_checksum_once_from_fully_normalized_content(monkeypatch):
    document = _document()
    payload = document.model_dump(mode="python")
    payload["checksum"] = "ignored-caller-value"
    payload["project_metadata"] = {"nested": {"tuple": (1, "two"), "stamp": document.nodes[0].created_at}}
    expected = _original_factory(payload)
    checksum = schema.project_document_checksum
    calls = []

    def measured(value):
        calls.append(value)
        return checksum(value)

    monkeypatch.setattr(schema, "project_document_checksum", measured)
    actual = schema.create_project_document(**payload)
    assert actual == expected
    assert len(calls) == 1
    assert actual.checksum == checksum(actual)
    assert payload["checksum"] == "ignored-caller-value"
    assert schema.ProjectDocument.model_validate(actual.model_dump(mode="python")) == actual


@pytest.mark.parametrize("scope", ["whole_project", "story_flows"])
def test_factory_preserves_whole_and_scoped_export_bytes(scope):
    source = document_for(load_scale_fixture(1000))
    payload = source.model_dump(mode="python")
    before = _original_factory(payload)
    after = schema.create_project_document(**payload)
    options = ExportOptionsV1(
        format="json", scope=scope, engine_tag_target="generic",
        story_flow_ids=[source.story_flows[0].id] if scope == "story_flows" else [],
    )
    service, adapter = ExportProjectionService(), JsonExportAdapter()
    original, current = service.build(before, options), service.build(after, options)
    assert current == original
    assert adapter.serialize(current.projection) == adapter.serialize(original.projection)
