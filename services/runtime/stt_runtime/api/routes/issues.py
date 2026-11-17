from typing import Annotated

from fastapi import APIRouter, Depends, Response, status

from ..crud import create_issue, delete_issue, get_issue, list_issues, update_issue
from ..dependencies import get_uow
from ...repositories.interfaces import UnitOfWork
from ...schemas.resources import IssueCreate, IssueResponse, IssueUpdate

router = APIRouter(prefix="/issues", tags=["issues"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("", response_model=IssueResponse, status_code=status.HTTP_201_CREATED)
def create_issue_resource(payload: IssueCreate, uow: UowDep) -> IssueResponse:
    return create_issue(uow, payload)


@router.get("", response_model=list[IssueResponse])
def list_issue_resources(project_id: str, uow: UowDep) -> list[IssueResponse]:
    return list_issues(uow, project_id)


@router.get("/{issue_id}", response_model=IssueResponse)
def get_issue_resource(issue_id: str, uow: UowDep) -> IssueResponse:
    return get_issue(uow, issue_id)


@router.put("/{issue_id}", response_model=IssueResponse)
def update_issue_resource(issue_id: str, payload: IssueUpdate, uow: UowDep) -> IssueResponse:
    return update_issue(uow, issue_id, payload)


@router.delete("/{issue_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_issue_resource(issue_id: str, uow: UowDep) -> Response:
    delete_issue(uow, issue_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
