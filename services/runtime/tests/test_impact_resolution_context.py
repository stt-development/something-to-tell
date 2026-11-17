"""P5.5-003 coverage for minimal, bounded, secret-safe Impact context."""

from copy import deepcopy
from datetime import UTC, datetime
import json
from pathlib import Path

import pytest

from services.runtime.stt_runtime.impact import (
    ImpactDependencyTraversal,
    ImpactResolutionContextBuilder,
    ProjectDependencyProjector,
)
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactAnalysisInput,
    ImpactAnalysisLimits,
    ImpactAnalysisRequest,
    ImpactAnalysisRun,
    ImpactCounts,
    ImpactSummary,
)
from services.runtime.stt_runtime.schemas.impact_resolution import (
    ImpactResolutionLimits,
    ImpactResolutionRequest,
)
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
NOW = datetime(2026, 8, 31, 10, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def aurora(tmp_path_factory: pytest.TempPathFactory) -> ProjectDocument:
    project_path = tmp_path_factory.mktemp("impact-resolution-context") / "Aurora.narrative"
    return import_project_fixture(FIXTURE, project_path).document


def test_aurora_context_follows_selected_paths_across_authoring_domains(
    aurora: ProjectDocument,
) -> None:
    captured, run = _completed_run(aurora)
    selected = _one_finding_per_domain(run)
    request = _resolution_request(run, selected)
    before = deepcopy(aurora.model_dump(mode="json"))

    first = ImpactResolutionContextBuilder().build(captured, run, request)
    repeated = ImpactResolutionContextBuilder().build(captured, run, request)

    assert first == repeated
    assert aurora.model_dump(mode="json") == before
    assert [item.memory_id for item in first.approved_memory.entries] == [
        "memory-workflow-03-impact-en"
    ]
    assert first.approved_memory.agent_id == "impact_resolver"
    assert {item.id for item in first.findings} == {item.id for item in selected}
    selected_domains = {item.domain for item in selected}
    assert selected_domains.issubset({item.domain for item in first.resources})
    assert {"graph", "flow", "dialogue", "quest"}.issubset(selected_domains)
    assert {"temporal", "playback"}.intersection(selected_domains)
    assert any(item.resource.owner_type == "dialogue_element" for item in first.resources)
    assert any(item.resource.owner_type == "quest_giver" for item in first.resources)
    playback = next(
        item for item in first.resources
        if item.resource.owner_type == "playback_definition"
    )
    assert playback.authored_fields["entry_node_id"]
    assert playback.authored_fields["member_node_ids"]
    assert first.glossary
    assert {item.kind.lower() for item in first.glossary}.issubset(
        {"character", "location", "item", "faction"}
    )


def test_context_excludes_runtime_metadata_and_secret_shaped_authored_fields(
    aurora: ProjectDocument,
) -> None:
    secret = "must-not-enter-impact-provider-context"
    nodes = [
        node.model_copy(update={
            "metadata": {
                **node.metadata,
                "api_key": secret,
                "local_path": f"/private/tmp/{secret}",
                "storage_profile": {"password": secret},
            }
        }) if node.id == "node-inspection" else node
        for node in aurora.nodes
    ]
    payload = aurora.model_dump(mode="python", exclude={"checksum"})
    payload.update({
        "nodes": nodes,
        "project_metadata": {
            **aurora.project_metadata,
            "project_path": f"/private/tmp/{secret}",
            "lock": secret,
        },
    })
    document = create_project_document(**payload)
    captured, run = _completed_run(document)
    selected = tuple(run.findings[:8])

    context = ImpactResolutionContextBuilder().build(
        captured,
        run,
        _resolution_request(run, selected),
    )
    serialized = json.dumps(context.model_dump(mode="json"), sort_keys=True)

    assert secret not in serialized
    assert "project_metadata" not in serialized
    assert "project_path" not in serialized
    assert "connection_profile_id" not in serialized
    assert "playback_session" not in serialized
    assert "playback_trace" not in serialized


def test_context_discloses_resource_truncation(
    aurora: ProjectDocument,
) -> None:
    captured, run = _completed_run(aurora)
    selected = tuple(run.findings[:12])
    request = _resolution_request(
        run,
        selected,
        limits=ImpactResolutionLimits(
            max_findings=20,
            max_context_resources=4,
            max_context_characters=120_000,
        ),
    )

    context = ImpactResolutionContextBuilder().build(captured, run, request)
    serialized = json.dumps(
        context.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    )

    assert len(context.resources) + len(context.glossary) <= 4
    assert len(serialized) <= 120_000
    assert context.omitted_resource_count > 0
    assert context.omitted_domains


def test_context_discloses_character_truncation(aurora: ProjectDocument) -> None:
    captured, run = _completed_run(aurora)
    selected = (run.findings[0],)
    complete = ImpactResolutionContextBuilder().build(
        captured,
        run,
        _resolution_request(run, selected),
    )
    complete_size = len(json.dumps(
        complete.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    ))

    context = ImpactResolutionContextBuilder().build(
        captured,
        run,
        _resolution_request(
            run,
            selected,
            limits=ImpactResolutionLimits(max_context_characters=complete_size - 500),
        ),
    )
    serialized = json.dumps(
        context.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    )

    assert len(serialized) <= complete_size - 500
    assert context.omitted_resource_count > 0
    assert context.omitted_domains


def _completed_run(
    document: ProjectDocument,
) -> tuple[ImpactAnalysisInput, ImpactAnalysisRun]:
    analysis_request = ImpactAnalysisRequest(
        observed_saved_revision=document.manifest.saved_revision,
        expected_history_revision=7,
        source_checksum=document.checksum,
        scenario={
            "type": "selection",
            "intent": "modify",
            "seeds": [
                {"resource": {"owner_type": "node", "owner_id": "node-inspection"}},
                {"resource": {"owner_type": "node", "owner_id": "node-dock-dialogue"}},
                {"resource": {"owner_type": "node", "owner_id": "node-smuggler-route"}},
                {"resource": {"owner_type": "node", "owner_id": "node-sealed-ledger"}},
            ],
        },
        direction="both",
        limits=ImpactAnalysisLimits(max_depth=3, max_targets=500),
    )
    captured = ImpactAnalysisInput(
        project_id=document.manifest.project_id,
        saved_revision=document.manifest.saved_revision,
        history_revision=7,
        source_checksum=document.checksum,
        document=document,
        request=analysis_request,
    )
    result = ImpactDependencyTraversal().traverse(
        ProjectDependencyProjector().project(document),
        seeds=analysis_request.scenario.seeds,
        direction=analysis_request.direction,
        domains=analysis_request.domains,
        limits=analysis_request.limits,
    )
    summary = _summary(result.findings)
    run = ImpactAnalysisRun(
        id="impact-context-run",
        project_id=document.manifest.project_id,
        saved_revision=document.manifest.saved_revision,
        history_revision=7,
        source_checksum=document.checksum,
        status="completed",
        request=analysis_request,
        findings=result.findings,
        summary=summary,
        started_at=NOW,
        completed_at=NOW,
    )
    return captured, run


def _one_finding_per_domain(run: ImpactAnalysisRun) -> tuple:
    selected = {}
    for finding in run.findings:
        selected.setdefault(finding.domain, finding)
    return tuple(selected[domain] for domain in sorted(selected))


def _resolution_request(
    run: ImpactAnalysisRun,
    findings: tuple,
    *,
    limits: ImpactResolutionLimits | None = None,
) -> ImpactResolutionRequest:
    return ImpactResolutionRequest(
        impact_run_id=run.id,
        finding_ids=[item.id for item in findings],
        source_checksum=run.source_checksum,
        provider_source="project_default",
        model_id="structured-model",
        content_consent=True,
        limits=limits or ImpactResolutionLimits(),
    )


def _summary(findings: tuple) -> ImpactSummary:
    propagation = {"required": 0, "conditional": 0, "contextual": 0}
    for finding in findings:
        propagation[finding.propagation] += 1
    return ImpactSummary(
        finding_count=len(findings),
        direct_count=sum(item.distance == 1 for item in findings),
        transitive_count=sum(item.distance > 1 for item in findings),
        propagation=ImpactCounts(**propagation),
    )
