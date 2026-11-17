"""C2 memory-only lifecycle proofs with injected clocks and synchronized races."""

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from uuid import uuid4

import pytest

from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plans import SchemaPlanContext, SchemaPlanRegistry
from services.runtime.stt_runtime.schemas.remote_storage import (
    RemoteSchemaPlanRequestV1, RemoteSchemaExecuteRequestV1,
    RemoteSchemaBackupAttestationRequestV1, RemoteStorageInspectionV1,
)

PATH = "/private/author/Secret.narrative"


class Clock:
    monotonic = 100.0
    utc = datetime(2026, 10, 23, 12, tzinfo=UTC)


def context(upgrade=False):
    return SchemaPlanContext(project_id="project-a", profile_id="admin", authority_fingerprint="a" * 64,
        schema_fingerprint="b" * 64, target_schema_revision="20261022_0012", migration_revisions=("20261022_0012",),
        maintenance=False, inspection=RemoteStorageInspectionV1(server_major=17,
            schema_status="older" if upgrade else "empty", schema_revision="20261022_0011" if upgrade else None,
            tls_policy="disable", tls_active=False, identity_verified=False, privileges="administrator"))


def request(ctx):
    return RemoteSchemaPlanRequestV1(project_path=PATH, profile_id=ctx.profile_id,
        action="provision" if ctx.inspection.schema_revision is None else "upgrade",
        expected_schema_revision=ctx.inspection.schema_revision)


def claim(plan, backup=None, **overrides):
    return RemoteSchemaExecuteRequestV1(project_path=PATH, profile_id="admin", plan_id=plan.plan_id,
        plan_fingerprint=plan.plan_fingerprint, backup_attestation_id=backup).model_copy(update=overrides)


def confirmation(plan):
    return RemoteSchemaBackupAttestationRequestV1(project_path=PATH, profile_id="admin", plan_id=plan.plan_id,
        plan_fingerprint=plan.plan_fingerprint, confirmation="backup_and_restore_verified")


@pytest.fixture
def workspace():
    clock = Clock()
    owner = SchemaPlanRegistry(monotonic_clock=lambda: clock.monotonic, utc_clock=lambda: clock.utc)
    return owner, clock


def test_unique_metadata_and_private_scope_are_not_credentials_or_paths(workspace):
    owner, _ = workspace
    ctx = context()
    first, second = owner.create(request(ctx), ctx), owner.create(request(ctx), ctx)
    assert first.plan_id != second.plan_id and first.plan_fingerprint != second.plan_fingerprint
    assert first.expires_at == "2026-10-23T12:05:00Z"
    assert PATH not in repr(owner._plans) and PATH not in first.model_dump_json()
    assert owner.claim(claim(first), ctx) == first
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(first), ctx)


def test_upgrade_confirmation_is_matching_idempotent_and_never_extends_expiry(workspace):
    owner, clock = workspace
    ctx = context(upgrade=True)
    plan = owner.create(request(ctx), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_backup_required"):
        owner.claim(claim(plan), ctx)
    ack = owner.attest(confirmation(plan), ctx)
    clock.monotonic += 30
    assert owner.attest(confirmation(plan), ctx) == ack and ack.expires_at == plan.expires_at
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(plan, str(uuid4())), ctx)
    assert owner.claim(claim(plan, ack.backup_attestation_id), ctx) == plan
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.attest(confirmation(plan), ctx)


def test_attestation_cannot_be_borrowed_from_another_plan(workspace):
    owner, _ = workspace
    ctx = context(upgrade=True)
    first, second = owner.create(request(ctx), ctx), owner.create(request(ctx), ctx)
    ack = owner.attest(confirmation(first), ctx)
    owner.attest(confirmation(second), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(second, ack.backup_attestation_id), ctx)


def test_provision_does_not_accept_a_backup_confirmation(workspace):
    owner, _ = workspace
    ctx = context()
    plan = owner.create(request(ctx), ctx)
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        owner.attest(confirmation(plan), ctx)
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        owner.claim(claim(plan, str(uuid4())), ctx)
    assert owner.claim(claim(plan), ctx) == plan


def test_provision_executor_cannot_claim_an_upgrade_or_consume_its_acknowledgement(workspace):
    owner, _ = workspace
    ctx = context(upgrade=True)
    plan = owner.create(request(ctx), ctx)
    ack = owner.attest(confirmation(plan), ctx)
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        owner.claim(claim(plan, ack.backup_attestation_id), ctx, action="provision")
    assert owner.claim(claim(plan, ack.backup_attestation_id), ctx, action="upgrade") == plan


@pytest.mark.parametrize("upgrade", [False, True])
def test_execution_action_is_scoped_nonconsuming_and_expires_without_extension(workspace, upgrade):
    owner, clock = workspace
    ctx = context(upgrade=upgrade)
    plan = owner.create(request(ctx), ctx)
    for _ in range(2):
        assert owner.execution_action(claim(plan)) == ("upgrade" if upgrade else "provision")
    for overrides in ({"project_path": "/wrong.narrative"}, {"profile_id": "wrong"}, {"plan_fingerprint": "f" * 64}):
        with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
            owner.execution_action(claim(plan, **overrides))
    assert plan.plan_id in owner._plans
    clock.monotonic += 300
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.execution_action(claim(plan))
    assert plan.plan_id not in owner._plans


@pytest.mark.parametrize("elapsed,valid", [(299.999, True), (300, False)])
def test_monotonic_deadline_is_exact_even_if_wall_clock_moves_back(workspace, elapsed, valid):
    owner, clock = workspace
    ctx = context()
    plan = owner.create(request(ctx), ctx)
    clock.monotonic += elapsed
    clock.utc -= timedelta(days=1)
    if valid:
        assert owner.claim(claim(plan), ctx) == plan
    else:
        with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
            owner.claim(claim(plan), ctx)


def test_wall_clock_jump_does_not_expire_a_monotonically_valid_plan(workspace):
    owner, clock = workspace
    ctx = context(upgrade=True)
    plan = owner.create(request(ctx), ctx)
    clock.utc += timedelta(days=30)
    ack = owner.attest(confirmation(plan), ctx)
    assert owner.claim(claim(plan, ack.backup_attestation_id), ctx) == plan


@pytest.mark.parametrize("field,value,burns", [
    ("project_id", "other", True), ("profile_id", "other", False),
    ("authority_fingerprint", "c" * 64, True), ("schema_fingerprint", "d" * 64, True),
    ("target_schema_revision", "20261023_0013", True), ("migration_revisions", ("different",), True),
    ("maintenance", True, True),
    ("inspection", context().inspection.model_copy(update={"privileges": "runtime"}), True),
])
def test_changed_binding_cannot_reuse_or_revive_a_plan(workspace, field, value, burns):
    owner, _ = workspace
    ctx = context()
    plan = owner.create(request(ctx), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(plan), ctx.model_copy(update={field: value}))
    if burns:
        with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
            owner.claim(claim(plan), ctx)
    else:
        assert owner.claim(claim(plan), ctx) == plan


@pytest.mark.parametrize("override", [{"project_path": "/other.narrative"}, {"profile_id": "other"},
    {"plan_fingerprint": "f" * 64}])
def test_wrong_request_does_not_consume_legitimate_plan(workspace, override):
    owner, _ = workspace
    ctx = context()
    plan = owner.create(request(ctx), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(plan, **override), ctx)
    assert owner.claim(claim(plan), ctx) == plan


def test_capacity_is_released_on_claim_and_expiry_without_eviction():
    clock = Clock()
    owner = SchemaPlanRegistry(max_pending=1, monotonic_clock=lambda: clock.monotonic, utc_clock=lambda: clock.utc)
    ctx = context()
    plan = owner.create(request(ctx), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_limit"):
        owner.create(request(ctx), ctx)
    owner.claim(claim(plan), ctx)
    second = owner.create(request(ctx), ctx)
    clock.monotonic += 300
    third = owner.create(request(ctx), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(second), ctx)
    assert owner.claim(claim(third), ctx) == third


def test_parallel_claim_has_exactly_one_winner(workspace):
    owner, _ = workspace
    ctx = context()
    plan, barrier = owner.create(request(ctx), ctx), Barrier(2)
    def attempt():
        barrier.wait(timeout=5)
        try:
            return owner.claim(claim(plan), ctx).plan_id
        except ProjectSessionError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: attempt(), range(2)))
    assert sorted(results) == sorted([plan.plan_id, "remote_schema_plan_stale"])


def test_reset_and_new_owner_forget_pending_confirmations(workspace):
    owner, _ = workspace
    ctx = context(upgrade=True)
    plan = owner.create(request(ctx), ctx)
    ack = owner.attest(confirmation(plan), ctx)
    owner.clear_all()
    for registry in (owner, SchemaPlanRegistry()):
        with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
            registry.claim(claim(plan, ack.backup_attestation_id), ctx)


@pytest.mark.parametrize("capacity", [True, 0, 65])
def test_capacity_configuration_is_bounded(capacity):
    with pytest.raises(ValueError, match="schema_plan_capacity_invalid"):
        SchemaPlanRegistry(max_pending=capacity)


def test_late_confirmation_cannot_renew_plan_deadline(workspace):
    owner, clock = workspace
    ctx = context(upgrade=True)
    plan = owner.create(request(ctx), ctx)
    clock.monotonic += 299
    ack = owner.attest(confirmation(plan), ctx)
    assert ack.expires_at == plan.expires_at
    clock.monotonic += 1
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.claim(claim(plan, ack.backup_attestation_id), ctx)


def test_creation_rejects_maintenance_profile_and_source_drift(workspace):
    owner, _ = workspace
    ctx = context(upgrade=True)
    with pytest.raises(ProjectSessionError, match="remote_schema_busy"):
        owner.create(request(ctx), ctx.model_copy(update={"maintenance": True}))
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.create(request(ctx).model_copy(update={"profile_id": "other"}), ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_plan_stale"):
        owner.create(request(ctx).model_copy(update={"expected_schema_revision": "different"}), ctx)


def test_confirmation_must_keep_explicit_operator_acknowledgement(workspace):
    owner, _ = workspace
    ctx = context(upgrade=True)
    plan = owner.create(request(ctx), ctx)
    invalid = confirmation(plan).model_copy(update={"confirmation": "backup_only"})
    with pytest.raises(ProjectSessionError, match="remote_contract_invalid"):
        owner.attest(invalid, ctx)
    with pytest.raises(ProjectSessionError, match="remote_schema_backup_required"):
        owner.claim(claim(plan), ctx)


@pytest.mark.parametrize("override,code", [
    ({"server_major": 16}, "remote_server_version_unsupported"),
    ({"privileges": "runtime"}, "remote_admin_required"),
    ({"schema_status": "future"}, "remote_schema_future"),
    ({"schema_status": "partial"}, "remote_schema_partial"),
    ({"schema_status": "unknown"}, "remote_schema_unknown"),
    ({"schema_status": "current"}, "remote_schema_plan_stale"),
])
def test_creation_requires_an_eligible_fresh_administrative_context(workspace, override, code):
    owner, _ = workspace
    ctx = context(upgrade=True)
    changed = ctx.model_copy(update={"inspection": ctx.inspection.model_copy(update=override)})
    with pytest.raises(ProjectSessionError, match=code):
        owner.create(request(ctx), changed)
