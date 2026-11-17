"""Bounded process-local review plans. No SQL, path access or DDL authorization."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from hashlib import sha256
import hmac
import json
from secrets import token_bytes
from threading import RLock
from time import monotonic
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from .project_session.errors import ProjectSessionError
from .schemas.remote_storage import (
    REMOTE_SCHEMA_PLAN_TTL_SECONDS, REMOTE_SUPPORTED_POSTGRES_MAJORS,
    RemoteChecksum, RemoteId, RemoteSchemaRevision, RemoteStorageInspectionV1,
    RemoteSchemaPlanV1, RemoteSchemaBackupAttestationV1, RemoteSchemaPlanRequestV1,
    RemoteSchemaExecuteRequestV1, RemoteSchemaBackupAttestationRequestV1,
)


class SchemaPlanContext(BaseModel):
    """Trusted immutable observations supplied by runtime SQL composition, not clients."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    project_id: RemoteId
    profile_id: RemoteId
    authority_fingerprint: RemoteChecksum
    schema_fingerprint: RemoteChecksum
    inspection: RemoteStorageInspectionV1
    target_schema_revision: RemoteSchemaRevision
    # Reinspection of current/ineligible storage has no remaining candidate steps.
    migration_revisions: tuple[RemoteSchemaRevision, ...] = Field(max_length=128)
    maintenance: bool


@dataclass
class _PlanRecord:
    plan: RemoteSchemaPlanV1
    context: SchemaPlanContext
    scope_digest: bytes
    deadline: float
    attestation: RemoteSchemaBackupAttestationV1 | None = None


class SchemaPlanRegistry:
    """One lock/state owner; successful claim forgets the plan before external work."""

    def __init__(self, *, monotonic_clock=monotonic, utc_clock=lambda: datetime.now(UTC), max_pending=64):
        if type(max_pending) is not int or not 1 <= max_pending <= 64:
            raise ValueError("schema_plan_capacity_invalid")
        self._monotonic, self._utc = monotonic_clock, utc_clock
        self._capacity = max_pending
        self._key = token_bytes(32)
        self._plans: dict[str, _PlanRecord] = {}
        self._guard = RLock()

    def create(self, request: RemoteSchemaPlanRequestV1, context: SchemaPlanContext) -> RemoteSchemaPlanV1:
        with self._guard:
            now = self._monotonic()
            self._purge_expired(now)
            self._require_administrator(request, context)
            observed = context.inspection
            if observed.schema_status in {"future", "unknown", "partial"}:
                raise ProjectSessionError(f"remote_schema_{observed.schema_status}")
            expected_status = "empty" if request.action == "provision" else "older"
            if (observed.schema_status != expected_status
                    or request.expected_schema_revision != observed.schema_revision):
                raise ProjectSessionError("remote_schema_plan_stale")
            if len(self._plans) >= self._capacity:
                raise ProjectSessionError("remote_schema_plan_limit")
            utc = self._utc()
            if utc.tzinfo is None or utc.utcoffset() is None:
                raise ValueError("schema_plan_utc_clock_invalid")
            expires_at = (utc.astimezone(UTC) + timedelta(seconds=REMOTE_SCHEMA_PLAN_TTL_SECONDS)).isoformat().replace("+00:00", "Z")
            metadata = dict(protocol_version=1, plan_id=str(uuid4()), action=request.action,
                source_schema_revision=observed.schema_revision, target_schema_revision=context.target_schema_revision,
                migration_revisions=context.migration_revisions, expires_at=expires_at,
                backup_required=request.action == "upgrade")
            scope = self._scope_digest(request.project_path)
            envelope = dict(plan=metadata, context=context.model_dump(mode="json"), scope=scope.hex())
            canonical = json.dumps(envelope, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
            plan = RemoteSchemaPlanV1(**metadata, plan_fingerprint=hmac.new(self._key, canonical, sha256).hexdigest())
            self._plans[plan.plan_id] = _PlanRecord(plan, context, scope, now + REMOTE_SCHEMA_PLAN_TTL_SECONDS)
            return plan

    def attest(self, request: RemoteSchemaBackupAttestationRequestV1, context: SchemaPlanContext) -> RemoteSchemaBackupAttestationV1:
        with self._guard:
            record = self._find(request, context)
            if not record.plan.backup_required or request.confirmation != "backup_and_restore_verified":
                raise ProjectSessionError("remote_contract_invalid")
            if record.attestation is None:
                record.attestation = RemoteSchemaBackupAttestationV1(backup_attestation_id=str(uuid4()),
                    plan_id=record.plan.plan_id, plan_fingerprint=record.plan.plan_fingerprint,
                    expires_at=record.plan.expires_at)
            return record.attestation

    def claim(self, request: RemoteSchemaExecuteRequestV1, context: SchemaPlanContext, *,
              action: Literal["provision", "upgrade"] | None = None) -> RemoteSchemaPlanV1:
        """Return reviewed metadata once; callers must still coordinate/recheck SQL."""
        with self._guard:
            record = self._find(request, context)
            if action is not None and record.plan.action != action:
                raise ProjectSessionError("remote_contract_invalid")
            if record.plan.backup_required:
                if record.attestation is None or request.backup_attestation_id is None:
                    raise ProjectSessionError("remote_schema_backup_required")
                if request.backup_attestation_id != record.attestation.backup_attestation_id:
                    raise ProjectSessionError("remote_schema_plan_stale")
            elif request.backup_attestation_id is not None:
                raise ProjectSessionError("remote_contract_invalid")
            del self._plans[record.plan.plan_id]
            return record.plan

    def execution_action(self, request: RemoteSchemaExecuteRequestV1) -> Literal["provision", "upgrade"]:
        """Scoped routing hint only; fresh locked SQL and one-time claim still authorize."""
        with self._guard:
            self._purge_expired(self._monotonic())
            return self._bound_record(request).plan.action

    def clear_all(self):
        with self._guard:
            self._plans.clear()
            self._key = token_bytes(32)

    def _find(self, request, context):
        self._purge_expired(self._monotonic())
        record = self._bound_record(request)
        if context.profile_id != record.context.profile_id:
            raise ProjectSessionError("remote_schema_plan_stale")
        if context != record.context:
            # Once an authorized fresh observation is stale, it cannot revive.
            del self._plans[record.plan.plan_id]
            raise ProjectSessionError("remote_schema_plan_stale")
        return record

    def _bound_record(self, request):
        record = self._plans.get(request.plan_id)
        if (record is None or request.profile_id != record.context.profile_id
                or not hmac.compare_digest(request.plan_fingerprint, record.plan.plan_fingerprint)
                or not hmac.compare_digest(self._scope_digest(request.project_path), record.scope_digest)):
            raise ProjectSessionError("remote_schema_plan_stale")
        return record

    def _scope_digest(self, canonical_path):
        try:
            return hmac.digest(self._key, canonical_path.encode("utf-8"), "sha256")
        except UnicodeError:
            raise ProjectSessionError("remote_contract_invalid") from None

    def _purge_expired(self, now):
        self._plans = {key: record for key, record in self._plans.items() if record.deadline > now}

    @staticmethod
    def _require_administrator(request, context):
        if request.profile_id != context.profile_id:
            raise ProjectSessionError("remote_schema_plan_stale")
        if context.inspection.server_major not in REMOTE_SUPPORTED_POSTGRES_MAJORS:
            raise ProjectSessionError("remote_server_version_unsupported")
        if context.maintenance:
            raise ProjectSessionError("remote_schema_busy")
        if context.inspection.privileges != "administrator":
            raise ProjectSessionError("remote_admin_required")
