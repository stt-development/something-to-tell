from pathlib import Path
from time import monotonic

import pytest

from services.runtime.stt_runtime.impact import (
    ImpactDependencyIndex,
    ImpactDependencyTraversal,
    ProjectDependencyProjector,
)
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.impact_analysis import (
    ImpactAnalysisLimits,
    ImpactDependency,
    ImpactDomain,
    ImpactPropagation,
    ImpactResourceRef,
    ImpactSeed,
)
from services.runtime.stt_runtime.schemas.project_document import ProjectDocument

CHECKSUM = "a" * 64
FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"


@pytest.fixture(scope="module")
def aurora(tmp_path_factory: pytest.TempPathFactory) -> ProjectDocument:
    project_path = tmp_path_factory.mktemp("impact-traversal") / "ProjectAurora.narrative"
    return import_project_fixture(FIXTURE, project_path).document


def _ref(owner_id: str, owner_type: str = "node") -> ImpactResourceRef:
    return ImpactResourceRef(owner_type=owner_type, owner_id=owner_id)


def _dependency(
    source: str,
    target: str,
    *,
    domain: ImpactDomain = "graph",
    propagation: ImpactPropagation = "required",
    kind: str = "test.reference",
) -> ImpactDependency:
    return ImpactDependency(
        source=_ref(source),
        target=_ref(target),
        domain=domain,
        kind=kind,
        propagation=propagation,
        message_key=f"impact.test.{kind}",
    )


def _index(*dependencies: ImpactDependency) -> ImpactDependencyIndex:
    resources = {
        endpoint.stable_key(): endpoint
        for item in dependencies
        for endpoint in (item.source, item.target)
    }
    return ImpactDependencyIndex.build(
        project_id="test-project",
        source_checksum=CHECKSUM,
        resources=resources.values(),
        dependencies=dependencies,
    )


def _traverse(
    index: ImpactDependencyIndex,
    seed_id: str,
    *,
    direction: str = "downstream",
    domains: tuple[ImpactDomain, ...] = ("graph",),
    depth: int = 10,
    paths: int = 3,
    targets: int = 500,
    is_cancelled=None,
):
    return ImpactDependencyTraversal().traverse(
        index,
        seeds=(ImpactSeed(resource=_ref(seed_id)),),
        direction=direction,
        domains=domains,
        limits=ImpactAnalysisLimits(
            max_depth=depth,
            max_paths_per_target=paths,
            max_targets=targets,
        ),
        is_cancelled=is_cancelled,
    )


def test_chain_obeys_depth_and_upstream_downstream_direction() -> None:
    index = _index(
        _dependency("a", "b"),
        _dependency("b", "c"),
        _dependency("c", "d"),
    )

    downstream = _traverse(index, "a", depth=2)
    upstream = _traverse(index, "d", direction="upstream", depth=2)

    assert [(item.target.owner_id, item.distance) for item in downstream.findings] == [
        ("b", 1),
        ("c", 2),
    ]
    assert [(item.target.owner_id, item.distance) for item in upstream.findings] == [
        ("c", 1),
        ("b", 2),
    ]
    assert all(item.direction == "upstream" for item in upstream.findings)


def test_diamond_coalesces_target_and_bounds_stable_alternate_paths() -> None:
    index = _index(
        _dependency("seed", "a"),
        _dependency("seed", "b"),
        _dependency("seed", "c"),
        _dependency("a", "target"),
        _dependency("b", "target"),
        _dependency("c", "target"),
    )

    first = _traverse(index, "seed", paths=2)
    repeated = _traverse(index, "seed", paths=2)
    target = next(item for item in first.findings if item.target.owner_id == "target")

    assert len(target.paths) == 2
    assert [path.resources[1].owner_id for path in target.paths] == ["a", "b"]
    assert first == repeated


def test_multiple_seeds_and_cycles_remain_finite_without_returning_seeds() -> None:
    index = _index(
        _dependency("seed-a", "middle"),
        _dependency("seed-b", "middle"),
        _dependency("middle", "tail"),
        _dependency("tail", "seed-a"),
    )
    seeds = (ImpactSeed(resource=_ref("seed-a")), ImpactSeed(resource=_ref("seed-b")))

    result = ImpactDependencyTraversal().traverse(
        index,
        seeds=seeds,
        direction="downstream",
        domains=("graph",),
        limits=ImpactAnalysisLimits(max_depth=10),
    )
    middle = next(item for item in result.findings if item.target.owner_id == "middle")

    assert {seed.resource.owner_id for seed in middle.seeds} == {"seed-a", "seed-b"}
    assert {item.target.owner_id for item in result.findings} == {"middle", "tail"}
    assert all(
        len(path.resources) == len({item.stable_key() for item in path.resources})
        for finding in result.findings
        for path in finding.paths
    )


def test_both_direction_and_domain_filter_preserve_path_direction() -> None:
    index = _index(
        _dependency("upstream", "seed"),
        _dependency("seed", "downstream"),
        _dependency("seed", "flow-only", domain="flow"),
    )

    result = _traverse(index, "seed", direction="both", domains=("graph",))

    assert {
        (item.target.owner_id, item.direction)
        for item in result.findings
    } == {("upstream", "upstream"), ("downstream", "downstream")}
    assert not any(item.target.owner_id == "flow-only" for item in result.findings)


def test_shortest_distance_and_strongest_retained_path_drive_finding_summary() -> None:
    index = _index(
        _dependency("seed", "target", propagation="contextual"),
        _dependency("seed", "middle", propagation="required"),
        _dependency("middle", "target", propagation="required"),
        _dependency("seed", "context-only", propagation="contextual"),
    )

    result = _traverse(index, "seed")
    target = next(item for item in result.findings if item.target.owner_id == "target")

    assert target.distance == 1
    assert target.propagation == "required"
    assert [path.propagation for path in target.paths] == ["contextual", "required"]
    assert [item.propagation for item in result.findings] == [
        "required",
        "required",
        "contextual",
    ]
    assert result.summary.propagation.required == 2
    assert result.summary.propagation.contextual == 1
    assert result.summary.direct_count == 3
    assert result.summary.transitive_count == 0


def test_target_limit_reports_exact_omission_and_cancellation_publishes_nothing() -> None:
    index = _index(
        *(_dependency("seed", f"target-{number:02d}") for number in range(8))
    )
    limited = _traverse(index, "seed", targets=3)
    polls = 0

    def cancel_after_two_polls() -> bool:
        nonlocal polls
        polls += 1
        return polls > 2

    cancelled = _traverse(index, "seed", is_cancelled=cancel_after_two_polls)

    assert limited.summary.finding_count == 3
    assert limited.summary.truncated is True
    assert limited.summary.omitted_count == 5
    assert [item.code for item in limited.diagnostics] == [
        "impact_result_limit_reached"
    ]
    assert cancelled.cancelled is True
    assert cancelled.findings == ()
    assert cancelled.summary.finding_count == 0
    assert [item.code for item in cancelled.diagnostics] == ["impact_run_cancelled"]


def test_missing_seed_returns_typed_diagnostic_without_partial_findings() -> None:
    result = _traverse(_index(_dependency("a", "b")), "missing")

    assert result.findings == ()
    assert result.diagnostics[0].code == "impact_seed_not_found"
    assert result.diagnostics[0].parameters == {
        "owner_type": "node",
        "owner_id": "missing",
    }


def test_project_aurora_depth_three_reaches_called_flow_deterministically(
    aurora: ProjectDocument,
) -> None:
    index = ProjectDependencyProjector().project(aurora)
    before_resources = index.resources
    before_dependencies = index.dependencies
    seed = ImpactSeed(resource=_ref("node-inspection"))
    limits = ImpactAnalysisLimits(max_depth=3)
    traversal = ImpactDependencyTraversal()

    first = traversal.traverse(
        index,
        seeds=(seed,),
        direction="downstream",
        domains=("flow",),
        limits=limits,
    )
    repeated = traversal.traverse(
        index,
        seeds=(seed,),
        direction="downstream",
        domains=("flow",),
        limits=limits,
    )
    called_flow = next(
        item
        for item in first.findings
        if item.target.owner_type == "flow"
        and item.target.owner_id == "flow-smuggler-route"
    )

    assert called_flow.distance == 3
    assert [item.owner_type for item in called_flow.paths[0].resources] == [
        "node",
        "flow_member",
        "flow_invocation",
        "flow",
    ]
    assert first == repeated
    assert index.resources == before_resources
    assert index.dependencies == before_dependencies
    assert index.source_checksum == aurora.checksum


def test_fanout_performance_remains_bounded() -> None:
    # This fixture exceeds the public target limit while keeping path depth one,
    # protecting the normal high-fanout authoring case from accidental quadratic work.
    index = _index(
        *(_dependency("seed", f"target-{number:04d}") for number in range(600))
    )

    started = monotonic()
    result = _traverse(index, "seed", targets=500)
    elapsed = monotonic() - started

    assert result.summary.finding_count == 500
    assert result.summary.omitted_count == 100
    assert elapsed < 1.0
