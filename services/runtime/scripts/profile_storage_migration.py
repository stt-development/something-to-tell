"""P9-009R2a: owned migration controls/diagnostics, never normal runtime hooks."""

import argparse
from contextlib import ExitStack, nullcontext
from functools import wraps
from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
from tempfile import mkdtemp
from threading import get_ident
from time import perf_counter
from unittest.mock import patch

from sqlalchemy import Engine, event

from services.runtime.scripts.benchmark_storage import (
    _latency, _profile, disposable_database, environment,
)
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.scripts.storage_scale_metrics import OperationMetrics
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_session import service as session_module
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.repositories import sqlite as repositories
from services.runtime.stt_runtime.storage_profiles import StorageProfileRegistry


class MigrationProfile:
    """Process-local inclusive spans and SQL counts; no arguments/results retained."""

    TARGETS = (
        (session_module, "prepare_migration_target", "prepare_target"),
        (ProjectSessionRegistry, "_load_document", "registry_load"),
        (ProjectSessionRegistry, "_stage_checkpoint", "stage_checkpoint"),
        (ProjectDocumentService, "load", "document_load"),
        (ProjectDocumentService, "reconcile", "reconcile"),
        (repositories.SqlAlchemyUnitOfWork, "commit", "commit"),
        (repositories.SqlAlchemyNodeRepository, "add", "node_add"),
        (repositories.SqlAlchemyVisualPlacementRepository, "add", "placement_add"),
    )

    def __init__(self):
        self.sql = OperationMetrics()
        self.failed_sql = 0
        self.spans = {}
        self.thread = get_ident()
        self.stack = ExitStack()

    def _before(self, *args):
        if get_ident() == self.thread:
            self.sql._before(*args)

    def _after(self, *args):
        if get_ident() == self.thread:
            self.sql._after(*args)

    def _error(self, context):
        if get_ident() == self.thread:
            self.failed_sql += 1

    def _wrap(self, name, original):
        @wraps(original)
        def measured(*args, **kwargs):
            if get_ident() != self.thread:
                return original(*args, **kwargs)
            start, calls = perf_counter(), self.sql.calls
            failed = False
            try:
                return original(*args, **kwargs)
            except BaseException:
                failed = True
                raise
            finally:
                row = self.spans.setdefault(name, dict(calls=0, failures=0, wall_seconds=0.0, cursor_calls=0))
                row["calls"] += 1
                row["failures"] += int(failed)
                row["wall_seconds"] += perf_counter() - start
                row["cursor_calls"] += self.sql.calls - calls
        return measured

    def __enter__(self):
        try:
            for name, listener in (("before_cursor_execute", self._before), ("after_cursor_execute", self._after), ("handle_error", self._error)):
                event.listen(Engine, name, listener)
                self.stack.callback(event.remove, Engine, name, listener)
            for owner, attribute, label in self.TARGETS:
                original = getattr(owner, attribute)
                self.stack.enter_context(patch.object(owner, attribute, self._wrap(label, original)))
            return self
        except BaseException:
            self.stack.close()
            raise

    def __exit__(self, *args):
        self.stack.close()

    def summary(self):
        return {
            "sql": dict(cursor_calls=self.sql.calls, parameter_sets=self.sql.parameter_sets,
                read_calls=self.sql.reads, write_calls=self.sql.writes, ddl_calls=self.sql.ddl,
                failed_calls=self.failed_sql, successful_cursor_seconds=round(self.sql.sql_seconds, 6)),
            "stages": [{"stage": name, **{key: round(value, 6) if key == "wall_seconds" else value
                for key, value in row.items()}} for name, row in sorted(self.spans.items())],
        }


def _error_code(error):
    """Stable codes only; SQLAlchemy exception text can contain values/credentials."""
    value = getattr(error, "code", None)
    return value if isinstance(value, str) and re.fullmatch(r"[a-z_]{1,80}", value) else "unclassified"


def profile_migration(size, database_url, *, instrumented=False, parent=None):
    """Allocate a fresh owned folder; retain it if public release cannot be proven."""
    if size not in ("small", "1000"):
        raise ValueError("migration_probe_size_unsupported")
    metadata = environment()
    root = Path(mkdtemp(prefix="stt-r2-migration-", dir=parent))
    registry, session_id, opened = None, None, None
    report = dict(report_version=1, size=size, instrumentation="sql_named_stages" if instrumented else "wall_control",
        environment=metadata, probe_sha256=sha256(Path(__file__).read_bytes()).hexdigest(),
        status="failed", cleanup="pending", invariants={}, stage="prepare_fixture")
    try:
        fixture = prepare(root / "fixture", size)
        report.update(fixture_source_sha256=fixture["source_sha256"], node_count=fixture["node_count"], geometry=fixture["geometry"])
        report["stage"] = "connection"
        report["connection"] = _latency(database_url)
        profiles = StorageProfileRegistry([_profile(database_url)], master_key_file=root / "machine.key")
        registry = ProjectSessionRegistry(profiles)
        report["stage"] = "open_source"
        opened = registry.open(Path(fixture["path"]))
        session_id = opened.session.session_id
        profile = MigrationProfile() if instrumented else None
        report["stage"] = "migration"
        start = perf_counter()
        try:
            with profile if profile is not None else nullcontext():
                result = registry.migrate_storage(session_id, expected_revision=opened.session.saved_revision,
                    target_mode="postgresql", target_profile_id="scale-test")
            report["status"] = "ok"
            report["invariants"]["target_document_verified"] = result.verified_checksum == result.project.document.checksum
        except Exception as error:
            report.update(error_code=_error_code(error), error_type=type(error).__name__)
        finally:
            report["wall_seconds"] = round(perf_counter() - start, 6)
            if profile is not None:
                report.update(profile.summary())
        report["stage"] = "verify_authority"
        current = registry.inspect(session_id)
        if report["status"] == "ok":
            # Storage/manifest timestamps change by contract; every authored collection stays exact.
            before = opened.document.model_dump(mode="json", exclude={"manifest", "checksum"})
            after = current.document.model_dump(mode="json", exclude={"manifest", "checksum"})
            report["invariants"].update(collections_equal=before == after,
                target_authority=current.session.storage_mode == "postgresql")
        else:
            report["invariants"]["source_authority_preserved"] = (
                current.session.storage_mode == "local_sqlite" and current.document.checksum == opened.document.checksum)
        if not all(report["invariants"].values()):
            report["status"] = "integrity_failed"
        report["stage"] = "complete"
    except Exception as error:
        report.update(status="failed", error_code=_error_code(error), error_type=type(error).__name__)
    finally:
        if registry is not None and session_id is not None:
            try:
                registry.close(session_id)
                report["cleanup"] = "released"
            except Exception:
                report["cleanup"] = "failed"
        elif opened is None:
            report["cleanup"] = "not_acquired"
        # Never delete a project still held by a session, even when the benchmark fails.
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
            report = profile_migration(args.size, url, instrumented=args.instrumented)
        report["database_cleanup"] = "released"
    except Exception as error:
        report.update(status="failed", error_code=_error_code(error), error_type=type(error).__name__)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "cleanup": report["cleanup"], "report": str(args.report)}))
    return 0 if report["status"] == "ok" and report["cleanup"] == "released" else 1


if __name__ == "__main__":
    raise SystemExit(main())
