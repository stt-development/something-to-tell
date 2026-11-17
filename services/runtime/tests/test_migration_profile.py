"""Owned attribution helper: counts, transparent wrapping, privacy and safe cleanup."""

import json
import os
from pathlib import Path
from threading import Thread

import pytest
from sqlalchemy import Engine, create_engine, event, make_url, text

from services.runtime.scripts import profile_storage_migration as probe
from services.runtime.scripts.benchmark_storage import disposable_database
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


def test_sql_counts_and_all_wrappers_restore_after_exception():
    original = ProjectDocumentService.load
    originals = [(owner, name, getattr(owner, name)) for owner, name, _label in probe.MigrationProfile.TARGETS]
    engine = create_engine("sqlite:///:memory:")
    profile = probe.MigrationProfile()
    try:
        with pytest.raises(RuntimeError, match="owned_failure"):
            with profile:
                assert ProjectDocumentService.load is not original
                with engine.begin() as connection:
                    connection.execute(text("CREATE TABLE example (id integer)"))
                    connection.execute(text("INSERT INTO example VALUES (:id)"), [{"id": 1}, {"id": 2}])
                    connection.execute(text("SELECT count(*) FROM example"))
                raise RuntimeError("owned_failure")
        assert ProjectDocumentService.load is original
        assert all(getattr(owner, name) is method for owner, name, method in originals)
        summary = profile.summary()["sql"]
        assert (summary["cursor_calls"], summary["parameter_sets"]) == (3, 4)
        assert (summary["read_calls"], summary["write_calls"], summary["ddl_calls"]) == (1, 1, 1)
        assert not event.contains(Engine, "before_cursor_execute", profile._before)
        assert not event.contains(Engine, "after_cursor_execute", profile._after)
        assert not event.contains(Engine, "handle_error", profile._error)
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        assert profile.sql.calls == 3
    finally:
        engine.dispose()


def test_failed_statements_and_background_work_are_not_silently_successful():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    profile = probe.MigrationProfile()
    def background():
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
    try:
        with profile:
            thread = Thread(target=background)
            thread.start()
            thread.join()
            assert profile.sql.calls == 0
            with pytest.raises(Exception), engine.connect() as connection:
                connection.execute(text("SELECT * FROM missing_example"))
        summary = profile.summary()["sql"]
        assert summary["cursor_calls"] == summary["failed_calls"] == 1
        assert summary["successful_cursor_seconds"] == 0
    finally:
        engine.dispose()


def test_named_spans_preserve_return_identity_and_propagate_failure_without_data():
    profile = probe.MigrationProfile()
    private = object()
    assert profile._wrap("document_load", lambda value: value)(private) is private
    with pytest.raises(ValueError):
        profile._wrap("document_load", lambda: (_ for _ in ()).throw(ValueError("secret payload")))()
    row = profile.summary()["stages"][0]
    assert (row["calls"], row["failures"]) == (2, 1)
    assert row["wall_seconds"] >= 0
    assert "secret" not in json.dumps(profile.summary())


@pytest.mark.parametrize("instrumented", [False, True])
def test_failed_migration_preserves_complete_local_authority_and_closes_owned_project(tmp_path, monkeypatch, instrumented):
    def failed(*args, **kwargs):
        raise ProjectSessionError("remote_storage_timeout", private="must not enter report")
    monkeypatch.setattr(probe, "_latency", lambda url: {"transport": "unit_no_remote_connection"})
    monkeypatch.setattr(ProjectSessionRegistry, "migrate_storage", failed)
    report = probe.profile_migration("small", make_url("postgresql+psycopg://private_user:private_value@invalid:5432/test"),
        instrumented=instrumented, parent=tmp_path)
    assert report["status"] == "failed"
    assert report["error_code"] == "remote_storage_timeout"
    assert report["invariants"] == {"source_authority_preserved": True}
    assert report["cleanup"] == "released"
    assert not list(tmp_path.iterdir())
    encoded = json.dumps(report)
    for forbidden in (str(tmp_path), "private_user", "private_value", "must not enter", "session_id"):
        assert forbidden not in encoded


def test_failed_public_close_retains_owned_project_instead_of_deleting_its_lock(tmp_path, monkeypatch):
    registry = ProjectSessionRegistry(StorageProfileRegistry([], master_key_file=tmp_path / "machine.key"))
    close = registry.close
    monkeypatch.setattr(probe, "_latency", lambda url: {})
    monkeypatch.setattr(probe, "ProjectSessionRegistry", lambda profiles: registry)
    monkeypatch.setattr(registry, "migrate_storage", lambda *args, **kwargs: (_ for _ in ()).throw(ProjectSessionError("remote_storage_timeout")))
    monkeypatch.setattr(registry, "close", lambda *args, **kwargs: (_ for _ in ()).throw(ProjectSessionError("project_unsaved_changes")))
    try:
        report = probe.profile_migration("small", make_url("postgresql+psycopg://unused:unused@invalid:5432/test"), parent=tmp_path)
        assert report["cleanup"] == "retained"
        assert list(tmp_path.rglob("project.lock.json"))
    finally:
        monkeypatch.setattr(registry, "close", close)
        registry.close_all()
    assert not list(tmp_path.rglob("project.lock.json"))


@pytest.mark.skipif(not os.environ.get("STT_TEST_POSTGRES_URL"), reason="requires the explicit disposable PostgreSQL test URL")
def test_small_real_postgresql_migration_and_complete_document_verification(tmp_path):
    with disposable_database() as url:
        report = probe.profile_migration("small", url, instrumented=True, parent=tmp_path)
    assert report["status"] == "ok"
    assert report["cleanup"] == "released"
    assert all(report["invariants"].values())
    assert report["sql"]["cursor_calls"] > 0
    assert {row["stage"] for row in report["stages"]} >= {"prepare_target", "document_load", "reconcile", "commit"}
    assert not list(tmp_path.iterdir())


@pytest.mark.internal_documentation
def test_frozen_migration_evidence_keeps_controls_and_timeouts_distinct():
    path = Path(__file__).resolve().parents[3] / "docs/verification/baselines/p9-009r2a-migration-before.json"
    report = json.loads(path.read_text())
    rows = report["cases"]
    assert [(row["size"], row["instrumentation"]) for row in rows] == [
        ("small", "wall_control"), ("small", "sql_named_stages"),
        ("1000", "wall_control"), ("1000", "sql_named_stages")]
    assert len({row["probe_sha256"] for row in rows}) == 1
    assert len({row["environment"]["production_tree"] for row in rows}) == 1
    assert rows[0]["fixture_source_sha256"] == rows[1]["fixture_source_sha256"]
    assert rows[2]["fixture_source_sha256"] == rows[3]["fixture_source_sha256"]
    for index, row in enumerate(rows):
        assert row["cleanup"] == row["database_cleanup"] == "released"
        assert all(row["invariants"].values())
        if index < 2:
            assert row["status"] == "ok"
        else:
            assert row["status"] == "failed"
            assert row["error_code"] == "remote_storage_timeout"
    assert "sql" not in rows[0] and "sql" not in rows[2]
    stages = {row["stage"]: row for row in rows[3]["stages"]}
    assert stages["node_add"]["calls"] == 1000
    assert stages["node_add"]["cursor_calls"] == 1558
    assert stages["reconcile"]["failures"] == 1
    assert "placement_add" not in stages and "stage_checkpoint" not in stages
    for secret in ("postgresql+psycopg", "stt_test_password", "/Users/", '"session_id"', '"parameters"'):
        assert secret not in json.dumps(report)


@pytest.mark.internal_documentation
def test_batch_migration_evidence_verifies_complete_work_without_hiding_prior_failure():
    root = Path(__file__).resolve().parents[3] / "docs/verification/baselines"
    before = json.loads((root / "p9-009r2a-migration-before.json").read_text())["cases"]
    after = json.loads((root / "p9-009r2b2-migration-after.json").read_text())["cases"]
    assert len(after) == 4
    assert len({row["probe_sha256"] for row in before + after}) == 1
    assert len({row["environment"]["production_tree"] for row in after}) == 1
    assert after[0]["environment"]["production_tree"] != before[0]["environment"]["production_tree"]
    for original, current in zip(before, after, strict=True):
        assert (current["size"], current["instrumentation"], current["fixture_source_sha256"]) == (
            original["size"], original["instrumentation"], original["fixture_source_sha256"])
        assert current["status"] == "ok"
        assert current["cleanup"] == current["database_cleanup"] == "released"
        assert all(current["invariants"].values())
        assert "error_code" not in current
    large = {row["stage"]: row for row in after[3]["stages"]}
    assert large["node_add"]["calls"] == 124
    assert large["reconcile"]["failures"] == 0
    assert large["reconcile"]["cursor_calls"] == 1119
    assert large["commit"]["calls"] == large["stage_checkpoint"]["calls"] == 1
    assert after[3]["sql"]["failed_calls"] == 0
    for forbidden in ("postgresql+psycopg", "stt_test_password", "/Users/", '"session_id"', '"parameters"'):
        assert forbidden not in json.dumps(after)
