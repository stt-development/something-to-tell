"""Determinism, safety, and substitution tests for Phase 8 serializers."""

import json
from pathlib import Path
import re

import pytest
import yaml

from services.runtime.stt_runtime.export.serialization import (
    ExportSerializationError,
    ExportSerializationService,
    JsonExportAdapter,
    YamlExportAdapter,
)
from services.runtime.stt_runtime.schemas.export import ExportProjectionV1

GOLDEN = Path("services/runtime/tests/fixtures/export_projection_v1.golden.json")
GOLDEN_YAML = Path("services/runtime/tests/fixtures/export_projection_v1.golden.yaml")


def _projection(*, ambiguous_values: bool = False) -> ExportProjectionV1:
    payload = json.loads(GOLDEN.read_text(encoding="utf-8"))
    if ambiguous_values:
        payload["project"]["extensions"]["values"] = {
            "x-empty": "",
            "x-date": "2026-09-25",
            "x-boolean": "true",
            "x-null": "null",
            "x-number": "00123",
            "x-multiline": "first line\nвторая строка\n",
            "x-values": [None, True, False, 17, 1.25],
        }
    return ExportProjectionV1.model_validate(payload)


def test_json_is_stable_utf8_indented_lf_terminated_and_validated() -> None:
    projection = _projection()
    adapter = JsonExportAdapter()

    first = adapter.serialize(projection)
    second = adapter.serialize(projection)

    assert first == second
    assert first.endswith(b"\n") and not first.endswith(b"\n\n")
    assert b"\r" not in first
    assert first.splitlines()[1].startswith(b"  ")
    assert "Русская строка" in first.decode("utf-8")
    assert adapter.deserialize(first) == projection


def test_yaml_is_safe_explicit_stable_and_preserves_ambiguous_scalars() -> None:
    projection = _projection(ambiguous_values=True)
    adapter = YamlExportAdapter()

    first = adapter.serialize(projection)
    second = adapter.serialize(projection)
    text = first.decode("utf-8")

    assert first == second
    assert first.endswith(b"\n") and not first.endswith(b"\n\n")
    assert b"\r" not in first
    assert '"2026-09-25"' in text
    assert '"true"' in text and '"null"' in text and '"00123"' in text
    assert re.search(r'^\s+"x-multiline": \|', text, flags=re.MULTILINE)
    assert re.search(r'^\s{8}- null$', text, flags=re.MULTILINE)
    assert not re.search(r"(?:^|\s)[&*][A-Za-z0-9_-]+", text)
    assert "!!" not in text
    assert adapter.deserialize(first) == projection
    assert yaml.safe_load(text)["project"]["extensions"]["values"]["x-date"] == "2026-09-25"
    unquoted_date = text.replace('"2026-09-25"', "2026-09-25").encode("utf-8")
    restored = adapter.deserialize(unquoted_date)
    assert restored.project.extensions.values["x-date"] == "2026-09-25"


def test_json_and_yaml_have_identical_validated_semantics() -> None:
    projection = _projection(ambiguous_values=True)
    json_projection = JsonExportAdapter().deserialize(JsonExportAdapter().serialize(projection))
    yaml_projection = YamlExportAdapter().deserialize(YamlExportAdapter().serialize(projection))

    assert json_projection == yaml_projection == projection
    assert json_projection.model_dump(mode="json") == yaml_projection.model_dump(mode="json")


def test_bilingual_json_and_yaml_golden_bytes_remain_stable() -> None:
    projection = _projection()
    json_bytes = JsonExportAdapter().serialize(projection)
    yaml_bytes = YamlExportAdapter().serialize(projection)

    assert json_bytes == GOLDEN.read_bytes()
    assert yaml_bytes == GOLDEN_YAML.read_bytes()
    assert JsonExportAdapter().deserialize(json_bytes) == projection
    assert YamlExportAdapter().deserialize(yaml_bytes) == projection


@pytest.mark.parametrize(
    "payload",
    [
        b"---\n{}\n---\n{}\n",
        b'root: &shared {value: 1}\ncopy: *shared\n',
        b'root: !!python/object/apply:os.system ["echo unsafe"]\n',
    ],
)
def test_yaml_rejects_multiple_documents_aliases_anchors_and_tags(payload: bytes) -> None:
    with pytest.raises(ExportSerializationError) as caught:
        YamlExportAdapter().deserialize(payload)
    assert caught.value.code in {"export_contract_invalid", "export_projection_unsafe"}


def test_deserializers_reject_invalid_utf8_nonfinite_json_and_schema_drift() -> None:
    for adapter, payload in (
        (JsonExportAdapter(), b"\xff"),
        (JsonExportAdapter(), b'{"value": NaN}\n'),
        (YamlExportAdapter(), b"\xff"),
        (YamlExportAdapter(), b'"projection_version": 2\n'),
    ):
        with pytest.raises(ExportSerializationError) as caught:
            adapter.deserialize(payload)
        assert caught.value.code == "export_contract_invalid"


def test_output_and_input_byte_limits_are_enforced(monkeypatch: pytest.MonkeyPatch) -> None:
    import services.runtime.stt_runtime.export.serialization as serialization

    monkeypatch.setattr(serialization, "EXPORT_MAX_OUTPUT_BYTES", 64)
    for adapter in (JsonExportAdapter(), YamlExportAdapter()):
        with pytest.raises(ExportSerializationError, match="export_limit_exceeded"):
            adapter.serialize(_projection())
        with pytest.raises(ExportSerializationError, match="export_limit_exceeded"):
            adapter.deserialize(b" " * 65)


def test_service_uses_only_the_substituted_narrow_adapter() -> None:
    projection = _projection()

    class RecordingAdapter:
        format = "json"
        media_type = "application/test"
        extension = ".test"

        def __init__(self) -> None:
            self.serialized: list[ExportProjectionV1] = []
            self.deserialized: list[bytes] = []

        def serialize(self, value: ExportProjectionV1) -> bytes:
            self.serialized.append(value)
            return b"substituted\n"

        def deserialize(self, payload: bytes) -> ExportProjectionV1:
            self.deserialized.append(payload)
            return projection

    adapter = RecordingAdapter()
    service = ExportSerializationService({"json": adapter})

    assert service.serialize("json", projection) == b"substituted\n"
    assert service.deserialize("json", b"input") == projection
    assert adapter.serialized == [projection]
    assert adapter.deserialized == [b"input"]

    with pytest.raises(ExportSerializationError, match="export_contract_invalid"):
        ExportSerializationService({}).serialize("json", projection)
    with pytest.raises(ExportSerializationError, match="export_contract_invalid"):
        ExportSerializationService({"yaml": adapter})


def test_serialization_module_has_no_repository_or_filesystem_dependencies() -> None:
    source = Path(
        "services/runtime/stt_runtime/export/serialization.py"
    ).read_text(encoding="utf-8")
    forbidden = ("repositories", "sqlalchemy", "pathlib", "open(", "ProjectDocument")
    assert all(token not in source for token in forbidden)
    assert "ExportProjectionV1" in source
