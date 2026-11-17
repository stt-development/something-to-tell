"""Compose existing authoring services into ONE server-owned command transaction."""

from contextlib import contextmanager
from copy import deepcopy
from functools import wraps
import inspect
from uuid import uuid4

from pydantic_core import to_jsonable_python
from sqlalchemy import select
from sqlalchemy.exc import DBAPIError

from ..db.models import ImpactResolutionDecision
from ..schemas.remote_storage import RemoteCommandGuardV1
from .errors import ProjectSessionError
from .remote_context import RemoteTransaction, current_transaction, request_intent, transaction
from .remote_files import mark_pending, pending_path, publish_local, sync_active
from .remote_ownership import fence, lease_for
import services.runtime.stt_runtime.project_session.remote_store as store
from .remote_handoff import authority, restore_authority, handoff_marker, finish_handoff, remember_authority
from .remote_ownership import close_remote


class RemoteReplay(Exception):
    def __init__(self, receipt):
        self.receipt = receipt


def command_guard(active, row):
    intent = request_intent.get()
    if intent is None:
        return RemoteCommandGuardV1(project_id=active.manifest.project_id,
            storage_generation=row["storage_generation"], command_id=str(uuid4()),
            writer_epoch=str(row["writer_epoch"]), expected_revision=str(row["authoring_revision"]))
    if intent.version != "1":
        raise ProjectSessionError("remote_storage_protocol_unsupported")
    try:
        return RemoteCommandGuardV1(project_id=active.manifest.project_id,
            storage_generation=intent.headers["x-remote-storage-generation"],
            command_id=intent.headers["x-remote-command-id"], writer_epoch=intent.headers["x-remote-writer-epoch"],
            expected_revision=intent.headers["x-remote-expected-revision"])
    except (ValueError, KeyError):
        raise ProjectSessionError("remote_contract_invalid") from None


def decisions(session, project_id):
    return list(session.execute(select(ImpactResolutionDecision.__table__).where(
        ImpactResolutionDecision.project_id == project_id)).mappings())


@contextmanager
def durable_command(registry, active, kind, payload):
    factory, lease = active.session_factory, lease_for(active.session_factory)
    old_state, old_manifest, old_history = active.state, active.manifest, deepcopy(active.history)
    source = authority(active)
    target = migration = None
    intent = request_intent.get()
    if active.remote_state != "ready":
        raise ProjectSessionError("remote_commit_unknown" if active.remote_state == "outcome_unknown"
                                  else "remote_local_publication_required")
    committed, committing, token = False, False, None
    try:
        with factory() as session:
            fence(session)
            row = store.row_for(session, active.manifest.project_id)
            guard = command_guard(active, row)
            request_digest = store.digest(guard, intent.kind if intent else kind,
                intent.target if intent else {}, intent.payload if intent else payload)
            if guard.storage_generation != row["storage_generation"]:
                raise ProjectSessionError("remote_generation_mismatch")
            existing = store.receipt_for(session, guard)
            if existing is not None:
                if existing.request_digest != request_digest:
                    raise ProjectSessionError("remote_command_reused")
                if intent:
                    intent.receipt = existing
                raise RemoteReplay(existing)
            if guard.writer_epoch != str(lease.epoch):
                raise ProjectSessionError("remote_writer_lost")
            if guard.expected_revision != str(row["authoring_revision"]):
                raise ProjectSessionError("remote_revision_stale")
            active.manifest = store.manifest_for(row)
            before = store.document_in_session(session, active.manifest)
            before_decisions = decisions(session, active.manifest.project_id)
            current = RemoteTransaction(factory, session, before, active.manifest)
            root_transaction = session.get_transaction()
            if intent:
                intent.transaction = current
            else:
                token = transaction.set(current)
            mark_pending(active, guard)
            yield current
            if session.get_transaction() is not root_transaction:
                raise ProjectSessionError("remote_contract_invalid")
            if active.session_factory is not factory:
                target = authority(active)
                profile_id = active.manifest.settings.storage.connection_profile_id
                migration = handoff_marker(active, source, target, profile_id=profile_id)
                restore_authority(active, source)
            document = store.document_in_session(session, active.manifest)
            changed = document.checksum != before.checksum or before_decisions != decisions(session, guard.project_id)
            mark_pending(active, guard, saved=current.saved, migration=migration)
            receipt = store.publish(session, lease, guard, request_digest, document, changed=changed, saved=current.saved)
            # All borrowed UoW.commit calls only flushed. This is the sole commit.
            committing = True
            session.commit()
            committed = True
            if token is not None:
                transaction.reset(token)
                token = None
            if intent:
                intent.transaction = None
            if intent:
                intent.receipt = receipt
            document, row = store.capture(factory, guard.project_id)
            sync_active(active, document, row)
        try:
            if target is not None:
                remember_authority(active.path, guard.project_id, guard.storage_generation, migration["source_profile_id"])
                finish_handoff(active, target, migration["target_profile_id"])
                close_remote(factory)
                source["engine"].dispose()
            else:
                publish_local(active, captured=(factory, document, row))
        except Exception as error:
            if target is not None:
                close_remote(target["session_factory"])
                target["engine"].dispose()
                restore_authority(active, source)
            active.remote_state = "recovery_required"
            active.history.clear()
            raise ProjectSessionError("remote_local_publication_required") from error
        if registry._on_authoring_committed is not None and changed:
            registry._on_authoring_committed(guard.project_id)
    except Exception as error:
        if committed and getattr(error, "code", None) != "remote_local_publication_required":
            active.remote_state = "recovery_required"
            active.history.clear()
            raise ProjectSessionError("remote_local_publication_required") from error
        if not committed:
            if target is not None:
                close_remote(target["session_factory"])
                target["engine"].dispose()
            restore_authority(active, source)
            active.state, active.manifest, active.history = old_state, old_manifest, old_history
            if committing and (isinstance(error, DBAPIError) or getattr(error, "code", "") in {
                "remote_storage_unavailable", "remote_storage_timeout"
            }):
                active.remote_state = "outcome_unknown"
                active.history.clear()
                raise ProjectSessionError("remote_commit_unknown") from error
            pending_path(active.path).unlink(missing_ok=True)
        raise
    finally:
        if intent:
            intent.transaction = None
        if token is not None:
            transaction.reset(token)


def remote_method(function):
    """Registry remains the single owner; nested commands borrow its transaction."""
    signature = inspect.signature(function)
    @wraps(function)
    def wrapped(self, session_id, *args, **kwargs):
        active = self._require_session(session_id)
        if active.state.storage_mode != "postgresql" or current_transaction(active.session_factory) is not None:
            return function(self, session_id, *args, **kwargs)
        bound = signature.bind(self, session_id, *args, **kwargs)
        payload = {key: to_jsonable_python(value, serialize_unknown=True, inf_nan_mode="constants") for key, value in bound.arguments.items()
                   if key not in {"self", "session_id"}}
        with active.write_guard, durable_command(self, active, function.__name__, payload):
            result = function(self, session_id, *args, **kwargs)
        return published_result(result, active.state)
    return wrapped


def published_result(result, state):
    """Replace pre-publication session DTOs, including reviewed decision tuples."""
    if isinstance(result, tuple):
        return tuple(published_result(item, state) for item in result)
    if hasattr(result, "session"):
        return result.model_copy(update={"session": state})
    if hasattr(result, "project"):
        return result.model_copy(update={"project": published_result(result.project, state)})
    return result


def remote_uow(function):
    @contextmanager
    @wraps(function)
    def wrapped(self, session_id, *args, **kwargs):
        active = self._require_session(session_id)
        mutating = function.__name__ == "authoring_unit_of_work" or kwargs.get("mark_dirty", False)
        if not mutating or active.state.storage_mode != "postgresql" or current_transaction(active.session_factory):
            with function(self, session_id, *args, **kwargs) as uow:
                yield uow
            return
        with active.write_guard, durable_command(self, active, kwargs.get("command_kind", function.__name__), {}):
            with function(self, session_id, *args, **kwargs) as uow:
                yield uow
    return wrapped
