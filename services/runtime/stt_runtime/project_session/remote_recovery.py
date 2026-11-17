"""Receipt resolution and explicit reacquisition; a ping never restores write access."""

import json

from ..schemas.remote_storage import RemoteCommandGuardV1
from .errors import ProjectSessionError
from .remote_files import pending_path, read_binding
from .remote_ownership import lease_for
from .remote_store import outcome, row_for, head_dto, lookup_guard


def resolve_pending(factory, path, project_id):
    pending = pending_path(path)
    if not pending.exists():
        return
    try:
        value = json.loads(pending.read_text(encoding="utf-8"))
        if value["project_id"] != project_id:
            raise ValueError
        guard = lookup_guard(project_id, value["storage_generation"], value["command_id"])
    except (OSError, ValueError, KeyError, TypeError):
        raise ProjectSessionError("remote_contract_invalid") from None
    resolved = outcome(factory, guard)
    if resolved.status == "unknown":
        raise ProjectSessionError("remote_commit_unknown")


def current_head(registry, session_id):
    active = registry._require_session(session_id)
    if active.state.storage_mode != "postgresql":
        raise ProjectSessionError("remote_contract_invalid")
    with active.engine.connect() as connection:
        row = row_for(connection, active.manifest.project_id)
    state = active.remote_state
    lease = lease_for(active.session_factory)
    if state == "ready" and (lease.lost.is_set() or row["storage_generation"] != lease.generation
            or row["writer_epoch"] != lease.epoch or row["owner_token"] != lease.token or not row["_lease_valid"]):
        lease.lost.set()
        state = "writer_lost"
    return head_dto(row, state=state)


def command_outcome(registry, session_id, command_id, generation):
    active = registry._require_session(session_id)
    from .remote_handoff import previous_profile
    profile_id = previous_profile(active.path, active.manifest.project_id, generation)
    if profile_id is not None:
        from .database import create_session_factory
        engine = registry._storage_profiles.create_engine(profile_id, active.path)
        try:
            return outcome(create_session_factory(engine), lookup_guard(active.manifest.project_id, generation, command_id))
        finally:
            engine.dispose()
    if active.state.storage_mode != "postgresql":
        raise ProjectSessionError("remote_contract_invalid")
    return outcome(active.session_factory, lookup_guard(active.manifest.project_id, generation, command_id))


def reconnect(registry, session_id, request):
    active = registry._require_session(session_id)
    with active.write_guard:
        head = current_head(registry, session_id)
        if head.storage_generation != request.storage_generation:
            raise ProjectSessionError("remote_generation_mismatch")
        if int(request.observed_revision) > int(head.authoring_revision):
            raise ProjectSessionError("remote_revision_stale")
        if request.unresolved_command_id:
            result = command_outcome(registry, session_id, request.unresolved_command_id, request.storage_generation)
            if result.status == "unknown":
                raise ProjectSessionError("remote_commit_unknown")
        resolve_pending(active.session_factory, active.path, active.manifest.project_id)
        binding = read_binding(active.path, active.manifest.project_id)
        path = active.path
        lease_for(active.session_factory).lost.set()
        registry.close(session_id)
        return registry.open(path, remote_profile_id=binding["profile_id"])
