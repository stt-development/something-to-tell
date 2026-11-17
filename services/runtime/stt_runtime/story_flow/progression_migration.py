from __future__ import annotations

from dataclasses import replace
from hashlib import sha256
import json

from ..domain.entities import EdgeEntity, StoryFlowNodeEntity, SuggestionEntity, utc_now
from ..repositories.interfaces import UnitOfWork
from ..schemas.progression_migration import (
    ProgressionCandidate,
    ProgressionDecision,
    ProgressionMigrationAccept,
    ProgressionMigrationAcceptResponse,
    ProgressionMigrationReview,
)
from ..schemas.story_flow_api import FlowTransitionCreate
from .service import StoryFlowService, StoryFlowServiceError

MIGRATION_ACTOR = "story-flow-progression-migration"


class ProgressionMigrationService:
    """Reviews semantic progression without inferring order from presentation."""

    def review(self, uow: UnitOfWork, project_id: str) -> ProgressionMigrationReview:
        if uow.projects.get(project_id) is None:
            raise StoryFlowServiceError("project_not_found", f"Project not found: {project_id}")
        candidates = [self._candidate(edge) for edge in uow.edges.list(project_id=project_id) if self._eligible(edge)]
        decisions = self._decisions(uow, project_id)
        decided = {decision.fingerprint for decision in decisions}
        return ProgressionMigrationReview(
            pending=sorted((item for item in candidates if item.fingerprint not in decided), key=lambda item: item.edge_id),
            decisions=sorted(decisions, key=lambda item: item.id),
        )

    def reject(self, uow: UnitOfWork, project_id: str, fingerprint: str) -> ProgressionDecision:
        candidate = self._require_pending(uow, project_id, fingerprint)
        decision = self._persist_decision(uow, candidate, status="rejected")
        uow.commit()
        return decision

    def accept(
        self,
        uow: UnitOfWork,
        fingerprint: str,
        payload: ProgressionMigrationAccept,
    ) -> ProgressionMigrationAcceptResponse:
        candidate = self._require_pending(uow, payload.project_id, fingerprint)
        flow = uow.story_flows.get(payload.flow_id)
        if flow is None or flow.project_id != payload.project_id:
            raise StoryFlowServiceError("story_flow_not_found", f"Story Flow not found: {payload.flow_id}")
        story_flow = StoryFlowService()
        try:
            memberships = list(uow.story_flow_nodes.list(project_id=payload.project_id, flow_id=flow.id))
            for node_id in (candidate.source_node_id, candidate.target_node_id):
                if uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node_id) is None:
                    membership = StoryFlowNodeEntity(
                        project_id=payload.project_id,
                        flow_id=flow.id,
                        node_id=node_id,
                        presentation_order=max((-1, *(item.presentation_order for item in memberships))) + 1,
                        metadata={"progression_migration_fingerprint": fingerprint},
                    )
                    memberships.append(uow.story_flow_nodes.add(membership))
            if flow.entry_node_id is None:
                flow = uow.story_flows.update(replace(flow, entry_node_id=candidate.source_node_id, updated_at=utc_now()))
            transitions = list(uow.flow_transitions.list(project_id=payload.project_id, flow_id=flow.id))
            existing_transition = next(
                (item for item in transitions if item.metadata.get("semantic_edge_id") == candidate.edge_id),
                None,
            )
            priority = existing_transition.priority if existing_transition else max(
                (-1, *(item.priority for item in transitions if item.source_node_id == candidate.source_node_id))
            ) + 1
            transition_payload = FlowTransitionCreate(
                project_id=payload.project_id,
                source_node_id=candidate.source_node_id,
                target_node_id=candidate.target_node_id,
                priority=priority,
                kind=payload.kind,
                label=payload.label.strip() or candidate.label,
                condition=payload.condition,
                is_default=payload.is_default,
                metadata={
                    "semantic_edge_id": candidate.edge_id,
                    "progression_migration_fingerprint": fingerprint,
                    **candidate.origin_metadata,
                },
            )
            if existing_transition is None:
                transition = story_flow._add_transition_record(uow, flow, transition_payload)
            else:
                story_flow._validate_transition(
                    uow,
                    flow,
                    transition_payload,
                    excluded_transition_id=existing_transition.id,
                )
                transition = uow.flow_transitions.update(
                    replace(
                        existing_transition,
                        source_node_id=transition_payload.source_node_id,
                        target_node_id=transition_payload.target_node_id,
                        kind=transition_payload.kind,
                        label=transition_payload.label,
                        condition=transition_payload.condition,
                        is_default=transition_payload.is_default,
                        metadata=transition_payload.metadata,
                        updated_at=utc_now(),
                    )
                )
            if not payload.preserve_relationship:
                uow.edges.delete(candidate.edge_id)
            decision = self._persist_decision(
                uow,
                candidate,
                status="accepted",
                flow_id=flow.id,
                transition_id=transition.id,
                original_relationship="preserved" if payload.preserve_relationship else "removed",
            )
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return ProgressionMigrationAcceptResponse(
            decision=decision,
            transition=story_flow._transition_response(transition),
            snapshot=story_flow._snapshot(uow, flow),
        )

    @staticmethod
    def _eligible(edge: EdgeEntity) -> bool:
        return edge.type == "leads_to" or "dialogue_element_id" in edge.metadata or "quest_branch_id" in edge.metadata

    def _candidate(self, edge: EdgeEntity) -> ProgressionCandidate:
        origin_kind = (
            "dialogue" if "dialogue_element_id" in edge.metadata
            else "quest" if "quest_branch_id" in edge.metadata
            else "relationship"
        )
        origin_metadata = {
            key: str(edge.metadata[key])
            for key in ("dialogue_element_id", "quest_stage_id", "quest_branch_id")
            if key in edge.metadata
        }
        evidence = [f"Relationship type is {edge.type}."]
        if origin_kind == "dialogue":
            evidence.append(f"Owned by Dialogue origin {origin_metadata['dialogue_element_id']}.")
        elif origin_kind == "quest":
            evidence.append(
                f"Owned by Quest stage {origin_metadata.get('quest_stage_id', 'unknown')} "
                f"branch {origin_metadata['quest_branch_id']}."
            )
        signature = {
            "edge_id": edge.id,
            "source_node_id": edge.source_node_id,
            "target_node_id": edge.target_node_id,
            "type": edge.type,
            "label": edge.label,
            "condition": edge.condition,
            "origin_metadata": origin_metadata,
        }
        fingerprint = sha256(json.dumps(signature, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return ProgressionCandidate(
            fingerprint=fingerprint,
            project_id=edge.project_id,
            edge_id=edge.id,
            source_node_id=edge.source_node_id,
            target_node_id=edge.target_node_id,
            origin_kind=origin_kind,
            label=edge.label,
            condition=edge.condition,
            evidence=evidence,
            origin_metadata=origin_metadata,
        )

    def _require_pending(self, uow: UnitOfWork, project_id: str, fingerprint: str) -> ProgressionCandidate:
        review = self.review(uow, project_id)
        candidate = next((item for item in review.pending if item.fingerprint == fingerprint), None)
        if candidate is None:
            raise StoryFlowServiceError("progression_candidate_not_found", "Progression candidate is missing or already reviewed.")
        return candidate

    def _decisions(self, uow: UnitOfWork, project_id: str) -> list[ProgressionDecision]:
        return [
            self._decision(entity)
            for entity in uow.suggestions.list(project_id=project_id)
            if entity.created_by == MIGRATION_ACTOR
        ]

    def _persist_decision(
        self,
        uow: UnitOfWork,
        candidate: ProgressionCandidate,
        *,
        status: str,
        flow_id: str | None = None,
        transition_id: str | None = None,
        original_relationship: str = "unchanged",
    ) -> ProgressionDecision:
        entity = uow.suggestions.add(
            SuggestionEntity(
                project_id=candidate.project_id,
                title=f"Progression migration: {candidate.label or candidate.edge_id}",
                description="Reviewed semantic progression candidate.",
                status=status,
                patch=candidate.model_dump(),
                created_by=MIGRATION_ACTOR,
                metadata={
                    "fingerprint": candidate.fingerprint,
                    "edge_id": candidate.edge_id,
                    "flow_id": flow_id,
                    "transition_id": transition_id,
                    "original_relationship": original_relationship,
                },
            )
        )
        return self._decision(entity)

    @staticmethod
    def _decision(entity: SuggestionEntity) -> ProgressionDecision:
        return ProgressionDecision(
            id=entity.id,
            project_id=entity.project_id,
            fingerprint=str(entity.metadata["fingerprint"]),
            edge_id=str(entity.metadata["edge_id"]),
            status=entity.status,
            flow_id=entity.metadata.get("flow_id"),
            transition_id=entity.metadata.get("transition_id"),
            original_relationship=entity.metadata.get("original_relationship", "unchanged"),
            candidate=ProgressionCandidate.model_validate(entity.patch),
        )
