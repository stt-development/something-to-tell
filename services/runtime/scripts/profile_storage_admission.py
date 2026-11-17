"""R2e: compare owned public encrypted-profile admission over ASGI and live TCP."""

import argparse
from contextlib import contextmanager
from functools import wraps
from hashlib import sha256
import json
from multiprocessing import get_context
import os
from pathlib import Path
import re
import shutil
import signal
import socket
from tempfile import mkdtemp
from time import monotonic, sleep

import httpx
from fastapi.testclient import TestClient
import uvicorn

from services.runtime.scripts.benchmark_storage import disposable_database, environment
from services.runtime.scripts.prepare_frontend_baseline import prepare
from services.runtime.scripts.profile_storage_migration_batches import MigrationBatchProfile
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyAgentMemoryRepository
from services.runtime.stt_runtime.schemas.project_session import ProjectSessionResponse


class AdmissionProfile(MigrationBatchProfile):
    """Keep only machine-readable SQL failure categories, never driver messages."""

    TARGETS = MigrationBatchProfile.TARGETS + (
        (SqlAlchemyAgentMemoryRepository, "add_many", "memory_batch"),
    )

    def __init__(self):
        super().__init__()
        self.sql_failures = []

    def _error(self, context):
        previous = self.failed_sql
        super()._error(context)
        if self.failed_sql == previous:
            return
        state = getattr(context.original_exception, "sqlstate", None)
        statement = context.statement or ""
        command = statement.lstrip().split(None, 1)[0].upper() if statement.strip() else ""
        self.sql_failures.append(dict(
            sqlstate=state if isinstance(state, str) and re.fullmatch(r"[0-9A-Z]{5}", state) else "unavailable",
            command=command if command in {"SELECT", "INSERT", "UPDATE", "DELETE", "COMMIT", "SET"} else "other"))

    def summary(self):
        return {**super().summary(), "sql_failures": self.sql_failures}


def owned_app(root, *, instrumented):
    """All configuration is explicit: never load a user's profiles, key or DB."""
    root = Path(root)
    app = create_app(RuntimeSettings(_env_file=None,
        database_url=f"sqlite:///{root / 'process.sqlite'}",
        storage_profiles_file=root / "profiles.json", storage_master_key_file=root / "machine.key",
        canon_provider_profiles_file=root / "providers.enc",
        ink_compiler_policy="disabled", yarn_compiler_policy="disabled"))
    registry = app.state.project_sessions
    original = registry.migrate_storage

    @wraps(original)
    def measured(*args, **kwargs):
        # Construct inside FastAPI's actual worker, not the process main thread.
        profile = AdmissionProfile() if instrumented else None
        started = monotonic()
        try:
            if profile is None:
                return original(*args, **kwargs)
            with profile:
                return original(*args, **kwargs)
        finally:
            data = {"migration_wall_seconds": round(monotonic() - started, 6)}
            if profile is not None:
                data.update(profile.summary())
            (root / "migration-metrics.json").write_text(json.dumps(data), encoding="utf-8")

    # One owned process/registry/request; no production flag or global runtime hook.
    registry.migrate_storage = measured
    return app


def _serve(root, listener, instrumented):
    server = uvicorn.Server(uvicorn.Config(owned_app(root, instrumented=instrumented),
        log_level="critical", access_log=False))
    try:
        server.run(sockets=[listener])
    except KeyboardInterrupt:
        # Uvicorn re-raises SIGINT after graceful lifespan shutdown completes.
        pass


@contextmanager
def admission_client(root, transport, instrumented, lifecycle):
    lifecycle["runtime_cleanup"] = "pending"
    if transport == "asgi":
        with TestClient(owned_app(root, instrumented=instrumented),
                        headers={"X-Remote-Storage-Version": "1"}) as client:
            yield client
        lifecycle["runtime_cleanup"] = "released"
        return
    if transport != "live":
        raise ValueError("admission_transport_unsupported")
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    port = listener.getsockname()[1]
    process = get_context("spawn").Process(target=_serve, args=(root, listener, instrumented))
    try:
        process.start()
    finally:
        listener.close()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=60,
                          headers={"X-Remote-Storage-Version": "1"}, trust_env=False) as client:
            deadline = monotonic() + 30
            while True:
                if not process.is_alive():
                    raise RuntimeError("admission_runtime_start_failed")
                try:
                    if client.get("/api/health").status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                if monotonic() >= deadline:
                    raise RuntimeError("admission_runtime_start_timeout")
                sleep(0.05)
            yield client
    finally:
        if process.is_alive():
            os.kill(process.pid, signal.SIGINT)
        process.join(65)
        if process.is_alive():
            raise RuntimeError("admission_runtime_shutdown_failed")
        if process.exitcode != 0:
            raise RuntimeError("admission_runtime_exit_failed")
        lifecycle["runtime_cleanup"] = "released"


def _post(client, route, payload=None):
    response = client.post("/api" + route, json=payload or {})
    if not response.is_success:
        detail = response.json().get("detail", {})
        code = detail.get("code") if isinstance(detail, dict) else None
        # Never retain raw HTTP bodies (project text and encrypted credentials).
        return None, code if isinstance(code, str) and re.fullmatch(r"[a-z_]{1,80}", code) else "unclassified"
    return response.json(), None


def exercise(client, url, fixture, report):
    opened, error = _post(client, "/project-sessions/open", {"path": fixture["path"], "recovery_mode": "recover"})
    if error:
        raise RuntimeError("admission_source_open_failed")
    source = ProjectSessionResponse.model_validate(opened)
    sid = source.session.session_id
    try:
        report["stage"] = "encrypted_profile"
        profile, error = _post(client, "/storage-profiles", dict(session_id=sid, label="Disposable admission",
            host=url.host, port=url.port or 5432, database=url.database, username=url.username,
            password=url.password, tls_policy=url.query.get("sslmode", "verify-full")))
        if error:
            report["error_code"] = error
            return
        report["stage"] = "storage-migrations"
        result, error = _post(client, "/storage-migrations", dict(session_id=sid,
            expected_revision=source.session.saved_revision, target_mode="postgresql", target_profile_id=profile["profile_id"]))
        if error:
            report["error_code"] = error
            current = ProjectSessionResponse.model_validate(client.get(f"/api/project-sessions/{sid}").json())
            report["invariants"]["source_authority_preserved"] = (
                current.session.storage_mode == "local_sqlite" and current.document == source.document)
        else:
            current = ProjectSessionResponse.model_validate(result["project"])
            content = lambda document: document.model_dump(mode="json", exclude={"manifest", "checksum"})
            report["invariants"].update(collections_equal=content(current.document) == content(source.document),
                target_authority=current.session.storage_mode == "postgresql",
                target_checksum=result["verified_checksum"] == current.document.checksum)
            report["status"] = "ok"
        if not all(report["invariants"].values()):
            report["status"] = "integrity_failed"
    finally:
        _closed, error = _post(client, f"/project-sessions/{sid}/close")
        report["cleanup"] = "released" if error is None else "retained"


def profile_admission(size, url, *, transport, instrumented=False, parent=None):
    if size not in {"small", "1000"} or transport not in {"live", "asgi"}:
        raise ValueError("admission_case_unsupported")
    root = Path(mkdtemp(prefix="stt-r2-admission-", dir=parent))
    report = dict(report_version=1, size=size, transport=transport, profile_path="public_encrypted",
        instrumentation="sql_named_stages" if instrumented else "wall_control",
        environment=environment(), status="failed", cleanup="not_acquired", invariants={}, stage="fixture",
        probe_sha256=sha256(b"".join(Path(__file__).with_name(name).read_bytes() for name in (
            "profile_storage_admission.py", "profile_storage_migration_batches.py",
            "profile_storage_migration.py", "prepare_frontend_baseline.py", "storage_scale_metrics.py"))).hexdigest())
    try:
        fixture = prepare(root / "fixture", size)
        report.update(fixture_source_sha256=fixture["source_sha256"], node_count=fixture["node_count"], geometry=fixture["geometry"])
        with admission_client(root, transport, instrumented, report) as client:
            exercise(client, url, fixture, report)
    except Exception:
        # Failure metadata comes only from explicit allowlisted stage/HTTP/SQL fields.
        report["status"] = "failed"
    finally:
        metrics = root / "migration-metrics.json"
        if metrics.exists():
            report.update(json.loads(metrics.read_text(encoding="utf-8")))
        if (report["cleanup"] in {"released", "not_acquired"}
                and report.get("runtime_cleanup", "not_acquired") in {"released", "not_acquired"}
                and not list(root.rglob("project.lock.json"))):
            shutil.rmtree(root)
        else:
            report["cleanup"] = "retained"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", required=True, choices=("small", "1000"))
    parser.add_argument("--transport", required=True, choices=("live", "asgi"))
    parser.add_argument("--instrumented", action="store_true")
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    with disposable_database() as url:
        report = profile_admission(args.size, url, transport=args.transport, instrumented=args.instrumented)
    report["database_cleanup"] = "released"
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("status", "stage", "cleanup", "database_cleanup")}))
    return 0 if report["status"] == "ok" and report["cleanup"] == "released" else 1


if __name__ == "__main__":
    raise SystemExit(main())
