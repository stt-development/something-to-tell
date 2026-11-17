"""Offline operator reset for a verified restored destination (ADR0025/P9-010).

Never called by Open/reconnect. Maintenance and external runtime-access fencing
must already be established; this module neither changes roles nor lifts fences.
"""

from uuid import uuid4

from alembic.script import ScriptDirectory
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from .db.models import Project
from .db.remote_ownership import checkpoints, control, head, receipts
from .project_session.database import alembic_config
from .project_session.errors import ProjectSessionError
from .project_session.remote_store import document_in_session, head_dto, manifest_for
from .schema_admin_transaction import schema_admin_connection
from .schema_inspection import inspect_schema_connection
from .schema_upgrade_preflight import require_upgrade_quiescence
from .schemas.project_document import parse_project_document
from .schemas.remote_storage import RemoteCommandReceiptV1
from .storage_permissions import inspection_privileges


def _require(condition):
    if not condition:
        raise ProjectSessionError("remote_contract_invalid")


def _validate_records(connection, rows):
    """Validate every source aggregate before staging any generation writes."""
    by_project = {row["project_id"]: row for row in rows}
    _require(set(connection.scalars(select(Project.id))) == set(by_project))
    with Session(bind=connection, join_transaction_mode="rollback_only") as session:
        for row in rows:
            head_dto(row)
            manifest = manifest_for(row)
            document = document_in_session(session, manifest)
            _require(document.checksum == row["checksum"]
                     and manifest.project_id == row["project_id"]
                     and manifest.settings.storage.mode == "postgresql"
                     and manifest.saved_revision == row["saved_revision"]
                     and row["saved_authoring_revision"] <= row["authoring_revision"]
                     and row["writer_epoch"] < 9223372036854775807)
    saved = list(connection.execute(select(checkpoints)).mappings())
    current = []
    for record in saved:
        document = parse_project_document(record["document"])
        row = by_project.get(record["project_id"])
        _require(row is not None and document.manifest.project_id == record["project_id"]
                 and document.checksum == record["checksum"]
                 and document.manifest.saved_revision == record["saved_revision"])
        if record["storage_generation"] == row["storage_generation"]:
            _require(record["saved_authoring_revision"] <= row["authoring_revision"])
            current.append(dict(record))
    for row in rows:
        _require(any(record["project_id"] == row["project_id"]
                     and record["saved_revision"] == row["saved_revision"]
                     and record["saved_authoring_revision"] == row["saved_authoring_revision"]
                     for record in current))
    for record in connection.execute(select(receipts)).mappings():
        receipt = RemoteCommandReceiptV1.model_validate(record["outcome"])
        _require(record["project_id"] in by_project and all((
            receipt.project_id == record["project_id"],
            receipt.storage_generation == record["storage_generation"],
            receipt.command_id == record["command_id"],
            receipt.request_digest == record["digest"],
            receipt.base_revision == str(record["base_revision"]),
            receipt.result_revision == str(record["result_revision"]),
            receipt.document_checksum == record["checksum"],
        )))
    return current


def reset_restored_generations(engine, *, expected_database: str, confirmed: bool = False):
    """One bounded atomic operator action; uncertainty retains maintenance."""
    _require(confirmed is True and isinstance(expected_database, str) and bool(expected_database.strip()))
    with schema_admin_connection(engine) as connection:
        _require(connection.scalar(text("SELECT current_database()")) == expected_database)
        scripts = ScriptDirectory.from_config(alembic_config(""))
        _require(inspect_schema_connection(connection, scripts).status == "current")
        if inspection_privileges(connection, schema_status="current") != "administrator":
            raise ProjectSessionError("remote_admin_required")
        policy = connection.execute(select(control).where(control.c.id == 1).with_for_update()).mappings().one()
        _require(policy["maintenance"] is True)
        _require(policy["protocol_version"] == 1 and isinstance(policy["capabilities"], list)
                 and all(isinstance(value, str) for value in policy["capabilities"])
                 and {"consistent_capture", "durable_commands", "server_checkpoints"}.issubset(policy["capabilities"]))
        require_upgrade_quiescence(connection)
        rows = list(connection.execute(select(head).order_by(head.c.project_id).with_for_update()).mappings())
        saved = _validate_records(connection, rows)
        generations = {row["project_id"]: str(uuid4()) for row in rows}
        for record in saved:
            connection.execute(checkpoints.insert().values(
                **{**record, "storage_generation": generations[record["project_id"]]},
            ))
        for row in rows:
            result = connection.execute(update(head).where(
                head.c.project_id == row["project_id"],
                head.c.storage_generation == row["storage_generation"],
            ).values(storage_generation=generations[row["project_id"]],
                     writer_epoch=row["writer_epoch"] + 1, owner_token=None, lease_expires_at=None))
            _require(result.rowcount == 1)
        # Check complete persisted targets, not only affected-row counts. Historical
        # receipts/checkpoints remain old-generation records and cannot authorize replay.
        after = list(connection.execute(select(head).order_by(head.c.project_id)).mappings())
        _validate_records(connection, after)
        for before, restored in zip(rows, after, strict=True):
            expected = {**before, "storage_generation": generations[before["project_id"]],
                        "writer_epoch": before["writer_epoch"] + 1,
                        "owner_token": None, "lease_expires_at": None}
            _require(dict(restored) == expected)
        require_upgrade_quiescence(connection)
    return {"projects": len(rows), "copied_checkpoints": len(saved), "maintenance": True}
