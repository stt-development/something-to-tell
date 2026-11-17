from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..crud import create_project, delete_project, get_project, list_projects, update_project
from ..dependencies import get_uow
from ...project_format.service import ProjectFolder, ProjectFormatError, create_project_folder, validate_project_folder
from ...repositories.interfaces import UnitOfWork
from ...schemas.project import ProjectFolderRequest, ProjectFolderResponse
from ...schemas.resources import ProjectCreate, ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["projects"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=ProjectResponse, status_code=status.HTTP_201_CREATED)
def create_project_resource(payload: ProjectCreate, uow: UowDep) -> ProjectResponse:
    return create_project(uow, payload)


@router.get("", response_model=list[ProjectResponse])
def list_project_resources(uow: UowDep) -> list[ProjectResponse]:
    return list_projects(uow)


@router.get("/{project_id}", response_model=ProjectResponse)
def get_project_resource(project_id: str, uow: UowDep) -> ProjectResponse:
    return get_project(uow, project_id)


@router.put("/{project_id}", response_model=ProjectResponse)
def update_project_resource(project_id: str, payload: ProjectUpdate, uow: UowDep) -> ProjectResponse:
    return update_project(uow, project_id, payload)


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_resource(project_id: str, uow: UowDep) -> Response:
    delete_project(uow, project_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post(
    "/folder",
    response_model=ProjectFolderResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_folder(request: ProjectFolderRequest) -> ProjectFolderResponse:
    try:
        project = create_project_folder(Path(request.path), request.name)
    except ProjectFormatError as error:
        raise _project_format_http_error(error) from error

    return _project_folder_response(project)


@router.post("/folder/validate", response_model=ProjectFolderResponse)
def validate_folder(request: ProjectFolderRequest) -> ProjectFolderResponse:
    try:
        project = validate_project_folder(Path(request.path))
    except ProjectFormatError as error:
        raise _project_format_http_error(error) from error

    return _project_folder_response(project)


def _project_format_http_error(error: ProjectFormatError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"message": str(error), "missing": error.missing},
    )


def _project_folder_response(project: ProjectFolder) -> ProjectFolderResponse:
    return ProjectFolderResponse(
        path=str(project.path),
        project_id=project.project_id,
        name=project.name,
        description=project.description,
        format_version=project.format_version,
    )
