from fastapi import APIRouter

from ... import __version__
from ...schemas.health import HealthResponse

router = APIRouter(tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok", service="runtime", version=__version__)
