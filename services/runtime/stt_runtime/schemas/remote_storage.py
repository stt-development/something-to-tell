"""Inert ADR 0025 protocol contracts; no production session integration in P9-000."""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator, model_validator

REMOTE_STORAGE_VERSION = 1
REMOTE_COUNTER_MAX = 9_223_372_036_854_775_807
REMOTE_SUPPORTED_POSTGRES_MAJORS = (17,)
REMOTE_LEASE_TTL_SECONDS = 60
REMOTE_LEASE_RENEW_SECONDS = 15
REMOTE_TRANSACTION_TIMEOUT_SECONDS = 20
REMOTE_CONNECT_TIMEOUT_SECONDS = 5
REMOTE_POOL_TIMEOUT_SECONDS = 5
REMOTE_STATEMENT_TIMEOUT_SECONDS = 10
REMOTE_LOCK_TIMEOUT_SECONDS = 3
REMOTE_SCHEMA_PLAN_TTL_SECONDS = 300

RemoteCounter = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]{0,18})$")]
RemoteId = Annotated[str, Field(min_length=1, max_length=255, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")]
RemoteUuid = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")]
RemoteChecksum = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]
RemoteSchemaRevision = Annotated[str, Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")]


def _valid_utc_timestamp(value: str) -> str:
    # Keep wire text canonical, but reject impossible calendar dates as well.
    datetime.fromisoformat(value)
    return value


RemoteUtcTimestamp = Annotated[str, Field(pattern=r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$"),
                               AfterValidator(_valid_utc_timestamp)]
RemoteSchemaStatus = Literal["empty", "current", "older", "future", "unknown", "partial"]
RemoteSessionState = Literal["ready", "busy", "unavailable", "stale", "writer_lost", "outcome_unknown", "recovery_required", "schema_blocked"]
RemoteStorageErrorCode = Literal[
    "remote_contract_invalid", "remote_storage_protocol_unsupported",
    "remote_project_scope_mismatch", "remote_project_busy", "remote_writer_lost",
    "remote_revision_stale", "remote_generation_mismatch", "remote_command_reused",
    "remote_commit_unknown", "remote_storage_unavailable", "remote_storage_timeout",
    "remote_tls_failed", "remote_auth_failed", "remote_schema_upgrade_required",
    "remote_schema_future", "remote_schema_unknown", "remote_schema_partial",
    "remote_schema_busy", "remote_admin_required", "remote_storage_binding_required",
    "remote_server_version_unsupported", "remote_revision_exhausted",
    "remote_local_publication_required",
    "remote_project_not_provisioned",
    "remote_schema_plan_stale", "remote_schema_plan_limit", "remote_schema_backup_required",
]


class RemoteContractV1(BaseModel):
    """Unknown fields/secrets, coercion and accidental mutation fail closed."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)
    protocol_version: Literal[1] = 1

    @field_validator("protocol_version", mode="before")
    @classmethod
    def strict_version(cls, value):
        if type(value) is not int or value != REMOTE_STORAGE_VERSION:
            raise ValueError("remote_storage_protocol_unsupported")
        return value

    @field_validator("*", mode="after")
    @classmethod
    def bounded_counters(cls, value, info):
        # Wire counters intentionally remain decimal strings, including > 2**53.
        if info.field_name in {"authoring_revision", "saved_authoring_revision", "saved_revision",
                              "writer_epoch", "expected_revision", "base_revision", "result_revision",
                              "observed_revision"}:
            if int(value) > REMOTE_COUNTER_MAX:
                raise ValueError("remote_revision_exhausted")
        return value


class RemoteStorageHeadV1(RemoteContractV1):
    project_id: RemoteId
    storage_generation: RemoteUuid
    authoring_revision: RemoteCounter
    saved_authoring_revision: RemoteCounter
    saved_revision: RemoteCounter
    document_checksum: RemoteChecksum
    writer_epoch: RemoteCounter
    state: RemoteSessionState

    @model_validator(mode="after")
    def valid_head(self):
        if int(self.saved_authoring_revision) > int(self.authoring_revision):
            raise ValueError("remote_contract_invalid")
        if self.state == "ready" and self.writer_epoch == "0":
            raise ValueError("remote_contract_invalid")
        return self


class RemoteCommandGuardV1(RemoteContractV1):
    """The owner token and server-computed request digest never come from the UI."""

    project_id: RemoteId
    storage_generation: RemoteUuid
    command_id: RemoteUuid
    writer_epoch: RemoteCounter
    expected_revision: RemoteCounter

    @field_validator("writer_epoch")
    @classmethod
    def acquired_writer(cls, value):
        if value == "0":
            raise ValueError("remote_writer_lost")
        return value


class RemoteCommandReceiptV1(RemoteContractV1):
    project_id: RemoteId
    storage_generation: RemoteUuid
    command_id: RemoteUuid
    request_digest: RemoteChecksum
    base_revision: RemoteCounter
    result_revision: RemoteCounter
    document_checksum: RemoteChecksum
    result: Literal["changed", "no_change"]

    @model_validator(mode="after")
    def exact_transition(self):
        increment = 1 if self.result == "changed" else 0
        if int(self.result_revision) != int(self.base_revision) + increment:
            raise ValueError("remote_contract_invalid")
        return self


class RemoteCommandOutcomeV1(RemoteContractV1):
    project_id: RemoteId
    storage_generation: RemoteUuid
    command_id: RemoteUuid
    status: Literal["committed", "not_committed", "unknown"]
    receipt: RemoteCommandReceiptV1 | None = None

    @model_validator(mode="after")
    def matched_receipt(self):
        if (self.status == "committed") != (self.receipt is not None):
            raise ValueError("remote_contract_invalid")
        if self.receipt is not None and any(
            getattr(self, name) != getattr(self.receipt, name)
            for name in ("project_id", "storage_generation", "command_id")
        ):
            raise ValueError("remote_contract_invalid")
        return self


class RemoteStorageReconnectV1(RemoteContractV1):
    storage_generation: RemoteUuid
    observed_revision: RemoteCounter
    unresolved_command_id: RemoteUuid | None = None


class RemoteStorageReleaseV1(RemoteContractV1):
    """Explicit local lifecycle consent, never Save, Discard or command replay."""

    protocol_version: Literal[1] = Field(...)
    storage_generation: RemoteUuid
    confirmation: Literal["leave_remote_working_data_unchanged"]


class RemoteReconnectScopeV1(RemoteContractV1):
    """Process-local attempt correlation; never a lease or command authority."""

    protocol_version: Literal[1] = Field(...)
    project_id: RemoteId
    storage_generation: RemoteUuid
    attempt_id: RemoteUuid


class RemoteReconnectBeginV1(RemoteReconnectScopeV1):
    observed_revision: RemoteCounter
    unresolved_command_id: RemoteUuid | None
    confirmation: Literal["reload_remote_working_data"]


class RemoteReconnectAbandonV1(RemoteReconnectScopeV1):
    confirmation: Literal["leave_remote_working_data_unchanged"]


class RemoteReconnectOutcomeV1(RemoteReconnectScopeV1):
    source_session_id: RemoteId
    status: Literal["unknown", "pending", "ready", "failed", "releasing", "release_failed", "released"]
    result_session_id: RemoteId | None
    error_code: RemoteStorageErrorCode | None

    @model_validator(mode="after")
    def consistent_result(self):
        if ((self.result_session_id is not None) != (self.status in {"ready", "release_failed"})
                or (self.error_code is not None) != (self.status in {"failed", "release_failed"})
                or self.result_session_id == self.source_session_id):
            raise ValueError("remote_contract_invalid")
        return self


class RemoteStorageReleaseResultV1(RemoteContractV1):
    """Only local cleanup is acknowledged; a remote lease may still be expiring."""

    session_id: RemoteId
    project_id: RemoteId
    storage_generation: RemoteUuid
    status: Literal["local_session_released"]


class RemoteStorageInspectionV1(RemoteContractV1):
    """Schema capabilities are inspection results, never write authorization."""

    server_major: int = Field(ge=10, le=99)
    schema_status: RemoteSchemaStatus
    schema_revision: RemoteSchemaRevision | None
    tls_policy: Literal["disable", "require", "verify-full"]
    tls_active: bool
    identity_verified: bool
    privileges: Literal["runtime", "administrator", "insufficient"]

    @model_validator(mode="after")
    def inspection_consistency(self):
        if self.schema_status == "empty" and self.schema_revision is not None:
            raise ValueError("remote_contract_invalid")
        if self.schema_status in {"current", "older", "future"} and self.schema_revision is None:
            raise ValueError("remote_contract_invalid")
        if self.tls_policy == "disable" and self.tls_active:
            raise ValueError("remote_contract_invalid")
        if self.identity_verified and (not self.tls_active or self.tls_policy != "verify-full"):
            raise ValueError("remote_contract_invalid")
        return self


class RemoteStorageFolderRequestV1(RemoteContractV1):
    # OS-specific path/manifest authorization belongs to the inspection route.
    project_path: str = Field(min_length=1, max_length=4096)

    @field_validator("project_path")
    @classmethod
    def valid_path_text(cls, value):
        if not value.strip() or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("remote_contract_invalid")
        return value


class RemoteStorageInspectRequestV1(RemoteStorageFolderRequestV1):
    profile_id: RemoteId


class RemoteSchemaPlanRequestV1(RemoteStorageInspectRequestV1):
    action: Literal["provision", "upgrade"]
    expected_schema_revision: RemoteSchemaRevision | None

    @model_validator(mode="after")
    def expected_source(self):
        if (self.action == "provision") != (self.expected_schema_revision is None):
            raise ValueError("remote_contract_invalid")
        return self


class RemoteSchemaExecuteRequestV1(RemoteStorageInspectRequestV1):
    plan_id: RemoteUuid
    plan_fingerprint: RemoteChecksum
    backup_attestation_id: RemoteUuid | None


class RemoteSchemaPlanV1(RemoteContractV1):
    """Review metadata only; runtime ownership must enforce expiry and single use."""

    plan_id: RemoteUuid
    plan_fingerprint: RemoteChecksum
    action: Literal["provision", "upgrade"]
    source_schema_revision: RemoteSchemaRevision | None
    target_schema_revision: RemoteSchemaRevision
    migration_revisions: tuple[RemoteSchemaRevision, ...] = Field(min_length=1, max_length=128)
    expires_at: RemoteUtcTimestamp
    backup_required: bool

    @model_validator(mode="after")
    def consistent_plan(self):
        if ((self.action == "provision") != (self.source_schema_revision is None)
                or self.backup_required != (self.action == "upgrade")
                or self.migration_revisions[-1] != self.target_schema_revision
                or len(set(self.migration_revisions)) != len(self.migration_revisions)
                or self.source_schema_revision in self.migration_revisions):
            raise ValueError("remote_contract_invalid")
        return self


class RemoteSchemaBackupAttestationRequestV1(RemoteStorageInspectRequestV1):
    """Explicit operator acknowledgement, not proof that runtime inspected a dump."""

    plan_id: RemoteUuid
    plan_fingerprint: RemoteChecksum
    confirmation: Literal["backup_and_restore_verified"]


class RemoteSchemaBackupAttestationV1(RemoteContractV1):
    """The future owner binds this opaque acknowledgement to one reviewed plan."""

    backup_attestation_id: RemoteUuid
    plan_id: RemoteUuid
    plan_fingerprint: RemoteChecksum
    expires_at: RemoteUtcTimestamp


class RemoteSchemaExecutionV1(RemoteContractV1):
    """Known committed schema result only; no replay authority or secret observations."""

    plan_id: RemoteUuid
    action: Literal["provision", "upgrade"]
    schema_revision: RemoteSchemaRevision
    status: Literal["completed"]
