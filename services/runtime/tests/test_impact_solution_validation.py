"""Immutable, independently isolated solution validation for P5.5-005."""

from copy import deepcopy
from pathlib import Path

from services.runtime.stt_runtime.impact.context import ImpactResolutionContextBuilder
from services.runtime.stt_runtime.impact.coordinator import ImpactResolutionValidationInput
from services.runtime.stt_runtime.impact.resolution_agent import ImpactResolutionAgentResponse
from services.runtime.stt_runtime.impact.solution_validation import ImpactSolutionValidator
from services.runtime.stt_runtime.project_document.patch import derive_project_patch
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.impact_resolution import (
    ImpactResolutionExplanation,
    ImpactResolutionRequest,
)
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)
from services.runtime.stt_runtime.schemas.project_patch import ProjectPatch
from services.runtime.tests.test_impact_resolution_context import _completed_run

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"


def test_valid_patch_has_runtime_identity_and_deterministic_comparison(
    tmp_path: Path,
) -> None:
    document, context, source = _source(tmp_path)
    patch = _node_patch(document, context)
    before = deepcopy(document.model_dump(mode="json"))
    response = _response(context, [_alternative("valid", context, patch)])

    result = ImpactSolutionValidator().validate(response, context, source)

    assert document.model_dump(mode="json") == before
    assert result.diagnostics == ()
    assert len(result.alternatives) == 1
    alternative = result.alternatives[0]
    assert alternative.validation.status == "valid"
    assert alternative.semantic_fingerprint
    assert alternative.patch == patch
    assert alternative.comparison is not None
    assert alternative.comparison.source_checksum == document.checksum
    assert alternative.comparison.target_checksum == patch.target_checksum
    assert alternative.comparison.impact_before == source.impact_before
    assert alternative.comparison.dependencies.changed >= 0
    assert alternative.comparison.canon_facts.changed >= 0
    assert len(result.visual_projections) == 1
    assert result.visual_projections[0].alternative_fingerprint == alternative.semantic_fingerprint
    assert result.visual_projections[0].target_checksum == patch.target_checksum


def test_one_invalid_alternative_does_not_discard_valid_or_reviewable_results(
    tmp_path: Path,
) -> None:
    document, context, source = _source(tmp_path)
    valid_patch = _node_patch(document, context)
    invalid_target = ProjectPatch(
        **{
            **valid_patch.model_dump(mode="python"),
            "patch_id": "invalid-target",
            "target_checksum": "f" * 64,
        }
    )
    malformed = _alternative("malformed", context, None)
    malformed["patch"] = {"patch_version": 1, "op": "delete_everything"}
    response = _response(context, [
        _alternative("valid", context, valid_patch),
        malformed,
        _alternative("invalid-candidate", context, invalid_target),
    ])

    result = ImpactSolutionValidator().validate(response, context, source)

    assert [item.id for item in result.alternatives] == ["valid", "invalid-candidate"]
    assert result.alternatives[0].validation.status == "valid"
    assert result.alternatives[1].validation.status == "invalid"
    assert result.alternatives[1].comparison is None
    assert len(result.visual_projections) == 1
    assert result.alternatives[1].validation.diagnostics[0].code == (
        "impact_resolution_patch_invalid"
    )
    assert result.diagnostics[0].parameters["alternative_id"] == "malformed"


def test_duplicate_stale_foreign_and_out_of_scope_solutions_are_discarded(
    tmp_path: Path,
) -> None:
    document, context, source = _source(tmp_path)
    patch = _node_patch(document, context)
    stale = ProjectPatch(
        **{
            **patch.model_dump(mode="python"),
            "patch_id": "stale",
            "source_checksum": "b" * 64,
        }
    )
    foreign = ProjectPatch(
        **{
            **patch.model_dump(mode="python"),
            "patch_id": "foreign",
            "project_id": "other-project",
        }
    )
    out_of_scope = _alternative("out-of-scope", context, None)
    out_of_scope["finding_ids"] = ["c" * 64]
    response = _response(context, [
        _alternative("first", context, patch),
        _alternative("duplicate", context, patch),
        _alternative("stale", context, stale),
    ])

    result = ImpactSolutionValidator().validate(response, context, source)

    assert [item.id for item in result.alternatives] == ["first"]
    assert {item.code for item in result.diagnostics} == {
        "impact_resolution_response_invalid",
        "impact_resolution_patch_stale",
    }
    assert any(
        item.parameters.get("reason") == "duplicate_solution"
        for item in result.diagnostics
    )
    stale_result = ImpactSolutionValidator().validate(
        _response(context, [
            _alternative("stale", context, stale),
            _alternative("foreign", context, foreign),
            out_of_scope,
        ]),
        context,
        source,
    )
    assert stale_result.alternatives == ()
    assert {item.code for item in stale_result.diagnostics} == {
        "impact_resolution_patch_stale",
        "impact_resolution_patch_invalid",
        "impact_resolution_finding_invalid",
    }


def test_redundant_hidden_operation_is_retained_only_as_invalid_review(
    tmp_path: Path,
) -> None:
    document, context, source = _source(tmp_path)
    patch = _node_patch(document, context)
    changed_id = patch.operations[0].record_id
    context_node_ids = {
        item.resource.owner_id
        for item in context.resources
        if item.resource.owner_type == "node"
    }
    redundant = next(
        node
        for node in document.nodes
        if node.id in context_node_ids and node.id != changed_id
    )
    operations = [
        *patch.model_dump(mode="python")["operations"],
        {
            "op": "put_record",
            "collection": "nodes",
            "record_id": redundant.id,
            "record": redundant.model_dump(mode="json"),
        },
    ]
    operations.sort(key=lambda item: item["record_id"])
    hidden = ProjectPatch(
        patch_id="hidden-operation",
        project_id=patch.project_id,
        source_checksum=patch.source_checksum,
        target_checksum=patch.target_checksum,
        operations=operations,
    )

    result = ImpactSolutionValidator().validate(
        _response(context, [_alternative("hidden", context, hidden)]),
        context,
        source,
    )

    assert result.diagnostics == ()
    assert result.alternatives[0].validation.status == "invalid"
    diagnostic = result.alternatives[0].validation.diagnostics[0]
    assert diagnostic.code == "impact_resolution_patch_invalid"
    assert diagnostic.parameters["reason"] == "hidden_or_redundant_operation"


def test_explanation_only_solution_remains_useful_without_patch(tmp_path: Path) -> None:
    _, context, source = _source(tmp_path)

    result = ImpactSolutionValidator().validate(
        _response(context, [_alternative("manual", context, None)]),
        context,
        source,
    )

    alternative = result.alternatives[0]
    assert alternative.validation.status == "explanation_only"
    assert alternative.patch is None
    assert alternative.semantic_fingerprint is None
    assert alternative.comparison is None
    assert result.visual_projections == ()


def test_new_canvas_resource_without_explicit_placement_is_not_actionable(
    tmp_path: Path,
) -> None:
    document, context, source = _source(tmp_path)
    payload = document.model_dump(mode="python", exclude={"checksum"})
    created = {
        **payload["nodes"][0],
        "id": "agent-created-node",
        "title": "Agent-created node",
    }
    payload["nodes"].append(created)
    payload["nodes"].sort(key=lambda item: item["id"])
    candidate = create_project_document(**payload)
    patch = derive_project_patch(document, candidate)

    result = ImpactSolutionValidator().validate(
        _response(context, [_alternative("missing-placement", context, patch)]),
        context,
        source,
    )

    assert result.visual_projections == ()
    assert result.alternatives[0].validation.status == "invalid"
    diagnostic = result.alternatives[0].validation.diagnostics[0]
    assert diagnostic.code == "impact_resolution_visual_diff_invalid"
    assert "explicit placement" in diagnostic.parameters["reason"]


def test_project_administration_and_unrelated_existing_records_are_unsupported(
    tmp_path: Path,
) -> None:
    document, context, source = _source(tmp_path)
    valid = _node_patch(document, context)
    administration = ProjectPatch(
        patch_id="administration",
        project_id=valid.project_id,
        source_checksum=valid.source_checksum,
        target_checksum=valid.target_checksum,
        operations=[
            {"op": "replace_project_metadata", "value": document.project_metadata},
            *valid.model_dump(mode="python")["operations"],
        ],
    )
    context_ids = {
        item.resource.owner_id
        for item in context.resources
        if item.resource.owner_type == "node"
    }
    unrelated = next(node for node in document.nodes if node.id not in context_ids)
    unrelated_operations = [
        *valid.model_dump(mode="python")["operations"],
        {
            "op": "put_record",
            "collection": "nodes",
            "record_id": unrelated.id,
            "record": unrelated.model_dump(mode="json"),
        },
    ]
    unrelated_operations.sort(key=lambda item: item["record_id"])
    hidden = ProjectPatch(
        patch_id="unrelated",
        project_id=valid.project_id,
        source_checksum=valid.source_checksum,
        target_checksum=valid.target_checksum,
        operations=unrelated_operations,
    )

    result = ImpactSolutionValidator().validate(
        _response(context, [
            _alternative("administration", context, administration),
            _alternative("unrelated", context, hidden),
        ]),
        context,
        source,
    )

    assert [item.validation.status for item in result.alternatives] == [
        "invalid",
        "invalid",
    ]
    assert {
        item.validation.diagnostics[0].parameters["reason"]
        for item in result.alternatives
    } == {"project_administration", "unrelated_existing_record"}
    assert all(
        item.validation.diagnostics[0].code
        == "impact_resolution_operation_unsupported"
        for item in result.alternatives
    )


def _source(
    tmp_path: Path,
) -> tuple[ProjectDocument, object, ImpactResolutionValidationInput]:
    project_path = tmp_path / "Aurora.narrative"
    document = import_project_fixture(FIXTURE, project_path).document
    captured, run = _completed_run(document)
    selected = tuple(run.findings[:3])
    request = ImpactResolutionRequest(
        impact_run_id=run.id,
        finding_ids=[item.id for item in selected],
        source_checksum=document.checksum,
        provider_source="project_default",
        model_id="structured-model",
        content_consent=True,
    )
    context = ImpactResolutionContextBuilder().build(captured, run, request)
    return document, context, ImpactResolutionValidationInput(
        document=document,
        analysis_request=captured.request,
        impact_before=run.summary,
    )


def _node_patch(document: ProjectDocument, context) -> ProjectPatch:
    context_node_ids = {
        item.resource.owner_id
        for item in context.resources
        if item.resource.owner_type == "node"
    }
    selected_id = next(node.id for node in document.nodes if node.id in context_node_ids)
    payload = document.model_dump(mode="python", exclude={"checksum"})
    payload["nodes"] = [
        node.model_copy(update={
            "summary": "A clarified opening beat for the reviewed alternative.",
            "body": "A clarified opening beat for the reviewed alternative.",
        }) if node.id == selected_id else node
        for node in document.nodes
    ]
    candidate = create_project_document(**payload)
    return derive_project_patch(document, candidate)


def _response(context, alternatives: list[dict]) -> ImpactResolutionAgentResponse:
    return ImpactResolutionAgentResponse(
        explanation=ImpactResolutionExplanation(summary="Review these bounded alternatives."),
        alternatives=alternatives,
    )


def _alternative(
    alternative_id: str,
    context,
    patch: ProjectPatch | None,
) -> dict:
    return {
        "id": alternative_id,
        "finding_ids": list(context.request.finding_ids),
        "title": f"Alternative {alternative_id}",
        "rationale": "This option addresses only the selected deterministic findings.",
        "tradeoffs": ["Authored content changes after explicit approval."],
        "expected_outcomes": ["The candidate remains structurally valid."],
        "patch": None if patch is None else patch.model_dump(mode="json"),
    }
