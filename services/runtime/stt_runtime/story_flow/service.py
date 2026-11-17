from __future__ import annotations

from dataclasses import replace

from ..domain.entities import (
    FlowTransitionEntity,
    NodeEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    VisualPlacementEntity,
    new_entity_id,
    utc_now,
)
from ..engine_tags.automatic import add_node_with_automatic_tag
from ..composition.service import ROOT_SCOPE_KEY
from ..project_format.interchange import normalize_story_flow_name
from ..repositories.interfaces import UnitOfWork
from ..schemas.story_flow import (
    StoryFlow,
    StoryFlowDeletionImpact,
    StoryFlowNode,
    StoryFlowNodeDeletionImpact,
    StoryFlowSnapshot,
)
from .presenters import (
    boundary_response,
    flow_response,
    membership_response,
    node_response,
    placement_response,
    transition_response,
)
from ..schemas.story_flow_api import (
    ContinueExistingNode,
    ContinueNewNode,
    FlowTransitionCreate,
    FlowTransitionOrderUpdate,
    FlowTransitionFields,
    FlowTransitionUpdate,
    SceneFlowBoundaryUpsert,
    StoryFlowContinuationResponse,
    StoryFlowBootstrapCreate,
    StoryFlowBootstrapResponse,
    StoryFlowCreate,
    StoryFlowEntryUpdate,
    StoryFlowMembershipCreate,
    StoryFlowUpdate,
)


class StoryFlowServiceError(ValueError):
    """Carries stable Story Flow validation codes to API adapters."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class StoryFlowService:
    """Owns Story Flow invariants and transaction boundaries."""

    _flow_response = staticmethod(flow_response)
    _membership_response = staticmethod(membership_response)
    _transition_response = staticmethod(transition_response)
    _boundary_response = staticmethod(boundary_response)
    _node_response = staticmethod(node_response)
    _placement_response = staticmethod(placement_response)

    def create(self, uow: UnitOfWork, payload: StoryFlowCreate) -> StoryFlow:
        self._require_project(uow, payload.project_id)
        self._require_available_name(uow, payload.project_id, payload.name)
        if payload.status == "active":
            raise StoryFlowServiceError(
                "story_flow_invalid_entry",
                "An empty Story Flow cannot be active before an entry member is set.",
            )
        flow = uow.story_flows.add(
            StoryFlowEntity(
                project_id=payload.project_id,
                name=payload.name.strip(),
                normalized_name=normalize_story_flow_name(payload.name),
                description=payload.description,
                kind=payload.kind,
                status=payload.status,
                metadata=payload.metadata,
            )
        )
        uow.commit()
        return self._flow_response(flow)

    def bootstrap(self, uow: UnitOfWork, payload: StoryFlowBootstrapCreate) -> StoryFlowBootstrapResponse:
        """Create the first placed node and active Main Story as one authoring command."""

        self._require_project(uow, payload.project_id)
        self._require_available_name(uow, payload.project_id, payload.flow_name)
        node_id = new_entity_id()
        placement_id = new_entity_id()
        node_metadata = {
            **payload.node.metadata,
            "position": payload.position.model_dump(),
            "width": payload.size.width,
            "height": payload.size.height,
            "root_placement_id": placement_id,
            **({"composition_frame": True} if payload.node.type == "Scene" else {}),
        }
        node = NodeEntity(
            id=node_id,
            project_id=payload.project_id,
            type=payload.node.type,
            title=payload.node.title,
            summary=payload.node.summary,
            body=payload.node.body,
            status=payload.node.status,
            metadata=node_metadata,
        )
        placement = VisualPlacementEntity(
            id=placement_id,
            project_id=payload.project_id,
            canonical_node_id=node_id,
            scope_key=ROOT_SCOPE_KEY,
            x=payload.position.x,
            y=payload.position.y,
            width=payload.size.width,
            height=payload.size.height,
            is_primary=True,
            metadata={"created_with_story_flow_bootstrap": True},
        )
        flow = StoryFlowEntity(
            project_id=payload.project_id,
            name=payload.flow_name.strip(),
            normalized_name=normalize_story_flow_name(payload.flow_name),
            description=payload.flow_description,
            kind="main",
            status="active",
            entry_node_id=node_id,
            metadata={"created_with_empty_project_workflow": True},
        )
        membership = StoryFlowNodeEntity(
            project_id=payload.project_id,
            flow_id=flow.id,
            node_id=node_id,
            presentation_order=0,
            metadata={"created_with_empty_project_workflow": True},
        )
        try:
            saved_node = add_node_with_automatic_tag(uow, node)
            saved_placement = uow.visual_placements.add(placement)
            saved_flow = uow.story_flows.add(flow)
            saved_membership = uow.story_flow_nodes.add(membership)
            uow.commit()
        except Exception:
            # Starter records are unusable independently and must roll back together.
            uow.rollback()
            raise
        return StoryFlowBootstrapResponse(
            node=self._node_response(saved_node),
            placement=self._placement_response(saved_placement),
            membership=self._membership_response(saved_membership),
            snapshot=self._snapshot(uow, saved_flow),
        )

    def list(self, uow: UnitOfWork, project_id: str) -> list[StoryFlow]:
        self._require_project(uow, project_id)
        flows = sorted(uow.story_flows.list(project_id=project_id), key=lambda item: (item.created_at, item.id))
        return [self._flow_response(flow) for flow in flows]

    def snapshot(self, uow: UnitOfWork, flow_id: str) -> StoryFlowSnapshot:
        return self._snapshot(uow, self._require_flow(uow, flow_id))

    def update(self, uow: UnitOfWork, flow_id: str, payload: StoryFlowUpdate) -> StoryFlowSnapshot:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        self._require_available_name(uow, payload.project_id, payload.name, excluded_flow_id=flow.id)
        if payload.status == "active":
            self._require_valid_entry(uow, flow)
        saved = uow.story_flows.update(
            replace(
                flow,
                name=payload.name.strip(),
                normalized_name=normalize_story_flow_name(payload.name),
                description=payload.description,
                kind=payload.kind,
                status=payload.status,
                metadata=payload.metadata,
                updated_at=utc_now(),
            )
        )
        uow.commit()
        return self._snapshot(uow, saved)

    def archive(self, uow: UnitOfWork, flow_id: str, project_id: str) -> StoryFlow:
        flow = self._require_flow_project(uow, flow_id, project_id)
        saved = uow.story_flows.update(replace(flow, status="archived", updated_at=utc_now()))
        uow.commit()
        return self._flow_response(saved)

    def deletion_impact(self, uow: UnitOfWork, flow_id: str) -> StoryFlowDeletionImpact:
        flow = self._require_flow(uow, flow_id)
        invocations = [
            item
            for item in uow.flow_invocations.list(project_id=flow.project_id)
            if item.source_flow_id == flow.id or item.target_flow_id == flow.id
        ]
        exits = uow.flow_exits.list(project_id=flow.project_id, flow_id=flow.id)
        invocation_ids = {item.id for item in invocations}
        exit_ids = {item.id for item in exits}
        bindings = [
            item
            for item in uow.flow_exit_bindings.list(project_id=flow.project_id)
            if item.invocation_id in invocation_ids or item.exit_id in exit_ids
        ]
        return StoryFlowDeletionImpact(
            flow_id=flow.id,
            membership_count=len(uow.story_flow_nodes.list(project_id=flow.project_id, flow_id=flow.id)),
            transition_count=len(uow.flow_transitions.list(project_id=flow.project_id, flow_id=flow.id)),
            scene_boundary_count=len(uow.scene_flow_boundaries.list(project_id=flow.project_id, flow_id=flow.id)),
            invocation_ids=sorted(invocation_ids),
            exit_ids=sorted(exit_ids),
            binding_ids=sorted(item.id for item in bindings),
            agent_memory_ids=sorted(
                memory.id
                for memory in uow.agent_memories.list_for_owner(
                    project_id=flow.project_id,
                    owner_kind="story_flow",
                    owner_id=flow.id,
                )
            ),
        )

    def delete(self, uow: UnitOfWork, flow_id: str, *, confirmed: bool) -> None:
        flow = self._require_flow(uow, flow_id)
        if not confirmed:
            raise StoryFlowServiceError(
                "story_flow_delete_confirmation_required",
                "Preview Story Flow deletion impact and confirm the destructive operation.",
            )
        impact = self.deletion_impact(uow, flow.id)
        try:
            # Phase 3.10 references are removed in dependency order after the
            # caller reviewed the complete flow impact.
            for binding_id in impact.binding_ids:
                uow.flow_exit_bindings.delete(binding_id)
            for exit_id in impact.exit_ids:
                uow.flow_exits.delete(exit_id)
            for invocation_id in impact.invocation_ids:
                uow.flow_invocations.delete(invocation_id)
            for memory_id in impact.agent_memory_ids:
                uow.agent_memories.delete(memory_id)
            uow.story_flows.delete(flow_id)
            uow.commit()
        except Exception:
            uow.rollback()
            raise

    def add_membership(
        self,
        uow: UnitOfWork,
        flow_id: str,
        payload: StoryFlowMembershipCreate,
    ) -> StoryFlowSnapshot:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        node = self._require_project_node(uow, payload.node_id, flow.project_id)
        is_first_member = not self._flow_memberships(uow, flow)
        self._add_membership_record(
            uow,
            flow,
            node,
            presentation_order=payload.presentation_order,
            metadata=payload.metadata,
        )
        if is_first_member and flow.entry_node_id is None:
            # First membership and entry are one command so an active flow never becomes invalid.
            flow = uow.story_flows.update(replace(flow, entry_node_id=node.id, updated_at=utc_now()))
        uow.commit()
        return self._snapshot(uow, flow)

    def set_entry(
        self,
        uow: UnitOfWork,
        flow_id: str,
        payload: StoryFlowEntryUpdate,
    ) -> StoryFlowSnapshot:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        self._require_project_node(uow, payload.node_id, flow.project_id)
        if uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=payload.node_id) is None:
            raise StoryFlowServiceError(
                "story_flow_invalid_entry",
                "Story Flow entry must be an existing member of the same flow.",
            )
        saved = uow.story_flows.update(replace(flow, entry_node_id=payload.node_id, updated_at=utc_now()))
        uow.commit()
        return self._snapshot(uow, saved)

    def membership_deletion_impact(
        self,
        uow: UnitOfWork,
        flow_id: str,
        node_id: str,
    ) -> StoryFlowNodeDeletionImpact:
        flow = self._require_flow(uow, flow_id)
        self._require_membership(uow, flow, node_id)
        transitions = self._flow_transitions(uow, flow)
        boundaries = self._flow_boundaries(uow, flow)
        invocations = [
            item
            for item in uow.flow_invocations.list(project_id=flow.project_id)
            if item.source_flow_id == flow.id and item.source_node_id == node_id
        ]
        exits = [
            item
            for item in uow.flow_exits.list(project_id=flow.project_id, flow_id=flow.id)
            if item.source_node_id == node_id
        ]
        invocation_ids = {item.id for item in invocations}
        exit_ids = {item.id for item in exits}
        bindings = [
            item
            for item in uow.flow_exit_bindings.list(project_id=flow.project_id)
            if item.invocation_id in invocation_ids
            or item.exit_id in exit_ids
            or (
                item.target_node_id == node_id
                and (invocation := uow.flow_invocations.get(item.invocation_id)) is not None
                and invocation.source_flow_id == flow.id
            )
        ]
        return StoryFlowNodeDeletionImpact(
            flow_id=flow.id,
            node_id=node_id,
            transition_ids=[
                item.id
                for item in transitions
                if item.source_node_id == node_id or item.target_node_id == node_id
            ],
            scene_boundary_ids=[
                item.id
                for item in boundaries
                if item.scene_node_id == node_id
                or item.entry_node_id == node_id
                or node_id in item.exit_node_ids
            ],
            invocation_ids=sorted(invocation_ids),
            exit_ids=sorted(exit_ids),
            binding_ids=sorted(item.id for item in bindings),
            removes_entry=flow.entry_node_id == node_id,
        )

    def remove_membership(
        self,
        uow: UnitOfWork,
        flow_id: str,
        node_id: str,
        *,
        confirmed: bool,
    ) -> StoryFlowSnapshot:
        flow = self._require_flow(uow, flow_id)
        membership = self._require_membership(uow, flow, node_id)
        if not confirmed:
            raise StoryFlowServiceError(
                "story_flow_membership_delete_confirmation_required",
                "Preview membership deletion impact and confirm the destructive operation.",
            )
        impact = self.membership_deletion_impact(uow, flow.id, node_id)
        try:
            for binding_id in impact.binding_ids:
                uow.flow_exit_bindings.delete(binding_id)
            for exit_id in impact.exit_ids:
                uow.flow_exits.delete(exit_id)
            for invocation_id in impact.invocation_ids:
                uow.flow_invocations.delete(invocation_id)
            for transition_id in impact.transition_ids:
                uow.flow_transitions.delete(transition_id)
            for boundary_id in impact.scene_boundary_ids:
                uow.scene_flow_boundaries.delete(boundary_id)
            if impact.removes_entry:
                # An active flow cannot survive without an entry. Returning it to
                # draft keeps the remaining authored order without inventing one.
                flow = uow.story_flows.update(
                    replace(
                        flow,
                        entry_node_id=None,
                        status="draft" if flow.status == "active" else flow.status,
                        updated_at=utc_now(),
                    )
                )
            uow.story_flow_nodes.delete(membership.id)
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return self._snapshot(uow, flow)

    def create_transition(
        self,
        uow: UnitOfWork,
        flow_id: str,
        payload: FlowTransitionCreate,
    ) -> FlowTransition:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        transition = self._add_transition_record(uow, flow, payload)
        uow.commit()
        return self._transition_response(transition)

    def update_transition(
        self,
        uow: UnitOfWork,
        flow_id: str,
        transition_id: str,
        payload: FlowTransitionUpdate,
    ) -> FlowTransition:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        existing = self._require_transition(uow, flow, transition_id)
        self._validate_transition(uow, flow, payload, excluded_transition_id=existing.id)
        saved = uow.flow_transitions.update(
            replace(
                existing,
                source_node_id=payload.source_node_id,
                target_node_id=payload.target_node_id,
                kind=payload.kind,
                label=payload.label,
                condition=payload.condition,
                priority=payload.priority,
                is_default=payload.is_default,
                metadata=payload.metadata,
                updated_at=utc_now(),
            )
        )
        uow.commit()
        return self._transition_response(saved)

    def delete_transition(self, uow: UnitOfWork, flow_id: str, transition_id: str) -> None:
        flow = self._require_flow(uow, flow_id)
        self._require_transition(uow, flow, transition_id)
        uow.flow_transitions.delete(transition_id)
        uow.commit()

    def reorder_transitions(
        self,
        uow: UnitOfWork,
        flow_id: str,
        payload: FlowTransitionOrderUpdate,
    ) -> StoryFlowSnapshot:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        siblings = [
            item
            for item in self._flow_transitions(uow, flow)
            if item.source_node_id == payload.source_node_id
        ]
        expected_ids = {item.id for item in siblings}
        supplied_ids = payload.transition_ids
        if len(supplied_ids) != len(set(supplied_ids)) or set(supplied_ids) != expected_ids:
            raise StoryFlowServiceError(
                "story_flow_transition_order_invalid",
                "Transition order must contain every outgoing transition exactly once.",
            )
        uow.flow_transitions.reorder(
            flow_id=flow.id,
            source_node_id=payload.source_node_id,
            transition_ids=supplied_ids,
        )
        uow.commit()
        return self._snapshot(uow, flow)

    def upsert_scene_boundary(
        self,
        uow: UnitOfWork,
        flow_id: str,
        scene_node_id: str,
        payload: SceneFlowBoundaryUpsert,
    ) -> StoryFlowSnapshot:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        self._validate_scene_boundary(uow, flow, scene_node_id, payload)
        existing = uow.scene_flow_boundaries.get_for_scene(flow_id=flow.id, scene_node_id=scene_node_id)
        if existing is None:
            uow.scene_flow_boundaries.add(
                SceneFlowBoundaryEntity(
                    project_id=flow.project_id,
                    flow_id=flow.id,
                    scene_node_id=scene_node_id,
                    entry_node_id=payload.entry_node_id,
                    exit_node_ids=payload.exit_node_ids,
                    metadata=payload.metadata,
                )
            )
        else:
            uow.scene_flow_boundaries.update(
                replace(
                    existing,
                    entry_node_id=payload.entry_node_id,
                    exit_node_ids=payload.exit_node_ids,
                    metadata=payload.metadata,
                    updated_at=utc_now(),
                )
            )
        uow.commit()
        return self._snapshot(uow, flow)

    def delete_scene_boundary(self, uow: UnitOfWork, flow_id: str, scene_node_id: str) -> None:
        flow = self._require_flow(uow, flow_id)
        boundary = uow.scene_flow_boundaries.get_for_scene(flow_id=flow.id, scene_node_id=scene_node_id)
        if boundary is None:
            raise StoryFlowServiceError(
                "story_flow_boundary_not_found",
                f"Scene Flow boundary not found: {scene_node_id}",
            )
        uow.scene_flow_boundaries.delete(boundary.id)
        uow.commit()

    def continue_existing(
        self,
        uow: UnitOfWork,
        flow_id: str,
        payload: ContinueExistingNode,
    ) -> StoryFlowContinuationResponse:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        source = self._require_project_node(uow, payload.source_node_id, flow.project_id)
        node = self._require_project_node(uow, payload.target_node_id, flow.project_id)
        try:
            # Specialized Dialogue and Quest outcomes can join a flow as one
            # aggregate command, so neither endpoint may be persisted alone.
            if uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=source.id) is None:
                is_first_member = not self._flow_memberships(uow, flow)
                self._add_membership_record(
                    uow,
                    flow,
                    source,
                    presentation_order=None,
                    metadata={"specialized_outcome_source": True},
                )
                if is_first_member and flow.entry_node_id is None:
                    flow = uow.story_flows.update(
                        replace(flow, entry_node_id=source.id, updated_at=utc_now())
                    )
            membership = uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node.id)
            if membership is None:
                membership = self._add_membership_record(
                    uow,
                    flow,
                    node,
                    presentation_order=payload.presentation_order,
                    metadata=payload.membership_metadata,
                )
            transition_payload = self._continuation_transition(
                payload.project_id,
                payload.source_node_id,
                node.id,
                payload.transition,
            )
            semantic_edge_id = payload.transition.metadata.get("semantic_edge_id")
            existing_transition = next(
                (
                    item
                    for item in self._flow_transitions(uow, flow)
                    if semantic_edge_id
                    and item.metadata.get("semantic_edge_id") == semantic_edge_id
                ),
                None,
            )
            if existing_transition is None:
                transition = self._add_transition_record(uow, flow, transition_payload)
            else:
                self._validate_transition(
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
                        priority=transition_payload.priority,
                        is_default=transition_payload.is_default,
                        metadata=transition_payload.metadata,
                        updated_at=utc_now(),
                    )
                )
            uow.commit()
        except Exception:
            uow.rollback()
            raise
        return self._continuation_response(uow, flow, node, membership, transition)

    def continue_new(
        self,
        uow: UnitOfWork,
        flow_id: str,
        payload: ContinueNewNode,
    ) -> StoryFlowContinuationResponse:
        flow = self._require_flow_project(uow, flow_id, payload.project_id)
        self._require_membership(uow, flow, payload.source_node_id)
        try:
            node = add_node_with_automatic_tag(
                uow,
                NodeEntity(
                    id=new_entity_id(),
                    project_id=flow.project_id,
                    type=payload.node.type,
                    title=payload.node.title,
                    summary=payload.node.summary,
                    body=payload.node.body,
                    status=payload.node.status,
                    metadata=payload.node.metadata,
                )
            )
            membership = self._add_membership_record(
                uow,
                flow,
                node,
                presentation_order=payload.presentation_order,
                metadata=payload.membership_metadata,
            )
            transition = self._add_transition_record(
                uow,
                flow,
                self._continuation_transition(payload.project_id, payload.source_node_id, node.id, payload.transition),
            )
            uow.commit()
        except Exception:
            # Node, membership, and transition are one authoring command.
            uow.rollback()
            raise
        return self._continuation_response(uow, flow, node, membership, transition)

    def _add_membership_record(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        node: NodeEntity,
        *,
        presentation_order: int | None,
        metadata: dict[str, object],
    ) -> StoryFlowNodeEntity:
        if uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node.id) is not None:
            raise StoryFlowServiceError(
                "story_flow_duplicate_membership",
                f"Node is already a member of Story Flow: {node.id}",
            )
        memberships = self._flow_memberships(uow, flow)
        order = self._next_presentation_order(memberships) if presentation_order is None else presentation_order
        if any(item.presentation_order == order for item in memberships):
            raise StoryFlowServiceError(
                "story_flow_duplicate_presentation_order",
                f"Story Flow presentation order is already used: {order}",
            )
        return uow.story_flow_nodes.add(
            StoryFlowNodeEntity(
                project_id=flow.project_id,
                flow_id=flow.id,
                node_id=node.id,
                presentation_order=order,
                metadata=dict(metadata),
            )
        )

    def _add_transition_record(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        payload: FlowTransitionCreate,
    ) -> FlowTransitionEntity:
        self._validate_transition(uow, flow, payload)
        return uow.flow_transitions.add(
            FlowTransitionEntity(
                project_id=flow.project_id,
                flow_id=flow.id,
                source_node_id=payload.source_node_id,
                target_node_id=payload.target_node_id,
                kind=payload.kind,
                label=payload.label,
                condition=payload.condition,
                priority=payload.priority,
                is_default=payload.is_default,
                metadata=payload.metadata,
            )
        )

    def _validate_transition(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        payload: FlowTransitionCreate,
        *,
        excluded_transition_id: str | None = None,
    ) -> None:
        if payload.project_id != flow.project_id:
            raise StoryFlowServiceError(
                "story_flow_cross_project",
                "Flow transition belongs to another project.",
            )
        if payload.source_node_id == payload.target_node_id:
            raise StoryFlowServiceError(
                "story_flow_stale_endpoint",
                "Flow transition endpoints must be distinct current members.",
            )
        for node_id in (payload.source_node_id, payload.target_node_id):
            node = uow.nodes.get(node_id)
            membership = uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node_id)
            if node is None or node.project_id != flow.project_id or membership is None:
                raise StoryFlowServiceError(
                    "story_flow_stale_endpoint",
                    f"Flow transition endpoint is missing or no longer a member: {node_id}",
                )
        if payload.is_default and payload.condition.strip():
            raise StoryFlowServiceError(
                "story_flow_invalid_default",
                "A default transition cannot have a condition.",
            )
        if payload.kind == "branch" and not payload.is_default and not payload.condition.strip():
            raise StoryFlowServiceError(
                "story_flow_invalid_default",
                "A non-default branch requires a readable condition.",
            )
        siblings = [
            item
            for item in self._flow_transitions(uow, flow)
            if item.source_node_id == payload.source_node_id and item.id != excluded_transition_id
        ]
        invocation_siblings = [
            item
            for item in uow.flow_invocations.list(
                project_id=flow.project_id, source_flow_id=flow.id
            )
            if item.source_node_id == payload.source_node_id
        ]
        if any(item.priority == payload.priority for item in [*siblings, *invocation_siblings]):
            raise StoryFlowServiceError(
                "story_flow_duplicate_priority",
                f"Transition priority is already used from source: {payload.priority}",
            )
        if payload.is_default and any(item.is_default for item in [*siblings, *invocation_siblings]):
            raise StoryFlowServiceError(
                "story_flow_invalid_default",
                "Only one default transition is allowed from a source node.",
            )
        if any(
            item.source_node_id == payload.source_node_id
            for item in uow.flow_exits.list(project_id=flow.project_id, flow_id=flow.id)
        ):
            raise StoryFlowServiceError(
                "composable_flow_exit_not_terminal",
                "An exit source cannot also have an outgoing transition.",
            )

    def _validate_scene_boundary(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        scene_node_id: str,
        payload: SceneFlowBoundaryUpsert,
    ) -> None:
        scene = self._require_project_node(uow, scene_node_id, flow.project_id)
        if scene.type != "Scene":
            raise StoryFlowServiceError(
                "story_flow_invalid_scene_boundary",
                "Scene Flow boundary owner must be a Scene node.",
            )
        references = [payload.entry_node_id, *payload.exit_node_ids]
        if len(set(payload.exit_node_ids)) != len(payload.exit_node_ids) or scene_node_id in references:
            raise StoryFlowServiceError(
                "story_flow_invalid_scene_boundary",
                "Scene Flow boundary requires unique child entry and exit references.",
            )
        for node_id in [scene_node_id, *references]:
            self._require_project_node(uow, node_id, flow.project_id)
            if uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node_id) is None:
                raise StoryFlowServiceError(
                    "story_flow_invalid_scene_boundary",
                    f"Scene Flow boundary reference is not a flow member: {node_id}",
                )
        child_ids = {
            placement.canonical_node_id
            for placement in uow.visual_placements.list(project_id=flow.project_id)
            if placement.container_node_id == scene_node_id
        }
        if not set(references).issubset(child_ids):
            raise StoryFlowServiceError(
                "story_flow_invalid_scene_boundary",
                "Scene Flow boundary entry and exits must be canonical children of the Scene.",
            )

    def _snapshot(self, uow: UnitOfWork, flow: StoryFlowEntity) -> StoryFlowSnapshot:
        memberships = sorted(
            self._flow_memberships(uow, flow),
            key=lambda item: (item.presentation_order, item.created_at, item.id),
        )
        transitions = sorted(
            self._flow_transitions(uow, flow),
            key=lambda item: (item.source_node_id, item.priority, item.created_at, item.id),
        )
        boundaries = sorted(
            self._flow_boundaries(uow, flow),
            key=lambda item: (item.scene_node_id, item.created_at, item.id),
        )
        placements = uow.visual_placements.list(project_id=flow.project_id)
        return StoryFlowSnapshot(
            flow=self._flow_response(flow),
            nodes=[self._membership_response(item) for item in memberships],
            transitions=[self._transition_response(item) for item in transitions],
            scene_boundaries=[self._boundary_response(item) for item in boundaries],
            scene_children={
                boundary.scene_node_id: [
                    placement.canonical_node_id
                    for placement in placements
                    if placement.container_node_id == boundary.scene_node_id
                ]
                for boundary in boundaries
            },
        )

    def _continuation_response(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        node: NodeEntity,
        membership: StoryFlowNodeEntity,
        transition: FlowTransitionEntity,
    ) -> StoryFlowContinuationResponse:
        return StoryFlowContinuationResponse(
            node=self._node_response(node),
            membership=self._membership_response(membership),
            transition=self._transition_response(transition),
            snapshot=self._snapshot(uow, flow),
        )

    @staticmethod
    def _continuation_transition(
        project_id: str,
        source_node_id: str,
        target_node_id: str,
        fields: FlowTransitionFields,
    ) -> FlowTransitionCreate:
        return FlowTransitionCreate(
            project_id=project_id,
            source_node_id=source_node_id,
            target_node_id=target_node_id,
            **fields.model_dump(),
        )

    def _require_project(self, uow: UnitOfWork, project_id: str) -> None:
        if uow.projects.get(project_id) is None:
            raise StoryFlowServiceError(
                "story_flow_project_not_found",
                f"Project not found: {project_id}",
            )

    def _require_flow(self, uow: UnitOfWork, flow_id: str) -> StoryFlowEntity:
        flow = uow.story_flows.get(flow_id)
        if flow is None:
            raise StoryFlowServiceError(
                "story_flow_not_found",
                f"Story Flow not found: {flow_id}",
            )
        return flow

    def _require_flow_project(self, uow: UnitOfWork, flow_id: str, project_id: str) -> StoryFlowEntity:
        flow = self._require_flow(uow, flow_id)
        if flow.project_id != project_id:
            raise StoryFlowServiceError(
                "story_flow_cross_project",
                "Story Flow belongs to another project.",
            )
        return flow

    def _require_project_node(self, uow: UnitOfWork, node_id: str, project_id: str) -> NodeEntity:
        node = uow.nodes.get(node_id)
        if node is None:
            raise StoryFlowServiceError(
                "story_flow_node_not_found",
                f"Canonical node not found: {node_id}",
            )
        if node.project_id != project_id:
            raise StoryFlowServiceError(
                "story_flow_cross_project",
                f"Canonical node belongs to another project: {node_id}",
            )
        return node

    def _require_membership(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        node_id: str,
    ) -> StoryFlowNodeEntity:
        membership = uow.story_flow_nodes.get_for_node(flow_id=flow.id, node_id=node_id)
        if membership is None:
            raise StoryFlowServiceError(
                "story_flow_membership_not_found",
                f"Story Flow membership not found for node: {node_id}",
            )
        return membership

    def _require_transition(
        self,
        uow: UnitOfWork,
        flow: StoryFlowEntity,
        transition_id: str,
    ) -> FlowTransitionEntity:
        transition = uow.flow_transitions.get(transition_id)
        if transition is None or transition.flow_id != flow.id:
            raise StoryFlowServiceError(
                "story_flow_transition_not_found",
                f"Flow transition not found: {transition_id}",
            )
        return transition

    def _require_available_name(
        self,
        uow: UnitOfWork,
        project_id: str,
        name: str,
        *,
        excluded_flow_id: str | None = None,
    ) -> None:
        normalized = normalize_story_flow_name(name)
        if any(
            flow.normalized_name == normalized and flow.id != excluded_flow_id
            for flow in uow.story_flows.list(project_id=project_id)
        ):
            raise StoryFlowServiceError(
                "story_flow_duplicate_name",
                f"Story Flow name is already used in this project: {name.strip()}",
            )

    def _require_valid_entry(self, uow: UnitOfWork, flow: StoryFlowEntity) -> None:
        memberships = self._flow_memberships(uow, flow)
        if not memberships or flow.entry_node_id is None:
            raise StoryFlowServiceError(
                "story_flow_invalid_entry",
                "An active Story Flow requires at least one member and an entry.",
            )
        if not any(item.node_id == flow.entry_node_id for item in memberships):
            raise StoryFlowServiceError(
                "story_flow_invalid_entry",
                "Story Flow entry must be a current member.",
            )

    @staticmethod
    def _next_presentation_order(memberships: list[StoryFlowNodeEntity]) -> int:
        return max((item.presentation_order for item in memberships), default=-1) + 1

    @staticmethod
    def _flow_memberships(uow: UnitOfWork, flow: StoryFlowEntity) -> list[StoryFlowNodeEntity]:
        return list(uow.story_flow_nodes.list(project_id=flow.project_id, flow_id=flow.id))

    @staticmethod
    def _flow_transitions(uow: UnitOfWork, flow: StoryFlowEntity) -> list[FlowTransitionEntity]:
        return list(uow.flow_transitions.list(project_id=flow.project_id, flow_id=flow.id))

    @staticmethod
    def _flow_boundaries(uow: UnitOfWork, flow: StoryFlowEntity) -> list[SceneFlowBoundaryEntity]:
        return list(uow.scene_flow_boundaries.list(project_id=flow.project_id, flow_id=flow.id))
