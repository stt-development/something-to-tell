"""PostgreSQL lease lifecycle and lazy transaction fencing for registry sessions.

Only this adapter handles SQL ownership. Tokens are process-private capabilities,
never authored data. Reconnect deliberately requires closing and reopening.
"""

from contextlib import contextmanager
from dataclasses import dataclass, field
from secrets import token_hex
from threading import Event, Lock, Thread
from time import monotonic
from uuid import uuid4

from sqlalchemy import event, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import DBAPIError

from ..db.remote_ownership import control, head, owner_predicate
from ..db.models import Project
from .errors import ProjectSessionError


@dataclass(repr=False)
class RemoteLease:
    engine: object
    project_id: str
    generation: str
    epoch: int
    token: str = field(repr=False)
    renew_seconds: int = 15
    transaction_seconds: int = 20
    provisioned_project: bool = False
    lost: Event = field(default_factory=Event, repr=False)
    stopped: Event = field(default_factory=Event, repr=False)
    worker: Thread | None = field(default=None, repr=False)
    transaction_guard: Lock = field(default_factory=Lock, repr=False)

    def require_live(self):
        if self.lost.is_set() or self.stopped.is_set():
            raise ProjectSessionError("remote_writer_lost")

    def start(self):
        self.worker = Thread(target=self._heartbeat, name="remote-project-lease", daemon=True)
        self.worker.start()

    def _heartbeat(self):
        while not self.stopped.wait(self.renew_seconds):
            try:
                self.renew()
            except Exception:
                # Even an unknown renewal outcome cannot make the old session ready.
                self.lost.set()
                return

    def renew(self):
        self.require_live()
        if not self.transaction_guard.acquire(timeout=self.transaction_seconds + 5):
            self.lost.set()
            raise ProjectSessionError("remote_storage_timeout")
        try:
            with self.engine.begin() as connection:
                self.require_live()
                policy, row = lock_head(connection, self.project_id)
                require_owner(connection, row, self)
                connection.execute(update(head).where(head.c.project_id == self.project_id).values(
                    lease_expires_at=expiry(policy)))
        except DBAPIError as error:
            self.lost.set()
            raise ProjectSessionError("remote_storage_unavailable") from error
        except ProjectSessionError:
            self.lost.set()
            raise
        finally:
            self.transaction_guard.release()

    def close(self):
        self.stopped.set()
        if self.worker is not None:
            self.worker.join(timeout=2 * self.transaction_seconds + 15)
        try:
            with self.engine.begin() as connection:
                lock_head(connection, self.project_id, maintenance_allowed=True)
                connection.execute(update(head).where(owner_predicate(self)).values(
                    owner_token=None, lease_expires_at=None))
        except (DBAPIError, ProjectSessionError):
            # Expiry remains the crash/partition fallback. Never release another owner.
            pass


def lock_head(connection, project_id, *, maintenance_allowed=False):
    """Bound the complete PG17 transaction and always lock control before head."""
    connection.execute(text("SET LOCAL statement_timeout = '10s'"))
    connection.execute(text("SET LOCAL lock_timeout = '3s'"))
    connection.execute(text("SET LOCAL transaction_timeout = '20s'"))
    policy = connection.execute(select(control).where(control.c.id == 1).with_for_update(read=True)).mappings().one_or_none()
    if policy is None:
        raise ProjectSessionError("remote_schema_busy")
    capabilities = policy["capabilities"]
    if (policy["protocol_version"] != 1 or not isinstance(capabilities, list)
            or not all(isinstance(value, str) for value in capabilities)
            or not {"durable_commands", "consistent_capture", "server_checkpoints"}.issubset(capabilities)):
        raise ProjectSessionError("remote_storage_protocol_unsupported")
    if policy["maintenance"] and not maintenance_allowed:
        raise ProjectSessionError("remote_schema_busy")
    # The administrator may tighten the default policy, never an individual client.
    connection.execute(text("SELECT set_config('transaction_timeout', :value, true)"),
                       {"value": f"{policy['transaction_seconds']}s"})
    row = connection.execute(select(head).where(head.c.project_id == project_id).with_for_update()).mappings().one_or_none()
    if row is None:
        raise ProjectSessionError("remote_project_not_provisioned")
    return policy, row


def server_now(connection):
    # clock_timestamp(), unlike now(), is sampled AFTER the potentially waited lock.
    return connection.scalar(text("SELECT clock_timestamp()"))


def expiry(policy):
    return text("clock_timestamp() + make_interval(secs => :lease_seconds)").bindparams(
        lease_seconds=policy["lease_seconds"])


def require_owner(connection, row, lease):
    if row["storage_generation"] != lease.generation:
        raise ProjectSessionError("remote_generation_mismatch")
    if (row["writer_epoch"] != lease.epoch or row["owner_token"] != lease.token
            or row["lease_expires_at"] is None or row["lease_expires_at"] <= server_now(connection)):
        raise ProjectSessionError("remote_writer_lost")


def claim(connection, project_id):
    policy, row = lock_head(connection, project_id)
    if row["lease_expires_at"] is not None and row["lease_expires_at"] > server_now(connection):
        raise ProjectSessionError("remote_project_busy")
    if row["writer_epoch"] == 9223372036854775807:
        raise ProjectSessionError("remote_revision_exhausted")
    # Runtime-private randomness is never taken from a profile, path or HTTP caller.
    token = token_hex(32)
    epoch = row["writer_epoch"] + 1
    connection.execute(update(head).where(head.c.project_id == project_id).values(
        owner_token=token, writer_epoch=epoch, lease_expires_at=expiry(policy)))
    return RemoteLease(connection.engine, project_id, row["storage_generation"], epoch, token,
                       renew_seconds=policy["renew_seconds"], transaction_seconds=policy["transaction_seconds"])


def open_remote(factory, manifest):
    try:
        with factory.kw["bind"].begin() as connection:
            lease = claim(connection, manifest.project_id)
        bind_lease(factory, lease)
        lease.start()
        return lease
    except DBAPIError as error:
        raise ProjectSessionError("remote_storage_unavailable") from error


def provision_target(uow, factory, document, path):
    """Explicit copy/create admission, root + head + copied data in ONE transaction."""
    started = monotonic()
    session = uow._require_session()
    connection = session.connection()
    # Serialize initial provisioning, including the case where no head exists yet.
    connection.execute(text("SET LOCAL transaction_timeout = '20s'"))
    connection.execute(text("SET LOCAL statement_timeout = '10s'"))
    connection.execute(text("SET LOCAL lock_timeout = '3s'"))
    connection.execute(select(control).where(control.c.id == 1).with_for_update(read=True))
    connection.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:project, 0))"),
                       {"project": document.manifest.project_id})
    manifest = document.manifest
    created = connection.execute(insert(Project.__table__).values(
        id=manifest.project_id, name=manifest.name, path=str(path), format_version=manifest.format_version,
        created_at=manifest.created_at, updated_at=manifest.updated_at, metadata={}
    ).on_conflict_do_nothing(index_elements=["id"]).returning(Project.__table__.c.id)).scalar_one_or_none()
    connection.execute(insert(head).values(project_id=manifest.project_id,
        storage_generation=str(uuid4())).on_conflict_do_nothing(index_elements=["project_id"]))
    lease = claim(connection, manifest.project_id)
    lease.provisioned_project = created is not None
    bind_lease(factory, lease)
    session.info["remote_lease"] = lease
    session.info["remote_initial_manifest"] = document.manifest
    # claim already owns the row lock; establish the local whole-transaction deadline.
    session.info["remote_fence"] = started
    return lease


def fence(session):
    lease = session.info.get("remote_lease")
    if lease is None:
        return
    lease.require_live()
    if "remote_fence" not in session.info:
        started = monotonic()
        # Heartbeat waits locally for this runtime's own bounded writes instead of
        # mistaking its own head-row lock for a network/foreign-writer failure.
        if not lease.transaction_guard.acquire(timeout=125):
            lease.lost.set()
            raise ProjectSessionError("remote_storage_timeout")
        session.info["remote_gate"] = lease.transaction_guard
        try:
            lease.require_live()
            connection = session.connection()
            _, row = lock_head(connection, lease.project_id)
            require_owner(connection, row, lease)
        except Exception:
            lease.lost.set()
            session.info.pop("remote_gate").release()
            raise
        session.info["remote_fence"] = started


def final_fence(session):
    fence(session)
    lease = session.info.get("remote_lease")
    if lease is None:
        return
    connection = session.connection()
    # The server bounds idle and statement time too; the runtime bounds Python work.
    policy = connection.execute(select(control).where(control.c.id == 1)).mappings().one()
    if monotonic() - session.info["remote_fence"] >= policy["transaction_seconds"]:
        lease.lost.set()
        raise ProjectSessionError("remote_storage_timeout")
    result = connection.execute(update(head).where(owner_predicate(lease),
        head.c.lease_expires_at > text("clock_timestamp()")).values(writer_epoch=lease.epoch))
    if result.rowcount != 1:
        lease.lost.set()
        raise ProjectSessionError("remote_writer_lost")


def bind_lease(factory, lease):
    """Factory-local hooks fence ORM flushes AND bulk SQL without changing domain APIs."""
    factory.configure(info={"remote_lease": lease})
    if getattr(factory, "_remote_hooks_installed", False):
        return
    factory._remote_hooks_installed = True
    event.listen(factory, "before_flush", lambda session, *_: fence(session))
    event.listen(factory, "do_orm_execute", _before_execute)
    event.listen(factory, "before_commit", _before_commit)
    event.listen(factory, "after_transaction_end", _after_transaction)
    def unavailable(context):
        state = getattr(context.original_exception, "sqlstate", None)
        timed_out = state in {"57014", "25P04", "55P03"}
        if context.execution_context is not None and context.execution_context.execution_options.get("remote_read_probe"):
            if timed_out:
                context.is_disconnect = True
                context.invalidate_pool_on_disconnect = False
            return None
        if context.is_disconnect or timed_out or state == "57P01":
            lease.lost.set()
            context.is_disconnect = True
            return ProjectSessionError("remote_storage_timeout" if timed_out else "remote_storage_unavailable")
        return None
    event.listen(lease.engine, "handle_error", unavailable, retval=True)


def _before_execute(state):
    if state.is_insert or state.is_update or state.is_delete:
        fence(state.session)


def _before_commit(session):
    # SQLAlchemy otherwise flushes AFTER before_commit. Check expiry only after
    # pending ORM writes have flushed, so no later flush can bypass the fence.
    session.flush()
    manifest = session.info.pop("remote_initial_manifest", None)
    if manifest is not None:
        from .remote_store import bootstrap
        bootstrap(session, manifest)
    final_fence(session)


def _after_transaction(session, transaction):
    if transaction.parent is None:
        session.info.pop("remote_fence", None)
        gate = session.info.pop("remote_gate", None)
        if gate is not None:
            gate.release()


def lease_for(factory):
    return factory.kw.get("info", {}).get("remote_lease")


def close_remote(factory):
    lease = lease_for(factory)
    if lease is not None:
        lease.close()


def revoke_remote(engine, project_id):
    """Trusted administrative recovery. Call only after stopping the old writer."""
    with engine.begin() as connection:
        _, row = lock_head(connection, project_id, maintenance_allowed=True)
        if row["writer_epoch"] == 9223372036854775807:
            raise ProjectSessionError("remote_revision_exhausted")
        connection.execute(update(head).where(head.c.project_id == project_id).values(
            writer_epoch=row["writer_epoch"] + 1, owner_token=None, lease_expires_at=None))


@contextmanager
def ownership_guard(factory, *, retire_on_success=False):
    """Fence manifest-only publication; durable manifest heads belong to P9-005."""
    from .remote_context import current_transaction
    if current_transaction(factory) is not None:
        yield
        return
    if lease_for(factory) is None:
        yield
        if retire_on_success:
            factory.kw["bind"].dispose()
        return
    try:
        with factory() as session:
            fence(session)
            yield
            session.commit()
    except DBAPIError as error:
        lease_for(factory).lost.set()
        raise ProjectSessionError("remote_storage_unavailable") from error
    else:
        if retire_on_success:
            close_remote(factory)
            factory.kw["bind"].dispose()
