from collections.abc import Sequence
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .story_flow import FlowTransition, StoryFlow, StoryFlowNode


class FlowInvocation(BaseModel):
    """Runtime-owned Phase 3.10 call route between two Story Flows."""

    model_config = ConfigDict(extra="forbid")

    invocation_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    source_flow_id: str = Field(min_length=1)
    source_node_id: str = Field(min_length=1)
    target_flow_id: str = Field(min_length=1)
    label: str = Field(default="", max_length=255)
    condition: str = ""
    priority: int = Field(ge=0)
    is_default: bool = False
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def validate_route_semantics(self) -> "FlowInvocation":
        if self.source_flow_id == self.target_flow_id:
            raise ValueError("flow invocation cannot target its source flow")
        if self.is_default and self.condition.strip():
            raise ValueError("default flow invocation cannot have a condition")
        return self


class FlowExit(BaseModel):
    """Named terminal route exposed by one invoked Story Flow."""

    model_config = ConfigDict(extra="forbid")

    exit_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    flow_id: str = Field(min_length=1)
    key: str = Field(min_length=1, max_length=128, pattern=r"^[a-z][a-z0-9_-]*$")
    label: str = Field(default="", max_length=255)
    source_node_id: str = Field(min_length=1)
    created_at: datetime
    updated_at: datetime


class FlowExitBinding(BaseModel):
    """Per-call-site return from one callee exit to its immediate caller."""

    model_config = ConfigDict(extra="forbid")

    binding_version: Literal[1] = 1
    id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(min_length=1)
    invocation_id: str = Field(min_length=1)
    exit_id: str = Field(min_length=1)
    target_node_id: str = Field(min_length=1)
    created_at: datetime
    updated_at: datetime


FlowRoute = FlowTransition | FlowInvocation


def order_outgoing_routes(
    transitions: Sequence[FlowTransition],
    invocations: Sequence[FlowInvocation],
) -> tuple[FlowRoute, ...]:
    """Return a stable route projection without reordering either input collection."""

    routes: tuple[FlowRoute, ...] = (*transitions, *invocations)
    return tuple(sorted(routes, key=_route_sort_key))


class ComposableFlowGraph(BaseModel):
    """Strict executable call graph spanning every referenced Story Flow."""

    model_config = ConfigDict(extra="forbid")

    composition_version: Literal[1] = 1
    project_id: str = Field(min_length=1)
    flows: list[StoryFlow] = Field(default_factory=list)
    memberships: list[StoryFlowNode] = Field(default_factory=list)
    transitions: list[FlowTransition] = Field(default_factory=list)
    invocations: list[FlowInvocation] = Field(default_factory=list)
    exits: list[FlowExit] = Field(default_factory=list)
    bindings: list[FlowExitBinding] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_composition(self) -> "ComposableFlowGraph":
        self._require_unique_ids("flow", self.flows)
        self._require_unique_ids("membership", self.memberships)
        self._require_unique_ids("transition", self.transitions)
        self._require_unique_ids("invocation", self.invocations)
        self._require_unique_ids("exit", self.exits)
        self._require_unique_ids("binding", self.bindings)

        flows = {flow.id: flow for flow in self.flows}
        if any(flow.project_id != self.project_id for flow in self.flows):
            raise ValueError("flow belongs to another project")

        member_pairs: set[tuple[str, str]] = set()
        for membership in self.memberships:
            if membership.project_id != self.project_id:
                raise ValueError("flow membership belongs to another project")
            if membership.flow_id not in flows:
                raise ValueError("flow membership references a missing flow")
            pair = (membership.flow_id, membership.node_id)
            if pair in member_pairs:
                raise ValueError("duplicate flow membership for node")
            member_pairs.add(pair)

        for flow in self.flows:
            if flow.entry_node_id is not None and (flow.id, flow.entry_node_id) not in member_pairs:
                raise ValueError("flow entry node must be a member")

        for transition in self.transitions:
            if transition.project_id != self.project_id:
                raise ValueError("flow transition belongs to another project")
            if transition.flow_id not in flows:
                raise ValueError("flow transition references a missing flow")
            endpoints = {
                (transition.flow_id, transition.source_node_id),
                (transition.flow_id, transition.target_node_id),
            }
            if not endpoints.issubset(member_pairs):
                raise ValueError("flow transition endpoints must be members")

        for invocation in self.invocations:
            if invocation.project_id != self.project_id:
                raise ValueError("flow invocation belongs to another project")
            if invocation.source_flow_id not in flows or invocation.target_flow_id not in flows:
                raise ValueError("flow invocation references a missing flow")
            if (invocation.source_flow_id, invocation.source_node_id) not in member_pairs:
                raise ValueError("flow invocation source node must be a caller member")
            callee = flows[invocation.target_flow_id]
            if callee.entry_node_id is None or (callee.id, callee.entry_node_id) not in member_pairs:
                raise ValueError("invoked flow requires a valid entry")

        self._validate_combined_routes()
        self._validate_call_graph()
        exits = self._validate_exits(flows, member_pairs)
        self._validate_bindings(exits, member_pairs)
        return self

    def _validate_combined_routes(self) -> None:
        priorities: set[tuple[str, str, int]] = set()
        defaults: set[tuple[str, str]] = set()
        for route in order_outgoing_routes(self.transitions, self.invocations):
            owner = _route_owner(route)
            priority = (*owner, route.priority)
            if priority in priorities:
                raise ValueError("outgoing transitions and invocations must use unique priorities")
            if route.is_default and owner in defaults:
                raise ValueError("outgoing transitions and invocations allow one default route")
            priorities.add(priority)
            if route.is_default:
                defaults.add(owner)

    def _validate_call_graph(self) -> None:
        targets: dict[str, set[str]] = {flow.id: set() for flow in self.flows}
        for invocation in self.invocations:
            targets[invocation.source_flow_id].add(invocation.target_flow_id)

        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(flow_id: str) -> None:
            if flow_id in visiting:
                raise ValueError("flow invocation graph contains a cycle")
            if flow_id in visited:
                return
            visiting.add(flow_id)
            for target_id in sorted(targets[flow_id]):
                visit(target_id)
            visiting.remove(flow_id)
            visited.add(flow_id)

        for flow_id in sorted(targets):
            visit(flow_id)

    def _validate_exits(
        self,
        flows: dict[str, StoryFlow],
        member_pairs: set[tuple[str, str]],
    ) -> dict[str, FlowExit]:
        exits: dict[str, FlowExit] = {}
        exit_keys: set[tuple[str, str]] = set()
        outgoing_owners = {
            _route_owner(route) for route in order_outgoing_routes(self.transitions, self.invocations)
        }
        for flow_exit in self.exits:
            if flow_exit.project_id != self.project_id:
                raise ValueError("flow exit belongs to another project")
            if flow_exit.flow_id not in flows:
                raise ValueError("flow exit references a missing flow")
            if (flow_exit.flow_id, flow_exit.source_node_id) not in member_pairs:
                raise ValueError("flow exit source node must be a flow member")
            key = (flow_exit.flow_id, flow_exit.key)
            if key in exit_keys:
                raise ValueError("flow exit key must be unique within its flow")
            if (flow_exit.flow_id, flow_exit.source_node_id) in outgoing_owners:
                raise ValueError("flow exit source must be terminal")
            exit_keys.add(key)
            exits[flow_exit.id] = flow_exit
        return exits

    def _validate_bindings(
        self,
        exits: dict[str, FlowExit],
        member_pairs: set[tuple[str, str]],
    ) -> None:
        invocations = {invocation.id: invocation for invocation in self.invocations}
        mapped_exits: set[tuple[str, str]] = set()
        for binding in self.bindings:
            if binding.project_id != self.project_id:
                raise ValueError("flow exit binding belongs to another project")
            invocation = invocations.get(binding.invocation_id)
            flow_exit = exits.get(binding.exit_id)
            if invocation is None or flow_exit is None:
                raise ValueError("flow exit binding references a missing invocation or exit")
            if flow_exit.flow_id != invocation.target_flow_id:
                raise ValueError("bound exit must belong to the invocation target flow")
            if (invocation.source_flow_id, binding.target_node_id) not in member_pairs:
                raise ValueError("flow exit binding target must be a caller member")
            mapping = (binding.invocation_id, binding.exit_id)
            if mapping in mapped_exits:
                raise ValueError("one call site may map an exit only once")
            mapped_exits.add(mapping)

    @staticmethod
    def _require_unique_ids(label: str, records: Sequence[Any]) -> None:
        ids = [record.id for record in records]
        if len(ids) != len(set(ids)):
            raise ValueError(f"duplicate {label} id")


def _route_owner(route: FlowRoute) -> tuple[str, str]:
    if isinstance(route, FlowInvocation):
        return route.source_flow_id, route.source_node_id
    return route.flow_id, route.source_node_id


def _route_sort_key(route: FlowRoute) -> tuple[str, str, int, int, str]:
    flow_id, source_node_id = _route_owner(route)
    kind_order = 1 if isinstance(route, FlowInvocation) else 0
    return flow_id, source_node_id, route.priority, kind_order, route.id
