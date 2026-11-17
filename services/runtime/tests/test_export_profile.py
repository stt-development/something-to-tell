"""The diagnostic must keep original guards, deterministic bytes and cleanup."""

import json
from pathlib import Path

import pytest

from services.runtime.scripts import benchmark_storage as benchmark
from services.runtime.scripts.profile_storage_export import run_export_case
from services.runtime.stt_runtime.export.projection import ExportProjectionService


def test_export_probe_uses_owned_setup_and_restores_hooks(tmp_path):
    original = benchmark.measure_operations
    report = run_export_case(16, "local_sqlite", tmp_path / "case")
    assert benchmark.measure_operations is original
    assert report["status"] == "ok"
    assert all(report["integrity"].values())
    assert [row["operation"] for row in report["operations"]] == [
        "export_whole_project", "export_story_flows",
    ]
    for row in report["operations"]:
        assert row["write_calls"] == row["ddl_calls"] == 0
        assert row["python_allocation_peak_bytes"] > 0
        stages = {item["stage"]: item for item in row["attribution"]["stages"]}
        assert stages["document_load"]["calls"] == 1
        for name in ("projection", "tag_projection", "serialization", "installation"):
            assert stages[name]["calls"] == 1
            assert stages[name]["failures"] == 0
    assert not list(tmp_path.rglob("project.lock.json"))


def test_export_probe_restores_callback_on_setup_failure(tmp_path, monkeypatch):
    original = benchmark.measure_operations

    def fail(_size):
        raise ValueError("injected_setup_failure")

    monkeypatch.setattr(benchmark, "workload_fixture", fail)
    with pytest.raises(ValueError, match="injected_setup_failure"):
        run_export_case(16, "local_sqlite", tmp_path / "case")
    assert benchmark.measure_operations is original
    assert not list(tmp_path.rglob("project.lock.json"))


def test_export_probe_retains_failure_without_private_payload(tmp_path, monkeypatch):
    original = benchmark.measure_operations

    def fail(*args, **kwargs):
        raise ValueError("private-author-content-must-not-escape")

    monkeypatch.setattr(ExportProjectionService, "build", fail)
    report = run_export_case(16, "local_sqlite", tmp_path / "case")
    assert report["status"] == "failed"
    assert report["operations"][0]["status"] == "failed"
    stages = {row["stage"]: row for row in report["operations"][0]["attribution"]["stages"]}
    assert stages["projection"]["failures"] == 1
    assert ExportProjectionService.build is fail
    assert benchmark.measure_operations is original
    assert "private-author-content" not in json.dumps(report)
    assert str(tmp_path) not in json.dumps(report)
    assert not list(tmp_path.rglob("project.lock.json"))


@pytest.mark.internal_documentation
def test_frozen_export_pair_preserves_scope_probe_and_read_only_evidence():
    directory = Path(__file__).resolve().parents[3] / "docs/verification/baselines"
    before = json.loads((directory / "p9-009-export-before-v1.json").read_text())["cases"]
    after = json.loads((directory / "p9-009-export-after-v1.json").read_text())["cases"]
    assert [row["mode"] for row in before] == [row["mode"] for row in after] == ["local_sqlite", "postgresql"]
    for original, current in zip(before, after, strict=True):
        for field in ("fixture_checksum", "fixture_source_sha256", "probe_sha256", "collection_counts", "measurement_kind"):
            assert current[field] == original[field]
        assert current["node_count"] == original["node_count"] == 1000
        assert current["status"] == original["status"] == "ok"
        assert current["local_cleanup"] == original["local_cleanup"] == "released"
        assert all(current["integrity"].values()) and all(original["integrity"].values())
        for left, right in zip(original["operations"], current["operations"], strict=True):
            assert right["operation"] == left["operation"]
            assert right["status"] == left["status"] == "ok"
            assert right["write_calls"] == right["ddl_calls"] == 0
            assert right["cursor_calls"] == left["cursor_calls"]
            for field in ("records", "nodes", "bytes"):
                assert right["artifact"][field] == left["artifact"][field]
        assert [row["artifact"]["nodes"] for row in current["operations"]] == [1000, 15]
