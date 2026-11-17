"""Opt-in official pg_dump/pg_restore drill, not native desktop UI acceptance.

Requires the repository's existing local Docker PostgreSQL and CREATE DATABASE
test account. Only fresh generated source/target DBs are ever supplied to tools.
"""

from dataclasses import replace
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select, update
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from services.runtime.scripts.benchmark_storage import _profile, disposable_database, environment
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.db.remote_ownership import checkpoints, control, head, receipts
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.export.serialization import JsonExportAdapter, YamlExportAdapter
from services.runtime.stt_runtime.project_session import remote_store
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.resources import NodeUpdate
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry
from services.runtime.stt_runtime.storage_restore import reset_restored_generations

pytestmark = pytest.mark.skipif(
    not os.getenv("STT_TEST_POSTGRES_URL") or os.getenv("STT_TEST_POSTGRES_NATIVE_DOCKER") != "1",
    reason="Requires explicit disposable PostgreSQL URL and native Docker drill opt-in",
)
ROOT = Path(__file__).resolve().parents[3]


def _native(tool, *arguments, payload=None):
    container = os.getenv("STT_TEST_POSTGRES_CONTAINER")
    if container:
        # CI supplies its owned service container id; local operators retain the
        # existing Compose service path. Neither branch ever invokes a shell.
        if not re.fullmatch(r"[a-f0-9]{12,64}", container):
            raise ValueError("Invalid disposable PostgreSQL container id")
        command = ["docker", "exec", "-i", container, tool, *arguments]
    else:
        command = ["docker-compose", "exec", "-T", "postgres", tool, *arguments]
    return subprocess.run(
        command,
        cwd=ROOT, input=payload, capture_output=True, timeout=60,
    )


def _rows(engine):
    """Compare all durable SQL tables, including analysis and operational records."""
    import_model_metadata()
    with engine.connect() as connection:
        return {table.name: [dict(row) for row in connection.execute(
            select(table).order_by(*table.primary_key.columns)).mappings()]
            for table in Base.metadata.sorted_tables}


def _captures(engine, project_ids):
    factory = sessionmaker(bind=engine)
    documents, saved = {}, {}
    for project_id in project_ids:
        document, row = remote_store.capture(factory, project_id)
        documents[project_id] = document
        with engine.connect() as connection:
            saved[project_id] = remote_store.saved_document(connection, project_id, row)
    return documents, saved


def _exports(document):
    result = {}
    for scope in ("whole_project", "story_flows"):
        options = ExportOptionsV1(
            format="json", scope=scope, engine_tag_target="generic",
            story_flow_ids=[document.story_flows[0].id] if scope == "story_flows" else [],
        )
        projection = ExportProjectionService().build(document, options).projection
        assert not any(row.severity == "error" for row in projection.diagnostics)
        for adapter in (JsonExportAdapter(), YamlExportAdapter()):
            result[(scope, adapter.format)] = adapter.serialize(projection)
    return result


def test_native_shared_database_restore_and_explicit_new_machine_cutover(tmp_path):
    destination = os.getenv("STT_RESTORE_DRILL_REPORT")
    if destination:
        # A failed rerun must never leave a previous success masquerading as new.
        Path(destination).write_text(json.dumps({"report_version": 1, "status": "running"}) + "\n")
    with disposable_database() as source_url, disposable_database() as target_url:
        # Docker's UNIX-socket tools must point at the same local service, not an
        # arbitrary configured remote server or a user's existing database.
        assert source_url.host in {"127.0.0.1", "localhost"} and source_url.port == 55432
        assert source_url.database != target_url.database
        versions = {}
        for tool in ("pg_dump", "pg_restore"):
            observed = _native(tool, "--version")
            assert observed.returncode == 0
            versions[tool] = re.search(rb"PostgreSQL\) ([0-9.]+)", observed.stdout).group(1).decode()
        source_registry = ProjectSessionRegistry(StorageProfileRegistry(
            [_profile(source_url)], master_key_file=tmp_path / "source.key"))
        source_engine = create_engine(source_url, poolclass=NullPool)
        target_engine = create_engine(target_url, poolclass=NullPool)
        report = {"report_version": 1, "status": "pending", "tools": versions, "environment": environment(),
                  "probe_sha256": sha256(Path(__file__).read_bytes()).hexdigest()}
        try:
            opened, paths = [], []
            for index in range(2):
                fixture = prepare(tmp_path / f"source-{index}", "small")
                path = Path(fixture["path"])
                project = source_registry.open(path)
                project = source_registry.migrate_storage(
                    project.session.session_id, expected_revision=project.session.saved_revision,
                    target_mode="postgresql", target_profile_id="scale-test").project
                opened.append(source_registry.save(project.session.session_id,
                    expected_revision=project.session.saved_revision, reason="manual"))
                paths.append(path)
            first = opened[0]
            with source_registry.authoring_unit_of_work(first.session.session_id,
                    command_kind="update_node", label_key="history.command.updateNode") as uow:
                node = next(node for node in uow.nodes.list(project_id=first.session.project_id) if node.type == "Lore")
                uow.nodes.update(replace(node, body=node.body + " Unsaved server working text."))
                uow.commit()
            project_ids = [project.session.project_id for project in opened]
            source_registry.close_all()  # Remote shutdown preserves dirty Working.
            with source_engine.begin() as connection:
                connection.execute(update(control).values(maintenance=True))
            original = _rows(source_engine)
            working, saved = _captures(source_engine, project_ids)
            assert working[project_ids[0]] != saved[project_ids[0]]
            assert working[project_ids[1]] == saved[project_ids[1]]
            assert {node.id for node in working[project_ids[0]].nodes} == {node.id for node in working[project_ids[1]].nodes}
            assert all(document.issues and document.engine_tag_bindings for document in working.values())
            artifacts = {pid: _exports(document) for pid, document in working.items()}
            dumped = _native("pg_dump", "-U", source_url.username, "--format=custom",
                             "--no-owner", "--no-privileges", source_url.database)
            assert dumped.returncode == 0 and dumped.stdout.startswith(b"PGDMP")
            restore_args = ("-U", target_url.username, "--dbname", target_url.database,
                            "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error")
            # Bad archive fails on the fresh target; no cutover/source writes.
            failed = _native("pg_restore", *restore_args, payload=b"invalid-archive")
            assert failed.returncode != 0
            with target_engine.connect() as connection:
                assert inspect(connection).get_table_names() == []
            assert _rows(source_engine) == original
            restored = _native("pg_restore", *restore_args, payload=dumped.stdout)
            assert restored.returncode == 0
            assert _rows(target_engine) == original
            with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
                reset_restored_generations(target_engine, expected_database=source_url.database, confirmed=True)
            assert _rows(target_engine) == original and _rows(source_engine) == original
            reset = reset_restored_generations(target_engine, expected_database=target_url.database, confirmed=True)
            assert reset["projects"] == 2 and reset["maintenance"] is True
            restored_working, restored_saved = _captures(target_engine, project_ids)
            assert restored_working == working and restored_saved == saved
            after = _rows(target_engine)
            for table, rows in original.items():
                if table not in {head.name, checkpoints.name}:
                    assert after[table] == rows
            assert after[receipts.name] == original[receipts.name]
            assert all(_exports(document) == artifacts[pid] for pid, document in restored_working.items())

            # New machine: copied project metadata/cache, independently created
            # encrypted profile and key. No credential/key copied from the source.
            profiles = StorageProfileRegistry(master_key_file=tmp_path / "new-machine.key")
            local_paths, profile_ids = [], []
            for index, path in enumerate(paths):
                assert not (path / "cache/remote-pending.json").exists()
                local = tmp_path / f"NewMachine-{index}.narrative"
                shutil.copytree(path, local, ignore=shutil.ignore_patterns("storage-profiles.enc", "project.lock.json"))
                summary = profiles.add(local, label="Restored database", host=target_url.host,
                    port=target_url.port, database=target_url.database, username=target_url.username,
                    password=target_url.password, tls_policy=target_url.query["sslmode"])
                assert target_url.password.encode() not in (local / "storage-profiles.enc").read_bytes()
                local_paths.append(local)
                profile_ids.append(summary.profile_id)
            app = create_app()
            registry = app.state.project_sessions
            registry._storage_profiles = profiles
            with TestClient(app) as client:
                with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
                    registry.open(local_paths[0], remote_profile_id=profile_ids[0])
                assert not list(tmp_path.rglob("project.lock.json"))
                # Only after complete archive/document/export verification does
                # the operator explicitly permit runtime use on this target.
                with target_engine.begin() as connection:
                    connection.execute(update(control).values(maintenance=False))
                sessions = [registry.open(path, remote_profile_id=profile_id)
                            for path, profile_id in zip(local_paths, profile_ids, strict=True)]
                for session, pid in zip(sessions, project_ids, strict=True):
                    assert session.document == working[pid]
                    assert session.session.saved_revision == saved[pid].manifest.saved_revision
                current = sessions[0].session.remote_storage
                old = next(row for row in original[head.name] if row["project_id"] == project_ids[0])
                assert current.storage_generation != old["storage_generation"]
                assert int(current.writer_epoch) > old["writer_epoch"]
                receipt = next(row for row in original[receipts.name] if row["project_id"] == project_ids[0])
                stale_payload = NodeUpdate(project_id=project_ids[0], type=node.type,
                    title=node.title, body="Must never be written").model_dump(mode="json")
                stale = client.put(f"/api/nodes/{node.id}", json=stale_payload, headers={
                    "X-Project-Session-Id": sessions[0].session.session_id,
                    "X-Remote-Storage-Version": "1", "X-Remote-Storage-Generation": old["storage_generation"],
                    "X-Remote-Writer-Epoch": str(old["writer_epoch"]),
                    "X-Remote-Expected-Revision": current.authoring_revision,
                    "X-Remote-Command-Id": receipt["command_id"],
                })
                assert stale.status_code == 409
                assert stale.json()["detail"]["code"] == "remote_generation_mismatch"
                for session, pid in zip(sessions, project_ids, strict=True):
                    assert registry.inspect(session.session.session_id).document == working[pid]
            restarted = ProjectSessionRegistry(StorageProfileRegistry(master_key_file=tmp_path / "new-machine.key"))
            try:
                for path, pid in zip(local_paths, project_ids, strict=True):
                    # Ordinary Open now uses the persisted new encrypted profile
                    # and binding, without the explicit rebind parameter.
                    assert restarted.open(path).document == working[pid]
            finally:
                restarted.close_all()
            assert _rows(source_engine) == original
            assert not list(tmp_path.rglob("project.lock.json"))
            report.update(status="ok", projects=2, canonical_nodes=sum(len(doc.nodes) for doc in working.values()),
                archive_sha256=sha256(dumped.stdout).hexdigest(), archive_bytes=len(dumped.stdout),
                invariants={name: True for name in (
                    "invalid_archive_retains_source", "exact_sql_restore", "complete_working_and_saved",
                    "analysis_and_tags", "canonical_id_isolation", "json_yaml_whole_scoped_parity",
                    "old_receipts_retained", "wrong_destination_rejected", "maintenance_retained_until_cutover",
                    "new_machine_encrypted_profiles", "ordinary_reopen_after_rebind",
                    "new_generation_and_epoch", "stale_command_rejected",
                    "source_unchanged_after_cutover", "sessions_released",
                )})
        finally:
            source_registry.close_all()
            source_engine.dispose()
            target_engine.dispose()
    report["database_cleanup"] = "released"
    if destination:
        Path(destination).write_text(json.dumps(report, indent=2) + "\n")
