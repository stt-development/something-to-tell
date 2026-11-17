"""Deterministic project-document adapters for the Phase 5 dependency index."""

from __future__ import annotations

from pydantic import ValidationError

from ..schemas.canon_check import CanonIssueMetadataV1, parse_canon_issue_metadata
from ..schemas.impact_analysis import (
    ImpactDependency,
    ImpactEvidenceRef,
    ImpactResourceRef,
)
from ..schemas.project_document import (
    ProjectDocument,
    ProjectEdgeRecord,
    ProjectIssueRecord,
    ProjectPlacementRecord,
)
from .builders import (
    dependency as _dependency,
    evidence_ref,
    resource_ref as _ref,
    unique_refs as _unique_refs,
)
from .index import ImpactDependencyIndex
from .narrative_projection import NarrativeStructureDependencyProjector
from .temporal_projection import TemporalPlaybackDependencyProjector


class ProjectDependencyProjector:
    """Projects immutable Phase 5 dependencies without repositories or UI state."""

    def project(self, document: ProjectDocument) -> ImpactDependencyIndex:
        # Revalidation severs caller-owned lists/dicts and protects this run from
        # mixed records while later adapters execute outside the session lock.
        snapshot = ProjectDocument.model_validate(document.model_dump(mode="json"))
        narrative = NarrativeStructureDependencyProjector()
        temporal_resources, temporal_dependencies = (
            TemporalPlaybackDependencyProjector().project(snapshot)
        )
        resources = [
            *self._resources(snapshot),
            *narrative.resources(snapshot),
            *temporal_resources,
        ]
        dependencies = [
            *self._graph_dependencies(snapshot),
            *self._composition_dependencies(snapshot),
            *narrative.project(snapshot),
            *temporal_dependencies,
            *self._canon_dependencies(snapshot),
        ]
        return ImpactDependencyIndex.build(
            project_id=snapshot.manifest.project_id,
            source_checksum=snapshot.checksum,
            resources=resources,
            dependencies=dependencies,
        )

    @staticmethod
    def _resources(document: ProjectDocument) -> list[ImpactResourceRef]:
        return [
            *(_ref("node", item.id) for item in document.nodes),
            *(_ref("edge", item.id) for item in document.edges),
            *(_ref("placement", item.id) for item in document.placements),
            *(_ref("issue", item.id) for item in document.issues),
        ]

    def _graph_dependencies(self, document: ProjectDocument) -> list[ImpactDependency]:
        dependencies: list[ImpactDependency] = []
        for edge in document.edges:
            edge_ref = _ref("edge", edge.id)
            source_ref = _ref("node", edge.source_node_id)
            target_ref = _ref("node", edge.target_node_id)
            dependencies.extend(
                (
                    _dependency(
                        source_ref,
                        edge_ref,
                        domain="graph",
                        kind="graph.edge-source",
                        propagation="required",
                        message_key="impact.dependency.graphEndpoint",
                        parameters={"endpoint": "source", "relationship_type": edge.type},
                        evidence=_edge_evidence(edge, "source_node_id"),
                    ),
                    _dependency(
                        target_ref,
                        edge_ref,
                        domain="graph",
                        kind="graph.edge-target",
                        propagation="required",
                        message_key="impact.dependency.graphEndpoint",
                        parameters={"endpoint": "target", "relationship_type": edge.type},
                        evidence=_edge_evidence(edge, "target_node_id"),
                    ),
                )
            )
            if edge.type in {"contains", "member_of"}:
                continue
            # Semantic edges carry context only. Their authored direction is not
            # promoted to executable order; P5-003 adds specialized outcome facts.
            dependencies.extend(
                (
                    _dependency(
                        edge_ref,
                        source_ref,
                        domain="graph",
                        kind="graph.semantic-source-context",
                        propagation="contextual",
                        message_key="impact.dependency.semanticContext",
                        parameters={"endpoint": "source", "relationship_type": edge.type},
                        evidence=_edge_evidence(edge, "type"),
                    ),
                    _dependency(
                        edge_ref,
                        target_ref,
                        domain="graph",
                        kind="graph.semantic-target-context",
                        propagation="contextual",
                        message_key="impact.dependency.semanticContext",
                        parameters={"endpoint": "target", "relationship_type": edge.type},
                        evidence=_edge_evidence(edge, "type"),
                    ),
                )
            )
        return dependencies

    def _composition_dependencies(
        self,
        document: ProjectDocument,
    ) -> list[ImpactDependency]:
        dependencies: list[ImpactDependency] = []
        contains_by_pair: dict[tuple[str, str], list[ProjectEdgeRecord]] = {}
        for edge in document.edges:
            if edge.type == "contains":
                contains_by_pair.setdefault(
                    (edge.source_node_id, edge.target_node_id),
                    [],
                ).append(edge)
        for placement in document.placements:
            placement_ref = _ref("placement", placement.id)
            canonical_ref = _ref("node", placement.canonical_node_id)
            dependencies.append(
                _dependency(
                    canonical_ref,
                    placement_ref,
                    domain="composition",
                    kind="composition.canonical-placement",
                    propagation="required",
                    message_key="impact.dependency.canonicalPlacement",
                    parameters={"is_primary": placement.is_primary},
                    evidence=_placement_evidence(placement, "canonical_node_id"),
                )
            )
            if placement.container_node_id is None:
                continue
            container_ref = _ref("node", placement.container_node_id)
            dependencies.extend(
                (
                    _dependency(
                        container_ref,
                        placement_ref,
                        domain="composition",
                        kind="composition.container-placement",
                        propagation="required",
                        message_key="impact.dependency.containerPlacement",
                        evidence=_placement_evidence(placement, "container_node_id"),
                    ),
                    _dependency(
                        placement_ref,
                        container_ref,
                        domain="composition",
                        kind="composition.placement-container-context",
                        propagation="contextual",
                        message_key="impact.dependency.placementContainer",
                        evidence=_placement_evidence(placement, "scope_key"),
                    ),
                    _dependency(
                        container_ref,
                        canonical_ref,
                        domain="composition",
                        kind="composition.contained-child-context",
                        propagation="contextual",
                        message_key="impact.dependency.containmentContext",
                        parameters={"role": "child"},
                        evidence=_placement_evidence(placement, "container_node_id"),
                    ),
                )
            )
            relationships = contains_by_pair.get(
                (placement.container_node_id, placement.canonical_node_id),
                [],
            )
            for relationship in relationships:
                dependencies.append(
                    _dependency(
                        placement_ref,
                        _ref("edge", relationship.id),
                        domain="composition",
                        kind="composition.placement-relationship",
                        propagation="required",
                        message_key="impact.dependency.placementRelationship",
                        evidence=_placement_evidence(placement, "scope_key"),
                    )
                )

        for edge in document.edges:
            if edge.type == "contains":
                dependencies.extend(self._contains_dependencies(edge))
            elif edge.type == "member_of":
                dependencies.extend(self._membership_dependencies(edge))
        return dependencies

    @staticmethod
    def _contains_dependencies(edge: ProjectEdgeRecord) -> tuple[ImpactDependency, ...]:
        edge_ref = _ref("edge", edge.id)
        return (
            _dependency(
                edge_ref,
                _ref("node", edge.source_node_id),
                domain="composition",
                kind="composition.container-context",
                propagation="contextual",
                message_key="impact.dependency.containmentContext",
                parameters={"role": "container"},
                evidence=_edge_evidence(edge, "type"),
            ),
            _dependency(
                edge_ref,
                _ref("node", edge.target_node_id),
                domain="composition",
                kind="composition.child-context",
                propagation="contextual",
                message_key="impact.dependency.containmentContext",
                parameters={"role": "child"},
                evidence=_edge_evidence(edge, "type"),
            ),
        )

    @staticmethod
    def _membership_dependencies(edge: ProjectEdgeRecord) -> tuple[ImpactDependency, ...]:
        edge_ref = _ref("edge", edge.id)
        return (
            _dependency(
                edge_ref,
                _ref("node", edge.source_node_id),
                domain="composition",
                kind="composition.membership-character-context",
                propagation="contextual",
                message_key="impact.dependency.factionMembership",
                parameters={"role": "character"},
                evidence=_edge_evidence(edge, "type"),
            ),
            _dependency(
                edge_ref,
                _ref("node", edge.target_node_id),
                domain="composition",
                kind="composition.membership-faction-context",
                propagation="contextual",
                message_key="impact.dependency.factionMembership",
                parameters={"role": "faction"},
                evidence=_edge_evidence(edge, "type"),
            ),
        )

    def _canon_dependencies(self, document: ProjectDocument) -> list[ImpactDependency]:
        dependencies: list[ImpactDependency] = []
        for issue in document.issues:
            issue_ref = _ref("issue", issue.id)
            direct_targets = [
                *([_ref("node", issue.node_id)] if issue.node_id is not None else []),
                *([_ref("edge", issue.edge_id)] if issue.edge_id is not None else []),
            ]
            metadata = self._generated_issue_metadata(issue)
            if metadata is not None:
                direct_targets.extend(metadata.targets)
            for target in _unique_refs(direct_targets):
                dependencies.append(
                    _dependency(
                        target,
                        issue_ref,
                        domain="canon",
                        kind="canon.issue-target",
                        propagation="required",
                        message_key="impact.dependency.canonIssueTarget",
                        parameters={"status": issue.status},
                        evidence=_issue_evidence(issue, target),
                    )
                )
            if metadata is None:
                continue
            contextual = [
                *([metadata.scope] if metadata.scope is not None else []),
                *(item.owner for item in metadata.evidence),
            ]
            for owner in _unique_refs(contextual):
                dependencies.append(
                    _dependency(
                        owner,
                        issue_ref,
                        domain="canon",
                        kind="canon.issue-evidence",
                        propagation="contextual",
                        message_key="impact.dependency.canonIssueEvidence",
                        parameters={"status": issue.status},
                        evidence=_issue_evidence(issue, owner),
                    )
                )
        return dependencies

    @staticmethod
    def _generated_issue_metadata(
        issue: ProjectIssueRecord,
    ) -> CanonIssueMetadataV1 | None:
        try:
            return parse_canon_issue_metadata(issue.metadata)
        except ValidationError:
            # A malformed recognized envelope remains a durable Issue record;
            # direct node_id/edge_id references still participate in impact.
            return None


# Retain the P5-002 public name while callers move to the domain-neutral entry
# point. Both names execute the exact same immutable projection pipeline.
GraphCompositionCanonDependencyProjector = ProjectDependencyProjector


def _edge_evidence(edge: ProjectEdgeRecord, field_path: str) -> ImpactEvidenceRef:
    return evidence_ref(
        _ref("edge", edge.id),
        field_path=field_path,
        message_key="impact.evidence.relationship",
        parameters={"relationship_type": edge.type},
        excerpt=edge.label or None,
    )


def _placement_evidence(
    placement: ProjectPlacementRecord,
    field_path: str,
) -> ImpactEvidenceRef:
    return evidence_ref(
        _ref("placement", placement.id),
        field_path=field_path,
        message_key="impact.evidence.placement",
        parameters={"scope_key": placement.scope_key},
    )


def _issue_evidence(
    issue: ProjectIssueRecord,
    target: ImpactResourceRef,
) -> ImpactEvidenceRef:
    return evidence_ref(
        _ref("issue", issue.id),
        field_path="metadata",
        message_key="impact.evidence.canonIssue",
        parameters={
            "target_type": target.owner_type,
            "target_id": target.owner_id,
        },
        excerpt=issue.title,
    )
