"""Bounded deterministic traversal over one immutable Impact dependency index."""

from __future__ import annotations

from dataclasses import dataclass, field
import heapq
from itertools import count
from typing import Callable

from ..schemas.impact_analysis import (
    ImpactAnalysisLimits,
    ImpactCounts,
    ImpactDependency,
    ImpactDiagnostic,
    ImpactDomain,
    ImpactFinding,
    ImpactPath,
    ImpactPathDirection,
    ImpactPropagation,
    ImpactRequestDirection,
    ImpactResourceRef,
    ImpactSeed,
    ImpactSummary,
    ImpactType,
    impact_finding_fingerprint,
)
from .index import ImpactDependencyIndex, ResourceKey

CancellationCheck = Callable[[], bool]


@dataclass(frozen=True)
class ImpactTraversalResult:
    """Internal traversal output consumed by the P5-007 run coordinator."""

    findings: tuple[ImpactFinding, ...]
    summary: ImpactSummary
    diagnostics: tuple[ImpactDiagnostic, ...] = ()
    cancelled: bool = False


@dataclass(frozen=True)
class _PathState:
    direction: ImpactPathDirection
    seed: ImpactSeed
    resources: tuple[ImpactResourceRef, ...]
    dependencies: tuple[ImpactDependency, ...] = ()

    @property
    def current(self) -> ImpactResourceRef:
        return self.resources[-1]

    @property
    def propagation(self) -> ImpactPropagation:
        return min(
            (item.propagation for item in self.dependencies),
            key=_propagation_order,
        )

    def as_path(self) -> ImpactPath:
        return ImpactPath(
            direction=self.direction,
            propagation=self.propagation,
            resources=self.resources,
            dependencies=self.dependencies,
        )


@dataclass
class _FindingGroup:
    target: ImpactResourceRef
    domain: ImpactDomain
    direction: ImpactPathDirection
    seeds: dict[ResourceKey, ImpactSeed] = field(default_factory=dict)
    paths: dict[tuple[object, ...], ImpactPath] = field(default_factory=dict)

    def add(self, state: _PathState) -> None:
        path = state.as_path()
        self.seeds[state.seed.resource.stable_key()] = state.seed
        self.paths[path.stable_key()] = path


class ImpactDependencyTraversal:
    """Traverse typed dependencies with bounded alternate-path retention."""

    def traverse(
        self,
        index: ImpactDependencyIndex,
        *,
        seeds: tuple[ImpactSeed, ...] | list[ImpactSeed],
        direction: ImpactRequestDirection,
        domains: tuple[ImpactDomain, ...] | frozenset[ImpactDomain],
        limits: ImpactAnalysisLimits,
        is_cancelled: CancellationCheck | None = None,
    ) -> ImpactTraversalResult:
        normalized_seeds = tuple(
            sorted(
                {seed.stable_key(): seed for seed in seeds}.values(),
                key=ImpactSeed.stable_key,
            )
        )
        missing = [seed for seed in normalized_seeds if not index.contains(seed.resource)]
        if missing:
            return ImpactTraversalResult(
                findings=(),
                summary=ImpactSummary(),
                diagnostics=(
                    ImpactDiagnostic(
                        code="impact_seed_not_found",
                        message_key="impact.error.impact_seed_not_found",
                        parameters={
                            "owner_type": missing[0].resource.owner_type,
                            "owner_id": missing[0].resource.owner_id,
                        },
                    ),
                ),
            )
        selected_domains = frozenset(domains)
        directions = (
            ("downstream", "upstream")
            if direction == "both"
            else (direction,)
        )
        groups: dict[
            tuple[ResourceKey, ImpactDomain, ImpactPathDirection],
            _FindingGroup,
        ] = {}
        seed_keys = {seed.resource.stable_key() for seed in normalized_seeds}
        arrival_counts: dict[
            tuple[ImpactPathDirection, ResourceKey, ResourceKey, ImpactDomain],
            int,
        ] = {}
        queue: list[tuple[tuple[object, ...], int, _PathState]] = []
        sequence = count()
        for traversal_direction in directions:
            for seed in normalized_seeds:
                state = _PathState(
                    direction=traversal_direction,
                    seed=seed,
                    resources=(seed.resource,),
                )
                heapq.heappush(
                    queue,
                    (_state_order_key(state), next(sequence), state),
                )

        while queue:
            if is_cancelled is not None and is_cancelled():
                return _cancelled_result()
            _, _, state = heapq.heappop(queue)
            distance = len(state.dependencies)
            if distance:
                last_domain = state.dependencies[-1].domain
                arrival_key = (
                    state.direction,
                    state.seed.resource.stable_key(),
                    state.current.stable_key(),
                    last_domain,
                )
                accepted = arrival_counts.get(arrival_key, 0)
                if accepted >= limits.max_paths_per_target:
                    continue
                arrival_counts[arrival_key] = accepted + 1
                if state.current.stable_key() not in seed_keys:
                    group_key = (
                        state.current.stable_key(),
                        last_domain,
                        state.direction,
                    )
                    group = groups.setdefault(
                        group_key,
                        _FindingGroup(
                            target=state.current,
                            domain=last_domain,
                            direction=state.direction,
                        ),
                    )
                    group.add(state)
            if distance >= limits.max_depth:
                continue
            for dependency in self._adjacent(
                index,
                state.current,
                state.direction,
                selected_domains,
            ):
                target = (
                    dependency.target
                    if state.direction == "downstream"
                    else dependency.source
                )
                if target.stable_key() in {
                    resource.stable_key() for resource in state.resources
                }:
                    continue
                next_state = _PathState(
                    direction=state.direction,
                    seed=state.seed,
                    resources=(*state.resources, target),
                    dependencies=(*state.dependencies, dependency),
                )
                heapq.heappush(
                    queue,
                    (_state_order_key(next_state), next(sequence), next_state),
                )

        findings = tuple(
            sorted(
                (
                    _finding(group, limits.max_paths_per_target)
                    for group in groups.values()
                ),
                key=ImpactFinding.stable_order_key,
            )
        )
        omitted_count = max(0, len(findings) - limits.max_targets)
        selected = findings[: limits.max_targets]
        diagnostics = (
            (
                ImpactDiagnostic(
                    code="impact_result_limit_reached",
                    message_key="impact.error.impact_result_limit_reached",
                    parameters={
                        "max_targets": limits.max_targets,
                        "omitted_count": omitted_count,
                    },
                ),
            )
            if omitted_count
            else ()
        )
        return ImpactTraversalResult(
            findings=selected,
            summary=_summary(selected, omitted_count),
            diagnostics=diagnostics,
        )

    @staticmethod
    def _adjacent(
        index: ImpactDependencyIndex,
        resource: ImpactResourceRef,
        direction: ImpactPathDirection,
        domains: frozenset[ImpactDomain],
    ) -> tuple[ImpactDependency, ...]:
        if direction == "downstream":
            return index.outgoing(resource, domains=domains)
        return index.incoming(resource, domains=domains)


def _state_order_key(state: _PathState) -> tuple[object, ...]:
    if not state.dependencies:
        return (0, 0, state.direction, state.seed.stable_key())
    return (
        len(state.dependencies),
        _propagation_order(state.propagation),
        state.direction,
        tuple(resource.stable_key() for resource in state.resources),
        tuple(dependency.stable_key() for dependency in state.dependencies),
    )


def _finding(group: _FindingGroup, path_limit: int) -> ImpactFinding:
    paths = tuple(sorted(group.paths.values(), key=ImpactPath.stable_key)[:path_limit])
    seeds = tuple(group.seeds[key] for key in sorted(group.seeds))
    primary = paths[0]
    direct = primary.dependencies[-1]
    return ImpactFinding(
        id=impact_finding_fingerprint(
            seeds=seeds,
            target=group.target,
            domain=group.domain,
            direction=group.direction,
        ),
        seeds=seeds,
        target=group.target,
        domain=group.domain,
        direction=group.direction,
        impact_type=_impact_type(direct),
        propagation=min(
            (path.propagation for path in paths),
            key=_propagation_order,
        ),
        distance=min(len(path.dependencies) for path in paths),
        message_key=direct.message_key,
        message_parameters=direct.message_parameters,
        paths=paths,
    )


def _impact_type(dependency: ImpactDependency) -> ImpactType:
    if dependency.domain == "temporal":
        return "state"
    if dependency.domain in {"flow", "dialogue", "quest", "playback"}:
        return "execution"
    if dependency.domain == "composition":
        return "ownership"
    if dependency.domain == "canon":
        return "integrity"
    if dependency.kind in {"graph.edge-source", "graph.edge-target"}:
        return "structural"
    return "reference"


def _summary(
    findings: tuple[ImpactFinding, ...],
    omitted_count: int,
) -> ImpactSummary:
    counts = {"required": 0, "conditional": 0, "contextual": 0}
    for finding in findings:
        counts[finding.propagation] += 1
    return ImpactSummary(
        finding_count=len(findings),
        direct_count=sum(finding.distance == 1 for finding in findings),
        transitive_count=sum(finding.distance > 1 for finding in findings),
        propagation=ImpactCounts(**counts),
        truncated=omitted_count > 0,
        omitted_count=omitted_count,
    )


def _cancelled_result() -> ImpactTraversalResult:
    return ImpactTraversalResult(
        findings=(),
        summary=ImpactSummary(),
        diagnostics=(
            ImpactDiagnostic(
                code="impact_run_cancelled",
                message_key="impact.error.impact_run_cancelled",
            ),
        ),
        cancelled=True,
    )


def _propagation_order(value: ImpactPropagation) -> int:
    return {"required": 0, "conditional": 1, "contextual": 2}[value]
