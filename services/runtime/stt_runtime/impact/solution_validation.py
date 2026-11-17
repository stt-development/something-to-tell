"""Independent validation of untrusted Impact solution alternatives."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Annotated, Any, Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..canon.projection import CanonFactProjector
from ..project_document.patch import (
    ProjectPatchError,
    apply_project_patch,
    derive_project_patch,
)
from ..schemas.impact_analysis import PatchImpactScenario
from ..schemas.impact_resolution import (
    ImpactResolutionComparison,
    ImpactResolutionContextPackage,
    ImpactResolutionDeltaCounts,
    ImpactResolutionDiagnostic,
    ImpactResolutionErrorCode,
    ImpactVisualDiffProjection,
    ImpactSolutionAlternative,
    ImpactSolutionValidation,
    impact_solution_fingerprint,
)
from ..schemas.project_document import ProjectDocument
from ..schemas.project_patch import (
    PutProjectRecordOperation,
    RemoveProjectRecordOperation,
    ProjectPatch,
    ReplaceManifestOperation,
    ReplaceProjectMetadataOperation,
    project_record_id,
)
from .comparison import (
    ImpactPatchComparator,
    ImpactPatchComparisonError,
    ImpactPatchComparisonResult,
)
from .coordinator import ImpactResolutionValidationInput
from .projection import ProjectDependencyProjector
from .resolution_agent import ImpactResolutionAgentResponse
from .traversal import ImpactDependencyTraversal
from .visual_projection import ImpactVisualPatchProjector, ImpactVisualProjectionError


class ImpactSolutionValidationCancelled(RuntimeError):
    """Internal cooperative cancellation between independently validated patches."""


class _ProviderAlternative(BaseModel):
    """Prose is bounded here; every patch field remains untrusted until validated."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str = Field(min_length=1, max_length=128)
    finding_ids: tuple[str, ...] = Field(min_length=1, max_length=50)
    title: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=1, max_length=4_000)
    tradeoffs: tuple[
        Annotated[str, Field(min_length=1, max_length=2_000)], ...
    ] = Field(default=(), max_length=20)
    expected_outcomes: tuple[
        Annotated[str, Field(min_length=1, max_length=2_000)], ...
    ] = Field(default=(), max_length=20)
    patch: dict[str, Any] | None = None


@dataclass(frozen=True)
class ImpactSolutionValidationResult:
    """Validated alternatives plus diagnostics for independently discarded entries."""

    alternatives: tuple[ImpactSolutionAlternative, ...]
    visual_projections: tuple[ImpactVisualDiffProjection, ...]
    diagnostics: tuple[ImpactResolutionDiagnostic, ...]


class ImpactSolutionValidator:
    """Apply, canonicalize, and compare each provider alternative in isolation."""

    def __init__(
        self,
        *,
        comparator: ImpactPatchComparator | None = None,
        fact_projector: CanonFactProjector | None = None,
        dependency_projector: ProjectDependencyProjector | None = None,
        traversal: ImpactDependencyTraversal | None = None,
        visual_projector: ImpactVisualPatchProjector | None = None,
    ) -> None:
        self._comparator = comparator or ImpactPatchComparator()
        self._fact_projector = fact_projector or CanonFactProjector()
        self._dependency_projector = dependency_projector or ProjectDependencyProjector()
        self._traversal = traversal or ImpactDependencyTraversal()
        self._visual_projector = visual_projector or ImpactVisualPatchProjector()

    def validate(
        self,
        response: ImpactResolutionAgentResponse,
        context: ImpactResolutionContextPackage,
        source: ImpactResolutionValidationInput,
        *,
        is_cancelled: Callable[[], bool] = lambda: False,
    ) -> ImpactSolutionValidationResult:
        alternatives: list[ImpactSolutionAlternative] = []
        visual_projections: list[ImpactVisualDiffProjection] = []
        diagnostics: list[ImpactResolutionDiagnostic] = []
        ids: set[str] = set()
        fingerprints: set[str] = set()
        requested = context.request.requested_alternative_count
        raw_alternatives = response.alternatives[:requested]
        if len(response.alternatives) > requested:
            diagnostics.append(_diagnostic(
                "impact_resolution_limit_invalid",
                {"field": "alternatives", "maximum": requested},
            ))

        for index, raw in enumerate(raw_alternatives):
            if is_cancelled():
                raise ImpactSolutionValidationCancelled()
            try:
                proposed = _ProviderAlternative.model_validate(raw)
            except ValidationError:
                diagnostics.append(_diagnostic(
                    "impact_resolution_response_invalid",
                    {"alternative_index": index},
                ))
                continue
            if proposed.id in ids:
                diagnostics.append(_diagnostic(
                    "impact_resolution_response_invalid",
                    {"alternative_id": proposed.id, "reason": "duplicate_id"},
                ))
                continue
            ids.add(proposed.id)
            finding_ids = set(proposed.finding_ids)
            if (
                len(finding_ids) != len(proposed.finding_ids)
                or any(not _is_fingerprint(item) for item in proposed.finding_ids)
                or not finding_ids <= set(context.request.finding_ids)
            ):
                diagnostics.append(_diagnostic(
                    "impact_resolution_finding_invalid",
                    {"alternative_id": proposed.id},
                ))
                continue
            if proposed.patch is None:
                alternatives.append(_explanation_only(proposed))
                continue
            try:
                patch = ProjectPatch.model_validate(proposed.patch)
            except ValidationError:
                diagnostics.append(_diagnostic(
                    "impact_resolution_patch_invalid",
                    {"alternative_id": proposed.id, "reason": "contract"},
                ))
                continue
            if patch.project_id != source.document.manifest.project_id:
                diagnostics.append(_diagnostic(
                    "impact_resolution_patch_invalid",
                    {"alternative_id": proposed.id, "reason": "project_id"},
                ))
                continue
            if patch.source_checksum != source.document.checksum:
                diagnostics.append(_diagnostic(
                    "impact_resolution_patch_stale",
                    {"alternative_id": proposed.id},
                ))
                continue
            if len(patch.operations) > context.request.limits.max_patch_operations:
                diagnostics.append(_diagnostic(
                    "impact_resolution_limit_invalid",
                    {"alternative_id": proposed.id, "field": "patch_operations"},
                ))
                continue

            fingerprint = impact_solution_fingerprint(proposed.finding_ids, patch)
            if fingerprint in fingerprints:
                diagnostics.append(_diagnostic(
                    "impact_resolution_response_invalid",
                    {"alternative_id": proposed.id, "reason": "duplicate_solution"},
                ))
                continue
            fingerprints.add(fingerprint)
            scope_error = _operation_scope_error(source.document, context, patch)
            if scope_error is not None:
                alternatives.append(_invalid_alternative(
                    proposed,
                    patch,
                    fingerprint,
                    "impact_resolution_operation_unsupported",
                    scope_error,
                ))
                continue
            try:
                candidate = apply_project_patch(source.document, patch)
                canonical = derive_project_patch(source.document, candidate)
                if canonical.operations != patch.operations:
                    alternatives.append(_invalid_alternative(
                        proposed,
                        patch,
                        fingerprint,
                        "impact_resolution_patch_invalid",
                        "hidden_or_redundant_operation",
                    ))
                    continue
                comparison_result = self._comparator.compare(source.document, patch)
                if is_cancelled():
                    raise ImpactSolutionValidationCancelled()
                comparison = self._comparison(
                    source,
                    candidate,
                    comparison_result,
                    is_cancelled,
                )
            except (ProjectPatchError, ImpactPatchComparisonError, ValueError):
                alternatives.append(_invalid_alternative(
                    proposed,
                    patch,
                    fingerprint,
                    "impact_resolution_patch_invalid",
                    "candidate_validation",
                ))
                continue
            try:
                visual_projection = self._visual_projector.project(
                    source.document,
                    candidate,
                    alternative_fingerprint=fingerprint,
                    max_changes=context.request.limits.max_visual_changes,
                )
            except (ImpactVisualProjectionError, ValidationError) as error:
                alternatives.append(_invalid_alternative(
                    proposed,
                    patch,
                    fingerprint,
                    "impact_resolution_visual_diff_invalid",
                    str(error),
                ))
                continue
            alternatives.append(ImpactSolutionAlternative(
                id=proposed.id,
                finding_ids=proposed.finding_ids,
                semantic_fingerprint=fingerprint,
                title=proposed.title,
                rationale=proposed.rationale,
                tradeoffs=proposed.tradeoffs,
                expected_outcomes=proposed.expected_outcomes,
                patch=patch,
                validation=ImpactSolutionValidation(status="valid"),
                comparison=comparison,
            ))
            visual_projections.append(visual_projection)

        return ImpactSolutionValidationResult(
            alternatives=tuple(alternatives),
            visual_projections=tuple(visual_projections),
            diagnostics=tuple(diagnostics),
        )

    def _comparison(
        self,
        source: ImpactResolutionValidationInput,
        candidate: ProjectDocument,
        result: ImpactPatchComparisonResult,
        is_cancelled: Callable[[], bool],
    ) -> ImpactResolutionComparison:
        request = source.analysis_request
        scenario = request.scenario
        seeds = result.seeds if isinstance(scenario, PatchImpactScenario) else scenario.seeds
        after = self._traversal.traverse(
            self._dependency_projector.project(candidate),
            seeds=seeds,
            direction=request.direction,
            domains=request.domains,
            limits=request.limits,
            is_cancelled=is_cancelled,
        )
        if after.cancelled:
            raise ImpactSolutionValidationCancelled()
        if is_cancelled():
            raise ImpactSolutionValidationCancelled()
        before_facts = self._fact_projector.project(source.document).facts
        after_facts = self._fact_projector.project(candidate).facts
        return ImpactResolutionComparison(
            source_checksum=result.source_checksum,
            target_checksum=result.target_checksum,
            impact_before=source.impact_before,
            impact_after=after.summary,
            dependencies=_change_counts(result.dependency_changes),
            reachability=_change_counts(result.reachability_changes),
            state_paths=_change_counts(result.state_path_changes),
            canon_facts=_fact_change_counts(before_facts, after_facts),
            affected_issue_count=len(result.affected_existing_issues),
        )


def _explanation_only(proposed: _ProviderAlternative) -> ImpactSolutionAlternative:
    return ImpactSolutionAlternative(
        id=proposed.id,
        finding_ids=proposed.finding_ids,
        title=proposed.title,
        rationale=proposed.rationale,
        tradeoffs=proposed.tradeoffs,
        expected_outcomes=proposed.expected_outcomes,
        validation=ImpactSolutionValidation(status="explanation_only"),
    )


def _invalid_alternative(
    proposed: _ProviderAlternative,
    patch: ProjectPatch,
    fingerprint: str,
    code: ImpactResolutionErrorCode,
    reason: str,
) -> ImpactSolutionAlternative:
    diagnostic = _diagnostic(code, {"alternative_id": proposed.id, "reason": reason})
    return ImpactSolutionAlternative(
        id=proposed.id,
        finding_ids=proposed.finding_ids,
        semantic_fingerprint=fingerprint,
        title=proposed.title,
        rationale=proposed.rationale,
        tradeoffs=proposed.tradeoffs,
        expected_outcomes=proposed.expected_outcomes,
        patch=patch,
        validation=ImpactSolutionValidation(status="invalid", diagnostics=[diagnostic]),
    )


def _change_counts(changes: tuple[Any, ...]) -> ImpactResolutionDeltaCounts:
    values = {"added": 0, "removed": 0, "changed": 0}
    for change in changes:
        values[change.change] += 1
    return ImpactResolutionDeltaCounts(**values)


def _fact_change_counts(before: tuple[Any, ...], after: tuple[Any, ...]) -> ImpactResolutionDeltaCounts:
    before_by_id = {_fact_identity(item): _fact_payload(item) for item in before}
    after_by_id = {_fact_identity(item): _fact_payload(item) for item in after}
    common = before_by_id.keys() & after_by_id.keys()
    return ImpactResolutionDeltaCounts(
        added=len(after_by_id.keys() - before_by_id.keys()),
        removed=len(before_by_id.keys() - after_by_id.keys()),
        changed=sum(before_by_id[key] != after_by_id[key] for key in common),
    )


def _fact_identity(fact: Any) -> tuple[Any, ...]:
    return (
        fact.code,
        fact.domain,
        fact.scope.stable_key(),
        tuple(owner.stable_key() for owner in fact.owners),
    )


def _fact_payload(fact: Any) -> str:
    return json.dumps(
        fact.model_dump(mode="json", exclude={"source_revision"}),
        sort_keys=True,
        separators=(",", ":"),
    )


def _is_fingerprint(value: str) -> bool:
    return len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def _operation_scope_error(
    source: ProjectDocument,
    context: ImpactResolutionContextPackage,
    patch: ProjectPatch,
) -> str | None:
    """Reject project administration and unrelated existing-record mutations."""

    blocked_collections = {"issues", "suggestions"}
    existing = {
        collection: {
            project_record_id(collection, record.model_dump(mode="json"))
            for record in getattr(source, collection)
        }
        for collection in {
            operation.collection
            for operation in patch.operations
            if isinstance(operation, (PutProjectRecordOperation, RemoveProjectRecordOperation))
        }
    }
    allowed = {
        (resource.resource.owner_type, resource.resource.owner_id)
        for resource in context.resources
    }
    for resource in context.resources:
        owner = resource.resource
        if owner.context_id is not None:
            allowed.add((owner.context_type or "", owner.context_id))
    owner_types = {
        "nodes": {"node"},
        "edges": {"edge"},
        "engine_tags": {"engine_tag"},
        "placements": {"placement"},
        "dialogues": {"node", "dialogue"},
        "quests": {"node", "quest"},
        "story_flows": {"flow"},
        "story_flow_nodes": {"flow_member"},
        "flow_transitions": {"flow_transition"},
        "scene_flow_boundaries": {"scene_boundary"},
        "flow_invocations": {"flow_invocation"},
        "flow_exits": {"flow_exit"},
        "flow_exit_bindings": {"flow_exit_binding"},
        "flow_initial_states": {"initial_state"},
        "narrative_effects": {"effect"},
        "narrative_effect_bindings": {"effect_binding"},
    }
    for operation in patch.operations:
        if isinstance(operation, (ReplaceManifestOperation, ReplaceProjectMetadataOperation)):
            return "project_administration"
        collection = operation.collection
        if collection in blocked_collections:
            return "runtime_owned_collection"
        if operation.record_id not in existing[collection]:
            continue
        if not any(
            (owner_type, operation.record_id) in allowed
            for owner_type in owner_types.get(collection, set())
        ):
            return "unrelated_existing_record"
    return None


def _diagnostic(
    code: ImpactResolutionErrorCode,
    parameters: dict[str, object],
) -> ImpactResolutionDiagnostic:
    return ImpactResolutionDiagnostic(
        code=code,
        message_key=f"impactResolution.error.{code}",
        parameters=parameters,
    )
