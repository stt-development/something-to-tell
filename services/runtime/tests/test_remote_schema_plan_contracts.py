"""C1 wire-only plan metadata; no store, clock-based authorization or database IO."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.remote_storage import (
    RemoteSchemaPlanV1, RemoteSchemaBackupAttestationRequestV1, RemoteSchemaBackupAttestationV1,
    RemoteSchemaExecutionV1,
)

SAMPLES = json.loads((Path(__file__).parent / "fixtures/remote_storage_v1.json").read_text())


@pytest.mark.parametrize("name,model", [
    ("schema_plan", RemoteSchemaPlanV1), ("schema_backup_request", RemoteSchemaBackupAttestationRequestV1),
    ("schema_backup_attestation", RemoteSchemaBackupAttestationV1),
    ("schema_execution", RemoteSchemaExecutionV1),
])
def test_golden_plan_and_confirmation_round_trip(name, model):
    value = model.model_validate_json(json.dumps(SAMPLES[name]))
    assert json.loads(value.model_dump_json()) == SAMPLES[name]
    with pytest.raises(ValidationError):
        value.protocol_version = 1


@pytest.mark.parametrize("override", [
    {"action": "provision"}, {"source_schema_revision": None}, {"backup_required": False},
    {"backup_required": "true"}, {"action": ["upgrade"], "backup_required": False},
    {"migration_revisions": []}, {"migration_revisions": ["wrong-target"]},
    {"migration_revisions": ["20261022_0012", "20261022_0012"]},
    {"migration_revisions": ["20261022_0011", "20261022_0012"]},
    {"migration_revisions": ["x"] * 129}, {"target_schema_revision": "bad\nstamp"},
    {"target_schema_revision": "20261022_0012\n"}, {"plan_id": "44444444-4444-4444-8444-444444444444\n"},
    {"plan_fingerprint": "c" * 64 + "\n"}, {"expires_at": "2026-02-30T12:05:00Z"},
    {"expires_at": "2026-10-23T12:05:00+01:00"}, {"expires_at": "2026-10-23T12:05:00"},
    {"expires_at": "2026-10-23T12:05:00Z\n"}, {"expires_at": "0000-01-01T00:00:00Z"},
    {"password": "not-retained"}, {"project_path": "/private/project"}, {"protocol_version": True},
])
def test_inconsistent_or_secret_plan_payloads_are_rejected(override):
    with pytest.raises(ValidationError):
        RemoteSchemaPlanV1.model_validate_json(json.dumps({**SAMPLES["schema_plan"], **override}))


def test_provision_has_no_source_or_backup_and_migration_list_is_immutable():
    payload = {**SAMPLES["schema_plan"], "action": "provision", "source_schema_revision": None, "backup_required": False}
    plan = RemoteSchemaPlanV1.model_validate_json(json.dumps(payload))
    assert isinstance(plan.migration_revisions, tuple)
    with pytest.raises(ValidationError):
        plan.migration_revisions += ("unexpected",)


@pytest.mark.parametrize("override", [{"confirmation": False}, {"confirmation": "backup_only"},
    {"confirmation": ""}, {"verified_dump_path": "/private/backup.sql"}, {"plan_fingerprint": "bad"}])
def test_operator_confirmation_is_explicit_and_not_a_backup_upload(override):
    with pytest.raises(ValidationError):
        RemoteSchemaBackupAttestationRequestV1.model_validate_json(json.dumps({**SAMPLES["schema_backup_request"], **override}))


def test_attestation_does_not_accept_backup_contents_or_missing_plan():
    for override in ({"backup": "dump content"}, {"plan_id": None}, {"backup_attestation_id": "bad"}):
        with pytest.raises(ValidationError):
            RemoteSchemaBackupAttestationV1.model_validate_json(json.dumps({**SAMPLES["schema_backup_attestation"], **override}))


@pytest.mark.parametrize("override", [{"status": "pending"}, {"action": ["provision"]},
    {"action": "drop"}, {"schema_revision": None}, {"schema_revision": "bad\nstamp"},
    {"plan_id": "bad"}, {"protocol_version": True}, {"password": "private"},
    {"project_path": "/private/path"}])
def test_completed_result_rejects_pending_coerced_or_secret_fields(override):
    with pytest.raises(ValidationError):
        RemoteSchemaExecutionV1.model_validate_json(json.dumps({**SAMPLES["schema_execution"], **override}))
