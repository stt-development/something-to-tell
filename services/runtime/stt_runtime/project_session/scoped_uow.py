"""Compose project validation with SQL scope without reversing dependencies."""

from pydantic import ValidationError

from ..project_document.service import ProjectDocumentError, ProjectDocumentService
from ..project_format.manifest import ProjectManifestV2
from ..repositories.interfaces import UnitOfWork
from ..repositories.project_scope import ProjectScopeError
from ..repositories.sqlite import SqlAlchemyUnitOfWork
from .remote_context import current_transaction


def project_unit_of_work(session_factory, manifest: ProjectManifestV2) -> SqlAlchemyUnitOfWork:
    """The session owner supplies immutable authority, never a request body id."""
    def validate_document(uow: UnitOfWork) -> None:
        try:
            ProjectDocumentService().load(uow, manifest)
        except (ProjectDocumentError, ValidationError) as error:
            # Missing and foreign nested references have the same external result.
            raise ProjectScopeError() from error

    current = current_transaction(session_factory)
    return SqlAlchemyUnitOfWork(session_factory, project_id=manifest.project_id,
                               before_commit=validate_document,
                               borrowed_session=current.session if current is not None else None)
