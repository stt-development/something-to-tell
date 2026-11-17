"""P9-001 storage baseline. Only disposable projects and fresh PostgreSQL DBs.

Run as a module; each size/mode has a separate worker and RSS high-water mark.
Never pass a production database URL: the test account needs CREATE DATABASE.
"""

import argparse
from contextlib import contextmanager
from dataclasses import replace
from hashlib import sha256
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import sqlite3
import statistics
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from uuid import uuid4

import psycopg
from psycopg import sql
from sqlalchemy import create_engine, make_url, text

from services.runtime.scripts.scale_fixture import SOURCE, document_for, generate_scale_fixture
from services.runtime.scripts.scale_fixture_files import SIZES, load_scale_fixture, seed_sha256
from services.runtime.scripts.storage_scale_metrics import (
    ANALYSIS_MAX_ALLOCATION_BYTES, ANALYSIS_MAX_SECONDS, OperationBudgetExceeded, OperationMetrics,
)
from services.runtime.stt_runtime.dialogue.service import DialogueService
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.export.serialization import JsonExportAdapter
from services.runtime.stt_runtime.export.writer import AtomicExportWriter
from services.runtime.stt_runtime.project_fixture import import_project_fixture, write_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.storage_profiles import PostgreSqlProfile, StorageProfileRegistry

ROOT = Path(__file__).resolve().parents[3]


def _connection(url):
    url = make_url(url)
    return psycopg.connect(host=url.host, port=url.port, dbname=url.database,
                           user=url.username, password=url.password, connect_timeout=5,
                           sslmode=url.query.get("sslmode", "verify-full"), autocommit=True)


@contextmanager
def disposable_database():
    """The configured database is never reset; only our generated name is dropped."""
    configured = os.environ.get("STT_TEST_POSTGRES_URL")
    if not configured:
        raise ValueError("scale_postgresql_test_url_required")
    name = "stt_p9_scale_" + uuid4().hex
    url = make_url(configured)
    with _connection(url) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        try:
            yield url.set(database=name)
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))


def _git_revision(reference):
    """An uncommitted source snapshot has no revision; never invent evidence."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--verify", reference], cwd=ROOT,
            text=True, capture_output=True, check=False,
        )
    except FileNotFoundError:
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def environment():
    """Record reproducibility metadata, never hostname, working paths or DSNs."""
    return {
        "system": platform.system(), "platform": platform.platform(), "machine": platform.machine(),
        "logical_cpus": os.cpu_count(), "python": platform.python_version(),
        "sqlalchemy": version("sqlalchemy"), "psycopg": version("psycopg"),
        "sqlite": sqlite3.sqlite_version,
        "baseline_revision": _git_revision("HEAD"),
        "production_tree": _git_revision("HEAD:services/runtime/stt_runtime"),
        "harness_sha256": sha256(b"".join((Path(__file__).with_name(name)).read_bytes() for name in
            ("benchmark_storage.py", "scale_fixture.py", "scale_fixture_files.py", "storage_scale_metrics.py"))).hexdigest(),
    }


def _latency(url):
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            server = str(connection.execute(text("SHOW server_version")).scalar_one())
            samples = []
            for _ in range(20):
                started = time.perf_counter()
                connection.execute(text("SELECT 1")).scalar_one()
                samples.append((time.perf_counter() - started) * 1000)
        return {"transport": "local_tcp_docker", "server_version": server,
                "samples": len(samples), "select_1_median_ms": round(statistics.median(samples), 4),
                "select_1_max_ms": round(max(samples), 4), "tls": "explicit_test_url_policy"}
    finally:
        engine.dispose()


def _profile(url):
    return PostgreSqlProfile(profile_id="scale-test", label="Disposable scale benchmark", host=url.host,
                             port=url.port, database=url.database, username=url.username,
                             password=url.password, tls_policy=url.query.get("sslmode", "verify-full"))


def measure_operations(registry, project_path, artifact_path, report, *, full_history=False):
    """Use exactly the public session/domain boundaries that the API wraps."""
    def measure(name, action):
        print(f"{report['mode']} {report['node_count']}: {name}", file=sys.stderr, flush=True)
        collector = OperationMetrics()
        try:
            result, metrics = collector.measure(name, action, bounded_analysis=name == "analysis_capture")
        except Exception as error:
            report["operations"].append({**collector.last,
                "status": "budget_exceeded" if isinstance(error, OperationBudgetExceeded) else "failed",
                "error_type": type(error).__name__})
            if isinstance(error, OperationBudgetExceeded):
                report["operations"][-1]["budget_reason"] = str(error)
            raise
        metrics["status"] = "ok"
        report["operations"].append(metrics)
        return result

    opened = measure("open", lambda: registry.open(project_path))
    session_id = opened.session.session_id
    saved_revision = opened.session.saved_revision
    narrow_id = next(node.id for node in opened.document.nodes if node.type == "Lore")
    dialogue_id = opened.document.dialogues[0].node_id
    scoped_flow_id = opened.document.story_flows[0].id
    initial_checksum = opened.document.checksum
    del opened

    def narrow():
        with registry.authoring_unit_of_work(session_id, command_kind="update_node", label_key="history.command.updateNode") as uow:
            node = uow.nodes.get(narrow_id)
            uow.nodes.update(replace(node, body=node.body + " Benchmark edit."))
            uow.commit()

    def aggregate():
        with registry.authoring_unit_of_work(session_id, command_kind="update_dialogue", label_key="history.command.updateDialogue") as uow:
            service = DialogueService()
            document = service.get_document(uow, dialogue_id)
            payload = document.model_dump(mode="json")
            line = next(element for element in payload["elements"] if element["kind"] == "line")
            line["text"] += " Benchmark reply."
            service.update_document(uow, dialogue_id, type(document).model_validate(payload))

    measure("narrow_command", narrow)
    measure("dialogue_aggregate", aggregate)
    assert registry.inspect_history(session_id).undo_depth == 2
    changed = registry.inspect(session_id).document.checksum
    assert changed != initial_checksum
    defer_history = report["mode"] == "postgresql" and report["node_count"] > 1000 and not full_history
    report["large_history_deferred"] = defer_history
    if defer_history:
        # Explicit author decision: collect these two stress samples after P9-009.
        for name in ("undo", "redo"):
            report["operations"].append({"operation": name, "status": "deferred",
                "reason": "author_deferred_until_p9_009"})
    else:
        measure("undo", lambda: registry.undo_history(session_id, expected_history_revision=registry.inspect_history(session_id).history_revision))
        redone = measure("redo", lambda: registry.redo_history(session_id, expected_history_revision=registry.inspect_history(session_id).history_revision))
        assert redone.project.document.checksum == changed
        del redone
    saved = measure("save", lambda: registry.save(session_id, expected_revision=saved_revision, reason="manual"))
    saved_checksum = saved.document.checksum
    del saved

    def reopen():
        registry.close(session_id)
        return registry.open(project_path)

    opened = measure("reopen", reopen)
    session_id = opened.session.session_id
    assert opened.document.checksum == saved_checksum
    del opened
    try:
        capture = measure("analysis_capture", lambda: registry.capture_canon_input(session_id))
    except OperationBudgetExceeded:
        report["analysis_capture_complete"] = False
    else:
        report["analysis_capture_type"] = type(capture).__name__
        report["analysis_capture_complete"] = True
        del capture

    def export(scope):
        with registry.readonly_document_guard(session_id) as (document, _):
            options = ExportOptionsV1(format="json", scope=scope, engine_tag_target="generic",
                                     story_flow_ids=[scoped_flow_id] if scope == "story_flows" else [])
            build = ExportProjectionService().build(document, options)
            if any(item.severity == "error" for item in build.projection.diagnostics):
                raise ValueError("scale_export_diagnostic_error")
            payload = JsonExportAdapter().serialize(build.projection)
            artifact = AtomicExportWriter().install(payload=payload, destination_directory=artifact_path,
                filename=f"{scope}.json", format="json", source_checksum=document.checksum, overwrite=False)
            return {"bytes": artifact.bytes_written, "checksum": artifact.artifact_checksum,
                    "records": build.inventory.record_count, "nodes": build.inventory.node_count}

    before_export = registry.inspect(session_id)
    for scope in ("whole_project", "story_flows"):
        artifact = measure("export_" + scope, lambda scope=scope: export(scope))
        report["operations"][-1]["artifact"] = artifact
    after_export = registry.inspect(session_id)
    assert after_export == before_export
    registry.close(session_id)
    report["integrity"] = {"real_history_commands": 2, "redo_matches_changed_document": None if defer_history else True,
                           "reopen_matches_saved_document": True, "export_read_only": True}


def workload_fixture(node_count):
    """Default workloads are pinned inputs; small developer probes remain generated."""
    return load_scale_fixture(node_count) if node_count in SIZES else generate_scale_fixture(node_count)


def run_case(node_count, mode, folder, database_url=None, *, full_history=False):
    folder.mkdir(parents=True)
    fixture = workload_fixture(node_count)
    document = document_for(fixture)
    report = {"report_version": 1, "fixture_version": 1, "mode": mode, "node_count": node_count,
              "fixture_checksum": document.checksum,
              "fixture_source_sha256": seed_sha256(node_count) if node_count in SIZES else sha256(SOURCE.read_bytes()).hexdigest(),
              "workload_source": "frozen_fixture" if node_count in SIZES else "generated_small_probe",
              "fixture_counts": fixture.expected_validation.model_dump(),
              "collection_counts": {name: len(getattr(document, name)) for name in type(document).model_fields if isinstance(getattr(document, name), list)},
              "environment": environment(), "operations": [],
              "analysis_guard": {"wall_seconds": ANALYSIS_MAX_SECONDS,
                                 "python_allocation_bytes": ANALYSIS_MAX_ALLOCATION_BYTES}}
    del document
    source = folder / "source.json"
    write_project_fixture(source, fixture)
    del fixture
    project_path = folder / "Scale.narrative"
    import_project_fixture(source, project_path)
    profiles = StorageProfileRegistry([_profile(database_url)] if database_url else [], master_key_file=folder / "machine.key")
    registry = ProjectSessionRegistry(profiles)
    artifacts = folder / "artifacts"
    artifacts.mkdir()
    try:
        if mode == "postgresql":
            report["connection"] = _latency(database_url)
            opened = registry.open(project_path)
            registry.migrate_storage(opened.session.session_id, expected_revision=opened.session.saved_revision,
                                     target_mode="postgresql", target_profile_id="scale-test")
            registry.close(opened.session.session_id)
            del opened
        else:
            report["connection"] = {"transport": "in_process_sqlite", "network_rtt_ms": None}
        try:
            measure_operations(registry, project_path, artifacts, report, full_history=full_history)
        except Exception as error:
            # Preserve partial evidence without persisting raw exceptions, paths or DSNs.
            report["status"] = "failed"
            report["error_type"] = type(error).__name__
    finally:
        registry.close_all()
    assert not list(folder.rglob("project.lock.json"))
    if "status" not in report:
        report["status"] = "limited" if any(item["status"] != "ok" for item in report["operations"]) else "ok"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sizes", type=int, nargs="+", default=[1000, 10000])
    parser.add_argument("--modes", choices=("local_sqlite", "postgresql"), nargs="+", default=["local_sqlite", "postgresql"])
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--full-history", action="store_true", help="Include author-deferred PostgreSQL >1000-node Undo/Redo (P9-009)")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        if len(args.sizes) != 1 or len(args.modes) != 1:
            parser.error("A worker owns exactly one size and mode")
        with TemporaryDirectory(prefix="stt-scale-") as temporary:
            folder = Path(temporary).resolve() / "case"
            if args.modes[0] == "postgresql":
                with disposable_database() as url:
                    result = run_case(args.sizes[0], args.modes[0], folder, url, full_history=args.full_history)
            else:
                result = run_case(args.sizes[0], args.modes[0], folder)
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        return
    reports = []
    with TemporaryDirectory(prefix="stt-scale-reports-") as temporary:
        for size in args.sizes:
            for mode in args.modes:
                path = Path(temporary) / f"{size}-{mode}.json"
                command = [sys.executable, "-m", "services.runtime.scripts.benchmark_storage", "--worker",
                    "--sizes", str(size), "--modes", mode, "--report", str(path)]
                if args.full_history:
                    command.append("--full-history")
                subprocess.run(command, cwd=ROOT, check=True)
                reports.append(json.loads(path.read_text()))
                # Retain completed cases even if a later worker is interrupted.
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps({"report_version": 1, "cases": reports}, indent=2, sort_keys=True) + "\n")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps({"report_version": 1, "cases": reports}, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
