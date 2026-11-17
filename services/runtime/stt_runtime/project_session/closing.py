"""Serialize close/shutdown with publication without waiting under the registry lock."""

from ..schemas.project_session import ProjectSessionResponse
from .errors import ProjectSessionError
from .remote_ownership import close_remote, lease_for
from ..schemas.remote_storage import RemoteStorageReleaseResultV1


def release_remote_project(registry, session_id, request):
    """Explicitly leave server working data untouched; acknowledge only local release."""
    with registry._guard:
        active = registry._require_session(session_id)
    with active.write_guard:
        with registry._guard:
            if registry._require_session(session_id) is not active:
                raise ProjectSessionError("project_session_not_found")
        lease = lease_for(active.session_factory)
        if active.state.storage_mode != "postgresql" or lease is None:
            raise ProjectSessionError("remote_contract_invalid")
        if request.storage_generation != lease.generation:
            raise ProjectSessionError("remote_generation_mismatch")
        result = RemoteStorageReleaseResultV1(session_id=session_id,
            project_id=active.state.project_id, storage_generation=lease.generation,
            status="local_session_released")
        # Existing cleanup owns lease fencing, engine disposal and exact local lock
        # removal. Shutdown mode skips document capture/dirty checkpointing only.
        close_project(registry, session_id, shutdown=True)
        return result


def close_project(registry, session_id, *, shutdown=False):
    with registry._guard:
        active = registry._require_session(session_id)
    with active.write_guard:
        with registry._guard:
            if registry._require_session(session_id) is not active:
                raise ProjectSessionError("project_session_not_found")
        lease = lease_for(active.session_factory)
        if not shutdown and active.state.save_status != "clean" and not (
            lease and (lease.lost.is_set() or active.remote_state != "ready")
        ):
            raise ProjectSessionError("project_unsaved_changes", save_status=active.state.save_status)
        try:
            if not shutdown:
                document = registry._load_document(active)
                state = active.state.model_copy(update={"lifecycle": "closed"})
        finally:
            close_remote(active.session_factory)
            active.engine.dispose()
            registry._release_lock(active.path, session_id)
            with registry._guard:
                registry._sessions.pop(session_id, None)
                registry._paths.pop(active.path, None)
            if registry._on_session_closed is not None:
                registry._on_session_closed(session_id, active.state.project_id)
        if not shutdown:
            return ProjectSessionResponse(session=state, document=document)
