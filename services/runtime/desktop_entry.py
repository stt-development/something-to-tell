"""Frozen runtime entry point: offline probe or private desktop-controlled server."""

import argparse
import asyncio
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.domain.entities import NodeEntity
from services.runtime.stt_runtime.desktop_runtime import run_desktop


async def self_check() -> dict:
    """Exercise real package imports/migrations and Save without a socket or user data."""
    with TemporaryDirectory(prefix="stt-frozen-check-") as temporary:
        root = Path(temporary)
        app = create_app(RuntimeSettings(
            _env_file=None, docs_enabled=False,
            storage_profiles_file=root / "storage.json",
            storage_master_key_file=root / "storage.key",
            canon_provider_profiles_file=root / "providers.enc",
            ink_compiler_policy="disabled", yarn_compiler_policy="disabled",
        ))
        async with app.router.lifespan_context(app):
            registry = app.state.project_sessions
            path = root / "Probe.narrative"
            created = registry.create(path, "Bundled runtime probe")
            session = created.session.session_id
            with registry.authoring_unit_of_work(
                session, command_kind="create_node", label_key="history.command.createNode",
            ) as uow:
                uow.nodes.add(NodeEntity(project_id=created.session.project_id,
                                         type="Lore", title="Frozen runtime check"))
                uow.commit()
            saved = registry.save(session, expected_revision=created.session.saved_revision, reason="manual")
            checksum = saved.document.checksum
            registry.close(session)
            reopened = registry.open(path)
            if reopened.document.checksum != checksum or len(reopened.document.nodes) != 1:
                raise RuntimeError("runtime_self_check_round_trip_failed")
            registry.close(reopened.session.session_id)
            if list(root.rglob("project.lock.json")):
                raise RuntimeError("runtime_self_check_lock_retained")
        if any((root / name).exists() for name in ("storage.json", "storage.key", "providers.enc")):
            raise RuntimeError("runtime_self_check_profile_mutation")
        return {"schema_version": 1, "status": "ok", "checks": [
            "app_imports", "migrations", "create", "edit", "save", "reopen", "lock_release",
        ]}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Something To Tell Engine bundled runtime")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--self-check", action="store_true")
    modes.add_argument("--desktop", action="store_true")
    args = parser.parse_args(argv)
    # Installed migration Python resources are read-only, not a bytecode cache.
    sys.dont_write_bytecode = True
    if args.desktop:
        return asyncio.run(run_desktop(sys.stdin.fileno(), sys.stdout))
    try:
        report = asyncio.run(self_check())
    except Exception:
        # No paths, authored content, environment values or provider credentials.
        print(json.dumps({"schema_version": 1, "status": "failed", "code": "runtime_self_check_failed"}))
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
