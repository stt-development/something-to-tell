"""Unit coverage for the runtime-owned Phase 5.5 transport contracts."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.canon_check import CanonOwnerRef
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactDependency,
    ImpactFinding,
    ImpactPath,
    ImpactSeed,
    ImpactSummary,
    impact_finding_fingerprint,
)
from services.runtime.stt_runtime.schemas.impact_resolution import (
    IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES,
    IMPACT_RESOLUTION_MAX_ALTERNATIVES,
    IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
    IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
    IMPACT_RESOLUTION_MAX_FINDINGS,
    IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
    IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
    ImpactResolutionComparison,
    ImpactResolutionContextPackage,
    ImpactResolutionContextResource,
    ImpactResolutionDecision,
    ImpactResolutionExplanation,
    ImpactResolutionLimits,
    ImpactResolutionRequest,
    ImpactResolutionRun,
    ImpactSolutionAlternative,
    ImpactSolutionValidation,
    ImpactVisualChange,
    ImpactVisualDiffProjection,
    ImpactVisualFieldChange,
    impact_solution_fingerprint,
    impact_visual_change_fingerprint,
)
from services.runtime.stt_runtime.schemas.project_patch import ProjectPatch

NOW = datetime(2026, 8, 29, 10, 0, tzinfo=UTC)
SOURCE = "a" * 64
TARGET = "b" * 64


def _owner(owner_id: str) -> CanonOwnerRef:
    return CanonOwnerRef(owner_type="node", owner_id=owner_id)


def _finding() -> ImpactFinding:
    seed = ImpactSeed(resource=_owner("source"))
    target = _owner("target")
    dependency = ImpactDependency(
        source=seed.resource,
        target=target,
        domain="flow",
        kind="flow.sequence",
        propagation="required",
        message_key="impact.dependency.flow",
    )
    path = ImpactPath(
        direction="downstream",
        propagation="required",
        resources=[seed.resource, target],
        dependencies=[dependency],
    )
    return ImpactFinding(
        id=impact_finding_fingerprint(
            seeds=[seed], target=target, domain="flow", direction="downstream"
        ),
        seeds=[seed],
        target=target,
        domain="flow",
        direction="downstream",
        impact_type="execution",
        propagation="required",
        distance=1,
        message_key="impact.finding",
        paths=[path],
    )


def _request(finding: ImpactFinding | None = None, **overrides: object) -> ImpactResolutionRequest:
    selected = finding or _finding()
    return ImpactResolutionRequest.model_validate(
        {
            "impact_run_id": "impact-run",
            "finding_ids": [selected.id],
            "source_checksum": SOURCE,
            "provider_source": "project_default",
            "model_id": "provider-model",
            "content_consent": True,
            **overrides,
        }
    )


def _patch(patch_id: str = "solution") -> ProjectPatch:
    return ProjectPatch(
        patch_id=patch_id,
        project_id="project",
        source_checksum=SOURCE,
        target_checksum=TARGET,
        operations=[{"op": "remove_record", "collection": "nodes", "record_id": "target"}],
    )


def _comparison() -> ImpactResolutionComparison:
    return ImpactResolutionComparison(
        source_checksum=SOURCE,
        target_checksum=TARGET,
        impact_before=ImpactSummary(),
        impact_after=ImpactSummary(),
        dependencies={"removed": 1},
    )


def _alternative(finding: ImpactFinding | None = None) -> ImpactSolutionAlternative:
    selected = finding or _finding()
    patch = _patch()
    return ImpactSolutionAlternative(
        id="minimal-fix",
        finding_ids=[selected.id],
        semantic_fingerprint=impact_solution_fingerprint([selected.id], patch),
        title="Remove the obsolete target",
        rationale="The transition no longer has an executable destination.",
        tradeoffs=["The old branch disappears."],
        expected_outcomes=["The invalid dependency is removed."],
        patch=patch,
        validation=ImpactSolutionValidation(status="valid"),
        comparison=_comparison(),
    )


def _validation_type(factory: object) -> str:
    with pytest.raises(ValidationError) as captured:
        assert callable(factory)
        factory()
    return captured.value.errors()[0]["type"]


def test_versions_defaults_and_limits_are_bounded() -> None:
    limits = ImpactResolutionLimits()

    assert limits.model_dump() == {
        "limits_version": 1,
        "max_findings": IMPACT_RESOLUTION_MAX_FINDINGS,
        "max_context_resources": IMPACT_RESOLUTION_MAX_CONTEXT_RESOURCES,
        "max_context_characters": IMPACT_RESOLUTION_MAX_CONTEXT_CHARACTERS,
        "max_patch_operations": IMPACT_RESOLUTION_MAX_PATCH_OPERATIONS,
        "max_visual_changes": IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
    }
    assert IMPACT_RESOLUTION_DEFAULT_ALTERNATIVES == IMPACT_RESOLUTION_MAX_ALTERNATIVES == 3
    assert _validation_type(lambda: ImpactResolutionLimits(max_findings=0)) == (
        "impact_resolution_limit_invalid"
    )


def test_request_requires_consent_and_consistent_provider_selection() -> None:
    assert _request().requested_alternative_count == 3
    assert _validation_type(lambda: _request(content_consent=False)) == (
        "impact_resolution_consent_required"
    )
    assert _validation_type(lambda: _request(requested_alternative_count=4)) == (
        "impact_resolution_limit_invalid"
    )
    assert _validation_type(
        lambda: _request(provider_source="override", provider_profile_id=None)
    ) == "impact_resolution_provider_invalid"
    assert _validation_type(
        lambda: _request(provider_profile_id="unexpected-default-profile")
    ) == "impact_resolution_provider_invalid"


def test_context_is_minimal_ordered_and_checksum_bound() -> None:
    finding = _finding()
    request = _request(finding)
    resources = [
        ImpactResolutionContextResource(
            resource=_owner("target"), domain="flow", authored_fields={"title": "Target"}
        ),
        ImpactResolutionContextResource(
            resource=_owner("source"), domain="graph", authored_fields={"title": "Source"}
        ),
    ]
    before = deepcopy(resources)
    context = ImpactResolutionContextPackage(
        project_id="project",
        saved_revision=4,
        history_revision=2,
        source_checksum=SOURCE,
        approved_memory={"agent_id": "impact_resolver", "content_locale": "en"},
        request=request,
        findings=[finding],
        resources=resources,
    )

    assert context.request.finding_ids == (finding.id,)
    assert resources == before
    assert "document" not in context.model_dump()
    assert _validation_type(
        lambda: ImpactResolutionContextPackage(
            project_id="project",
            saved_revision=4,
            history_revision=2,
            source_checksum=TARGET,
            approved_memory={"agent_id": "impact_resolver", "content_locale": "en"},
            request=request,
            findings=[finding],
            resources=[],
        )
    ) == "impact_resolution_run_stale"
    assert _validation_type(
        lambda: ImpactResolutionContextPackage(
            project_id="project",
            saved_revision=4,
            history_revision=2,
            source_checksum=SOURCE,
            approved_memory={"agent_id": "impact_resolver", "content_locale": "en"},
            request=request,
            findings=[finding],
            resources=[resources[0], resources[0]],
        )
    ) == "impact_resolution_owner_invalid"


def test_explanation_bounds_and_normalizes_evidence() -> None:
    explanation = ImpactResolutionExplanation(
        summary="A required destination is missing.",
        why_it_matters=["Playback cannot continue."],
        assumptions=["The branch should remain executable."],
        limitations=["No stylistic judgment was requested."],
    )

    assert explanation.explanation_version == 1
    with pytest.raises(ValidationError):
        ImpactResolutionExplanation(summary="x" * 4_001)


def test_solution_fingerprint_excludes_provider_wording_and_patch_id() -> None:
    finding = _finding()
    first = _patch("provider-label-one")
    second = _patch("provider-label-two")

    assert impact_solution_fingerprint([finding.id], first) == impact_solution_fingerprint(
        [finding.id], second
    )
    alternative = _alternative(finding)
    changed_wording = alternative.model_copy(
        update={"title": "A different localized title", "rationale": "Different prose."}
    )
    assert changed_wording.semantic_fingerprint == alternative.semantic_fingerprint


def test_actionable_alternative_requires_exact_validated_patch_comparison() -> None:
    finding = _finding()
    patch = _patch()
    fingerprint = impact_solution_fingerprint([finding.id], patch)

    assert _alternative(finding).validation.status == "valid"
    assert _validation_type(
        lambda: ImpactSolutionAlternative(
            id="wrong-fingerprint",
            finding_ids=[finding.id],
            semantic_fingerprint="f" * 64,
            title="Invalid",
            rationale="Invalid fingerprint.",
            patch=patch,
            validation={"status": "pending"},
        )
    ) == "impact_resolution_patch_invalid"
    assert _validation_type(
        lambda: ImpactSolutionAlternative(
            id="missing-comparison",
            finding_ids=[finding.id],
            semantic_fingerprint=fingerprint,
            title="Missing comparison",
            rationale="A valid patch must include deterministic comparison.",
            patch=patch,
            validation={"status": "valid"},
        )
    ) == "impact_resolution_patch_invalid"
    no_op = ProjectPatch(
        patch_id="no-op",
        project_id="project",
        source_checksum=SOURCE,
        target_checksum=SOURCE,
        operations=[],
    )
    assert _validation_type(
        lambda: ImpactSolutionAlternative(
            id="no-op",
            finding_ids=[finding.id],
            semantic_fingerprint=impact_solution_fingerprint([finding.id], no_op),
            title="No operation",
            rationale="This cannot resolve anything.",
            patch=no_op,
            validation={"status": "pending"},
        )
    ) == "impact_resolution_patch_invalid"


def test_explanation_only_alternative_cannot_smuggle_patch_state() -> None:
    finding = _finding()
    alternative = ImpactSolutionAlternative(
        id="explain-only",
        finding_ids=[finding.id],
        title="Manual review",
        rationale="No safe automatic patch is available.",
        validation={"status": "explanation_only"},
    )

    assert alternative.patch is None
    assert alternative.semantic_fingerprint is None
    with pytest.raises(ValidationError):
        ImpactSolutionAlternative.model_validate(
            {**alternative.model_dump(), "provider_payload": {"secret": "value"}}
        )


def test_visual_changes_enforce_shape_identity_and_stable_order() -> None:
    added_owner = _owner("added")
    removed_owner = _owner("removed")
    added = ImpactVisualChange(
        id=impact_visual_change_fingerprint(
            kind="add", surface="graph", before_resource=None, after_resource=added_owner
        ),
        kind="add",
        surface="graph",
        after_resource=added_owner,
        after_placement={"x": 10, "y": 20, "width": 240, "height": 140, "preview_only": False},
    )
    removed = ImpactVisualChange(
        id=impact_visual_change_fingerprint(
            kind="remove", surface="graph", before_resource=removed_owner, after_resource=None
        ),
        kind="remove",
        surface="graph",
        before_resource=removed_owner,
    )
    inputs = [removed, added]
    before = deepcopy(inputs)
    projection = ImpactVisualDiffProjection(
        alternative_fingerprint="c" * 64,
        source_checksum=SOURCE,
        target_checksum=TARGET,
        changes=inputs,
    )

    assert [item.kind for item in projection.changes] == ["add", "remove"]
    assert inputs == before
    assert _validation_type(
        lambda: ImpactVisualChange(
            id="d" * 64,
            kind="add",
            surface="graph",
            before_resource=_owner("unexpected"),
            after_resource=added_owner,
        )
    ) == "impact_resolution_visual_diff_invalid"


def test_modify_and_move_visual_changes_require_explicit_differences() -> None:
    owner = _owner("target")
    field = ImpactVisualFieldChange(path="title", before="Old", after="New")
    modified = ImpactVisualChange(
        id=impact_visual_change_fingerprint(
            kind="modify",
            surface="graph",
            before_resource=owner,
            after_resource=owner,
            field_paths=["title"],
        ),
        kind="modify",
        surface="graph",
        before_resource=owner,
        after_resource=owner,
        field_changes=[field],
    )

    assert modified.field_changes[0].path == "title"
    assert _validation_type(
        lambda: ImpactVisualChange(
            id=impact_visual_change_fingerprint(
                kind="move", surface="flow", before_resource=owner, after_resource=owner
            ),
            kind="move",
            surface="flow",
            before_resource=owner,
            after_resource=owner,
        )
    ) == "impact_resolution_visual_diff_invalid"
    assert _validation_type(
        lambda: ImpactVisualFieldChange(path="title", before="Same", after="Same")
    ) == "impact_resolution_visual_diff_invalid"


def test_run_lifecycle_allows_stale_read_only_output_but_bounds_scope() -> None:
    finding = _finding()
    request = _request(finding, requested_alternative_count=1)
    alternative = _alternative(finding)
    explanation = ImpactResolutionExplanation(summary="The branch is affected.")
    stale = ImpactResolutionRun(
        id="resolution-run",
        project_id="project",
        saved_revision=4,
        history_revision=2,
        source_checksum=SOURCE,
        request=request,
        status="stale",
        explanation=explanation,
        alternatives=[alternative],
        visual_projections=[ImpactVisualDiffProjection(
            alternative_fingerprint=alternative.semantic_fingerprint,
            source_checksum=SOURCE,
            target_checksum=TARGET,
            changes=[ImpactVisualChange(
                id=impact_visual_change_fingerprint(
                    kind="modify",
                    surface="graph",
                    before_resource=_owner("target"),
                    after_resource=_owner("target"),
                    field_paths=["title"],
                ),
                kind="modify",
                surface="graph",
                before_resource=_owner("target"),
                after_resource=_owner("target"),
                field_changes=[{"path": "title", "before": "Old", "after": "New"}],
            )],
        )],
        started_at=NOW,
        completed_at=NOW + timedelta(seconds=1),
    )

    assert stale.alternatives[0].semantic_fingerprint == alternative.semantic_fingerprint
    assert stale.visual_projections[0].alternative_fingerprint == alternative.semantic_fingerprint
    with pytest.raises(ValidationError, match="only completed or stale"):
        ImpactResolutionRun(**{**stale.model_dump(), "status": "failed"})
    with pytest.raises(ValidationError, match="terminal states"):
        ImpactResolutionRun(**{**stale.model_dump(), "status": "running"})


def test_decision_contract_cannot_persist_provider_content() -> None:
    finding = _finding()
    alternative = _alternative(finding)
    decision = ImpactResolutionDecision(
        finding_fingerprints=[finding.id],
        proposal_semantic_fingerprint=alternative.semantic_fingerprint,
        source_checksum=SOURCE,
        decision="rejected",
        decided_at=NOW,
    )

    assert set(decision.model_dump()) == {
        "decision_version",
        "finding_fingerprints",
        "proposal_semantic_fingerprint",
        "source_checksum",
        "decision",
        "decided_at",
    }
    with pytest.raises(ValidationError):
        ImpactResolutionDecision.model_validate(
            {**decision.model_dump(), "provider_explanation": "must not persist"}
        )
