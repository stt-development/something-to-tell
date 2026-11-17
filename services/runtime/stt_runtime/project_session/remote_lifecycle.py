"""Remote lifecycle authoring; file publication belongs to the outer command owner."""

from datetime import UTC, datetime
from uuid import uuid4

from ..project_format.manifest import ProjectManifestV2
from ..project_history.service import ProjectHistoryError
from ..project_document.service import ProjectDocumentService
from ..project_document.restore import restore_in_place
from ..schemas.project_session import ProjectSessionResponse
from .documents import document_with_manifest
from .remote_context import current_transaction
from .remote_store import saved_document
from .scoped_uow import project_unit_of_work
from .errors import ProjectSessionError


def save_working(registry, active, expected_revision):
    if expected_revision != active.state.saved_revision:
        raise ProjectSessionError("project_save_revision_stale")
    current = current_transaction(active.session_factory)
    if current is None:
        raise ProjectSessionError("remote_contract_invalid")
    if active.manifest.saved_revision >= 9223372036854775807:
        raise ProjectSessionError("remote_revision_exhausted")
    before = registry._load_document(active)
    active.manifest = active.manifest.model_copy(update={"saved_revision": active.manifest.saved_revision + 1,
                                                        "updated_at": datetime.now(UTC)})
    after = document_with_manifest(before, active.manifest)
    active.history = active.history.rebased_for_save(before, after)
    current.saved = True
    return ProjectSessionResponse(session=active.state, document=after)


def update_settings(registry, active, *, name, description, settings, expected_history_revision):
    if settings.storage != active.manifest.settings.storage:
        raise ProjectSessionError("project_storage_migration_required")
    revision = active.history.summary().history_revision
    if expected_history_revision is not None and expected_history_revision != revision:
        raise ProjectHistoryError("history_revision_stale")
    before = registry._load_document(active)
    if (name, description, settings) == (active.manifest.name, active.manifest.description, active.manifest.settings):
        return ProjectSessionResponse(session=active.state, document=before)
    active.manifest = ProjectManifestV2.model_validate({**active.manifest.model_dump(), "name": name,
        "description": description, "settings": settings, "updated_at": datetime.now(UTC)})
    after = document_with_manifest(before, active.manifest)
    with project_unit_of_work(active.session_factory, active.manifest) as uow:
        from dataclasses import replace
        project = uow.projects.get(active.manifest.project_id)
        uow.projects.update(replace(project, name=name, updated_at=active.manifest.updated_at))
        uow.commit()
    active.history.record(before, after, expected_history_revision=revision, command_id=str(uuid4()),
        command_kind="update_project_settings", label_key="history.command.updateProjectSettings")
    return ProjectSessionResponse(session=active.state, document=after)


def discard_working(registry, active):
    current = current_transaction(active.session_factory)
    document = saved_document(current.session, active.manifest.project_id)
    with project_unit_of_work(active.session_factory, active.manifest) as uow:
        if restore_in_place(uow, current.before, document):
            uow.commit()
        else:
            ProjectDocumentService().reconcile(uow, document)
    active.manifest = document.manifest
    active.history.clear()
    return ProjectSessionResponse(session=active.state, document=document)
