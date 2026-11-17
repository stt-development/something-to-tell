"""Disposable frontend baseline input; never regenerate pinned scale workloads."""

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import subprocess
from uuid import uuid4

from services.runtime.scripts.scale_fixture import SOURCE
from services.runtime.scripts.scale_fixture_files import DIRECTORY, load_scale_fixture
from services.runtime.stt_runtime.project_fixture import import_project_fixture, load_project_fixture, write_project_fixture
from services.runtime.stt_runtime.project_session.documents import replace_project_identity
from services.runtime.stt_runtime.schemas.project_fixture import ProjectFixtureEnvelope


def baseline_fixture(size):
    """Rebind only project ownership, preserving the checked-in narrative workload."""
    if size == "small":
        source, fixture = SOURCE, load_project_fixture(SOURCE)
    elif size == "1000":
        source, fixture = DIRECTORY / "storage-scale-1000.v1.json.gz", load_scale_fixture(1000)
    else:
        raise ValueError("frontend_baseline_size_unsupported")
    project_id = f"frontend-baseline-{uuid4()}"
    payload = replace_project_identity(fixture.model_dump(mode="json"), fixture.manifest.project_id, project_id)
    payload["manifest"]["name"] = f"Frontend Baseline {size}"
    rebound = ProjectFixtureEnvelope.model_validate(payload)
    return rebound, sha256(source.read_bytes()).hexdigest()


def geometry_summary(fixture):
    """Expose the pinned workload's dense root overlaps, not its narrative data."""
    roots = [item for item in fixture.placements if item.container_node_id is None]
    origins = Counter((item.x, item.y) for item in roots)
    return dict(placements=len(fixture.placements), root_placements=len(roots),
        distinct_root_origins=len(origins), max_roots_at_one_origin=max(origins.values(), default=0),
        variant="pinned_original_overlap")


def standalone_boundary_fixture(fixture):
    """Retarget one boundary in a copy without deleting tagged transitions."""
    payload = fixture.model_dump(mode="json")
    main = next(flow for flow in fixture.story_flows if flow.kind == "main")
    boundary = next(row for row in payload["scene_flow_boundaries"] if row["flow_id"] == main.id)
    members = {row.node_id for row in fixture.story_flow_nodes if row.flow_id == main.id}
    ordinary_targets = {row.target_node_id for row in fixture.flow_transitions
        if row.flow_id == main.id and row.source_node_id == boundary["scene_node_id"]}
    entry = next(row for row in fixture.placements
        if row.container_node_id == boundary["scene_node_id"]
        and row.canonical_node_id in members and row.canonical_node_id not in ordinary_targets
        and row.canonical_node_id != boundary["entry_node_id"])
    boundary["entry_node_id"] = entry.canonical_node_id
    payload["slug"] += "-standalone-boundary-v1"
    payload["manifest"]["name"] += " - Standalone Scene Boundary"
    return ProjectFixtureEnvelope.model_validate(payload)


def deep_detail_fixture(fixture):
    """Named disposable geometry variant; retain every pinned canonical record."""
    payload = fixture.model_dump(mode="json")
    primary = {row["canonical_node_id"]: row for row in payload["placements"] if row["is_primary"]}
    offices = sorted(node.id for node in fixture.nodes if node.type == "Location" and node.id.endswith("-node-customs-office"))[:5]
    if len(offices) != 5:
        raise ValueError("frontend_detail_fixture_requires_locations")
    harbor = primary[primary[offices[0]]["container_node_id"]]
    scene = primary[harbor["container_node_id"]]
    leaf = next(node.id for node in fixture.nodes if node.type == "Lore" and node.id in primary)
    scene.update(width=2200, height=2000)
    harbor.update(x=20, y=70, width=2000, height=1800)
    # Keep all children inside authored bounds; never ask Open to auto-layout a fixture.
    for index, node_id in enumerate(offices):
        primary[node_id].update(x=20, y=70, width=1800 - index * 300, height=1600 - index * 250)
        if index:
            primary[node_id]["container_node_id"] = offices[index - 1]
    primary[leaf].update(container_node_id=offices[-1], x=20, y=70, width=260, height=156)
    payload["slug"] += "-deep-detail-v1"
    payload["manifest"]["name"] += " - Deep Detail"
    return ProjectFixtureEnvelope.model_validate(payload)


def root_grid_fixture(fixture):
    """Reuse the frontend policy's single geometry owner; Node is a dev prerequisite."""
    payload = fixture.model_dump(mode="json")
    module = Path(__file__).resolve().parents[3] / "apps/web/performance/rendering-policy.mjs"
    script = ("import { spreadPlacements } from " + json.dumps(module.as_uri()) + ";"
        "let input=''; for await (const chunk of process.stdin) input+=chunk;"
        "process.stdout.write(JSON.stringify(spreadPlacements(JSON.parse(input))));")
    result = subprocess.run(["node", "--input-type=module", "-e", script],
        input=json.dumps(payload["placements"]), text=True, capture_output=True, check=True, timeout=30)
    payload["placements"] = json.loads(result.stdout)
    payload["slug"] += "-root-grid-v1"
    payload["manifest"]["name"] += " - Root Grid"
    return ProjectFixtureEnvelope.model_validate(payload)


def long_dialogue_fixture(fixture):
    """Extend one owned editor document only; never regenerate the pinned workload."""
    payload = fixture.model_dump(mode="json")
    if not payload["dialogues"] or not payload["dialogues"][0]["document"]["participants"]:
        raise ValueError("frontend_long_dialogue_requires_participant")
    document = payload["dialogues"][0]["document"]
    if len(document["elements"]) > 200:
        raise ValueError("frontend_long_dialogue_input_too_large")
    for index in range(len(document["elements"]), 200):
        document["elements"].append(dict(id=f"frontend-long-dialogue-line-{index}", kind="line",
            speaker_node_id=document["participants"][0], text=f"Disposable long dialogue line {index}.", next_element_id=None))
    payload["slug"] += "-long-dialogue-v1"
    payload["manifest"]["name"] += " - Long Dialogue"
    return ProjectFixtureEnvelope.model_validate(payload)


def long_quest_fixture(fixture):
    """Extend one owned Quest editor while retaining every original stage and outcome."""
    payload = fixture.model_dump(mode="json")
    if not payload["quests"]:
        raise ValueError("frontend_long_quest_requires_document")
    document = payload["quests"][0]["document"]
    if len(document["stages"]) > 200:
        raise ValueError("frontend_long_quest_input_too_large")
    for index in range(len(document["stages"]), 200):
        document["stages"].append(dict(id=f"frontend-long-quest-stage-{index}", title=f"Disposable stage {index}",
            description=f"Disposable Quest description {index}.", branches=[dict(id=f"frontend-long-quest-branch-{index}",
                label=f"Disposable branch {index}", condition="", target_stage_id=None)]))
    if document["entry_stage_id"] is None:
        document["entry_stage_id"] = document["stages"][0]["id"]
    payload["slug"] += "-long-quest-v1"
    payload["manifest"]["name"] += " - Long Quest"
    return ProjectFixtureEnvelope.model_validate(payload)


def prepare(directory, size, variant=None):
    if variant not in (None, "standalone_scene_boundary_v1", "deep_detail_v1", "long_dialogue_v1", "long_quest_v1", "root_grid_v1"):
        raise ValueError("frontend_baseline_variant_unsupported")
    directory = Path(directory)
    if directory.exists():
        raise ValueError("frontend_baseline_destination_exists")
    fixture, fingerprint = baseline_fixture(size)
    if variant == "standalone_scene_boundary_v1":
        fixture = standalone_boundary_fixture(fixture)
    elif variant == "deep_detail_v1":
        fixture = deep_detail_fixture(fixture)
    elif variant == "long_dialogue_v1":
        fixture = long_dialogue_fixture(fixture)
    elif variant == "long_quest_v1":
        fixture = long_quest_fixture(fixture)
    elif variant == "root_grid_v1":
        fixture = root_grid_fixture(fixture)
    directory.mkdir(parents=True)
    source, destination = directory / "source.json", directory / "Baseline.narrative"
    write_project_fixture(source, fixture)
    imported = import_project_fixture(source, destination)
    result = dict(directory=str(directory), path=str(destination), name=fixture.manifest.name,
        node_count=len(imported.document.nodes), source_sha256=fingerprint, storage_mode="local_sqlite",
        geometry=geometry_summary(fixture))
    if variant:
        result["variant"] = variant
    if variant in ("deep_detail_v1", "root_grid_v1"):
        result["geometry"]["variant"] = variant
    if variant == "root_grid_v1":
        result["geometry"]["placement_geometry_sha256"] = sha256(
            json.dumps([row.model_dump(mode="json") for row in fixture.placements], sort_keys=True).encode()).hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--size", choices=("small", "1000"), required=True)
    parser.add_argument("--variant", choices=("standalone_scene_boundary_v1", "deep_detail_v1", "long_dialogue_v1", "long_quest_v1", "root_grid_v1"))
    args = parser.parse_args()
    print(json.dumps(prepare(args.directory, args.size, args.variant)))


if __name__ == "__main__":
    main()
