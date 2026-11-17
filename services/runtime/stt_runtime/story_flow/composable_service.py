from __future__ import annotations

from collections import Counter, defaultdict, deque
from collections.abc import Sequence
from dataclasses import replace
from typing import Literal

from pydantic import ValidationError

from ..domain.entities import (
    FlowExitBindingEntity,
    FlowExitEntity,
    FlowInvocationEntity,
    FlowTransitionEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    utc_now,
)
from ..project_format.interchange import normalize_story_flow_name
from ..repositories.interfaces import UnitOfWork
from ..schemas.resource_presenters import edge_response
from ..schemas.dialogue_transition import OutcomeFlowCompositionReference
from ..schemas.composable_story_flow import (
    ComposableFlowGraph,
    FlowExit,
    FlowExitBinding,
    FlowInvocation,
)
from ..schemas.composable_story_flow_api import (
    ComposableFlowProjection,
    ComposableIntegrityFact,
    ComposableIntegrityReport,
    CompositionDeletionImpact,
    FlowCompositionSnapshot,
    FlowExitBindingCreate,
    FlowExitBindingUpdate,
    FlowExitCreate,
    FlowExitUpdate,
    FlowInvocationCreate,
    FlowInvocationUpdate,
    OutcomeSideFlowCreate,
    OutcomeSideFlowResponse,
)
from .service import StoryFlowService, StoryFlowServiceError


# The semantic edge stores this shared reference; composition owns its atomic rewrite.
OUTCOME_FLOW_COMPOSITION_METADATA_KEY = "outcome_flow_composition"


class ComposableStoryFlowService:
    """Owns permissive Phase 3.10 authoring and strict execution projections."""

    def snapshot(self, uow: UnitOfWork, project_id: str) -> FlowCompositionSnapshot:
        self._require_project(uow, project_id)
        return FlowCompositionSnapshot(
            project_id=project_id,
            invocations=[self._invocation(item) for item in self._invocations(uow, project_id)],
            exits=[self._exit(item) for item in self._exits(uow, project_id)],
            bindings=[self._binding(item) for item in self._bindings(uow, project_id)],
        )

    def create_invocation(self, uow: UnitOfWork, payload: FlowInvocationCreate) -> FlowInvocation:
        candidate = FlowInvocationEntity(
            project_id=payload.project_id,
            source_flow_id=payload.source_flow_id,
            source_node_id=payload.source_node_id,
            target_flow_id=payload.target_flow_id,
            label=payload.label,
            condition=payload.condition,
            priority=payload.priority,
            is_default=payload.is_default,
        )
        self._validate_invocation(uow, candidate)
        saved = uow.flow_invocations.add(candidate)
        uow.commit()
        return self._invocation(saved)

    def update_invocation(
        self, uow: UnitOfWork, invocation_id: str, payload: FlowInvocationUpdate
    ) -> FlowInvocation:
        existing = self._require_invocation(uow, invocation_id, payload.project_id)
        candidate = replace(
            existing,
            source_flow_id=payload.source_flow_id,
            source_node_id=payload.source_node_id,
            target_flow_id=payload.target_flow_id,
            label=payload.label,
            condition=payload.condition,
            priority=payload.priority,
            is_default=payload.is_default,
            updated_at=utc_now(),
        )
        self._validate_invocation(uow, candidate, excluded_id=existing.id)
        saved = uow.flow_invocations.update(candidate)
        uow.commit()
        return self._invocation(saved)

    def create_outcome_side_flow(
        self, uow: UnitOfWork, payload: OutcomeSideFlowCreate
    ) -> OutcomeSideFlowResponse:
        """Replace a specialized outcome route without exposing partial composition."""

        self._require_project(uow, payload.project_id)
        edge = uow.edges.get(payload.edge_id)
        if edge is None or edge.project_id != payload.project_id:
            raise StoryFlowServiceError(
                "composable_flow_outcome_not_found",
                f"Specialized outcome edge not found: {payload.edge_id}",
            )
        if not (
            edge.metadata.get("dialogue_element_id")
            or (
                edge.metadata.get("quest_stage_id")
                and edge.metadata.get("quest_branch_id")
            )
        ):
            raise StoryFlowServiceError(
                "composable_flow_outcome_origin_invalid",
                f"Edge is not a Dialogue or Quest outcome: {edge.id}",
            )
        source_node = uow.nodes.get(edge.source_node_id)
        is_dialogue_outcome = bool(edge.metadata.get("dialogue_element_id"))
        is_quest_outcome = bool(
            edge.metadata.get("quest_stage_id")
            and edge.metadata.get("quest_branch_id")
        )
        if (
            source_node is None
            or source_node.project_id != payload.project_id
            or (is_dialogue_outcome and source_node.type != "Dialogue")
            or (is_quest_outcome and source_node.type != "Quest")
        ):
            raise StoryFlowServiceError(
                "composable_flow_outcome_origin_invalid",
                f"Specialized outcome source is invalid: {edge.source_node_id}",
            )
        source_flow = self._require_flow(uow, payload.source_flow_id, payload.project_id)
        target_node = uow.nodes.get(edge.target_node_id)
        if target_node is None or target_node.project_id != payload.project_id:
            raise StoryFlowServiceError(
                "composable_flow_node_not_found",
                f"Outcome target node not found: {edge.target_node_id}",
            )
        normalized_name = normalize_story_flow_name(payload.name)
        if not normalized_name:
            raise StoryFlowServiceError(
                "story_flow_name_required", "Story Flow name is required."
            )
        if any(
            flow.normalized_name == normalized_name
            for flow in uow.story_flows.list(project_id=payload.project_id)
        ):
            raise StoryFlowServiceError(
                "story_flow_name_conflict",
                f"Story Flow name is already used: {payload.name.strip()}",
            )

        association_payload = edge.metadata.get(OUTCOME_FLOW_COMPOSITION_METADATA_KEY)
        try:
            association = (
                OutcomeFlowCompositionReference.model_validate(association_payload)
                if association_payload is not None
                else None
            )
        except ValidationError as error:
            raise StoryFlowServiceError(
                "composable_flow_outcome_association_invalid",
                f"Outcome composition association is invalid: {edge.id}",
            ) from error

        try:
            if association is not None:
                previous = uow.flow_invocations.get(association.invocation_id)
                if previous is None or previous.project_id != payload.project_id:
                    raise StoryFlowServiceError(
                        "composable_flow_invocation_not_found",
                        f"Associated invocation not found: {association.invocation_id}",
                    )
                for binding in uow.flow_exit_bindings.list(
                    project_id=payload.project_id,
                    invocation_id=previous.id,
                ):
                    uow.flow_exit_bindings.delete(binding.id)
                uow.flow_invocations.delete(previous.id)

            for transition in uow.flow_transitions.list(project_id=payload.project_id):
                if transition.metadata.get("semantic_edge_id") == edge.id:
                    uow.flow_transitions.delete(transition.id)

            target_flow = uow.story_flows.add(
                StoryFlowEntity(
                    project_id=payload.project_id,
                    name=payload.name.strip(),
                    normalized_name=normalized_name,
                    description=payload.description,
                    kind="side",
                    status="active",
                    entry_node_id=target_node.id,
                    metadata={"created_from_specialized_outcome": edge.id},
                )
            )
            uow.story_flow_nodes.add(
                StoryFlowNodeEntity(
                    project_id=payload.project_id,
                    flow_id=target_flow.id,
                    node_id=target_node.id,
                    presentation_order=0,
                    metadata={"created_from_specialized_outcome": edge.id},
                )
            )
            source_members = list(
                uow.story_flow_nodes.list(
                    project_id=payload.project_id, flow_id=source_flow.id
                )
            )
            if not any(member.node_id == edge.source_node_id for member in source_members):
                uow.story_flow_nodes.add(
                    StoryFlowNodeEntity(
                        project_id=payload.project_id,
                        flow_id=source_flow.id,
                        node_id=edge.source_node_id,
                        presentation_order=max(
                            (member.presentation_order for member in source_members),
                            default=-1,
                        )
                        + 1,
                        metadata={"added_for_specialized_outcome": edge.id},
                    )
                )

            invocation_entity = FlowInvocationEntity(
                project_id=payload.project_id,
                source_flow_id=source_flow.id,
                source_node_id=edge.source_node_id,
                target_flow_id=target_flow.id,
                label=payload.label,
                condition=payload.condition,
                priority=payload.priority,
                is_default=payload.is_default,
            )
            self._validate_invocation(uow, invocation_entity)
            invocation_entity = uow.flow_invocations.add(invocation_entity)
            association = OutcomeFlowCompositionReference(
                invocation_id=invocation_entity.id,
                source_flow_id=source_flow.id,
                target_flow_id=target_flow.id,
            )
            updated_edge = uow.edges.update(
                replace(
                    edge,
                    metadata={
                        **edge.metadata,
                        OUTCOME_FLOW_COMPOSITION_METADATA_KEY: association.model_dump(
                            mode="json"
                        ),
                    },
                    updated_at=utc_now(),
                )
            )
            uow.commit()
        except Exception:
            # Every flushed flow, membership, route, and edge update belongs to this transaction.
            uow.rollback()
            raise

        return OutcomeSideFlowResponse(
            edge=edge_response(updated_edge),
            invocation=self._invocation(invocation_entity),
            source_flow=StoryFlowService().snapshot(uow, source_flow.id),
            target_flow=StoryFlowService().snapshot(uow, target_flow.id),
        )

    def invocation_impact(self, uow: UnitOfWork, invocation_id: str) -> CompositionDeletionImpact:
        invocation = self._require_invocation(uow, invocation_id)
        bindings = uow.flow_exit_bindings.list(
            project_id=invocation.project_id, invocation_id=invocation.id
        )
        return CompositionDeletionImpact(
            subject_kind="invocation",
            subject_id=invocation.id,
            invocation_ids=[invocation.id],
            binding_ids=sorted(item.id for item in bindings),
        )

    def delete_invocation(self, uow: UnitOfWork, invocation_id: str, *, impact_reviewed: bool) -> None:
        impact = self.invocation_impact(uow, invocation_id)
        self._require_review(impact, impact_reviewed)
        try:
            for binding_id in impact.binding_ids:
                uow.flow_exit_bindings.delete(binding_id)
            uow.flow_invocations.delete(invocation_id)
            uow.commit()
        except Exception:
            uow.rollback()
            raise

    def create_exit(self, uow: UnitOfWork, payload: FlowExitCreate) -> FlowExit:
        candidate = FlowExitEntity(
            project_id=payload.project_id,
            flow_id=payload.flow_id,
            key=payload.key,
            label=payload.label,
            source_node_id=payload.source_node_id,
        )
        self._validate_exit(uow, candidate)
        saved = uow.flow_exits.add(candidate)
        uow.commit()
        return self._exit(saved)

    def update_exit(self, uow: UnitOfWork, exit_id: str, payload: FlowExitUpdate) -> FlowExit:
        existing = self._require_exit(uow, exit_id, payload.project_id)
        candidate = replace(
            existing,
            flow_id=payload.flow_id,
            key=payload.key,
            label=payload.label,
            source_node_id=payload.source_node_id,
            updated_at=utc_now(),
        )
        self._validate_exit(uow, candidate, excluded_id=existing.id)
        saved = uow.flow_exits.update(candidate)
        uow.commit()
        return self._exit(saved)

    def exit_impact(self, uow: UnitOfWork, exit_id: str) -> CompositionDeletionImpact:
        flow_exit = self._require_exit(uow, exit_id)
        bindings = [
            item
            for item in self._bindings(uow, flow_exit.project_id)
            if item.exit_id == flow_exit.id
        ]
        return CompositionDeletionImpact(
            subject_kind="exit",
            subject_id=flow_exit.id,
            exit_ids=[flow_exit.id],
            binding_ids=sorted(item.id for item in bindings),
        )

    def delete_exit(self, uow: UnitOfWork, exit_id: str, *, impact_reviewed: bool) -> None:
        impact = self.exit_impact(uow, exit_id)
        self._require_review(impact, impact_reviewed)
        try:
            for binding_id in impact.binding_ids:
                uow.flow_exit_bindings.delete(binding_id)
            uow.flow_exits.delete(exit_id)
            uow.commit()
        except Exception:
            uow.rollback()
            raise

    def create_binding(
        self, uow: UnitOfWork, payload: FlowExitBindingCreate
    ) -> FlowExitBinding:
        candidate = FlowExitBindingEntity(
            project_id=payload.project_id,
            invocation_id=payload.invocation_id,
            exit_id=payload.exit_id,
            target_node_id=payload.target_node_id,
        )
        self._validate_binding(uow, candidate)
        saved = uow.flow_exit_bindings.add(candidate)
        uow.commit()
        return self._binding(saved)

    def update_binding(
        self, uow: UnitOfWork, binding_id: str, payload: FlowExitBindingUpdate
    ) -> FlowExitBinding:
        existing = self._require_binding(uow, binding_id, payload.project_id)
        candidate = replace(
            existing,
            invocation_id=payload.invocation_id,
            exit_id=payload.exit_id,
            target_node_id=payload.target_node_id,
            updated_at=utc_now(),
        )
        self._validate_binding(uow, candidate, excluded_id=existing.id)
        saved = uow.flow_exit_bindings.update(candidate)
        uow.commit()
        return self._binding(saved)

    def delete_binding(self, uow: UnitOfWork, binding_id: str) -> None:
        self._require_binding(uow, binding_id)
        uow.flow_exit_bindings.delete(binding_id)
        uow.commit()

    def flow_impact(self, uow: UnitOfWork, flow_id: str) -> CompositionDeletionImpact:
        flow = self._require_flow(uow, flow_id)
        invocations = [
            item
            for item in self._invocations(uow, flow.project_id)
            if item.source_flow_id == flow.id or item.target_flow_id == flow.id
        ]
        exits = [item for item in self._exits(uow, flow.project_id) if item.flow_id == flow.id]
        invocation_ids = {item.id for item in invocations}
        exit_ids = {item.id for item in exits}
        bindings = [
            item
            for item in self._bindings(uow, flow.project_id)
            if item.invocation_id in invocation_ids or item.exit_id in exit_ids
        ]
        return CompositionDeletionImpact(
            subject_kind="flow",
            subject_id=flow.id,
            invocation_ids=sorted(invocation_ids),
            exit_ids=sorted(exit_ids),
            binding_ids=sorted(item.id for item in bindings),
        )

    def node_impact(self, uow: UnitOfWork, project_id: str, node_id: str) -> CompositionDeletionImpact:
        self._require_project(uow, project_id)
        node = uow.nodes.get(node_id)
        if node is None or node.project_id != project_id:
            raise StoryFlowServiceError("composable_flow_node_not_found", f"Node not found: {node_id}")
        invocations = [
            item for item in self._invocations(uow, project_id) if item.source_node_id == node_id
        ]
        exits = [item for item in self._exits(uow, project_id) if item.source_node_id == node_id]
        bindings = [item for item in self._bindings(uow, project_id) if item.target_node_id == node_id]
        return CompositionDeletionImpact(
            subject_kind="node",
            subject_id=node_id,
            invocation_ids=sorted(item.id for item in invocations),
            exit_ids=sorted(item.id for item in exits),
            binding_ids=sorted(item.id for item in bindings),
        )

    def integrity(self, uow: UnitOfWork, project_id: str, root_flow_id: str) -> ComposableIntegrityReport:
        self._require_project(uow, project_id)
        root = self._require_flow(uow, root_flow_id, project_id)
        flows = {item.id: item for item in uow.story_flows.list(project_id=project_id)}
        memberships = list(uow.story_flow_nodes.list(project_id=project_id))
        transitions = list(uow.flow_transitions.list(project_id=project_id))
        invocations = self._invocations(uow, project_id)
        exits = self._exits(uow, project_id)
        bindings = self._bindings(uow, project_id)
        reachable_flow_ids = self._reachable_flow_ids(root.id, flows, invocations)
        facts = self._integrity_facts(
            project_id,
            reachable_flow_ids,
            flows,
            memberships,
            transitions,
            invocations,
            exits,
            bindings,
        )
        return ComposableIntegrityReport(
            project_id=project_id,
            root_flow_id=root.id,
            reachable_flow_ids=sorted(reachable_flow_ids),
            facts=sorted(facts, key=self._fact_key),
            executable=not any(fact.level == "error" for fact in facts),
        )

    def projection(
        self,
        uow: UnitOfWork,
        project_id: str,
        root_flow_id: str,
        consumer: Literal["story", "playback"],
    ) -> ComposableFlowProjection:
        report = self.integrity(uow, project_id, root_flow_id)
        if not report.executable:
            codes = sorted({fact.code for fact in report.facts if fact.level == "error"})
            raise StoryFlowServiceError(
                "composable_flow_projection_blocked",
                f"{consumer.title()} projection is blocked by: {', '.join(codes)}",
            )
        reachable = set(report.reachable_flow_ids)
        flow_entities = [item for item in uow.story_flows.list(project_id=project_id) if item.id in reachable]
        memberships = [item for item in uow.story_flow_nodes.list(project_id=project_id) if item.flow_id in reachable]
        transitions = [item for item in uow.flow_transitions.list(project_id=project_id) if item.flow_id in reachable]
        invocations = [item for item in self._invocations(uow, project_id) if item.source_flow_id in reachable]
        exits = [item for item in self._exits(uow, project_id) if item.flow_id in reachable]
        invocation_ids = {item.id for item in invocations}
        exit_ids = {item.id for item in exits}
        bindings = [
            item
            for item in self._bindings(uow, project_id)
            if item.invocation_id in invocation_ids and item.exit_id in exit_ids
        ]
        try:
            graph = ComposableFlowGraph(
                project_id=project_id,
                flows=[StoryFlowService._flow_response(item) for item in flow_entities],
                memberships=[StoryFlowService._membership_response(item) for item in memberships],
                transitions=[StoryFlowService._transition_response(item) for item in transitions],
                invocations=[self._invocation(item) for item in invocations],
                exits=[self._exit(item) for item in exits],
                bindings=[self._binding(item) for item in bindings],
            )
        except ValidationError as error:
            raise StoryFlowServiceError(
                "composable_flow_projection_blocked", "Reachable composition is not executable."
            ) from error
        return ComposableFlowProjection(consumer=consumer, root_flow_id=root_flow_id, graph=graph)

    def _validate_invocation(
        self, uow: UnitOfWork, candidate: FlowInvocationEntity, *, excluded_id: str | None = None
    ) -> None:
        self._require_project(uow, candidate.project_id)
        source = self._require_flow(uow, candidate.source_flow_id, candidate.project_id)
        self._require_flow(uow, candidate.target_flow_id, candidate.project_id)
        if source.id == candidate.target_flow_id:
            self._fail("composable_flow_self_call", "A Story Flow cannot invoke itself.")
        self._require_member(uow, source, candidate.source_node_id)
        if candidate.is_default and candidate.condition.strip():
            self._fail("composable_flow_invalid_default", "A default invocation cannot have a condition.")
        routes = [
            item
            for item in uow.flow_transitions.list(project_id=candidate.project_id, flow_id=source.id)
            if item.source_node_id == candidate.source_node_id
        ]
        calls = [
            item
            for item in self._invocations(uow, candidate.project_id)
            if item.source_flow_id == source.id
            and item.source_node_id == candidate.source_node_id
            and item.id != excluded_id
        ]
        if any(item.priority == candidate.priority for item in [*routes, *calls]):
            self._fail("composable_flow_ambiguous_routes", "Outgoing route priority is already used.")
        if candidate.is_default and any(item.is_default for item in [*routes, *calls]):
            self._fail("composable_flow_ambiguous_routes", "Only one default outgoing route is allowed.")
        if any(
            item.flow_id == source.id and item.source_node_id == candidate.source_node_id
            for item in self._exits(uow, candidate.project_id)
        ):
            self._fail("composable_flow_exit_not_terminal", "An exit source cannot also invoke a flow.")
        candidate_calls = [
            item for item in self._invocations(uow, candidate.project_id) if item.id != excluded_id
        ] + [candidate]
        if self._has_cycle(candidate_calls):
            self._fail("composable_flow_call_cycle", "Flow invocation graph cannot contain a cycle.")
        if excluded_id is not None:
            exits_by_id = {item.id: item for item in self._exits(uow, candidate.project_id)}
            for binding in uow.flow_exit_bindings.list(
                project_id=candidate.project_id, invocation_id=excluded_id
            ):
                flow_exit = exits_by_id.get(binding.exit_id)
                if flow_exit is None or flow_exit.flow_id != candidate.target_flow_id:
                    self._fail(
                        "composable_flow_binding_exit_mismatch",
                        "Update or remove existing exit bindings before changing the invoked flow.",
                    )
                if uow.story_flow_nodes.get_for_node(
                    flow_id=candidate.source_flow_id, node_id=binding.target_node_id
                ) is None:
                    self._fail(
                        "composable_flow_member_not_found",
                        "Existing return target is not a member of the updated caller flow.",
                    )

    def _validate_exit(
        self, uow: UnitOfWork, candidate: FlowExitEntity, *, excluded_id: str | None = None
    ) -> None:
        self._require_project(uow, candidate.project_id)
        flow = self._require_flow(uow, candidate.flow_id, candidate.project_id)
        self._require_member(uow, flow, candidate.source_node_id)
        if any(
            item.flow_id == flow.id and item.key == candidate.key and item.id != excluded_id
            for item in self._exits(uow, candidate.project_id)
        ):
            self._fail("composable_flow_duplicate_exit_key", "Exit key must be unique within a flow.")
        has_transition = any(
            item.source_node_id == candidate.source_node_id
            for item in uow.flow_transitions.list(project_id=candidate.project_id, flow_id=flow.id)
        )
        has_invocation = any(
            item.source_flow_id == flow.id
            and item.source_node_id == candidate.source_node_id
            and item.id != excluded_id
            for item in self._invocations(uow, candidate.project_id)
        )
        if has_transition or has_invocation:
            self._fail("composable_flow_exit_not_terminal", "Exit source must be terminal.")
        if excluded_id is not None:
            invocations = {
                item.id: item for item in self._invocations(uow, candidate.project_id)
            }
            for binding in self._bindings(uow, candidate.project_id):
                if binding.exit_id != excluded_id:
                    continue
                invocation = invocations.get(binding.invocation_id)
                if invocation is None or invocation.target_flow_id != candidate.flow_id:
                    self._fail(
                        "composable_flow_binding_exit_mismatch",
                        "Update or remove existing bindings before moving an exit to another flow.",
                    )

    def _validate_binding(
        self, uow: UnitOfWork, candidate: FlowExitBindingEntity, *, excluded_id: str | None = None
    ) -> None:
        self._require_project(uow, candidate.project_id)
        invocation = self._require_invocation(uow, candidate.invocation_id, candidate.project_id)
        flow_exit = self._require_exit(uow, candidate.exit_id, candidate.project_id)
        if flow_exit.flow_id != invocation.target_flow_id:
            self._fail("composable_flow_binding_exit_mismatch", "Exit must belong to the invoked flow.")
        caller = self._require_flow(uow, invocation.source_flow_id, candidate.project_id)
        self._require_member(uow, caller, candidate.target_node_id)
        if any(
            item.invocation_id == candidate.invocation_id
            and item.exit_id == candidate.exit_id
            and item.id != excluded_id
            for item in self._bindings(uow, candidate.project_id)
        ):
            self._fail("composable_flow_duplicate_binding", "A call site may map an exit only once.")

    def _integrity_facts(
        self,
        project_id: str,
        reachable_flow_ids: set[str],
        flows: dict[str, StoryFlowEntity],
        memberships: Sequence[StoryFlowNodeEntity],
        transitions: Sequence[FlowTransitionEntity],
        invocations: Sequence[FlowInvocationEntity],
        exits: Sequence[FlowExitEntity],
        bindings: Sequence[FlowExitBindingEntity],
    ) -> list[ComposableIntegrityFact]:
        facts: list[ComposableIntegrityFact] = []
        member_pairs = {(item.flow_id, item.node_id) for item in memberships if item.project_id == project_id}
        calls = [item for item in invocations if item.source_flow_id in reachable_flow_ids]
        called_flow_ids = {item.target_flow_id for item in calls}
        for flow_id in sorted(reachable_flow_ids):
            flow = flows.get(flow_id)
            if flow is None:
                facts.append(self._fact("composable_flow_deleted_reference", flow_id=flow_id))
                continue
            if flow.entry_node_id is None or (flow.id, flow.entry_node_id) not in member_pairs:
                facts.append(self._fact("composable_flow_missing_entry", flow_id=flow.id))

        if self._has_cycle(calls):
            facts.append(self._fact("composable_flow_call_cycle"))

        priority_counts = Counter()
        default_counts = Counter()
        for item in transitions:
            if item.flow_id in reachable_flow_ids:
                priority_counts[(item.flow_id, item.source_node_id, item.priority)] += 1
                if item.is_default:
                    default_counts[(item.flow_id, item.source_node_id)] += 1
        for item in calls:
            if item.target_flow_id not in flows or (item.source_flow_id, item.source_node_id) not in member_pairs:
                facts.append(self._fact("composable_flow_deleted_reference", invocation_id=item.id))
            priority_counts[(item.source_flow_id, item.source_node_id, item.priority)] += 1
            if item.is_default:
                default_counts[(item.source_flow_id, item.source_node_id)] += 1
        for (flow_id, node_id, priority), count in sorted(priority_counts.items()):
            if count > 1 or default_counts[(flow_id, node_id)] > 1:
                facts.append(
                    self._fact(
                        "composable_flow_ambiguous_routes",
                        flow_id=flow_id,
                        node_id=node_id,
                        parameters={"priority": priority},
                    )
                )

        exits_by_flow: dict[str, list[FlowExitEntity]] = defaultdict(list)
        for item in exits:
            if item.flow_id in reachable_flow_ids:
                exits_by_flow[item.flow_id].append(item)
                if (item.flow_id, item.source_node_id) not in member_pairs:
                    facts.append(self._fact("composable_flow_deleted_reference", exit_id=item.id))
        binding_pairs = {(item.invocation_id, item.exit_id) for item in bindings}
        for call in calls:
            for flow_exit in exits_by_flow[call.target_flow_id]:
                if (call.id, flow_exit.id) not in binding_pairs:
                    facts.append(
                        self._fact(
                            "composable_flow_unbound_exit",
                            flow_id=call.target_flow_id,
                            invocation_id=call.id,
                            exit_id=flow_exit.id,
                        )
                    )
        for item in bindings:
            call = next((value for value in calls if value.id == item.invocation_id), None)
            flow_exit = next((value for value in exits if value.id == item.exit_id), None)
            if call is None or flow_exit is None or (call.source_flow_id, item.target_node_id) not in member_pairs:
                facts.append(self._fact("composable_flow_deleted_reference", binding_id=item.id))

        for flow_id in sorted(reachable_flow_ids):
            flow = flows.get(flow_id)
            if flow is None or flow.entry_node_id is None:
                continue
            reachable_nodes = self._reachable_nodes(
                flow.entry_node_id,
                [item for item in transitions if item.flow_id == flow_id],
            )
            reachable_exits = [item for item in exits_by_flow[flow_id] if item.source_node_id in reachable_nodes]
            for flow_exit in exits_by_flow[flow_id]:
                if flow_exit.source_node_id not in reachable_nodes:
                    facts.append(self._fact("composable_flow_unreachable_exit", flow_id=flow_id, exit_id=flow_exit.id))
            if flow_id in called_flow_ids and not reachable_exits:
                facts.append(self._fact("composable_flow_called_without_reachable_exit", flow_id=flow_id))
        return facts

    @staticmethod
    def _reachable_flow_ids(
        root_flow_id: str,
        flows: dict[str, StoryFlowEntity],
        invocations: Sequence[FlowInvocationEntity],
    ) -> set[str]:
        outgoing: dict[str, set[str]] = defaultdict(set)
        for item in invocations:
            outgoing[item.source_flow_id].add(item.target_flow_id)
        reachable: set[str] = set()
        queue = deque([root_flow_id])
        while queue:
            flow_id = queue.popleft()
            if flow_id in reachable:
                continue
            reachable.add(flow_id)
            queue.extend(sorted(outgoing[flow_id] - reachable))
        return reachable

    @staticmethod
    def _reachable_nodes(entry_id: str, transitions: Sequence[FlowTransitionEntity]) -> set[str]:
        outgoing: dict[str, set[str]] = defaultdict(set)
        for item in transitions:
            outgoing[item.source_node_id].add(item.target_node_id)
        reachable: set[str] = set()
        queue = deque([entry_id])
        while queue:
            node_id = queue.popleft()
            if node_id in reachable:
                continue
            reachable.add(node_id)
            queue.extend(sorted(outgoing[node_id] - reachable))
        return reachable

    @staticmethod
    def _has_cycle(invocations: Sequence[FlowInvocationEntity]) -> bool:
        outgoing: dict[str, set[str]] = defaultdict(set)
        for item in invocations:
            outgoing[item.source_flow_id].add(item.target_flow_id)
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(flow_id: str) -> bool:
            if flow_id in visiting:
                return True
            if flow_id in visited:
                return False
            visiting.add(flow_id)
            if any(visit(target) for target in sorted(outgoing[flow_id])):
                return True
            visiting.remove(flow_id)
            visited.add(flow_id)
            return False

        return any(visit(flow_id) for flow_id in sorted(outgoing))

    @staticmethod
    def _require_review(impact: CompositionDeletionImpact, reviewed: bool) -> None:
        if impact.has_impacts and not reviewed:
            raise StoryFlowServiceError(
                "composable_flow_delete_impact_review_required",
                "Review the current composition deletion impact before confirming.",
            )

    @staticmethod
    def _fact(code: str, **values: object) -> ComposableIntegrityFact:
        return ComposableIntegrityFact(code=code, level="error", **values)

    @staticmethod
    def _fact_key(fact: ComposableIntegrityFact) -> tuple[str, ...]:
        return (
            fact.code,
            fact.flow_id or "",
            fact.node_id or "",
            fact.invocation_id or "",
            fact.exit_id or "",
            fact.binding_id or "",
        )

    @staticmethod
    def _invocations(uow: UnitOfWork, project_id: str) -> list[FlowInvocationEntity]:
        return sorted(uow.flow_invocations.list(project_id=project_id), key=lambda item: item.id)

    @staticmethod
    def _exits(uow: UnitOfWork, project_id: str) -> list[FlowExitEntity]:
        return sorted(uow.flow_exits.list(project_id=project_id), key=lambda item: item.id)

    @staticmethod
    def _bindings(uow: UnitOfWork, project_id: str) -> list[FlowExitBindingEntity]:
        return sorted(uow.flow_exit_bindings.list(project_id=project_id), key=lambda item: item.id)

    @staticmethod
    def _require_project(uow: UnitOfWork, project_id: str) -> None:
        if uow.projects.get(project_id) is None:
            raise StoryFlowServiceError("composable_flow_project_not_found", f"Project not found: {project_id}")

    def _require_flow(
        self, uow: UnitOfWork, flow_id: str, project_id: str | None = None
    ) -> StoryFlowEntity:
        flow = uow.story_flows.get(flow_id)
        if flow is None or (project_id is not None and flow.project_id != project_id):
            raise StoryFlowServiceError("composable_flow_flow_not_found", f"Story Flow not found: {flow_id}")
        return flow

    @staticmethod
    def _require_member(uow: UnitOfWork, flow: StoryFlowEntity, node_id: str) -> StoryFlowNodeEntity:
        member = uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node_id)
        if member is None:
            raise StoryFlowServiceError(
                "composable_flow_member_not_found", f"Flow member not found: {flow.id}/{node_id}"
            )
        return member

    def _require_invocation(
        self, uow: UnitOfWork, invocation_id: str, project_id: str | None = None
    ) -> FlowInvocationEntity:
        item = uow.flow_invocations.get(invocation_id)
        if item is None or (project_id is not None and item.project_id != project_id):
            self._fail("composable_flow_invocation_not_found", f"Invocation not found: {invocation_id}")
        return item

    def _require_exit(
        self, uow: UnitOfWork, exit_id: str, project_id: str | None = None
    ) -> FlowExitEntity:
        item = uow.flow_exits.get(exit_id)
        if item is None or (project_id is not None and item.project_id != project_id):
            self._fail("composable_flow_exit_not_found", f"Exit not found: {exit_id}")
        return item

    def _require_binding(
        self, uow: UnitOfWork, binding_id: str, project_id: str | None = None
    ) -> FlowExitBindingEntity:
        item = uow.flow_exit_bindings.get(binding_id)
        if item is None or (project_id is not None and item.project_id != project_id):
            self._fail("composable_flow_binding_not_found", f"Binding not found: {binding_id}")
        return item

    @staticmethod
    def _fail(code: str, message: str):
        raise StoryFlowServiceError(code, message)

    @staticmethod
    def _invocation(item: FlowInvocationEntity) -> FlowInvocation:
        return FlowInvocation(**{name: getattr(item, name) for name in item.__dataclass_fields__})

    @staticmethod
    def _exit(item: FlowExitEntity) -> FlowExit:
        return FlowExit(**{name: getattr(item, name) for name in item.__dataclass_fields__})

    @staticmethod
    def _binding(item: FlowExitBindingEntity) -> FlowExitBinding:
        return FlowExitBinding(**{name: getattr(item, name) for name in item.__dataclass_fields__})
