"""Owned session attribution: restoration, privacy, lifecycle and complete data."""

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import make_url

from services.runtime.scripts import profile_storage_session as probe
from services.runtime.scripts.benchmark_storage import disposable_database
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


def test_measure_preserves_return_and_restores_every_temporary_boundary():
    originals = [(owner, name, getattr(owner, name)) for owner, name, _label in probe.SessionProfile.TARGETS]
    result = object()
    report = {"operations": []}
    assert probe._measure(report, "open", lambda: result, True) is result
    assert report["operations"][0]["status"] == "ok"
    assert all(getattr(owner, name) is method for owner, name, method in originals)
    assert "object" not in json.dumps(report)


@pytest.mark.parametrize("instrumented", [False, True])
def test_failure_is_not_a_fast_success_or_a_payload_dump(instrumented):
    report = {"operations": []}
    def failed():
        raise ProjectSessionError("remote_storage_timeout", private="private-authored-text")
    with pytest.raises(ProjectSessionError):
        probe._measure(report, "save", failed, instrumented)
    row = report["operations"][0]
    assert row["status"] == "failed" and row["error_code"] == "remote_storage_timeout"
    assert row["wall_seconds"] >= 0
    assert ("sql" in row) == instrumented
    assert "private-authored-text" not in json.dumps(report)


def test_invalid_size_never_allocates_a_folder(tmp_path):
    with pytest.raises(ValueError, match="session_probe_size_unsupported"):
        probe.profile_session("10000", None, parent=tmp_path)
    assert not list(tmp_path.iterdir())


def test_failed_setup_releases_only_owned_local_source(tmp_path, monkeypatch):
    monkeypatch.setattr(probe, "_latency", lambda url: {})
    def failed(*args, **kwargs):
        raise ProjectSessionError("remote_storage_timeout", private="must-not-escape")
    monkeypatch.setattr(ProjectSessionRegistry, "migrate_storage", failed)
    report = probe.profile_session("small", make_url("postgresql+psycopg://private:secret@invalid:5432/test"), parent=tmp_path)
    assert report["status"] == "failed"
    assert report["error_code"] == "remote_storage_timeout"
    assert report["cleanup"] == "released" and not report["operations"]
    assert not list(tmp_path.iterdir())
    for private in ("secret", "must-not-escape", str(tmp_path), '"session_id"'):
        assert private not in json.dumps(report)


def test_failed_save_retains_dirty_owned_project_without_automatic_discard(tmp_path, monkeypatch):
    registry = ProjectSessionRegistry(StorageProfileRegistry([], master_key_file=tmp_path / "machine.key"))
    monkeypatch.setattr(probe, "ProjectSessionRegistry", lambda profiles: registry)
    monkeypatch.setattr(probe, "_latency", lambda url: {})
    # Explicit test-only SQLite stand-in exercises release failure without PG;
    # the real opt-in case below owns PostgreSQL semantics and saved verification.
    monkeypatch.setattr(registry, "migrate_storage", lambda sid, **kwargs: SimpleNamespace(project=registry.inspect(sid)))
    def failed(*args, **kwargs):
        raise ProjectSessionError("remote_storage_timeout")
    monkeypatch.setattr(registry, "save", failed)
    try:
        report = probe.profile_session("small", make_url("postgresql+psycopg://unused:unused@invalid:5432/test"), parent=tmp_path)
        assert report["status"] == "failed" and report["stage"] == "save"
        assert report["cleanup"] == "retained"
        assert report["invariants"]["edit_complete_document"]
        assert list(tmp_path.rglob("project.lock.json"))
        assert [row["status"] for row in report["operations"]] == ["ok", "ok", "failed"]
    finally:
        # This registry contains only the test's owned temporary project.
        registry.close_all()
    assert not list(tmp_path.rglob("project.lock.json"))


@pytest.mark.skipif(not os.environ.get("STT_TEST_POSTGRES_URL"), reason="requires explicit disposable PostgreSQL test URL")
def test_complete_small_session_lifecycle_against_owned_postgresql(tmp_path):
    with disposable_database() as url:
        report = probe.profile_session("small", url, instrumented=True, parent=tmp_path)
    assert report["status"] == "ok", {key: report.get(key) for key in ("stage", "error_code", "error_type")}
    assert report["cleanup"] == "released" and not list(tmp_path.iterdir())
    assert len(report["invariants"]) == 8 and all(report["invariants"].values())
    assert [row["operation"] for row in report["operations"]] == ["open", "edit", "save", "close"]
    assert all(row["status"] == "ok" and row["sql"]["cursor_calls"] > 0 for row in report["operations"])
    assert all(any(stage["stage"] == "document_load" for stage in row["stages"]) for row in report["operations"])
    for private in ("stt_test_password", "postgresql+psycopg", str(tmp_path), '"session_id"', '"parameters"'):
        assert private not in json.dumps(report)


@pytest.mark.internal_documentation
def test_session_evidence_preserves_failed_before_and_verified_capture_reduction():
    root = Path(__file__).resolve().parents[3] / "docs/verification/baselines"
    before = json.loads((root / "p9-009r2c1-session-before.json").read_text())["cases"]
    after = json.loads((root / "p9-009r2c2-session-after.json").read_text())["cases"]
    assert before[2]["status"] == "failed" and not before[2]["operations"]
    assert len({row["probe_sha256"] for row in before + after}) == 1
    assert len({row["environment"]["production_tree"] for row in after}) == 1
    for original, current in zip(before, after, strict=True):
        assert (current["size"], current["fixture_source_sha256"]) == (original["size"], original["fixture_source_sha256"])
        assert current["status"] == "ok" and all(current["invariants"].values())
        assert current["cleanup"] == current["database_cleanup"] == "released"
        assert [row["operation"] for row in current["operations"]] == ["open", "edit", "save", "close"]
    for index in (1, 3):
        rows = after[index]["operations"]
        assert [row["sql"]["cursor_calls"] for row in rows] == [46, 162, 113, 32]
        stages = [{stage["stage"]: stage for stage in row["stages"]} for row in rows]
        assert [row["document_load"]["calls"] for row in stages] == [1, 6, 4, 1]
        assert all("reconcile" not in row for row in stages)
        assert all(row["sql"]["failed_calls"] == 0 for row in rows)
    for forbidden in ("postgresql+psycopg", "stt_test_password", "/Users/", '"session_id"', '"parameters"'):
        assert forbidden not in json.dumps(after)
