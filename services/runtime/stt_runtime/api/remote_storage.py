"""Typed HTTP intent, negotiation and receipt headers; never client-provided digests."""

import json
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.routing import Match
from starlette.concurrency import run_in_threadpool
from sqlalchemy.exc import SQLAlchemyError

from ..project_session.errors import ProjectSessionError
from ..project_session.remote_context import RemoteIntent, request_intent
from ..project_session.remote_commands import command_guard, RemoteReplay
from ..project_session import remote_store
from .dependencies import AUTHORING_HISTORY_COMMANDS, DIRECT_HISTORY_COMMANDS

REMOTE_MUTATIONS = set(AUTHORING_HISTORY_COMMANDS) | set(DIRECT_HISTORY_COMMANDS) | {
    "undo_project_history", "redo_project_history", "save_project_session", "discard_project_session",
    "save_project_session_as", "exit_project_session", "migrate_storage", "start_canon_run",
    "reject_impact_resolution_alternative",
}


def error_response(error):
    code = error.code
    status = (503 if code in {"remote_commit_unknown", "remote_storage_unavailable", "remote_storage_timeout"}
              else 400 if code in {"remote_contract_invalid", "remote_storage_protocol_unsupported",
                                   "remote_storage_binding_required", "remote_server_version_unsupported",
                                   "remote_tls_failed", "remote_auth_failed", "remote_admin_required",
                                   "remote_storage_version_unsupported"} else 409)
    return JSONResponse(status_code=status, content={"detail": {"code": code,
        "message_key": f"remote_storage.error.{code}", "parameters": error.parameters}})


def receipt_headers(receipt):
    return {"X-Remote-Storage-Generation": receipt.storage_generation,
        "X-Remote-Result-Revision": receipt.result_revision, "X-Remote-Command-Id": receipt.command_id,
        "X-Remote-Document-Checksum": receipt.document_checksum}


async def remote_request_middleware(request: Request, call_next):
    route = None
    target = {}
    for candidate in request.app.routes:
        match, scope = candidate.matches(request.scope)
        if match == Match.FULL:
            route, target = candidate, scope.get("path_params", {})
            break
    if route is None:
        return await call_next(request)
    payload = None
    body_errors = []
    if getattr(route, "body_field", None) is not None:
        try:
            body = await request.body()
            raw = json.loads(body) if body else None
            payload, errors = route.body_field.validate(raw, {}, loc=("body",))
            if errors:
                body_errors = errors
            from pydantic_core import to_jsonable_python
            payload = to_jsonable_python(payload, inf_nan_mode="constants")
        except (ValueError, TypeError):
            body_errors = [{"loc": ("body",), "msg": "Invalid JSON request body", "type": "json_invalid"}]
    intent = RemoteIntent(request.headers.get("x-remote-storage-version"), dict(request.headers), route.name, payload,
                          {key: value for key, value in target.items() if key != "session_id"})
    token = request_intent.set(intent)
    try:
        if body_errors:
            # FastAPI may otherwise enter dependencies before reporting body errors.
            # Never create a transaction/context token for a request that cannot run.
            return JSONResponse(status_code=422, content={"error": "validation_error", "detail": [
                {"field": ".".join(str(part) for part in error["loc"]), "message": str(error["msg"]), "type": error["type"]}
                for error in body_errors
            ]})
        if route.name in {"reconnect_remote_storage", "release_remote_storage", "begin_remote_reconnect",
                          "inspect_remote_reconnect", "abandon_remote_reconnect"} and intent.version != "1":
            raise ProjectSessionError("remote_storage_protocol_unsupported")
        # Reject old clients before folder creation, lock acquisition or schema probes.
        mode = payload.get("settings", {}).get("storage", {}).get("mode") if isinstance(payload, dict) else None
        if route.name == "open_project_session" and isinstance(payload, dict):
            try:
                config = json.loads((Path(payload["path"]).expanduser() / "project.config.json").read_text())
                mode = config.get("settings", {}).get("storage", {}).get("mode")
            except (OSError, ValueError, KeyError):
                pass  # Owning lifecycle validation reports invalid paths/documents.
        if route.name == "migrate_storage" and isinstance(payload, dict):
            mode = payload.get("target_mode")
        if (mode == "postgresql" and route.name in {"create_project_session", "open_project_session", "migrate_storage"}
                and intent.version != "1"):
            raise ProjectSessionError("remote_storage_protocol_unsupported")
        session_id = (request.headers.get("x-project-session-id") or target.get("session_id")
                      or (payload.get("session_id") if isinstance(payload, dict) else None))
        registry = request.app.state.project_sessions
        selected = request.headers.get("x-project-session-id")
        declared = [target.get("session_id"), request.query_params.get("session_id"),
                    payload.get("session_id") if isinstance(payload, dict) else None]
        if request.url.path.startswith("/api/playback/"):
            declared = []  # Playback session identities are not project session identities.
        if selected and any(value is not None and value != selected for value in declared):
            raise ProjectSessionError("remote_project_scope_mismatch")
        if (request.method in {"POST", "PUT", "PATCH", "DELETE"} and route.name in REMOTE_MUTATIONS
                and request.headers.get("x-remote-storage-generation") and not request.headers.get("x-project-session-id")):
            raise ProjectSessionError("remote_contract_invalid")
        if session_id and request.method in {"POST", "PUT", "PATCH", "DELETE"} and route.name in REMOTE_MUTATIONS:
            active = registry._sessions.get(session_id)
            if active and (active.state.storage_mode == "postgresql" or request.headers.get("x-remote-storage-generation")):
                from fastapi.dependencies.utils import _get_multidict_value
                from pydantic_core import to_jsonable_python
                from pydantic import TypeAdapter, Field
                from typing import Annotated
                query = {}
                for field in route.dependant.query_params:
                    value, errors = field.validate(_get_multidict_value(field, request.query_params), {}, loc=("query", field.alias))
                    if errors:
                        raise ProjectSessionError("remote_contract_invalid")
                    if field.alias != "session_id":
                        query[field.alias] = to_jsonable_python(value, inf_nan_mode="constants")
                history_revision = request.headers.get("x-project-history-revision")
                if history_revision is not None:
                    try:
                        history_revision = TypeAdapter(Annotated[int, Field(ge=0)]).validate_python(history_revision)
                    except ValueError:
                        raise ProjectSessionError("remote_contract_invalid") from None
                canonical_body = ({key: value for key, value in payload.items() if key != "session_id"}
                                  if isinstance(payload, dict) else payload)
                intent.payload = dict(body=canonical_body, query=query, expected_history_revision=history_revision)
            if request.headers.get("x-remote-storage-generation") and not request.headers.get("x-project-session-id"):
                raise ProjectSessionError("remote_contract_invalid")
            if active and active.state.storage_mode == "local_sqlite" and request.headers.get("x-remote-storage-generation"):
                # A lost handoff response must not turn an obsolete remote command
                # into an unguarded SQLite mutation under the same session id.
                from ..project_session.remote_handoff import previous_profile
                generation = request.headers["x-remote-storage-generation"]
                profile = previous_profile(active.path, active.manifest.project_id, generation)
                if profile is None:
                    raise ProjectSessionError("remote_generation_mismatch")
                def previous_outcome():
                    engine = registry._storage_profiles.create_engine(profile, active.path)
                    try:
                        from ..project_session.database import create_session_factory
                        with engine.connect() as connection:
                            row = remote_store.row_for(connection, active.manifest.project_id)
                        guard = command_guard(active, row)
                        return guard, remote_store.outcome(create_session_factory(engine), guard)
                    finally:
                        engine.dispose()
                guard, resolved = await run_in_threadpool(previous_outcome)
                if resolved.receipt is None:
                    raise ProjectSessionError("remote_commit_unknown" if resolved.status == "unknown" else "remote_generation_mismatch")
                if resolved.receipt.request_digest != remote_store.digest(guard, intent.kind, intent.target, intent.payload):
                    raise ProjectSessionError("remote_command_reused")
                return JSONResponse(content=resolved.receipt.model_dump(mode="json"),
                    headers={**receipt_headers(resolved.receipt), "X-Remote-Replayed": "1"})
            if active and active.state.storage_mode == "postgresql" and route.name not in {
                "close_project_session", "reconnect_remote_storage"
            }:
                def preflight():
                    if not request.headers.get("x-project-session-id"):
                        raise ProjectSessionError("remote_contract_invalid")
                    with active.engine.connect() as connection:
                        row = remote_store.row_for(connection, active.manifest.project_id)
                    guard = command_guard(active, row)
                    return guard, remote_store.outcome(active.session_factory, guard)
                # Do not block the event loop while a prior request finishes commit.
                guard, resolved = await run_in_threadpool(preflight)
                if resolved.receipt:
                    digest = remote_store.digest(guard, intent.kind, intent.target, intent.payload)
                    if resolved.receipt.request_digest != digest:
                        raise ProjectSessionError("remote_command_reused")
                    return JSONResponse(content=resolved.receipt.model_dump(mode="json"),
                        headers={**receipt_headers(resolved.receipt), "X-Remote-Replayed": "1"})
                if resolved.status == "unknown":
                    raise ProjectSessionError("remote_commit_unknown")
        response = await call_next(request)
        if intent.receipt is not None:
            response.headers.update(receipt_headers(intent.receipt))
        return response
    except ProjectSessionError as error:
        return error_response(error)
    except SQLAlchemyError:
        return error_response(ProjectSessionError("remote_storage_unavailable"))
    finally:
        request_intent.reset(token)
