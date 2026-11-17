"""Repairable, secret-free local cache publication AFTER server commit."""

import json
from pathlib import Path
import shutil
from uuid import uuid4
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator
from ..schemas.remote_storage import RemoteUuid, RemoteCounter

from .checkpoints import checkpoint_path, prune_checkpoints, PROJECT_DOCUMENT_CHECKPOINT_FILE
from .errors import ProjectSessionError
from ..project_format.service import PROJECT_CONFIG_FILE, write_project_manifest
from .remote_store import capture, saved_document, row_for


class RemoteBinding(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    binding_version: Literal[1]
    project_id: str
    profile_id: str = Field(min_length=1, max_length=255)
    storage_generation: RemoteUuid
    observed_revision: RemoteCounter

    @field_validator("binding_version", mode="before")
    @classmethod
    def integer_version(cls, value):
        if type(value) is not int or value != 1:
            raise ValueError("remote_storage_binding_required")
        return value

    @field_validator("observed_revision")
    @classmethod
    def bounded_revision(cls, value):
        if int(value) > 9223372036854775807:
            raise ValueError("remote_storage_binding_required")
        return value


def atomic_json(path, value):
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def binding_path(path):
    return path / "cache/remote-binding.json"


def read_binding(path, project_id):
    try:
        value = RemoteBinding.model_validate_json(binding_path(path).read_text(encoding="utf-8")).model_dump()
        if value["project_id"] != project_id:
            raise ValueError
        return value
    except (OSError, ValueError, TypeError):
        raise ProjectSessionError("remote_storage_binding_required") from None


def write_binding(path, project_id, profile_id, row):
    atomic_json(binding_path(path), dict(binding_version=1, project_id=project_id, profile_id=profile_id,
        storage_generation=row["storage_generation"], observed_revision=str(row["authoring_revision"])))


def pending_path(path):
    return path / "cache/remote-pending.json"


def mark_pending(active, guard, *, saved=False, migration=None):
    value = dict(project_id=guard.project_id,
        storage_generation=guard.storage_generation, command_id=guard.command_id,
        expected_revision=guard.expected_revision, saved=saved)
    if migration is not None:
        value["migration"] = migration
    atomic_json(pending_path(active.path), value)


def sync_active(active, document, row):
    from ..schemas.project_session import RemoteProjectSessionState
    from .remote_store import head_dto
    from .remote_ownership import lease_for
    lease = lease_for(active.session_factory)
    if lease is not None and (lease.lost.is_set() or row["storage_generation"] != lease.generation
            or row["writer_epoch"] != lease.epoch or row["owner_token"] != lease.token or not row.get("_lease_valid", True)):
        lease.lost.set()
        if active.remote_state == "ready":
            active.remote_state = "writer_lost"
    active.manifest = document.manifest
    active.remote_head = head_dto(row, state=active.remote_state)
    active.saved_checksum = row.get("_saved_checksum", active.saved_checksum)
    active.state = RemoteProjectSessionState(**{
        **active.state.model_dump(exclude={"session_version", "remote_storage", "remote_state"}),
        "saved_revision": row["saved_revision"], "loaded_revision": row["saved_revision"],
        "save_status": "clean" if document.checksum == active.saved_checksum else "dirty",
        "last_saved_at": document.manifest.updated_at,
        "remote_storage": active.remote_head, "remote_state": active.remote_state,
    })


def publish_local(active, *, profile_id=None, captured=None):
    """A failed local write never reconciles a previous document over server data."""
    if captured is None:
        document, row = capture(active.session_factory, active.manifest.project_id)
    else:
        # Only the immediate Open/post-commit caller may hand off its verified
        # observation. Never retain it on active state or trust another factory.
        factory, document, row = captured
        if (factory is not active.session_factory or document.manifest.project_id != active.manifest.project_id
                or row.get("project_id") != active.manifest.project_id or row.get("checksum") != document.checksum):
            raise ProjectSessionError("remote_contract_invalid")
    with active.engine.connect() as connection:
        saved = saved_document(connection, active.manifest.project_id, row)
    staged = active.path / "snapshots" / f".remote-{uuid4().hex}.tmp"
    backup = None
    destination = checkpoint_path(active.path, saved.manifest.saved_revision)
    try:
        staged.mkdir()
        atomic_json(staged / PROJECT_DOCUMENT_CHECKPOINT_FILE, saved.model_dump(mode="json"))
        write_project_manifest(staged / PROJECT_CONFIG_FILE, saved.manifest)
        if destination.exists():
            backup = destination.with_name(f".remote-backup-{uuid4().hex}")
            destination.replace(backup)
        staged.replace(destination)
        write_project_manifest(active.path / PROJECT_CONFIG_FILE, document.manifest)
        profile_id = profile_id or read_binding(active.path, active.manifest.project_id)["profile_id"]
        write_binding(active.path, active.manifest.project_id, profile_id, row)
        pending_path(active.path).unlink(missing_ok=True)
        # Local SQLite recovery markers are never remote authority.
        (active.path / "cache/save-recovery.json").unlink(missing_ok=True)
        prune_checkpoints(active.path)
        active.remote_state = "ready"
        sync_active(active, document, row)
    finally:
        shutil.rmtree(staged, ignore_errors=True)
        if backup is not None:
            if not destination.exists():
                backup.replace(destination)
            else:
                shutil.rmtree(backup, ignore_errors=True)
    return document
