import uvicorn

from .core.config import get_settings


def main() -> None:
    settings = get_settings()
    uvicorn.run(
        "services.runtime.stt_runtime.app:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
    )
