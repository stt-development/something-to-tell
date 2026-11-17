"""Immutable before/after comparison for prospective ProjectPatch analysis."""

from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Literal

from pydantic import ValidationError

from ..canon.engine import CanonRuleEngine, CanonRuleEngineError
from ..canon.projection import CanonFactProjector
from ..project_document.patch import ProjectPatchError, apply_project_patch
from ..schemas.canon_check import (
    CanonIssueCandidate,
    CanonIssueMetadataV1,
    parse_canon_issue_metadata,
)
from ..schemas.impact_analysis import (
    ImpactDependency,
    ImpactDomain,
    ImpactResourceRef,
    ImpactSeed,
    SelectionImpactScenario,
)
from ..schemas.project_document import ProjectDocument, ProjectIssueRecord
from ..schemas.project_patch import (
    PROJECT_RECORD_COLLECTIONS,
    ProjectPatch,
    PutProjectRecordOperation,
    project_record_id,
)
from .index import ImpactDependencyIndex, ResourceKey
from .projection import ProjectDependencyProjector

DependencyChangeKind = Literal["added", "removed", "changed"]
IntegrityChangeKind = Literal["introduced", "resolved", "changed"]


class ImpactPatchComparisonError(ValueError):
    """Stable failure raised before a hypothetical result can be published."""

    def __init__(
        self,
        code: Literal["impact_patch_invalid", "impact_patch_stale"],
        **parameters: object,
    ) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


@dataclass(frozen=True)
class ImpactDependencyChange:
    """One dependency identity added, removed, or changed by a patch."""

    change: DependencyChangeKind
    before: ImpactDependency | None = None
    after: ImpactDependency | None = None

    def __post_init__(self) -> None:
        expected = {
            "added": (False, True),
            "removed": (True, False),
            "changed": (True, True),
        }[self.change]
        if (self.before is not None, self.after is not None) != expected:
            raise ValueError("impact dependency change has inconsistent boundaries")

    @property
    def dependency(self) -> ImpactDependency:
        value = self.after or self.before
        if value is None:  # Protected by __post_init__; retained for static narrowing.
            raise ValueError("impact dependency change has no dependency")
        return value

    def stable_key(self) -> tuple[object, ...]:
        return (
            {"removed": 0, "changed": 1, "added": 2}[self.change],
            _dependency_identity(self.dependency),
        )


@dataclass(frozen=True)
class ImpactIntegrityChange:
    """One deterministic Canon candidate introduced, resolved, or changed."""

    change: IntegrityChangeKind
    before: CanonIssueCandidate | None = None
    after: CanonIssueCandidate | None = None

    def __post_init__(self) -> None:
        expected = {
            "introduced": (False, True),
            "resolved": (True, False),
            "changed": (True, True),
        }[self.change]
        if (self.before is not None, self.after is not None) != expected:
            raise ValueError("impact integrity change has inconsistent boundaries")

    @property
    def candidate(self) -> CanonIssueCandidate:
        value = self.after or self.before
        if value is None:  # Protected by __post_init__; retained for static narrowing.
            raise ValueError("impact integrity change has no candidate")
        return value

    def stable_key(self) -> tuple[object, ...]:
        return (
            {"resolved": 0, "changed": 1, "introduced": 2}[self.change],
            self.candidate.fingerprint,
        )


@dataclass(frozen=True)
class ImpactPatchComparisonResult:
    """Storage-free comparison output; the hypothetical document is discarded."""

    project_id: str
    source_checksum: str
    target_checksum: str
    seeds: tuple[ImpactSeed, ...]
    added_resources: tuple[ImpactResourceRef, ...]
    removed_resources: tuple[ImpactResourceRef, ...]
    changed_resources: tuple[ImpactResourceRef, ...]
    dependency_changes: tuple[ImpactDependencyChange, ...]
    reachability_changes: tuple[ImpactDependencyChange, ...]
    state_path_changes: tuple[ImpactDependencyChange, ...]
    integrity_changes: tuple[ImpactIntegrityChange, ...]
    affected_existing_issues: tuple[ImpactResourceRef, ...]

    @property
    def no_op(self) -> bool:
        return not any(
            (
                self.added_resources,
                self.removed_resources,
                self.changed_resources,
                self.dependency_changes,
                self.integrity_changes,
                self.affected_existing_issues,
            )
        )


@dataclass(frozen=True)
class ImpactSelectionAssessment:
    """Concrete checks available without inventing a hypothetical field value."""

    seeds: tuple[ImpactSeed, ...]
    intent: Literal["modify", "delete"]
    structural_absences: tuple[ImpactDependency, ...] = ()

    @property
    def field_level_change_known(self) -> bool:
        return False


class ImpactSelectionInspector:
    """Identify direct delete breakage while leaving modify values unspecified."""

    def inspect(
        self,
        index: ImpactDependencyIndex,
        scenario: SelectionImpactScenario,
        *,
        domains: tuple[ImpactDomain, ...] | frozenset[ImpactDomain],
    ) -> ImpactSelectionAssessment:
        selected_domains = frozenset(domains)
        missing = [seed for seed in scenario.seeds if not index.contains(seed.resource)]
        if missing:
            raise ValueError(
                f"impact seed does not exist: {missing[0].resource.owner_type}:"
                f"{missing[0].resource.owner_id}"
            )
        structural: dict[tuple[str, ...], ImpactDependency] = {}
        if scenario.intent == "delete":
            for seed in scenario.seeds:
                for dependency in index.outgoing(seed.resource, domains=selected_domains):
                    if dependency.propagation == "required":
                        structural[dependency.stable_key()] = dependency
        return ImpactSelectionAssessment(
            seeds=scenario.seeds,
            intent=scenario.intent,
            structural_absences=tuple(structural[key] for key in sorted(structural)),
        )


class ImpactPatchComparator:
    """Compare one checksum-bound patch without changing its source document."""

    def __init__(
        self,
        *,
        dependency_projector: ProjectDependencyProjector | None = None,
        fact_projector: CanonFactProjector | None = None,
        rule_engine: CanonRuleEngine | None = None,
    ) -> None:
        self._dependency_projector = dependency_projector or ProjectDependencyProjector()
        self._fact_projector = fact_projector or CanonFactProjector()
        self._rule_engine = rule_engine or CanonRuleEngine()

    def compare(
        self,
        document: ProjectDocument,
        patch: ProjectPatch,
    ) -> ImpactPatchComparisonResult:
        source = ProjectDocument.model_validate(document.model_dump(mode="json"))
        if patch.source_checksum != source.checksum:
            raise ImpactPatchComparisonError(
                "impact_patch_stale",
                expected_checksum=source.checksum,
                patch_checksum=patch.source_checksum,
            )
        if patch.project_id != source.manifest.project_id:
            raise ImpactPatchComparisonError(
                "impact_patch_invalid",
                expected_project_id=source.manifest.project_id,
                patch_project_id=patch.project_id,
            )
        try:
            candidate = apply_project_patch(source, patch)
            before_index = self._dependency_projector.project(source)
            after_index = self._dependency_projector.project(candidate)
            dependency_changes = _dependency_changes(before_index, after_index)
            integrity_changes = self._integrity_changes(source, candidate)
        except (ProjectPatchError, ValidationError, CanonRuleEngineError, ValueError) as error:
            raise ImpactPatchComparisonError(
                "impact_patch_invalid",
                reason=str(error),
            ) from error

        added_resources, removed_resources = _resource_changes(before_index, after_index)
        changed_resources = _changed_resources(source, patch, before_index, after_index)
        changed_or_removed = {
            resource.stable_key()
            for resource in (*changed_resources, *removed_resources)
        }
        seeds = _seeds((*added_resources, *removed_resources, *changed_resources))
        return ImpactPatchComparisonResult(
            project_id=source.manifest.project_id,
            source_checksum=source.checksum,
            target_checksum=candidate.checksum,
            seeds=seeds,
            added_resources=added_resources,
            removed_resources=removed_resources,
            changed_resources=changed_resources,
            dependency_changes=dependency_changes,
            reachability_changes=tuple(
                change for change in dependency_changes if _is_reachability(change.dependency)
            ),
            state_path_changes=tuple(
                change for change in dependency_changes if _is_state_path(change.dependency)
            ),
            integrity_changes=integrity_changes,
            affected_existing_issues=_affected_issues(source, changed_or_removed),
        )

    def _integrity_changes(
        self,
        source: ProjectDocument,
        candidate: ProjectDocument,
    ) -> tuple[ImpactIntegrityChange, ...]:
        before = self._rule_engine.evaluate(self._fact_projector.project(source))
        after = self._rule_engine.evaluate(self._fact_projector.project(candidate))
        before_by_id = {item.fingerprint: item for item in before}
        after_by_id = {item.fingerprint: item for item in after}
        changes: list[ImpactIntegrityChange] = []
        for fingerprint in sorted(before_by_id.keys() | after_by_id.keys()):
            old = before_by_id.get(fingerprint)
            new = after_by_id.get(fingerprint)
            if old is None:
                changes.append(ImpactIntegrityChange("introduced", after=new))
            elif new is None:
                changes.append(ImpactIntegrityChange("resolved", before=old))
            elif _model_signature(old) != _model_signature(new):
                changes.append(ImpactIntegrityChange("changed", before=old, after=new))
        return tuple(sorted(changes, key=ImpactIntegrityChange.stable_key))


def _dependency_changes(
    before: ImpactDependencyIndex,
    after: ImpactDependencyIndex,
) -> tuple[ImpactDependencyChange, ...]:
    before_by_id = {_dependency_identity(item): item for item in before.dependencies}
    after_by_id = {_dependency_identity(item): item for item in after.dependencies}
    changes: list[ImpactDependencyChange] = []
    for identity in sorted(before_by_id.keys() | after_by_id.keys()):
        old = before_by_id.get(identity)
        new = after_by_id.get(identity)
        if old is None:
            changes.append(ImpactDependencyChange("added", after=new))
        elif new is None:
            changes.append(ImpactDependencyChange("removed", before=old))
        elif _model_signature(old) != _model_signature(new):
            changes.append(ImpactDependencyChange("changed", before=old, after=new))
    return tuple(sorted(changes, key=ImpactDependencyChange.stable_key))


def _resource_changes(
    before: ImpactDependencyIndex,
    after: ImpactDependencyIndex,
) -> tuple[tuple[ImpactResourceRef, ...], tuple[ImpactResourceRef, ...]]:
    before_by_key = {item.stable_key(): item for item in before.resources}
    after_by_key = {item.stable_key(): item for item in after.resources}
    added = tuple(
        after_by_key[key] for key in sorted(after_by_key.keys() - before_by_key.keys())
    )
    removed = tuple(
        before_by_key[key] for key in sorted(before_by_key.keys() - after_by_key.keys())
    )
    return added, removed


def _changed_resources(
    source: ProjectDocument,
    patch: ProjectPatch,
    before: ImpactDependencyIndex,
    after: ImpactDependencyIndex,
) -> tuple[ImpactResourceRef, ...]:
    existing_records = {
        collection: {
            project_record_id(collection, item.model_dump(mode="json"))
            for item in getattr(source, collection)
        }
        for collection in PROJECT_RECORD_COLLECTIONS
    }
    common = {
        item.stable_key(): item
        for item in before.resources
        if after.contains(item)
    }
    changed: dict[ResourceKey, ImpactResourceRef] = {}
    for operation in patch.operations:
        if not isinstance(operation, PutProjectRecordOperation):
            continue
        if operation.record_id not in existing_records[operation.collection]:
            continue
        for resource in common.values():
            if _operation_owns_resource(operation.collection, operation.record_id, resource):
                changed[resource.stable_key()] = resource
    return tuple(changed[key] for key in sorted(changed))


def _operation_owns_resource(
    collection: str,
    record_id: str,
    resource: ImpactResourceRef,
) -> bool:
    owner_types = {
        "nodes": {"node"},
        "edges": {"edge"},
        "issues": {"issue"},
        "placements": {"placement"},
        "dialogues": {"node"},
        "quests": {"node"},
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
    }.get(collection, set())
    return resource.owner_id == record_id and resource.owner_type in owner_types


def _affected_issues(
    document: ProjectDocument,
    changed_or_removed: set[ResourceKey],
) -> tuple[ImpactResourceRef, ...]:
    affected: dict[ResourceKey, ImpactResourceRef] = {}
    for issue in document.issues:
        if any(target.stable_key() in changed_or_removed for target in _issue_targets(issue)):
            issue_ref = ImpactResourceRef(owner_type="issue", owner_id=issue.id)
            affected[issue_ref.stable_key()] = issue_ref
    return tuple(affected[key] for key in sorted(affected))


def _issue_targets(issue: ProjectIssueRecord) -> tuple[ImpactResourceRef, ...]:
    targets = [
        *(
            [ImpactResourceRef(owner_type="node", owner_id=issue.node_id)]
            if issue.node_id is not None
            else []
        ),
        *(
            [ImpactResourceRef(owner_type="edge", owner_id=issue.edge_id)]
            if issue.edge_id is not None
            else []
        ),
    ]
    try:
        metadata: CanonIssueMetadataV1 | None = parse_canon_issue_metadata(issue.metadata)
    except ValidationError:
        metadata = None
    if metadata is not None:
        targets.extend(metadata.targets)
    keyed = {target.stable_key(): target for target in targets}
    return tuple(keyed[key] for key in sorted(keyed))


def _is_reachability(dependency: ImpactDependency) -> bool:
    return dependency.kind.endswith("reachability") or dependency.kind in {
        "dialogue.next-element",
        "dialogue.outcome-invocation",
        "dialogue.outcome-target",
        "dialogue.outcome-transition",
        "quest.outcome-target",
        "quest.outcome-transition",
        "playback.reachable-flow",
        "temporal.initial-value-read",
        "temporal.writer-read",
        "playback.dialogue-choice-read",
        "playback.visited-read",
    }


def _is_state_path(dependency: ImpactDependency) -> bool:
    values = [dependency.message_parameters, *(item.message_parameters for item in dependency.evidence)]
    return dependency.domain == "temporal" and any("path" in value for value in values)


def _dependency_identity(dependency: ImpactDependency) -> tuple[object, ...]:
    return (
        dependency.domain,
        dependency.kind,
        dependency.source.stable_key(),
        dependency.target.stable_key(),
    )


def _seeds(resources: tuple[ImpactResourceRef, ...]) -> tuple[ImpactSeed, ...]:
    keyed = {resource.stable_key(): ImpactSeed(resource=resource) for resource in resources}
    return tuple(keyed[key] for key in sorted(keyed))


def _model_signature(value: object) -> str:
    if not isinstance(value, (ImpactDependency, CanonIssueCandidate)):
        raise TypeError("impact comparison signature requires a contract model")
    payload = value.model_dump(mode="json")
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
