from typing import Annotated

from fastapi import APIRouter, Depends, status

from ..crud import api_error
from ..dependencies import get_uow
from ...analysis.service import SceneAnalysisError, SceneAnalysisService
from ...repositories.interfaces import UnitOfWork
from ...schemas.scene_analysis import SceneAnalysisRequest, SceneAnalysisResponse

router = APIRouter(prefix="/analysis", tags=["analysis"])
UowDep = Annotated[UnitOfWork, Depends(get_uow, scope="function")]


@router.post("/scenes", response_model=SceneAnalysisResponse, status_code=status.HTTP_201_CREATED)
def analyze_scene(payload: SceneAnalysisRequest, uow: UowDep) -> SceneAnalysisResponse:
    try:
        return SceneAnalysisService().analyze(uow, payload)
    except SceneAnalysisError as error:
        status_code = status.HTTP_503_SERVICE_UNAVAILABLE if error.code == "provider_unavailable" else status.HTTP_422_UNPROCESSABLE_CONTENT
        raise api_error(status_code, error.code, str(error)) from error
    except ValueError as error:
        raise api_error(status.HTTP_404_NOT_FOUND, "project_not_found", str(error)) from error
