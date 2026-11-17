from ..domain.entities import (
    FlowTransitionEntity,
    NodeEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
    VisualPlacementEntity,
)
from ..schemas.composition import VisualPlacement
from ..schemas.resources import NodeResponse
from ..schemas.story_flow import FlowTransition, SceneFlowBoundary, StoryFlow, StoryFlowNode


def flow_response(entity: StoryFlowEntity) -> StoryFlow:
    """Project a persisted Story Flow without adding service-owned behavior."""

    return StoryFlow(
        id=entity.id,
        project_id=entity.project_id,
        name=entity.name,
        description=entity.description,
        kind=entity.kind,
        status=entity.status,
        entry_node_id=entity.entry_node_id,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def membership_response(entity: StoryFlowNodeEntity) -> StoryFlowNode:
    """Project one canonical-node membership in stable schema form."""

    return StoryFlowNode(
        id=entity.id,
        project_id=entity.project_id,
        flow_id=entity.flow_id,
        node_id=entity.node_id,
        presentation_order=entity.presentation_order,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def transition_response(entity: FlowTransitionEntity) -> FlowTransition:
    """Project one ordered executable transition without normalization."""

    return FlowTransition(
        id=entity.id,
        project_id=entity.project_id,
        flow_id=entity.flow_id,
        source_node_id=entity.source_node_id,
        target_node_id=entity.target_node_id,
        kind=entity.kind,
        label=entity.label,
        condition=entity.condition,
        priority=entity.priority,
        is_default=entity.is_default,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def boundary_response(entity: SceneFlowBoundaryEntity) -> SceneFlowBoundary:
    """Project a Scene execution boundary while preserving authored exit order."""

    return SceneFlowBoundary(
        id=entity.id,
        project_id=entity.project_id,
        flow_id=entity.flow_id,
        scene_node_id=entity.scene_node_id,
        entry_node_id=entity.entry_node_id,
        exit_node_ids=entity.exit_node_ids,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def node_response(entity: NodeEntity) -> NodeResponse:
    """Project a canonical node created by Story Flow continuation."""

    return NodeResponse(
        id=entity.id,
        project_id=entity.project_id,
        type=entity.type,
        title=entity.title,
        summary=entity.summary,
        body=entity.body,
        status=entity.status,
        metadata=entity.metadata,
        created_at=entity.created_at,
        updated_at=entity.updated_at,
    )


def placement_response(entity: VisualPlacementEntity) -> VisualPlacement:
    """Project the visual placement created by Story Flow bootstrap."""

    return VisualPlacement(
        id=entity.id,
        project_id=entity.project_id,
        container_node_id=entity.container_node_id,
        canonical_node_id=entity.canonical_node_id,
        position={"x": entity.x, "y": entity.y},
        size={"width": entity.width, "height": entity.height},
        is_primary=entity.is_primary,
        presentation_state=entity.presentation_state,
        metadata=entity.metadata,
    )
