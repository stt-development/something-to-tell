"""Storage handoff recovery. Cross-database copies are staged, not distributed commits."""

import json

from ..project_format.manifest import ProjectManifestV2
from ..project_format.service import PROJECT_CONFIG_FILE, PROJECT_DATABASE_FILE, write_project_manifest
from .database import create_session_factory, open_database
from .errors import ProjectSessionError
from .remote_files import read_binding, write_binding, pending_path, publish_local
from .remote_files import atomic_json
from .remote_ownership import close_remote
from .remote_store import lookup_guard
import services.runtime.stt_runtime.project_session.remote_store as remote_store


FIELDS = ("engine", "session_factory", "manifest", "state", "saved_checksum", "remote_head", "remote_state")


def remember_authority(path, project_id, generation, profile_id):
    cache = path / "cache/remote-authorities.json"
    entries = json.loads(cache.read_text(encoding="utf-8")) if cache.exists() else {}
    entries[generation] = dict(project_id=project_id, profile_id=profile_id)
    atomic_json(cache, entries)


def previous_profile(path, project_id, generation):
    cache = path / "cache/remote-authorities.json"
    try:
        item = json.loads(cache.read_text(encoding="utf-8"))[generation]
        return item["profile_id"] if item["project_id"] == project_id else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def authority(active):
    return {name: getattr(active, name) for name in FIELDS}


def restore_authority(active, value):
    for name, item in value.items():
        setattr(active, name, item)


def handoff_marker(active, source, target, *, profile_id):
    binding = read_binding(active.path, source["manifest"].project_id)
    row = None
    if target["state"].storage_mode == "postgresql":
        with target["engine"].connect() as connection:
            row = remote_store.row_for(connection, source["manifest"].project_id)
    return dict(source_manifest=source["manifest"].model_dump(mode="json"), source_profile_id=binding["profile_id"],
        target_manifest=target["manifest"].model_dump(mode="json"), target_profile_id=profile_id,
        target_generation=row["storage_generation"] if row is not None else None,
        target_checksum=target["saved_checksum"])


def finish_handoff(active, target, profile_id):
    restore_authority(active, target)
    if active.state.storage_mode == "postgresql":
        return publish_local(active, profile_id=profile_id)
    from ..schemas.project_session import ProjectSessionState
    active.state = ProjectSessionState.model_validate(active.state.model_dump(
        exclude={"session_version", "remote_storage", "remote_state"}))
    active.remote_head, active.remote_state = None, "ready"
    write_project_manifest(active.path / PROJECT_CONFIG_FILE, active.manifest)
    pending_path(active.path).unlink(missing_ok=True)


def recover_handoff(registry, path):
    """Resolve the SOURCE receipt even if local binding/config publication was partial."""
    marker = pending_path(path)
    if not marker.exists():
        return
    try:
        pending = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ProjectSessionError("remote_contract_invalid") from None
    migration = pending.get("migration")
    if migration is None:
        return
    from .remote_context import request_intent
    intent = request_intent.get()
    if intent is not None and intent.version != "1":
        raise ProjectSessionError("remote_storage_protocol_unsupported")
    source_manifest = ProjectManifestV2.model_validate(migration["source_manifest"])
    source_engine = registry._storage_profiles.create_engine(migration["source_profile_id"], path)
    target_engine = None
    try:
        source_factory = create_session_factory(source_engine)
        guard = lookup_guard(source_manifest.project_id, pending["storage_generation"], pending["command_id"])
        result = remote_store.outcome(source_factory, guard)
        if result.status == "unknown":
            raise ProjectSessionError("remote_commit_unknown")
        if result.status == "not_committed":
            document, row = remote_store.capture(source_factory, source_manifest.project_id)
            write_project_manifest(path / PROJECT_CONFIG_FILE, document.manifest)
            write_binding(path, source_manifest.project_id, migration["source_profile_id"], row)
        else:
            remember_authority(path, source_manifest.project_id, pending["storage_generation"], migration["source_profile_id"])
            target = ProjectManifestV2.model_validate(migration["target_manifest"])
            if target.settings.storage.mode == "postgresql":
                target_engine = registry._storage_profiles.create_engine(migration["target_profile_id"], path)
                document, row = remote_store.capture(create_session_factory(target_engine), target.project_id)
                if row["storage_generation"] != migration["target_generation"]:
                    raise ProjectSessionError("remote_generation_mismatch")
                write_project_manifest(path / PROJECT_CONFIG_FILE, document.manifest)
                write_binding(path, target.project_id, migration["target_profile_id"], row)
            else:
                target_engine = open_database(path / PROJECT_DATABASE_FILE)
                from ..repositories.sqlite import SqlAlchemyUnitOfWork
                from ..project_document.service import ProjectDocumentService
                with SqlAlchemyUnitOfWork(create_session_factory(target_engine), project_id=target.project_id) as uow:
                    document = ProjectDocumentService().load(uow, target)
                if document.checksum != migration["target_checksum"]:
                    raise ProjectSessionError("remote_revision_stale")
                write_project_manifest(path / PROJECT_CONFIG_FILE, target)
        marker.unlink(missing_ok=True)
    finally:
        source_engine.dispose()
        if target_engine is not None:
            target_engine.dispose()
