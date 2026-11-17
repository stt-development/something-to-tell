"""Pure multi-surface visual projection coverage for P5.5-006."""

from copy import deepcopy
from pathlib import Path

import pytest

from services.runtime.stt_runtime.impact.visual_projection import (
    ImpactVisualPatchProjector,
    ImpactVisualProjectionError,
)
from services.runtime.stt_runtime.project_document.patch import (
    apply_project_patch,
    derive_project_patch,
)
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.schemas.project_document import create_project_document


FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
FINGERPRINT = "a" * 64


def test_aurora_projection_is_stable_pure_and_covers_every_authoring_surface(
    tmp_path: Path,
) -> None:
    source = _aurora(tmp_path)
    payload = source.model_dump(mode="python", exclude={"checksum"})
    payload["nodes"][0]["summary"] = "Preview summary"
    payload["placements"][0]["x"] += 180
    payload["flow_transitions"][0]["label"] = "Preview route"
    dialogue = payload["dialogues"][0]
    dialogue["document"]["elements"][0]["text"] = "Preview dialogue line."
    payload["dialogues"][0] = dialogue
    quest = payload["quests"][0]
    quest["document"]["stages"][0]["branches"][0]["label"] = "Preview branch"
    payload["quests"][0] = quest
    payload["narrative_effects"][0]["explanation"] = "Preview state transition."
    candidate = create_project_document(**payload)
    source_before = deepcopy(source.model_dump(mode="json"))
    candidate_before = deepcopy(candidate.model_dump(mode="json"))

    first = ImpactVisualPatchProjector().project(
        source, candidate, alternative_fingerprint=FINGERPRINT
    )
    second = ImpactVisualPatchProjector().project(
        source, candidate, alternative_fingerprint=FINGERPRINT
    )

    assert first == second
    assert source.model_dump(mode="json") == source_before
    assert candidate.model_dump(mode="json") == candidate_before
    assert {change.surface for change in first.changes} == {
        "graph", "composition", "flow", "story", "dialogue", "quest", "temporal", "canon"
    }
    assert any(change.kind == "move" and change.surface == "composition" for change in first.changes)
    assert all(change.field_changes for change in first.changes if change.kind == "modify")
    _assert_preview_rectangles_do_not_overlap(first.changes)


def test_new_canvas_node_requires_reviewed_non_preview_placement(tmp_path: Path) -> None:
    source = _aurora(tmp_path)
    payload = source.model_dump(mode="python", exclude={"checksum"})
    node = {**payload["nodes"][0], "id": "preview-node", "title": "Preview node"}
    payload["nodes"].append(node)
    payload["nodes"].sort(key=lambda item: item["id"])
    without_placement = create_project_document(**payload)

    with pytest.raises(ImpactVisualProjectionError, match="explicit placement"):
        ImpactVisualPatchProjector().project(
            source, without_placement, alternative_fingerprint=FINGERPRINT
        )

    placed_payload = without_placement.model_dump(mode="python", exclude={"checksum"})
    placement = {**placed_payload["placements"][0], **{
        "id": "placement-preview-node",
        "canonical_node_id": "preview-node",
        "x": 4800,
        "y": 2400,
        "is_primary": True,
    }}
    placed_payload["placements"].append(placement)
    placed_payload["placements"].sort(key=lambda item: item["id"])
    candidate = create_project_document(**placed_payload)

    projection = ImpactVisualPatchProjector().project(
        source, candidate, alternative_fingerprint=FINGERPRINT
    )

    added = next(
        change for change in projection.changes
        if change.surface == "graph" and change.after_resource
        and change.after_resource.owner_id == "preview-node"
    )
    assert added.kind == "add"
    assert added.after_placement is not None
    assert added.after_placement.preview_only is False
    assert (added.after_placement.x, added.after_placement.y) == (4800, 2400)


def test_aurora_supports_add_remove_modify_and_dialogue_repair_examples(
    tmp_path: Path,
) -> None:
    """Keep the documented example matrix grounded in valid authored patches."""

    source = _aurora(tmp_path)
    candidates = {
        "add": _added_graph_and_flow_candidate(source),
        "remove": _removed_graph_and_flow_candidate(source),
        "modify": _modified_graph_flow_and_dialogue_candidate(source),
    }

    projections = {}
    for name, candidate in candidates.items():
        patch = derive_project_patch(source, candidate)
        assert apply_project_patch(source, patch) == candidate
        projections[name] = ImpactVisualPatchProjector().project(
            source,
            candidate,
            alternative_fingerprint=FINGERPRINT,
        )

    assert {change.kind for change in projections["add"].changes} >= {"add"}
    assert {change.surface for change in projections["add"].changes} >= {
        "graph",
        "flow",
        "story",
    }
    assert "remove" in {change.kind for change in projections["remove"].changes}
    assert {change.surface for change in projections["remove"].changes} >= {
        "graph",
        "flow",
        "story",
    }
    assert "modify" in {change.kind for change in projections["modify"].changes}
    assert {change.surface for change in projections["modify"].changes} >= {
        "graph",
        "flow",
        "story",
        "dialogue",
    }


def _aurora(tmp_path: Path):
    return import_project_fixture(FIXTURE, tmp_path / "Aurora.narrative").document


def _added_graph_and_flow_candidate(source):
    """Add one explicitly placed beat and connect it in Graph and Main Story."""

    payload = source.model_dump(mode="python", exclude={"checksum"})
    node = deepcopy(next(item for item in payload["nodes"] if item["id"] == "node-inspection"))
    node.update({
        "id": "node-inspection-appeal",
        "title": "Inspection Appeal",
        "summary": "Mara files the ledger as a formal appeal.",
        "body": "Mara files the ledger as a formal appeal.",
    })
    node["metadata"] = {**node["metadata"], "title": node["title"], "label": node["title"]}
    placement = deepcopy(next(
        item for item in payload["placements"]
        if item["canonical_node_id"] == "node-inspection"
    ))
    placement.update({
        "id": "fixture-placement-node-inspection-appeal",
        "canonical_node_id": node["id"],
        "scope_key": f"<root>:{node['id']}",
        "x": 1120,
    })
    edge = deepcopy(next(item for item in payload["edges"] if item["id"] == "edge-condition-inspection"))
    edge.update({
        "id": "edge-ledger-appeal",
        "source_node_id": "node-sealed-ledger",
        "target_node_id": node["id"],
        "type": "enables",
        "label": "supports appeal",
    })
    member = deepcopy(next(
        item for item in payload["story_flow_nodes"]
        if item["node_id"] == "node-inspection"
    ))
    member.update({
        "id": f"flow-main-story:member:{node['id']}",
        "node_id": node["id"],
        "presentation_order": 4,
    })
    transition = deepcopy(next(
        item for item in payload["flow_transitions"]
        if item["id"] == "flow-transition-inspection-route"
    ))
    transition.update({
        "id": "flow-transition-inspection-appeal",
        "source_node_id": "node-inspection",
        "target_node_id": node["id"],
        "label": "File an appeal",
        "priority": 2,
    })
    for collection, record in (
        ("nodes", node),
        ("placements", placement),
        ("edges", edge),
        ("story_flow_nodes", member),
        ("flow_transitions", transition),
    ):
        payload[collection].append(record)
        payload[collection].sort(key=lambda item: item["id"])
    return create_project_document(**payload)


def _removed_graph_and_flow_candidate(source):
    """Remove one semantic edge and the documented Smuggler Route loop."""

    payload = source.model_dump(mode="python", exclude={"checksum"})
    payload["edges"] = [
        item for item in payload["edges"] if item["id"] != "edge-harbor-dialogue"
    ]
    payload["flow_transitions"] = [
        item for item in payload["flow_transitions"]
        if item["id"] != "flow-transition-blockade-cycle"
    ]
    return create_project_document(**payload)


def _modified_graph_flow_and_dialogue_candidate(source):
    """Modify one Graph beat, Flow transition, and nested Dialogue choice."""

    payload = source.model_dump(mode="python", exclude={"checksum"})
    opening = next(item for item in payload["nodes"] if item["id"] == "node-opening")
    opening["body"] = f"{opening['body']} Mara chooses how to answer the embargo."
    transition = next(
        item for item in payload["flow_transitions"]
        if item["id"] == "flow-transition-opening-dialogue"
    )
    transition["label"] = "Challenge the embargo"
    choice = next(
        item for item in payload["dialogues"][0]["document"]["elements"]
        if item["id"] == "choice-mara-response"
    )
    choice["options"][0]["condition"] = "items.node-sealed-ledger.holder.kind == \"player\""
    return create_project_document(**payload)


def _assert_preview_rectangles_do_not_overlap(changes) -> None:
    by_surface: dict[str, list[object]] = {}
    for change in changes:
        placement = change.after_placement or change.before_placement
        if placement is None or not placement.preview_only:
            continue
        existing = by_surface.setdefault(change.surface, [])
        assert all(not _overlaps(placement, other) for other in existing)
        existing.append(placement)


def _overlaps(left, right) -> bool:
    return not (
        left.x + left.width <= right.x
        or right.x + right.width <= left.x
        or left.y + left.height <= right.y
        or right.y + right.height <= left.y
    )
