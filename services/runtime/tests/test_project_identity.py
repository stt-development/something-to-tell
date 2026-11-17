"""Composite identity, historical migration and actual portable-copy evidence."""

from contextlib import ExitStack
from dataclasses import replace
import os
from pathlib import Path
import subprocess
import sqlite3

from alembic import command
from alembic.operations import BatchOperations, Operations
import pytest
from sqlalchemy import Column, MetaData, String, Table, create_engine, inspect, select
from fastapi.testclient import TestClient

from services.runtime.scripts.benchmark_storage import disposable_database, _profile
from services.runtime.scripts.scale_fixture import document_for, generate_scale_fixture
from services.runtime.stt_runtime.db.sqlite_policy import enable_foreign_keys
from services.runtime.stt_runtime.domain.entities import EdgeEntity, IssueEntity, NodeEntity, ProjectEntity, StoryFlowEntity
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_fixture import import_project_fixture, write_project_fixture
from services.runtime.stt_runtime.project_session.database import alembic_config, upgrade_database
from services.runtime.stt_runtime.project_session.documents import document_with_project_identity
from services.runtime.stt_runtime.project_session.scoped_uow import project_unit_of_work
from services.runtime.stt_runtime.project_session.service import ProjectSessionError, ProjectSessionRegistry
from services.runtime.stt_runtime.project_session.storage_migration import admit_migration_target
from services.runtime.stt_runtime.repositories.project_scope import ProjectScopeError
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.db.sqlite_backup import backup_sqlite
from services.runtime.stt_runtime.db.remote_ownership import control, head
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1

MODES = ["sqlite"] + (["postgresql"] if os.getenv("STT_TEST_POSTGRES_URL") else [])
OLD = "20260919_0009"
HEAD = "20261022_0012"


@pytest.fixture(params=MODES)
def authority(request, tmp_path):
    with ExitStack() as stack:
        url = stack.enter_context(disposable_database()) if request.param == "postgresql" else f"sqlite:///{tmp_path / 'authority.sqlite'}"
        engine = create_engine(url)
        enable_foreign_keys(engine)
        try:
            yield engine, alembic_config(engine.url.render_as_string(hide_password=False))
        finally:
            engine.dispose()


def seed(engine, document):
    from services.runtime.stt_runtime.project_session.database import create_session_factory
    factory = create_session_factory(engine)
    with SqlAlchemyUnitOfWork(factory, project_id=document.manifest.project_id) as uow:
        uow.projects.add(ProjectEntity(id=document.manifest.project_id, name=document.manifest.name,
            path="/tmp/Synthetic.narrative", format_version=2))
        return ProjectDocumentService().reconcile(uow, document)


def snapshot(engine):
    metadata = MetaData()
    metadata.reflect(bind=engine)
    with engine.connect() as connection:
        return {name: [dict(row) for row in connection.execute(select(table).order_by(*table.primary_key.columns)).mappings()]
                for name, table in metadata.tables.items() if name not in OPERATIONAL_TABLES | {"alembic_version"}}


# Operational leases are not canonical authoring records and may appear on upgrade.
OPERATIONAL_TABLES = {"remote_storage_control", "project_storage_heads",
                      "remote_command_receipts", "remote_saved_checkpoints"}


def test_identical_canonical_ids_and_all_references_coexist(authority):
    engine, config = authority
    command.upgrade(config, "head")
    first = seed(engine, document_for(generate_scale_fixture(16)))
    manifest = first.manifest.model_copy(update={"project_id": "independent-copy", "name": "Independent copy"})
    second = seed(engine, document_with_project_identity(first, manifest, first.manifest.project_id))
    from services.runtime.stt_runtime.project_session.database import create_session_factory
    factory = create_session_factory(engine)
    original = first.checksum
    with project_unit_of_work(factory, second.manifest) as uow:
        target = uow.nodes.get(first.nodes[0].id)
        assert target.project_id == second.manifest.project_id
        uow.nodes.update(replace(target, title="Changed copy only"))
        uow.commit()
    with project_unit_of_work(factory, first.manifest) as uow:
        assert ProjectDocumentService().load(uow, first.manifest).checksum == original
        assert uow.nodes.get(target.id).title != "Changed copy only"
    with SqlAlchemyUnitOfWork(factory) as unbound:
        with pytest.raises(ProjectScopeError):
            unbound.nodes.get(target.id)
    # Includes nested Dialogue/Quest ids, tag owners, effects, memory scopes and
    # invocation/exit bindings, not merely graph-node counts.
    for field in type(first).model_fields:
        records, copies = getattr(first, field), getattr(second, field)
        if isinstance(records, list):
            assert [getattr(item, "id", getattr(item, "node_id", None)) for item in records] == [
                getattr(item, "id", getattr(item, "node_id", None)) for item in copies]
    for table in inspect(engine).get_table_names():
        if table not in OPERATIONAL_TABLES | {"projects", "alembic_version"}:
            assert inspect(engine).get_pk_constraint(table)["constrained_columns"] == ["project_id", "id"]
            for fk in inspect(engine).get_foreign_keys(table):
                if fk["referred_table"] != "projects":
                    assert fk["constrained_columns"][0] == fk["referred_columns"][0] == "project_id"
    options = ExportOptionsV1(format="json", scope="whole_project", engine_tag_target="generic")
    exports = [ExportProjectionService().build(document, options).projection for document in (first, second)]
    assert [node.id for node in exports[0].nodes] == [node.id for node in exports[1].nodes]
    before = snapshot(engine)
    with pytest.raises(RuntimeError, match="downgrade_requires_verified_backup_restore"):
        command.downgrade(config, OLD)
    assert snapshot(engine) == before


def test_online_sqlite_backup_includes_committed_wal_pages(tmp_path):
    source, destination = tmp_path / "wal.sqlite", tmp_path / "backup.sqlite"
    with sqlite3.connect(source) as connection:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("CREATE TABLE sample (value TEXT)")
        connection.execute("INSERT INTO sample VALUES ('committed')")
        connection.commit()
        assert Path(str(source) + "-wal").stat().st_size > 0
        backup_sqlite(source, destination)
        with sqlite3.connect(destination) as restored:
            assert restored.execute("SELECT value FROM sample").fetchone() == ("committed",)


def test_legacy_sqlite_orphan_is_rejected_before_any_ddl(tmp_path):
    # Older SQLite authorities could have FK enforcement disabled. Preserve that
    # genuine unsafe v9 input without weakening the new runtime connection policy.
    engine = create_engine(f"sqlite:///{tmp_path / 'orphan.sqlite'}")
    config = alembic_config(engine.url.render_as_string(hide_password=False))
    try:
        command.upgrade(config, OLD)
        from services.runtime.stt_runtime.project_session.database import create_session_factory
        with SqlAlchemyUnitOfWork(create_session_factory(engine)) as uow:
            uow.projects.add(ProjectEntity(id="p", name="P", path="/tmp/P.narrative", format_version=2))
            uow.edges.add(EdgeEntity(project_id="p", source_node_id="missing", target_node_id="also-missing", type="related_to"))
            uow.commit()
        before = snapshot(engine)
        with pytest.raises(RuntimeError, match="project_identity_reference_invalid"):
            command.upgrade(config, "head")
        assert snapshot(engine) == before
        assert inspect(engine).get_pk_constraint("edges")["constrained_columns"] == ["id"]
    finally:
        engine.dispose()


def test_failed_copy_provisioning_rolls_back_root_and_preserves_neighbour(authority):
    engine, config = authority
    command.upgrade(config, "head")
    first = seed(engine, document_for(generate_scale_fixture(16)))
    manifest = first.manifest.model_copy(update={"project_id": "failed-copy"})
    candidate = document_with_project_identity(first, manifest, first.manifest.project_id)
    from services.runtime.stt_runtime.project_session.database import create_session_factory
    factory = create_session_factory(engine)
    before = snapshot(engine)
    with pytest.raises(RuntimeError, match="injected_copy_failure"):
        with project_unit_of_work(factory, manifest) as uow:
            admit_migration_target(uow, candidate, Path("/tmp/Failed.narrative"), shared=True)
            raise RuntimeError("injected_copy_failure")
    assert snapshot(engine) == before


def test_nullable_reference_cleanup_and_cascade_do_not_touch_copy(authority):
    engine, config = authority
    command.upgrade(config, "head")
    from services.runtime.stt_runtime.project_session.database import create_session_factory
    factory = create_session_factory(engine)
    for project_id in ("a", "b"):
        with SqlAlchemyUnitOfWork(factory, project_id=project_id) as uow:
            uow.projects.add(ProjectEntity(id=project_id, name=project_id, path="/tmp/Test.narrative", format_version=2))
            for node_id in ("source", "target"):
                uow.nodes.add(NodeEntity(id=node_id, project_id=project_id, type="Lore", title=node_id))
            uow.edges.add(EdgeEntity(id="edge", project_id=project_id, source_node_id="source", target_node_id="target", type="related_to"))
            uow.issues.add(IssueEntity(id="issue", project_id=project_id, node_id="source", edge_id="edge", title="Issue"))
            uow.story_flows.add(StoryFlowEntity(id="flow", project_id=project_id, name="Flow", normalized_name="flow", entry_node_id="source"))
            uow.commit()
    with SqlAlchemyUnitOfWork(factory, project_id="b") as uow:
        uow.nodes.delete("source")
        uow.commit()
        assert uow.edges.get("edge") is None
        assert uow.issues.get("issue").node_id is None
        assert uow.issues.get("issue").edge_id is None
        assert uow.issues.get("issue").project_id == "b"
        assert uow.story_flows.get("flow").entry_node_id is None
    with SqlAlchemyUnitOfWork(factory, project_id="a") as uow:
        assert uow.nodes.get("source") and uow.edges.get("edge")
        assert uow.issues.get("issue").edge_id == "edge"
        assert uow.story_flows.get("flow").entry_node_id == "source"


def test_v9_migration_preserves_complete_data_and_backup(authority, tmp_path):
    engine, config = authority
    command.upgrade(config, OLD)
    document = seed(engine, document_for(generate_scale_fixture(16)))
    before = snapshot(engine)
    backup = None
    if engine.dialect.name == "sqlite":
        (tmp_path / "snapshots").mkdir()
        backup = upgrade_database(Path(engine.url.database), project_path=tmp_path, backup_existing=True)
        backup_engine = create_engine(f"sqlite:///{backup}")
        try:
            assert snapshot(backup_engine) == before
        finally:
            backup_engine.dispose()
    else:
        # Optional explicit Docker backup drill, enabled in the recorded task run.
        if os.getenv("STT_TEST_PG_DOCKER_BACKUP") == "1":
            backup = subprocess.run(["docker-compose", "exec", "-T", "postgres", "pg_dump", "-U", "stt_test",
                                     "-Fc", "--no-owner", engine.url.database], check=True, capture_output=True).stdout
        command.upgrade(config, "head")
    assert snapshot(engine) == before
    from services.runtime.stt_runtime.project_session.database import create_session_factory
    with project_unit_of_work(create_session_factory(engine), document.manifest) as uow:
        assert ProjectDocumentService().load(uow, document.manifest).checksum == document.checksum
    with engine.connect() as connection:
        ownership = list(connection.execute(select(head)).mappings())
        assert len(ownership) == 1
        assert ownership[0]["project_id"] == document.manifest.project_id
        assert ownership[0]["writer_epoch"] == 0
        assert ownership[0]["owner_token"] is ownership[0]["lease_expires_at"] is None
        policy = connection.execute(select(control)).mappings().one()
        assert (policy["transaction_seconds"], policy["lease_seconds"], policy["renew_seconds"]) == (20, 60, 15)
    command.upgrade(config, "head")  # Repeated upgrade does not rewrite data.
    assert snapshot(engine) == before
    with engine.connect() as connection:
        assert list(connection.execute(select(head)).mappings()) == ownership
    if engine.dialect.name == "postgresql" and backup is not None:
        with disposable_database() as restored_url:
            subprocess.run(["docker-compose", "exec", "-T", "postgres", "pg_restore", "-U", "stt_test",
                            "--no-owner", "--exit-on-error", "-d", restored_url.database],
                           input=backup, capture_output=True, check=True)
            restored = create_engine(restored_url)
            try:
                assert snapshot(restored) == before
                assert inspect(restored).get_pk_constraint("nodes")["constrained_columns"] == ["id"]
            finally:
                restored.dispose()


@pytest.mark.parametrize("failure", ["cross_project", "ddl", "schema"])
def test_migration_rejects_unsafe_data_and_rolls_back_partial_ddl(authority, monkeypatch, failure):
    engine, config = authority
    command.upgrade(config, OLD)
    from services.runtime.stt_runtime.project_session.database import create_session_factory
    factory = create_session_factory(engine)
    with SqlAlchemyUnitOfWork(factory) as uow:
        for identity in ("a", "b"):
            uow.projects.add(ProjectEntity(id=identity, name=identity, path="/tmp/Test.narrative", format_version=2))
            uow.nodes.add(NodeEntity(id=identity, project_id=identity, type="Lore", title=identity))
        if failure == "cross_project":
            uow.edges.add(EdgeEntity(id="invalid", project_id="b", source_node_id="a", target_node_id="b", type="related_to"))
        uow.commit()
    before = snapshot(engine)
    if failure == "schema":
        Table("unexpected", MetaData(), Column("id", String, primary_key=True)).create(engine)
        before = snapshot(engine)
    if failure == "ddl":
        owner = BatchOperations if engine.dialect.name == "sqlite" else Operations
        original = owner.create_primary_key
        calls = []
        def injected(*args, **kwargs):
            calls.append(True)
            if len(calls) == 2:
                raise RuntimeError("injected_ddl_failure")
            return original(*args, **kwargs)
        monkeypatch.setattr(owner, "create_primary_key", injected)
    with pytest.raises(RuntimeError, match="project_identity_reference_invalid|injected_ddl_failure|project_identity_schema_incompatible"):
        command.upgrade(config, "head")
    assert snapshot(engine) == before
    assert inspect(engine).get_pk_constraint("nodes")["constrained_columns"] == ["id"]
    with engine.connect() as connection:
        assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar_one() == OLD


if os.getenv("STT_TEST_POSTGRES_URL"):
    def test_real_save_as_copies_and_repeated_remote_import(tmp_path):
        fixture = tmp_path / "source.json"
        write_project_fixture(fixture, generate_scale_fixture(16))
        first, second, preserved = (tmp_path / f"{name}.narrative" for name in ("A", "B", "Relocated"))
        import_project_fixture(fixture, first)
        with disposable_database() as url:
            registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(url)]))
            try:
                a = registry.open(first)
                saved = registry.save_as(a.session.session_id, destination=second, expected_revision=a.session.saved_revision,
                                         identity="regenerate", replace_existing=False)
                registry.save_as(a.session.session_id, destination=preserved, expected_revision=a.session.saved_revision,
                                 identity="preserve", replace_existing=False)
                a = registry.migrate_storage(a.session.session_id, expected_revision=a.session.saved_revision,
                                             target_mode="postgresql", target_profile_id="scale-test").project
                b = registry.open(second)
                assert b.session.project_id == saved.project_id != a.session.project_id
                registry.migrate_storage(b.session.session_id, expected_revision=b.session.saved_revision,
                                         target_mode="postgresql", target_profile_id="scale-test")
                before = registry.inspect(a.session.session_id).document.checksum
                copy_before = registry.inspect(b.session.session_id).document.checksum
                with registry.authoring_unit_of_work(b.session.session_id, command_kind="update_node", label_key="history.command.updateNode") as uow:
                    node = uow.nodes.get(a.document.nodes[0].id)
                    uow.nodes.update(replace(node, title="Independent edit"))
                    uow.commit()
                assert registry.inspect(a.session.session_id).document.checksum == before
                registry.undo_history(b.session.session_id, expected_history_revision=registry.inspect_history(b.session.session_id).history_revision)
                assert registry.inspect(a.session.session_id).document.checksum == before
                assert registry.inspect(b.session.session_id).document.checksum == copy_before
                app = create_app()
                app.state.project_sessions = registry
                with TestClient(app) as client:
                    for selected in (a, b):
                        response = client.get(f"/api/nodes/{a.document.nodes[0].id}",
                            headers={"X-Project-Session-Id": selected.session.session_id})
                        assert response.status_code == 200
                        assert response.json()["project_id"] == selected.session.project_id
                # Same identity can reattach only when canonical data agrees.
                registry.close_all()
                c = registry.open(preserved)
                registry.migrate_storage(c.session.session_id, expected_revision=c.session.saved_revision,
                                         target_mode="postgresql", target_profile_id="scale-test")
                registry.close_all()
                c = registry.open(preserved)
                registry.migrate_storage(c.session.session_id, expected_revision=c.session.saved_revision,
                                         target_mode="local_sqlite", target_profile_id=None)
                with registry.authoring_unit_of_work(c.session.session_id, command_kind="update_node", label_key="history.command.updateNode") as uow:
                    node = uow.nodes.get(c.document.nodes[0].id)
                    uow.nodes.update(replace(node, title="Divergent relocation"))
                    uow.commit()
                c = registry.save(c.session.session_id, expected_revision=c.session.saved_revision, reason="manual")
                probe = create_engine(url)
                try:
                    remote_before = snapshot(probe)
                    with pytest.raises(ProjectSessionError, match="storage_migration_identity_conflict"):
                        registry.migrate_storage(c.session.session_id, expected_revision=c.session.saved_revision,
                                                 target_mode="postgresql", target_profile_id="scale-test")
                    assert snapshot(probe) == remote_before
                finally:
                    probe.dispose()
                active = registry._sessions[c.session.session_id]
                assert active.state.storage_mode == "local_sqlite"
            finally:
                registry.close_all()
        assert not list(tmp_path.rglob("project.lock.json"))
