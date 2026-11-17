"""Temporary detailed attribution must not change adapters or retain values."""

import json
from pathlib import Path

import pytest
from sqlalchemy import create_engine

from services.runtime.scripts import profile_storage_migration_batches as probe
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.db.session import create_session_factory
from services.runtime.stt_runtime.domain.entities import NodeEntity, ProjectEntity
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork


def test_actual_batch_is_counted_without_breaking_fast_path_and_all_wrappers_restore():
    originals = [(owner, name, getattr(owner, name)) for owner, name, _label in probe.MigrationBatchProfile.TARGETS]
    import_model_metadata()
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    try:
        with SqlAlchemyUnitOfWork(create_session_factory(engine), project_id="owned") as uow:
            uow.projects.add(ProjectEntity(id="owned", name="Owned", path="/tmp/owned", format_version=2))
            with probe.MigrationBatchProfile() as profile:
                uow.nodes.add_many([NodeEntity(project_id="owned", type="Lore", title="private-authored") for _ in range(2)])
            row = next(row for row in profile.summary()["stages"] if row["stage"] == "batch_Node")
            assert row["calls"] == row["cursor_calls"] == 1
            assert row["failures"] == 0
            assert "private-authored" not in json.dumps(profile.summary())
        assert all(getattr(owner, name) is method for owner, name, method in originals)
    finally:
        engine.dispose()


@pytest.mark.parametrize("fail", [False, True])
def test_helper_class_override_restores_on_return_or_failure(monkeypatch, fail):
    original = probe.migration.MigrationProfile
    def measured(*args, **kwargs):
        assert probe.migration.MigrationProfile is probe.MigrationBatchProfile
        if fail:
            raise RuntimeError("owned_failure")
        return {"status": "ok"}
    monkeypatch.setattr(probe.migration, "profile_migration", measured)
    if fail:
        with pytest.raises(RuntimeError, match="owned_failure"):
            probe.profile_batches("small", None)
    else:
        report = probe.profile_batches("small", None)
        assert report["diagnostic_kind"] == "repository_batches"
        assert len(report["probe_sha256"]) == 64
    assert probe.migration.MigrationProfile is original


@pytest.mark.internal_documentation
def test_node_batch_evidence_keeps_rejection_and_three_owned_successes_distinct():
    root = Path(__file__).resolve().parents[3] / "docs/verification/baselines"
    before = json.loads((root / "p9-009r2b3-batches-before.json").read_text())["cases"][0]
    rejected = json.loads((root / "p9-009r2b3-insert-trial-rejected.json").read_text())["cases"][0]
    after = json.loads((root / "p9-009r2b3-node-batch-after.json").read_text())["cases"]
    assert rejected["status"] == "failed" and rejected["error_code"] == "remote_storage_timeout"
    assert rejected["invariants"]["source_authority_preserved"]
    assert len(after) == 3
    assert before["probe_sha256"] == rejected["probe_sha256"] == after[0]["probe_sha256"]
    assert len({row["environment"]["production_tree"] for row in after}) == 1
    for row in [rejected, *after]:
        assert row["cleanup"] == row["database_cleanup"] == "released"
        assert all(row["invariants"].values())
    assert all(row["status"] == "ok" and row["size"] == "1000" for row in after)
    stages = {row["stage"]: row for row in after[0]["stages"]}
    assert stages["batch_Node"]["cursor_calls"] == 1
    assert stages["reconcile"]["cursor_calls"] == 437
    assert "node_add" not in stages
    assert stages["memory_add"]["calls"] == 80
    for forbidden in ("postgresql+psycopg", "stt_test_password", "/Users/", '"session_id"', '"parameters"'):
        assert forbidden not in json.dumps(after)
