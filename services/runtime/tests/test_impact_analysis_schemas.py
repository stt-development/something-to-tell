from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.canon_check import CanonEvidenceRef, CanonOwnerRef
from services.runtime.stt_runtime.schemas.impact_analysis import (
    IMPACT_DEFAULT_DEPTH,
    IMPACT_DEFAULT_PATHS_PER_TARGET,
    IMPACT_DEFAULT_TARGETS,
    ImpactAnalysisLimits,
    ImpactAnalysisRequest,
    ImpactAnalysisResponse,
    ImpactAnalysisRun,
    ImpactDependency,
    ImpactEvidenceRef,
    ImpactFinding,
    ImpactPath,
    ImpactResourceRef,
    ImpactSeed,
    ImpactSummary,
    impact_finding_fingerprint,
)
from services.runtime.stt_runtime.schemas.project_patch import ProjectPatch

NOW = datetime(2026, 8, 25, 10, 0, tzinfo=UTC)
CHECKSUM = "a" * 64


def _resource(owner_type: str, owner_id: str) -> ImpactResourceRef:
    return ImpactResourceRef(owner_type=owner_type, owner_id=owner_id)


def _seed(owner_id: str = "source") -> ImpactSeed:
    return ImpactSeed(resource=_resource("node", owner_id))


def _dependency(
    source: ImpactResourceRef,
    target: ImpactResourceRef,
    *,
    propagation: str = "required",
    message_key: str = "impact.dependency.en",
) -> ImpactDependency:
    return ImpactDependency(
        source=source,
        target=target,
        domain="flow",
        kind="flow.sequence",
        propagation=propagation,
        message_key=message_key,
        evidence=[
            ImpactEvidenceRef(
                owner=target,
                message_key=f"{message_key}.evidence",
            )
        ],
    )


def _path(
    seed: ImpactSeed,
    target: ImpactResourceRef,
    *,
    propagation: str = "required",
    message_key: str = "impact.dependency.en",
) -> ImpactPath:
    return ImpactPath(
        direction="downstream",
        propagation=propagation,
        resources=[seed.resource, target],
        dependencies=[
            _dependency(
                seed.resource,
                target,
                propagation=propagation,
                message_key=message_key,
            )
        ],
    )


def _request(**overrides: object) -> ImpactAnalysisRequest:
    payload = {
        "observed_saved_revision": 4,
        "expected_history_revision": 2,
        "source_checksum": CHECKSUM,
        "scenario": {
            "type": "selection",
            "intent": "modify",
            "seeds": [_seed("source")],
        },
        **overrides,
    }
    return ImpactAnalysisRequest.model_validate(payload)


def _validation_type(factory: object) -> str:
    with pytest.raises(ValidationError) as captured:
        assert callable(factory)
        factory()
    return captured.value.errors()[0]["type"]


def test_resource_and_evidence_reuse_canon_wire_contracts() -> None:
    assert ImpactResourceRef is CanonOwnerRef
    assert ImpactEvidenceRef is CanonEvidenceRef

    contextual = ImpactResourceRef(
        owner_type="dialogue_option",
        owner_id="option-1",
        context_type="dialogue",
        context_id="dialogue-1",
    )
    assert contextual.model_dump(mode="json") == {
        "owner_type": "dialogue_option",
        "owner_id": "option-1",
        "context_type": "dialogue",
        "context_id": "dialogue-1",
    }


def test_selection_request_normalizes_without_mutating_inputs() -> None:
    seeds = [_seed("b"), _seed("a"), _seed("b")]
    domains = ["canon", "graph", "flow", "graph"]
    before_seeds = deepcopy(seeds)
    before_domains = list(domains)

    request = _request(
        direction="both",
        domains=domains,
        scenario={"type": "selection", "intent": "delete", "seeds": seeds},
    )

    assert [seed.resource.owner_id for seed in request.scenario.seeds] == ["a", "b"]
    assert request.domains == ("graph", "flow", "canon")
    assert request.limits.max_depth == IMPACT_DEFAULT_DEPTH
    assert request.limits.max_paths_per_target == IMPACT_DEFAULT_PATHS_PER_TARGET
    assert request.limits.max_targets == IMPACT_DEFAULT_TARGETS
    assert seeds == before_seeds
    assert domains == before_domains


def test_finding_identity_and_order_exclude_localized_explanation_and_evidence() -> None:
    seed = _seed()
    target = _resource("node", "target")
    fingerprint = impact_finding_fingerprint(
        seeds=[seed],
        target=target,
        domain="flow",
        direction="downstream",
    )

    english = ImpactFinding(
        id=fingerprint,
        seeds=[seed],
        target=target,
        domain="flow",
        direction="downstream",
        impact_type="execution",
        propagation="required",
        distance=1,
        message_key="impact.finding.english",
        paths=[_path(seed, target, message_key="impact.dependency.english")],
    )
    russian = ImpactFinding(
        id=fingerprint,
        seeds=[seed],
        target=target,
        domain="flow",
        direction="downstream",
        impact_type="execution",
        propagation="required",
        distance=1,
        message_key="impact.finding.russian",
        paths=[_path(seed, target, message_key="impact.dependency.russian")],
    )

    assert english.id == russian.id == fingerprint
    assert english.stable_order_key() == russian.stable_order_key()


@pytest.mark.parametrize(
    ("factory", "error_type"),
    [
        (lambda: _request(direction="sideways"), "impact_direction_invalid"),
        (lambda: _request(domains=[]), "impact_domain_invalid"),
        (lambda: _request(domains=["style"]), "impact_domain_invalid"),
        (
            lambda: _dependency(_resource("node", "a"), _resource("node", "b"), propagation="maybe"),
            "impact_propagation_invalid",
        ),
        (lambda: ImpactAnalysisLimits(max_depth=0), "impact_depth_invalid"),
        (lambda: ImpactAnalysisLimits(max_paths_per_target=4), "impact_path_limit_invalid"),
        (lambda: ImpactAnalysisLimits(max_targets=501), "impact_target_limit_invalid"),
    ],
)
def test_invalid_controls_return_typed_localizable_codes(factory: object, error_type: str) -> None:
    assert _validation_type(factory) == error_type


def test_patch_scenario_rejects_a_stale_source_checksum_with_typed_code() -> None:
    patch = ProjectPatch(
        patch_id="impact-preview",
        project_id="project",
        source_checksum="b" * 64,
        target_checksum="b" * 64,
        operations=[],
    )

    assert _validation_type(
        lambda: _request(scenario={"type": "patch", "patch": patch})
    ) == "impact_patch_stale"


def test_path_rejects_disconnected_dependencies_and_weaker_classification() -> None:
    seed = _seed()
    target = _resource("node", "target")
    unrelated = _resource("node", "unrelated")

    with pytest.raises(ValidationError, match="adjacent resources"):
        ImpactPath(
            direction="downstream",
            propagation="required",
            resources=[seed.resource, target],
            dependencies=[_dependency(seed.resource, unrelated)],
        )
    with pytest.raises(ValidationError, match="strongest dependency"):
        ImpactPath(
            direction="downstream",
            propagation="contextual",
            resources=[seed.resource, target],
            dependencies=[_dependency(seed.resource, target, propagation="required")],
        )


def test_completed_run_normalizes_findings_and_requires_consistent_summary() -> None:
    seed = _seed()
    direct_target = _resource("node", "direct")
    later_target = _resource("node", "later")

    def finding(target: ImpactResourceRef, propagation: str) -> ImpactFinding:
        return ImpactFinding(
            id=impact_finding_fingerprint(
                seeds=[seed],
                target=target,
                domain="flow",
                direction="downstream",
            ),
            seeds=[seed],
            target=target,
            domain="flow",
            direction="downstream",
            impact_type="execution",
            propagation=propagation,
            distance=1,
            message_key="impact.finding",
            paths=[_path(seed, target, propagation=propagation)],
        )

    required = finding(direct_target, "required")
    contextual = finding(later_target, "contextual")
    inputs = [contextual, required]
    before = deepcopy(inputs)
    request = _request()
    run = ImpactAnalysisRun(
        id="run-1",
        project_id="project",
        saved_revision=4,
        history_revision=2,
        source_checksum=CHECKSUM,
        status="completed",
        request=request,
        findings=inputs,
        summary=ImpactSummary(
            finding_count=2,
            direct_count=2,
            propagation={"required": 1, "conditional": 0, "contextual": 1},
        ),
        started_at=NOW,
        completed_at=NOW + timedelta(seconds=1),
    )
    response = ImpactAnalysisResponse(run=run)

    assert [item.propagation for item in response.run.findings] == ["required", "contextual"]
    assert inputs == before
    with pytest.raises(ValidationError, match="summary must match"):
        ImpactAnalysisRun(**{
            **run.model_dump(),
            "summary": ImpactSummary(),
        })
    with pytest.raises(ValidationError, match="terminal run states"):
        ImpactAnalysisRun(**{
            **run.model_dump(),
            "completed_at": None,
        })
