from services.runtime.stt_runtime.domain.entities import (
    FlowTransitionEntity,
    SceneFlowBoundaryEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
)
from services.runtime.stt_runtime.story_flow.presenters import (
    boundary_response,
    flow_response,
    membership_response,
    transition_response,
)


def test_story_flow_presenters_preserve_identity_order_and_metadata() -> None:
    flow = StoryFlowEntity(
        id="flow",
        project_id="project",
        name="Main",
        normalized_name="main",
        entry_node_id="entry",
        metadata={"color": "red"},
    )
    membership = StoryFlowNodeEntity(
        id="membership",
        project_id="project",
        flow_id="flow",
        node_id="entry",
        presentation_order=3,
    )
    transition = FlowTransitionEntity(
        id="transition",
        project_id="project",
        flow_id="flow",
        source_node_id="entry",
        target_node_id="exit",
        priority=7,
        is_default=True,
    )
    boundary = SceneFlowBoundaryEntity(
        id="boundary",
        project_id="project",
        flow_id="flow",
        scene_node_id="scene",
        entry_node_id="entry",
        exit_node_ids=["exit-b", "exit-a"],
    )

    assert flow_response(flow).metadata == {"color": "red"}
    assert membership_response(membership).presentation_order == 3
    assert transition_response(transition).priority == 7
    assert boundary_response(boundary).exit_node_ids == ["exit-b", "exit-a"]
