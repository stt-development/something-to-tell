"""Server document/head/checkpoint and command-ledger SQL boundary (ADR 0025)."""

from hashlib import sha256
import json

from sqlalchemy import select, text, update

from ..db.remote_ownership import head, receipts, checkpoints, owner_predicate
from ..project_document.service import ProjectDocumentService
from ..project_format.manifest import ProjectManifestV2
from ..repositories.sqlite import SqlAlchemyUnitOfWork
from ..schemas.project_document import parse_project_document
from ..schemas.remote_storage import RemoteCommandReceiptV1, RemoteCommandOutcomeV1, RemoteStorageHeadV1
from .errors import ProjectSessionError
from .remote_context import current_transaction


def document_in_session(session, manifest):
    with SqlAlchemyUnitOfWork(lambda: session, project_id=manifest.project_id, borrowed_session=session) as uow:
        return ProjectDocumentService().load(uow, manifest)


def row_for(connection, project_id, *, shared=False):
    statement = select(head, (head.c.lease_expires_at > text("clock_timestamp()")).label("_lease_valid")).where(head.c.project_id == project_id)
    if shared:
        connection.execute(text("SET LOCAL lock_timeout='3s'"))
        connection.execute(text("SET LOCAL statement_timeout='10s'"))
        connection.execute(text("SET LOCAL transaction_timeout='20s'"))
        statement = statement.with_for_update(read=True)
    row = connection.execute(statement).mappings().one_or_none()
    if row is None:
        raise ProjectSessionError("remote_project_not_provisioned")
    return row


def manifest_for(row):
    if row["canonical_manifest"] is None:
        raise ProjectSessionError("remote_storage_binding_required")
    return ProjectManifestV2.model_validate(row["canonical_manifest"])


def head_dto(row, *, state="ready"):
    return RemoteStorageHeadV1(project_id=row["project_id"], storage_generation=row["storage_generation"],
        authoring_revision=str(row["authoring_revision"]), saved_authoring_revision=str(row["saved_authoring_revision"]),
        saved_revision=str(row["saved_revision"]), document_checksum=row["checksum"],
        writer_epoch=str(row["writer_epoch"]), state=state)


def capture(factory, project_id, *, manifest=None):
    """The head, canonical manifest and all tables belong to ONE MVCC snapshot."""
    current = current_transaction(factory)
    if current is not None:
        row = dict(row_for(current.session, project_id))
        row["_saved_checksum"] = saved_document(current.session, project_id, row).checksum
        return document_in_session(current.session, manifest or current.manifest), row
    engine = factory.kw["bind"]
    with engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with factory(bind=connection) as session:
            row = row_for(session, project_id)
            document = document_in_session(session, manifest_for(row))
            if document.checksum != row["checksum"]:
                raise ProjectSessionError("remote_revision_stale")
            row = dict(row)
            row["_saved_checksum"] = saved_document(session, project_id, row).checksum
            return document, row


def bootstrap(session, manifest):
    """Explicit creation/copy initializes a saved boundary, never ordinary Open."""
    row = row_for(session, manifest.project_id)
    if row["canonical_manifest"] is not None:
        return
    document = document_in_session(session, manifest)
    session.execute(update(head).where(head.c.project_id == manifest.project_id).values(
        canonical_manifest=manifest.model_dump(mode="json"), checksum=document.checksum,
        saved_revision=manifest.saved_revision))
    session.execute(checkpoints.insert().values(project_id=manifest.project_id,
        storage_generation=row["storage_generation"], saved_revision=manifest.saved_revision,
        saved_authoring_revision=row["authoring_revision"], checksum=document.checksum,
        document=document.model_dump(mode="json")))


def digest(guard, kind, target, payload):
    """Epoch/transport identity and secrets never become retained ledger payloads."""
    envelope = dict(protocol_version=1, project_id=guard.project_id, storage_generation=guard.storage_generation,
                    expected_revision=guard.expected_revision, kind=kind, target=target, payload=payload)
    try:
        encoded = json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        raise ProjectSessionError("remote_contract_invalid") from None
    return sha256(encoded).hexdigest()


def receipt_for(connection, guard):
    row = connection.execute(select(receipts).where(receipts.c.project_id == guard.project_id,
        receipts.c.storage_generation == guard.storage_generation, receipts.c.command_id == guard.command_id)).mappings().one_or_none()
    return RemoteCommandReceiptV1.model_validate(row["outcome"]) if row is not None else None


def publish(session, lease, guard, request_digest, document, *, changed, saved=False):
    before = int(guard.expected_revision)
    after = before + int(changed)
    if after > 9223372036854775807:
        raise ProjectSessionError("remote_revision_exhausted")
    values = dict(authoring_revision=after, canonical_manifest=document.manifest.model_dump(mode="json"),
                  checksum=document.checksum)
    if saved:
        values.update(saved_authoring_revision=after, saved_revision=document.manifest.saved_revision)
        session.execute(checkpoints.insert().values(project_id=guard.project_id, storage_generation=guard.storage_generation,
            saved_revision=document.manifest.saved_revision, saved_authoring_revision=after,
            document=document.model_dump(mode="json"), checksum=document.checksum))
        keep = select(checkpoints.c.saved_revision).where(checkpoints.c.project_id == guard.project_id,
            checkpoints.c.storage_generation == guard.storage_generation).order_by(checkpoints.c.saved_revision.desc()).limit(3)
        session.execute(checkpoints.delete().where(checkpoints.c.project_id == guard.project_id,
            checkpoints.c.storage_generation == guard.storage_generation, checkpoints.c.saved_revision.not_in(keep)))
    result = session.execute(update(head).where(owner_predicate(lease), head.c.authoring_revision == before,
        head.c.lease_expires_at > text("clock_timestamp()")).values(**values))
    if result.rowcount != 1:
        raise ProjectSessionError("remote_writer_lost")
    receipt = RemoteCommandReceiptV1(project_id=guard.project_id, storage_generation=guard.storage_generation,
        command_id=guard.command_id, request_digest=request_digest, base_revision=str(before), result_revision=str(after),
        document_checksum=document.checksum, result="changed" if changed else "no_change")
    session.execute(receipts.insert().values(project_id=guard.project_id, storage_generation=guard.storage_generation,
        command_id=guard.command_id, digest=request_digest, base_revision=before, result_revision=after,
        checksum=document.checksum, outcome=receipt.model_dump(mode="json")))
    return receipt


def saved_document(connection, project_id, row=None):
    row = row or row_for(connection, project_id)
    value = connection.scalar(select(checkpoints.c.document).where(checkpoints.c.project_id == project_id,
        checkpoints.c.storage_generation == row["storage_generation"], checkpoints.c.saved_revision == row["saved_revision"]))
    if value is None:
        raise ProjectSessionError("remote_contract_invalid")
    return parse_project_document(value)


def outcome(factory, guard):
    """Absence is conclusive only AFTER serializing behind any in-flight writer."""
    from sqlalchemy.exc import SQLAlchemyError
    try:
        with factory.kw["bind"].connect().execution_options(remote_read_probe=True) as connection:
            with connection.begin():
                row = row_for(connection, guard.project_id, shared=True)
                if row["storage_generation"] != guard.storage_generation:
                    raise ProjectSessionError("remote_generation_mismatch")
                receipt = receipt_for(connection, guard)
                state = "committed" if receipt else "not_committed"
    except (SQLAlchemyError, ProjectSessionError) as error:
        if isinstance(error, ProjectSessionError) and error.code == "remote_generation_mismatch":
            raise
        state, receipt = "unknown", None
    return RemoteCommandOutcomeV1(project_id=guard.project_id, storage_generation=guard.storage_generation,
        command_id=guard.command_id, status=state, receipt=receipt)


def lookup_guard(project_id, generation, command_id):
    from ..schemas.remote_storage import RemoteCommandGuardV1
    try:
        return RemoteCommandGuardV1(project_id=project_id, storage_generation=generation,
            command_id=command_id, writer_epoch="1", expected_revision="0")
    except ValueError:
        raise ProjectSessionError("remote_contract_invalid") from None
