from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exception_handlers import http_exception_handler
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .api.routes import runtime_routers
from .canon.coordinator import CanonRunCoordinator
from .canon.agent import CanonAgentService
from .canon.agent_profiles import CanonProviderProfileRegistry
from .core.config import RuntimeSettings, get_settings
from .impact.coordinator import ImpactRunCoordinator
from .impact.resolution_agent import ImpactResolutionAgentService
from .impact.resolution_coordinator import ImpactResolutionCoordinator
from .export.coordinator import ExportCoordinator
from .export.yarn_spinner import OfficialYarnCompiler, YarnSpinnerExportService
from .export.ink import InkExportService
from .export.ink_compiler import OfficialInkCompiler
from .playback.traversal_service import PlaybackSessionService
from .project_session.service import ProjectSessionRegistry
from .repositories.project_scope import ProjectScopeError
from .storage_profiles import StorageProfileRegistry
from .style_system.rewrite_agent import StyleRewriteAgentService
from .style_system.rewrite_coordinator import StyleRewriteCoordinator
from .agent_memory.candidate_agent import AgentMemoryCandidateAgentService
from .agent_memory.candidate_coordinator import AgentMemoryCandidateCoordinator
from .api.remote_storage import remote_request_middleware, error_response, receipt_headers
from .project_session.remote_commands import RemoteReplay
from .project_session.errors import ProjectSessionError
from .schema_plans import SchemaPlanRegistry
from .desktop_security import DesktopAuthorization


def create_app(settings: RuntimeSettings | None = None, *, desktop_token: str | None = None) -> FastAPI:
    runtime_settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        try:
            yield
        finally:
            app.state.schema_plans.clear_all()
            app.state.agent_memory_candidate_runs.clear_all()
            app.state.style_rewrite_runs.clear_all()
            app.state.impact_resolution_runs.clear_all()
            app.state.impact_runs.clear_all()
            app.state.exports.clear_all()
            app.state.project_sessions.close_all()
            app.state.canon_runs.clear_all()

    app = FastAPI(
        title="Something To Tell Engine Runtime",
        version=__version__,
        docs_url="/docs" if runtime_settings.docs_enabled else None,
        redoc_url="/redoc" if runtime_settings.docs_enabled else None,
        lifespan=lifespan,
    )
    app.middleware("http")(remote_request_middleware)
    # The browser dev shell and packaged Tauri shell call the same local API;
    # an explicit allowlist keeps that boundary usable without wildcard CORS.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(runtime_settings.allowed_origins),
        allow_methods=["DELETE", "GET", "PATCH", "POST", "PUT"],
        allow_headers=[
            "Content-Type",
            *(["Authorization"] if desktop_token is not None else []),
            "X-Project-History-Revision",
            "X-Project-Session-Id",
            "X-Remote-Storage-Version", "X-Remote-Storage-Generation", "X-Remote-Writer-Epoch",
            "X-Remote-Expected-Revision", "X-Remote-Command-Id",
        ],
        expose_headers=["X-Remote-Storage-Generation", "X-Remote-Result-Revision",
                        "X-Remote-Command-Id", "X-Remote-Document-Checksum", "X-Remote-Replayed"],
    )
    if desktop_token is not None:
        app.add_middleware(DesktopAuthorization, token=desktop_token,
                           allowed_origins=runtime_settings.allowed_origins)
    # Playback sessions are diagnostic process state and never enter SQLite.
    app.state.playback_sessions = PlaybackSessionService()
    # Review plans and backup acknowledgements are process-local, never project data.
    app.state.schema_plans = SchemaPlanRegistry()
    # Credentials remain in this runtime-owned registry and never enter API
    # responses, frontend state, project manifests, or portable snapshots.
    app.state.storage_profiles = StorageProfileRegistry.from_file(
        runtime_settings.storage_profiles_file,
        master_key_file=runtime_settings.storage_master_key_file,
    )
    app.state.canon_provider_profiles = CanonProviderProfileRegistry(
        runtime_settings.canon_provider_profiles_file,
        runtime_settings.storage_master_key_file,
    )
    app.state.canon_agent = CanonAgentService()
    # Project sessions own per-workspace engines and release locks at shutdown.
    def invalidate_authoring(project_id: str) -> None:
        app.state.playback_sessions.invalidate_project(project_id)
        impact_runs = getattr(app.state, "impact_runs", None)
        if impact_runs is not None:
            impact_runs.invalidate_project(project_id)
        resolution_runs = getattr(app.state, "impact_resolution_runs", None)
        if resolution_runs is not None:
            resolution_runs.invalidate_project(project_id)
        style_runs = getattr(app.state, "style_rewrite_runs", None)
        if style_runs is not None:
            style_runs.invalidate_project(project_id)
        memory_runs = getattr(app.state, "agent_memory_candidate_runs", None)
        if memory_runs is not None:
            memory_runs.invalidate_project(project_id)

    def clear_session_runs(session_id: str, project_id: str) -> None:
        canon_runs = getattr(app.state, "canon_runs", None)
        if canon_runs is not None:
            canon_runs.clear_session(session_id, project_id)
        impact_runs = getattr(app.state, "impact_runs", None)
        if impact_runs is not None:
            impact_runs.clear_session(session_id, project_id)
        resolution_runs = getattr(app.state, "impact_resolution_runs", None)
        if resolution_runs is not None:
            resolution_runs.clear_session(session_id, project_id)
        style_runs = getattr(app.state, "style_rewrite_runs", None)
        if style_runs is not None:
            style_runs.clear_session(session_id, project_id)
        memory_runs = getattr(app.state, "agent_memory_candidate_runs", None)
        if memory_runs is not None:
            memory_runs.clear_session(session_id, project_id)
        exports = getattr(app.state, "exports", None)
        if exports is not None:
            exports.clear_session(session_id, project_id)

    app.state.project_sessions = ProjectSessionRegistry(
        app.state.storage_profiles,
        on_authoring_committed=invalidate_authoring,
        on_session_closed=clear_session_runs,
    )
    app.state.exports = ExportCoordinator(
        app.state.project_sessions,
        ink=InkExportService(
            OfficialInkCompiler(str(runtime_settings.ink_compiler_path)
                                if runtime_settings.ink_compiler_path else None),
            compiler_policy=runtime_settings.ink_compiler_policy,
        ),
        yarn_spinner=YarnSpinnerExportService(
            OfficialYarnCompiler(
                str(runtime_settings.yarn_compiler_path)
                if runtime_settings.yarn_compiler_path is not None
                else None
            ),
            compiler_policy=runtime_settings.yarn_compiler_policy,
        ),
    )
    # Runs are operational process state; project close and restart erase them.
    app.state.canon_runs = CanonRunCoordinator(
        app.state.project_sessions,
        provider_profiles=app.state.canon_provider_profiles,
        agent=app.state.canon_agent,
    )
    app.state.impact_runs = ImpactRunCoordinator(app.state.project_sessions)
    app.state.impact_resolution_agent = ImpactResolutionAgentService()
    app.state.impact_resolution_runs = ImpactResolutionCoordinator(
        app.state.project_sessions,
        app.state.impact_runs,
        app.state.canon_provider_profiles,
        agent=app.state.impact_resolution_agent,
    )
    app.state.style_rewrite_agent = StyleRewriteAgentService()
    app.state.style_rewrite_runs = StyleRewriteCoordinator(
        app.state.project_sessions,
        app.state.canon_provider_profiles,
        agent=app.state.style_rewrite_agent,
    )
    app.state.agent_memory_candidate_agent = AgentMemoryCandidateAgentService()
    app.state.agent_memory_candidate_runs = AgentMemoryCandidateCoordinator(
        app.state.project_sessions,
        app.state.canon_provider_profiles,
        agent=app.state.agent_memory_candidate_agent,
    )

    for router in runtime_routers:
        app.include_router(router, prefix="/api")

    @app.exception_handler(ProjectSessionError)
    async def remote_session_error_handler(_, error):
        return error_response(error)

    @app.exception_handler(RemoteReplay)
    async def remote_replay_handler(_, error):
        return JSONResponse(content=error.receipt.model_dump(mode="json"),
            headers={**receipt_headers(error.receipt), "X-Remote-Replayed": "1"})

    @app.exception_handler(StarletteHTTPException)
    async def remote_http_exception_handler(request, exc):
        # Older domain routes already wrap lifecycle errors. Keep their payloads,
        # but give lease failures the same transport meaning on every endpoint.
        code = exc.detail.get("code", "") if isinstance(exc.detail, dict) else ""
        if code.startswith("remote_"):
            return error_response(ProjectSessionError(code, **exc.detail.get("parameters", {})))
        return await http_exception_handler(request, exc)

    @app.exception_handler(ProjectScopeError)
    async def project_scope_exception_handler(_: object, exc: ProjectScopeError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": {"code": "project_not_found"}})

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(_: object, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={
                "error": "validation_error",
                "detail": [
                    {
                        "field": ".".join(str(part) for part in error["loc"]),
                        "message": str(error["msg"]),
                        "type": str(error["type"]),
                    }
                    for error in exc.errors()
                ],
            },
        )

    return app
