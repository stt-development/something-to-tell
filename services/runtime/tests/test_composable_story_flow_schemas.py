from copy import deepcopy
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.composable_story_flow import (
    ComposableFlowGraph,
    FlowExit,
    FlowExitBinding,
    FlowInvocation,
    order_outgoing_routes,
)
from services.runtime.stt_runtime.schemas.story_flow import (
    FlowTransition,
    StoryFlow,
    StoryFlowNode,
)

NOW = datetime(2026, 8, 3, 10, 0, tzinfo=UTC)
PROJECT_ID = "project-composable"


def flow(flow_id: str, entry: str) -> StoryFlow:
    return StoryFlow(
        id=flow_id,
        project_id=PROJECT_ID,
        name=flow_id,
        status="active",
        entry_node_id=entry,
        created_at=NOW,
        updated_at=NOW,
    )


def member(flow_id: str, node_id: str, order: int) -> StoryFlowNode:
    return StoryFlowNode(
        id=f"member-{flow_id}-{node_id}",
        project_id=PROJECT_ID,
        flow_id=flow_id,
        node_id=node_id,
        presentation_order=order,
        created_at=NOW,
        updated_at=NOW,
    )


def transition(
    transition_id: str = "transition-main-return",
    *,
    flow_id: str = "flow-main",
    source: str = "main-start",
    target: str = "main-return",
    priority: int = 1,
    is_default: bool = False,
) -> FlowTransition:
    return FlowTransition(
        id=transition_id,
        project_id=PROJECT_ID,
        flow_id=flow_id,
        source_node_id=source,
        target_node_id=target,
        priority=priority,
        is_default=is_default,
        created_at=NOW,
        updated_at=NOW,
    )


def invocation(
    invocation_id: str = "invocation-side",
    *,
    source_flow_id: str = "flow-main",
    source_node_id: str = "main-start",
    target_flow_id: str = "flow-side",
    priority: int = 0,
    is_default: bool = False,
) -> FlowInvocation:
    return FlowInvocation(
        id=invocation_id,
        project_id=PROJECT_ID,
        source_flow_id=source_flow_id,
        source_node_id=source_node_id,
        target_flow_id=target_flow_id,
        label="Enter side story",
        priority=priority,
        is_default=is_default,
        created_at=NOW,
        updated_at=NOW,
    )


def flow_exit(
    exit_id: str = "exit-side-success",
    *,
    flow_id: str = "flow-side",
    key: str = "success",
    source_node_id: str = "side-end",
) -> FlowExit:
    return FlowExit(
        id=exit_id,
        project_id=PROJECT_ID,
        flow_id=flow_id,
        key=key,
        label="Success",
        source_node_id=source_node_id,
        created_at=NOW,
        updated_at=NOW,
    )


def binding(
    binding_id: str = "binding-side-success",
    *,
    invocation_id: str = "invocation-side",
    exit_id: str = "exit-side-success",
    target_node_id: str = "main-return",
) -> FlowExitBinding:
    return FlowExitBinding(
        id=binding_id,
        project_id=PROJECT_ID,
        invocation_id=invocation_id,
        exit_id=exit_id,
        target_node_id=target_node_id,
        created_at=NOW,
        updated_at=NOW,
    )


def valid_payload() -> dict[str, object]:
    return {
        "project_id": PROJECT_ID,
        "flows": [
            flow("flow-main", "main-start"),
            flow("flow-side", "side-start"),
            flow("flow-other", "other-start"),
        ],
        "memberships": [
            member("flow-main", "main-start", 0),
            member("flow-main", "main-return", 1),
            member("flow-side", "side-start", 0),
            member("flow-side", "side-end", 1),
            member("flow-other", "other-start", 0),
            member("flow-other", "other-end", 1),
        ],
        "transitions": [transition()],
        "invocations": [invocation()],
        "exits": [flow_exit()],
        "bindings": [binding()],
    }


def test_contracts_accept_one_owned_call_exit_and_return_binding() -> None:
    graph = ComposableFlowGraph.model_validate(valid_payload())

    assert graph.composition_version == 1
    assert graph.invocations[0].target_flow_id == "flow-side"
    assert graph.exits[0].key == "success"
    assert graph.bindings[0].target_node_id == "main-return"


def test_record_contracts_reject_self_calls_conditioned_defaults_and_invalid_keys() -> None:
    with pytest.raises(ValidationError, match="cannot target its source flow"):
        invocation(target_flow_id="flow-main")
    with pytest.raises(ValidationError, match="default flow invocation cannot have a condition"):
        FlowInvocation.model_validate(
            {**invocation().model_dump(), "is_default": True, "condition": "flag.ready"}
        )
    with pytest.raises(ValidationError, match="string_pattern_mismatch"):
        FlowExit.model_validate({**flow_exit().model_dump(), "key": "Not suitable"})


def test_graph_rejects_cross_project_and_missing_flow_ownership() -> None:
    payload = valid_payload()
    payload["invocations"] = [
        invocation().model_copy(update={"project_id": "project-other"})
    ]
    with pytest.raises(ValidationError, match="belongs to another project"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["invocations"] = [
        invocation().model_copy(update={"target_flow_id": "flow-missing"})
    ]
    with pytest.raises(ValidationError, match="references a missing flow"):
        ComposableFlowGraph.model_validate(payload)


def test_graph_rejects_duplicate_membership_and_invalid_entries() -> None:
    payload = valid_payload()
    duplicate = member("flow-main", "main-start", 2).model_copy(
        update={"id": "member-main-start-copy"}
    )
    payload["memberships"] = [*payload["memberships"], duplicate]
    with pytest.raises(ValidationError, match="duplicate flow membership"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["flows"] = [
        flow("flow-main", "main-start"),
        flow("flow-side", "side-missing"),
        flow("flow-other", "other-start"),
    ]
    with pytest.raises(ValidationError, match="entry node must be a member"):
        ComposableFlowGraph.model_validate(payload)


def test_graph_requires_invocation_source_membership_and_callee_entry() -> None:
    payload = valid_payload()
    payload["invocations"] = [invocation(source_node_id="main-missing")]
    with pytest.raises(ValidationError, match="source node must be a caller member"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["flows"] = [
        flow("flow-main", "main-start"),
        flow("flow-side", "side-start").model_copy(update={"entry_node_id": None}),
        flow("flow-other", "other-start"),
    ]
    with pytest.raises(ValidationError, match="invoked flow requires a valid entry"):
        ComposableFlowGraph.model_validate(payload)


def test_transitions_and_invocations_share_priority_and_default_namespace() -> None:
    payload = valid_payload()
    payload["transitions"] = [transition(priority=0)]
    with pytest.raises(ValidationError, match="unique priorities"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["transitions"] = [transition(priority=1, is_default=True)]
    payload["invocations"] = [invocation(priority=0, is_default=True)]
    with pytest.raises(ValidationError, match="one default route"):
        ComposableFlowGraph.model_validate(payload)


def test_graph_rejects_direct_and_indirect_call_cycles() -> None:
    with pytest.raises(ValidationError, match="cannot target its source flow"):
        invocation(target_flow_id="flow-main")

    payload = valid_payload()
    payload["invocations"] = [
        invocation(),
        invocation(
            "invocation-other",
            source_flow_id="flow-side",
            source_node_id="side-start",
            target_flow_id="flow-other",
        ),
        invocation(
            "invocation-main",
            source_flow_id="flow-other",
            source_node_id="other-start",
            target_flow_id="flow-main",
        ),
    ]
    payload["transitions"] = []
    with pytest.raises(ValidationError, match="contains a cycle"):
        ComposableFlowGraph.model_validate(payload)


def test_exit_requires_unique_key_member_source_and_terminal_route() -> None:
    payload = valid_payload()
    payload["exits"] = [
        flow_exit(),
        flow_exit("exit-side-copy", key="success"),
    ]
    with pytest.raises(ValidationError, match="key must be unique"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["exits"] = [flow_exit(source_node_id="side-missing")]
    payload["bindings"] = []
    with pytest.raises(ValidationError, match="source node must be a flow member"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["transitions"] = [
        transition(
            "transition-side-loop",
            flow_id="flow-side",
            source="side-end",
            target="side-start",
        )
    ]
    with pytest.raises(ValidationError, match="source must be terminal"):
        ComposableFlowGraph.model_validate(payload)


def test_binding_requires_matching_callee_exit_caller_target_and_unique_mapping() -> None:
    payload = valid_payload()
    payload["bindings"] = [binding(exit_id="exit-missing")]
    with pytest.raises(ValidationError, match="missing invocation or exit"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["exits"] = [flow_exit(flow_id="flow-other", source_node_id="other-end")]
    with pytest.raises(ValidationError, match="must belong to the invocation target flow"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["bindings"] = [binding(target_node_id="side-end")]
    with pytest.raises(ValidationError, match="target must be a caller member"):
        ComposableFlowGraph.model_validate(payload)

    payload = valid_payload()
    payload["bindings"] = [binding(), binding("binding-copy")]
    with pytest.raises(ValidationError, match="may map an exit only once"):
        ComposableFlowGraph.model_validate(payload)


def test_combined_route_order_is_deterministic_and_input_immutable() -> None:
    transitions = [transition(priority=2), transition("transition-first", priority=0)]
    invocations = [invocation(priority=1)]
    before = deepcopy([transitions, invocations])

    ordered = order_outgoing_routes(transitions, invocations)

    assert [route.id for route in ordered] == [
        "transition-first",
        "invocation-side",
        "transition-main-return",
    ]
    assert [transitions, invocations] == before
