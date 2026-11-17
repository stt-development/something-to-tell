from pathlib import Path
import json

from sqlalchemy import Engine

from ..project_format.manifest import ProjectManifestV2
from ..project_format.service import PROJECT_DATABASE_FILE
from ..storage_profiles import StorageProfileRegistry
from ..domain.entities import ProjectEntity
from ..project_document.service import ProjectDocumentService
from ..schemas.impact_resolution import ImpactResolutionDecision
from .database import (
    open_database,
    upgrade_database,
    upgrade_external_database,
    validate_postgresql_engine,
)
from .errors import ProjectSessionError


def admit_migration_target(uow, document, project_path, *, shared: bool, decisions=(), newly_provisioned=False):
    """Provision inside the copy transaction; never overwrite a divergent identity.

    Local SQLite is the project's own cache/authority, not another shared project.
    The registry acquires the remote ownership fence before calling admission.
    """
    manifest = document.manifest
    project = uow.projects.get(manifest.project_id)
    if project is not None and shared and not newly_provisioned:
        existing = ProjectDocumentService().load(uow, manifest)
        persisted_decisions = uow.impact_resolution_decisions.list(project_id=manifest.project_id)
        expected = sorted(json.dumps(item.model_dump(mode="json"), sort_keys=True) for item in decisions)
        actual = sorted(json.dumps(ImpactResolutionDecision.model_validate(item, from_attributes=True).model_dump(mode="json"),
                                   sort_keys=True) for item in persisted_decisions)
        if existing.checksum != document.checksum or project.name != manifest.name or actual != expected:
            raise ProjectSessionError("storage_migration_identity_conflict")
    if project is None:
        uow.projects.add(ProjectEntity(id=manifest.project_id, name=manifest.name,
            path=str(project_path), format_version=manifest.format_version,
            created_at=manifest.created_at, updated_at=manifest.updated_at))


def prepare_migration_target(
    project_path: Path,
    manifest: ProjectManifestV2,
    storage_profiles: StorageProfileRegistry,
) -> Engine:
    """Provision a target engine without changing the active session authority."""

    if manifest.settings.storage.mode == "local_sqlite":
        database_path = project_path / PROJECT_DATABASE_FILE
        upgrade_database(
            database_path,
            project_path=project_path,
            backup_existing=True,
        )
        return open_database(database_path)

    profile_id = manifest.settings.storage.connection_profile_id
    if profile_id is None:
        raise ProjectSessionError("storage_migration_target_invalid")
    result = storage_profiles.test(profile_id, project_path)
    if result.schema_status == "empty":
        profile = storage_profiles.resolve(profile_id, project_path)
        upgrade_external_database(profile.database_url())
        result = storage_profiles.test(profile_id, project_path)
    if result.schema_status != "current":
        raise ProjectSessionError(
            "storage_profile_schema_mismatch",
            profile_id=profile_id,
        )
    engine = storage_profiles.create_engine(profile_id, project_path)
    validate_postgresql_engine(engine)
    return engine
