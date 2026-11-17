"""Open admission owned by ProjectSessionRegistry; no independent session state."""

import shutil
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4
from sqlalchemy import Engine
from pydantic import ValidationError
from ..project_format.service import PROJECT_CONFIG_FILE, PROJECT_DATABASE_FILE, write_project_manifest
from ..project_document.service import ProjectDocumentError, ProjectDocumentService
from ..schemas.project_session import ProjectSessionState, ProjectSessionResponse
from ..storage_profiles import StorageProfileError
from .errors import ProjectSessionError
from .scoped_uow import project_unit_of_work
from .remote_ownership import open_remote, close_remote, provision_target, lease_for
from .storage_migration import prepare_migration_target
from ..schemas.project_document import create_project_document
from .remote_context import request_intent
from .remote_files import read_binding, publish_local
import services.runtime.stt_runtime.project_session.remote_store as remote_store

def open_locked(
    self,
    project_path: Path,
    *,
    recover_stale_lock: bool,
    newly_created: bool,
    recovery_mode: str = "cancel",
    expected_lock_session_id: str | None = None,
    active_session_type,
    remote_profile_id=None,
    initialize_remote_storage=False,
) -> ProjectSessionResponse:
    self._require_structure(project_path)
    from .remote_handoff import recover_handoff
    recover_handoff(self, project_path)
    config_path = project_path / PROJECT_CONFIG_FILE
    database_path = project_path / PROJECT_DATABASE_FILE
    raw_manifest = self._read_raw_manifest(config_path)
    remote = raw_manifest.get("settings", {}).get("storage", {}).get("mode") == "postgresql"
    intent = request_intent.get()
    if remote and intent is not None and intent.version != "1":
        raise ProjectSessionError("remote_storage_protocol_unsupported")
    # A local recovery marker/folder is NEVER authority over a remote server head.
    recovery_action = "none" if remote else self._prepare_recovery(project_path, recovery_mode)
    raw_manifest = self._read_raw_manifest(config_path)
    manifest, requires_manifest_migration = self._prepare_manifest(
        raw_manifest,
        database_path,
    )
    duplicate_identity = next(
        (
            session
            for session in self._sessions.values()
            if session.manifest.project_id == manifest.project_id
        ),
        None,
    )
    if duplicate_identity is not None:
        raise ProjectSessionError(
            "project_identity_already_open",
            session_id=duplicate_identity.state.session_id,
        )

    session_id = str(uuid4())
    self._acquire_lock(
        project_path,
        manifest.project_id,
        session_id,
        recover_stale_lock=recover_stale_lock,
        expected_lock_session_id=expected_lock_session_id,
    )
    engine: Engine | None = None
    captured = None
    migration_backup: Path | None = None
    database_upgrade_backup: Path | None = None
    try:
        if requires_manifest_migration:
            migration_backup = self._backup_project_for_migration(
                project_path,
                manifest.project_id,
            )
        if manifest.settings.storage.mode == "local_sqlite":
            database_upgrade_backup = self._upgrade_database(
                database_path,
                project_path=project_path,
                backup_existing=not newly_created and migration_backup is None,
            )
            engine = self._open_database(database_path)
        else:
            binding = None
            if not newly_created and remote_profile_id is None:
                binding = read_binding(project_path, manifest.project_id)
            profile_id = (remote_profile_id or (binding["profile_id"] if binding else None)
                          or (manifest.settings.storage.connection_profile_id if newly_created else None))
            if profile_id is None:
                raise ProjectSessionError("storage_profile_not_found")
            if newly_created:
                engine = prepare_migration_target(project_path, manifest, self._storage_profiles)
            else:
                profile_result = self._storage_profiles.test(profile_id, project_path)
                if profile_result.schema_status != "current":
                    raise ProjectSessionError("storage_profile_schema_empty", profile_id=profile_id)
                engine = self._storage_profiles.create_engine(profile_id, project_path)
                self._validate_postgresql_engine(engine)
            with engine.connect() as connection:
                row = remote_store.row_for(connection, manifest.project_id) if not newly_created else None
                if binding is not None and binding["storage_generation"] != row["storage_generation"]:
                    raise ProjectSessionError("remote_generation_mismatch")
        if requires_manifest_migration:
            write_project_manifest(config_path, manifest)

        session_factory = self._session_factory(engine)
        if manifest.settings.storage.mode == "postgresql":
            if newly_created:
                with project_unit_of_work(session_factory, manifest) as uow:
                    provision_target(uow, session_factory, create_project_document(manifest=manifest), project_path)
                    uow.commit()
                lease_for(session_factory).start()
            else:
                from .remote_recovery import resolve_pending
                resolve_pending(session_factory, project_path, manifest.project_id)
                open_remote(session_factory, manifest)
                with session_factory() as session:
                    row = remote_store.row_for(session, manifest.project_id)
                    if row["canonical_manifest"] is None:
                        if not initialize_remote_storage or remote_profile_id is None:
                            raise ProjectSessionError("remote_storage_binding_required")
                        remote_store.bootstrap(session, manifest)
                        session.commit()
                captured = remote_store.capture(session_factory, manifest.project_id)
                document, _ = captured
                manifest = document.manifest
        else:
            self._ensure_project_root(session_factory, project_path, manifest)
        opened_at = datetime.now(UTC)
        state = ProjectSessionState(
            session_id=session_id,
            project_id=manifest.project_id,
            project_path=str(project_path),
            storage_mode=manifest.settings.storage.mode,
            loaded_revision=manifest.saved_revision,
            saved_revision=manifest.saved_revision,
            opened_at=opened_at,
            last_saved_at=manifest.updated_at,
        )
        active = active_session_type(
            state=state,
            path=project_path,
            manifest=manifest,
            engine=engine,
            session_factory=session_factory,
        )
        if recovery_action == "last_saved_external":
            checkpoint = self._checkpoint_path(
                project_path,
                manifest.saved_revision,
            )
            with project_unit_of_work(active.session_factory, active.manifest) as uow:
                ProjectDocumentService().reconcile(
                    uow,
                    self._read_document_checkpoint(checkpoint),
                )
        document = captured[0] if captured is not None else self._load_document(active)
        active.saved_checksum = (
            None if recovery_action == "recover" else document.checksum
        )
        if manifest.settings.storage.mode == "postgresql":
            publish_local(active, profile_id=profile_id,
                captured=(session_factory, *captured) if captured is not None else None)
        else:
            self._ensure_checkpoint(active)
        if recovery_action == "recover":
            active.state = active.state.model_copy(update={"save_status": "dirty"})
        self._sessions[session_id] = active
        self._paths[project_path] = session_id
        return ProjectSessionResponse(session=active.state, document=document)
    except Exception as error:
        if engine is not None:
            if "session_factory" in locals():
                close_remote(session_factory)
            engine.dispose()
        if requires_manifest_migration and migration_backup is not None:
            self._restore_migration_backup(project_path, migration_backup)
        elif database_upgrade_backup is not None:
            shutil.copy2(database_upgrade_backup, database_path)
        self._release_lock(project_path, session_id)
        if isinstance(error, ProjectSessionError):
            raise
        if isinstance(error, StorageProfileError):
            raise ProjectSessionError(
                error.code,
                profile_id=error.profile_id,
            ) from error
        if isinstance(error, (ProjectDocumentError, ValidationError)):
            raise ProjectSessionError(
                "project_document_invalid",
                project_id=manifest.project_id,
            ) from error
        raise ProjectSessionError(
            "project_open_failed",
            project_id=manifest.project_id,
        ) from error
