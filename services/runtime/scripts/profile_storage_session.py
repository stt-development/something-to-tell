"""P9-009R2c1: owned session capture attribution, never normal runtime hooks."""

import argparse
from contextlib import nullcontext
from dataclasses import replace
from datetime import UTC, datetime
from hashlib import sha256
import json
from pathlib import Path
import shutil
from tempfile import mkdtemp
from time import perf_counter

from services.runtime.scripts.benchmark_storage import _latency, _profile, disposable_database, environment
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.scripts import profile_storage_migration as migration_probe
from services.runtime.stt_runtime.project_session import remote_store
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


class SessionProfile(migration_probe.MigrationProfile):
    """Inclusive stages distinguish table captures from saved checkpoint parsing."""

    TARGETS = migration_probe.MigrationProfile.TARGETS + (
        (remote_store, "capture", "capture"),
        (remote_store, "document_in_session", "document_in_session"),
        (remote_store, "saved_document", "saved_document"),
    )


def _measure(report, name, action, instrumented):
    row = {"operation": name, "status": "failed"}
    profile = SessionProfile() if instrumented else None
    start = perf_counter()
    try:
        with profile if profile is not None else nullcontext():
            result = action()
        row["status"] = "ok"
        return result
    except Exception as error:
        row.update(error_code=migration_probe._error_code(error), error_type=type(error).__name__)
        raise
    finally:
        row["wall_seconds"] = round(perf_counter() - start, 6)
        if profile is not None:
            row.update(profile.summary())
        report["operations"].append(row)


def profile_session(size, database_url, *, instrumented=False, parent=None):
    if size not in ("small", "1000"):
        raise ValueError("session_probe_size_unsupported")
    report = dict(report_version=1, size=size, instrumentation="sql_named_stages" if instrumented else "wall_control",
        environment=environment(), probe_sha256=sha256(Path(__file__).read_bytes() +
            Path(migration_probe.__file__).read_bytes()).hexdigest(), status="failed", cleanup="pending",
        invariants={}, operations=[], stage="prepare_fixture")
    root = Path(mkdtemp(prefix="stt-r2-session-", dir=parent))
    registry, session_id = None, None
    try:
        fixture = prepare(root / "fixture", size)
        path = Path(fixture["path"])
        report.update(fixture_source_sha256=fixture["source_sha256"], node_count=fixture["node_count"])
        report["connection"] = _latency(database_url)
        registry = ProjectSessionRegistry(StorageProfileRegistry([_profile(database_url)], master_key_file=root / "machine.key"))
        report["stage"] = "migration_setup"
        source = registry.open(path)
        session_id = source.session.session_id
        migrated = registry.migrate_storage(session_id, expected_revision=source.session.saved_revision,
            target_mode="postgresql", target_profile_id="scale-test").project
        setup_checksum = migrated.document.checksum
        registry.close(session_id)
        session_id = None

        report["stage"] = "open"
        opened = _measure(report, "open", lambda: registry.open(path), instrumented)
        session_id = opened.session.session_id
        report["invariants"]["opened_complete_target"] = opened.document.checksum == setup_checksum
        # Verification material remains private and outside operation timers.
        node = next(node for node in opened.document.nodes if node.type == "Lore")
        stamp = datetime.now(UTC)
        summary = node.summary + " Capture attribution edit."
        expected = opened.document.model_dump(mode="json", exclude={"manifest", "checksum"})
        expected["nodes"] = [record.model_copy(update={"summary": summary, "updated_at": stamp}).model_dump(mode="json")
            if record.id == node.id else record.model_dump(mode="json") for record in opened.document.nodes]

        def narrow_edit():
            with registry.authoring_unit_of_work(session_id, command_kind="update_node", label_key="history.command.updateNode") as uow:
                stored = uow.nodes.get(node.id)
                uow.nodes.update(replace(stored, summary=summary, updated_at=stamp))
                uow.commit()

        report["stage"] = "edit"
        _measure(report, "edit", narrow_edit, instrumented)
        changed = registry.inspect(session_id)
        report["invariants"]["edit_complete_document"] = changed.document.model_dump(
            mode="json", exclude={"manifest", "checksum"}) == expected
        report["invariants"]["edit_dirty_and_history"] = changed.session.save_status == "dirty" and registry.inspect_history(session_id).undo_depth == 1

        report["stage"] = "save"
        saved = _measure(report, "save", lambda: registry.save(session_id,
            expected_revision=opened.session.saved_revision, reason="manual"), instrumented)
        report["invariants"].update(saved_complete_document=saved.document.model_dump(
            mode="json", exclude={"manifest", "checksum"}) == expected,
            saved_clean=saved.session.save_status == "clean",
            saved_revision_advanced=saved.session.saved_revision == opened.session.saved_revision + 1)

        report["stage"] = "close"
        closed = _measure(report, "close", lambda: registry.close(session_id), instrumented)
        session_id = None
        report["invariants"]["close_complete_document"] = closed.document.checksum == saved.document.checksum
        report["stage"] = "verify_saved_reopen"
        reopened = registry.open(path)
        session_id = reopened.session.session_id
        report["invariants"]["reopened_saved_document"] = (
            reopened.document.checksum == saved.document.checksum and reopened.session.saved_revision == saved.session.saved_revision)
        report["status"] = "ok" if all(report["invariants"].values()) else "integrity_failed"
        report["stage"] = "complete"
    except Exception as error:
        report.update(error_code=migration_probe._error_code(error), error_type=type(error).__name__)
    finally:
        if registry is not None and session_id is not None:
            try:
                registry.close(session_id)
                report["cleanup"] = "released"
            except Exception:
                report["cleanup"] = "retained"
        else:
            report["cleanup"] = "not_acquired" if registry is None else "released"
        if report["cleanup"] in ("released", "not_acquired") and not list(root.rglob("project.lock.json")):
            shutil.rmtree(root)
        else:
            report["cleanup"] = "retained"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", choices=("small", "1000"), required=True)
    parser.add_argument("--instrumented", action="store_true")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report = dict(report_version=1, status="failed", cleanup="not_acquired", database_cleanup="unavailable")
    try:
        with disposable_database() as url:
            report = profile_session(args.size, url, instrumented=args.instrumented)
        report["database_cleanup"] = "released"
    except Exception as error:
        report.update(status="failed", error_code=migration_probe._error_code(error), error_type=type(error).__name__)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cleanup": report["cleanup"], "report": str(args.report)}))
    return 0 if report["status"] == "ok" and report["cleanup"] == "released" else 1


if __name__ == "__main__":
    raise SystemExit(main())
