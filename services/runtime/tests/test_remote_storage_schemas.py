"""Freeze the proposed wire boundary without enabling remote session behavior."""

import json
import re
from pathlib import Path
from typing import get_args

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas import remote_storage as wire

ROOT = Path(__file__).parents[3]
SAMPLES = json.loads((Path(__file__).parent / "fixtures/remote_storage_v1.json").read_text())


def test_golden_constants_and_typescript_error_codes_match():
    for name, expected in SAMPLES["constants"].items():
        actual = getattr(wire, name)
        if name == "REMOTE_COUNTER_MAX":
            actual = str(actual)
        elif isinstance(actual, tuple):
            actual = list(actual)
        assert actual == expected
    source = (ROOT / "packages/contracts/src/remoteStorage.ts").read_text()
    error_union = source.split("export type RemoteStorageErrorCode =", 1)[1].split(";", 1)[0]
    assert set(re.findall(r'"(remote_[a-z_]+)"', error_union)) == set(get_args(wire.RemoteStorageErrorCode))
    for name in ("RemoteSchemaStatus", "RemoteSessionState"):
        declaration = source.split(f"export type {name} =", 1)[1].split(";", 1)[0]
        assert set(re.findall(r'"([a-z_]+)"', declaration)) == set(get_args(getattr(wire, name)))


@pytest.mark.internal_documentation
def test_private_protocol_error_table_matches_wire_codes():
    """Documentation parity is separate from the always-on Python/TS contract test."""
    specification = (ROOT / "docs/architecture/remote-storage-protocol-v1.md").read_text()
    error_table = specification.split("| HTTP | Exact Codes |", 1)[1].split("Foreign object", 1)[0]
    assert set(re.findall(r"`(remote_[a-z_]+)`", error_table)) == set(get_args(wire.RemoteStorageErrorCode))


@pytest.mark.parametrize("name,model", [
    ("head", wire.RemoteStorageHeadV1), ("guard", wire.RemoteCommandGuardV1),
    ("receipt", wire.RemoteCommandReceiptV1),
])
def test_golden_round_trip_preserves_bigint_precision(name, model):
    parsed = model.model_validate(SAMPLES[name])
    assert json.loads(parsed.model_dump_json()) == SAMPLES[name]
    with pytest.raises(ValidationError):
        parsed.protocol_version = 1


@pytest.mark.parametrize("counter", [0, True, "01", "-1", "1.0", "1e2", "", "9223372036854775808"])
def test_counter_rejects_coercion_noncanonical_and_overflow(counter):
    with pytest.raises(ValidationError):
        wire.RemoteCommandGuardV1.model_validate({**SAMPLES["guard"], "expected_revision": counter})


@pytest.mark.parametrize("version", [True, "1", 1.0, 2, None])
def test_protocol_version_is_exact_integer(version):
    with pytest.raises(ValidationError):
        wire.RemoteCommandGuardV1.model_validate({**SAMPLES["guard"], "protocol_version": version})


def test_guard_limits_and_secret_exclusion():
    guard = SAMPLES["guard"]
    assert wire.RemoteCommandGuardV1.model_validate({**guard, "expected_revision": str(wire.REMOTE_COUNTER_MAX)})
    for override in ({"owner_token": "secret"}, {"password": "secret"}, {"writer_epoch": "0"},
                     {"command_id": "not-a-uuid"}, {"project_id": "../other"}):
        with pytest.raises(ValidationError):
            wire.RemoteCommandGuardV1.model_validate({**guard, **override})


@pytest.mark.parametrize("state", get_args(wire.RemoteSessionState))
def test_all_session_states_have_a_stable_wire_spelling(state):
    assert wire.RemoteStorageHeadV1.model_validate({**SAMPLES["head"], "state": state}).state == state


def test_head_and_receipt_transitions_are_consistent():
    for override in ({"saved_authoring_revision": "9223372036854775807"}, {"writer_epoch": "0"}):
        with pytest.raises(ValidationError):
            wire.RemoteStorageHeadV1.model_validate({**SAMPLES["head"], **override})
    for override in ({"result_revision": "9007199254740994"}, {"request_digest": "bad"}, {"result": "no_change"}):
        with pytest.raises(ValidationError):
            wire.RemoteCommandReceiptV1.model_validate({**SAMPLES["receipt"], **override})
    noop = {**SAMPLES["receipt"], "result": "no_change", "result_revision": SAMPLES["receipt"]["base_revision"]}
    assert wire.RemoteCommandReceiptV1.model_validate(noop).result == "no_change"


def test_outcome_cannot_claim_unrelated_or_missing_receipt():
    context = {key: SAMPLES["guard"][key] for key in ("protocol_version", "project_id", "storage_generation", "command_id")}
    assert wire.RemoteCommandOutcomeV1(**context, status="committed", receipt=SAMPLES["receipt"])
    for status in ("unknown", "not_committed"):
        assert wire.RemoteCommandOutcomeV1(**context, status=status).receipt is None
        with pytest.raises(ValidationError):
            wire.RemoteCommandOutcomeV1(**context, status=status, receipt=SAMPLES["receipt"])
    with pytest.raises(ValidationError):
        wire.RemoteCommandOutcomeV1(**context, status="committed")
    with pytest.raises(ValidationError):
        wire.RemoteCommandOutcomeV1(**context, status="committed", receipt={**SAMPLES["receipt"], "project_id": "project-b"})


def test_inspection_does_not_misrepresent_tls_or_schema():
    inspection = dict(server_major=17, schema_status="current", schema_revision="20261020_0010",
                      tls_policy="verify-full", tls_active=True, identity_verified=True, privileges="runtime")
    assert wire.RemoteStorageInspectionV1(**inspection)
    for override in ({"schema_revision": None}, {"schema_status": "empty"}, {"tls_active": False},
                     {"tls_policy": "require"}, {"tls_policy": "disable"}, {"server_major": True}):
        with pytest.raises(ValidationError):
            wire.RemoteStorageInspectionV1(**{**inspection, **override})
    # Encrypted-only inspection is valid, but must not claim hostname verification.
    assert wire.RemoteStorageInspectionV1(**{**inspection, "tls_policy": "require", "identity_verified": False})


def test_administration_requests_require_explicit_source_and_plan():
    context = dict(project_path="/tmp/Example.narrative", profile_id="admin-profile")
    assert wire.RemoteSchemaPlanRequestV1(**context, action="provision", expected_schema_revision=None)
    assert wire.RemoteSchemaPlanRequestV1(**context, action="upgrade", expected_schema_revision="old")
    for action, revision in (("provision", "old"), ("upgrade", None)):
        with pytest.raises(ValidationError):
            wire.RemoteSchemaPlanRequestV1(**context, action=action, expected_schema_revision=revision)
    for path in ("", "   ", "bad\0path", "bad\npath"):
        with pytest.raises(ValidationError):
            wire.RemoteStorageInspectRequestV1(**{**context, "project_path": path})
    plan = dict(plan_id=SAMPLES["guard"]["command_id"], plan_fingerprint="a" * 64, backup_attestation_id=None)
    assert wire.RemoteSchemaExecuteRequestV1(**context, **plan)
    with pytest.raises(ValidationError):
        wire.RemoteSchemaExecuteRequestV1(**context, plan_id=plan["plan_id"], plan_fingerprint=plan["plan_fingerprint"])
    assert wire.RemoteStorageReconnectV1(storage_generation=SAMPLES["guard"]["storage_generation"], observed_revision="0")
