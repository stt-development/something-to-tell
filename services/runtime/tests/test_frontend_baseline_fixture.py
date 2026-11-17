"""Frontend performance setup must reuse pinned content and avoid real projects."""

import pytest

from services.runtime.scripts.prepare_frontend_baseline import baseline_fixture, deep_detail_fixture, geometry_summary, long_dialogue_fixture, long_quest_fixture, prepare, root_grid_fixture, standalone_boundary_fixture
from services.runtime.stt_runtime.project_fixture import load_project_fixture, write_project_fixture


@pytest.mark.parametrize("size,count", [("small", 16), ("1000", 1000)])
def test_fixture_has_unique_ownership_and_stable_source_hash(size, count):
    first, fingerprint = baseline_fixture(size)
    second, repeated = baseline_fixture(size)
    assert len(first.nodes) == count
    assert first.manifest.project_id != second.manifest.project_id
    assert fingerprint == repeated and len(fingerprint) == 64
    assert all(node.project_id == first.manifest.project_id for node in first.nodes)


def test_prepare_refuses_existing_directory_without_writing(tmp_path):
    with pytest.raises(ValueError, match="frontend_baseline_destination_exists"):
        prepare(tmp_path, "small")
    assert list(tmp_path.iterdir()) == []


def test_scale_geometry_retains_and_reports_dense_overlap():
    fixture, _ = baseline_fixture("1000")
    result = geometry_summary(fixture)
    assert result["max_roots_at_one_origin"] > 1
    assert result["root_placements"] > result["distinct_root_origins"]
    assert result["variant"] == "pinned_original_overlap"


def test_root_grid_preserves_content_and_separates_root_groups(tmp_path):
    fixture, _ = baseline_fixture("1000")
    original = fixture.model_dump(mode="json")
    variant = root_grid_fixture(fixture)
    payload = variant.model_dump(mode="json")
    expected = fixture.model_dump(mode="json")
    expected["slug"] += "-root-grid-v1"
    expected["manifest"]["name"] += " - Root Grid"
    expected["placements"] = payload["placements"]
    assert payload == expected and fixture.model_dump(mode="json") == original
    assert root_grid_fixture(fixture) == variant
    assert len(variant.nodes) == 1000 and len(variant.placements) == 1116
    roots = []
    for before, after in zip(original["placements"], payload["placements"], strict=True):
        if before["container_node_id"] is not None:
            assert before == after
        else:
            assert {**before, "x": after["x"], "y": after["y"]} == after
            roots.append(after)
    assert len({(row["x"], row["y"]) for row in roots}) == len(roots)
    for index, first in enumerate(roots):
        for second in roots[index + 1:]:
            assert (first["x"] + first["width"] <= second["x"]
                or second["x"] + second["width"] <= first["x"]
                or first["y"] + first["height"] <= second["y"]
                or second["y"] + second["height"] <= first["y"])
    path = tmp_path / "grid.json"
    write_project_fixture(path, variant)
    assert load_project_fixture(path) == variant


def test_prepared_root_grid_reports_geometry_hash_and_pinned_source(tmp_path):
    result = prepare(tmp_path / "grid", "small", "root_grid_v1")
    assert result["variant"] == result["geometry"]["variant"] == "root_grid_v1"
    assert len(result["geometry"]["placement_geometry_sha256"]) == 64
    assert result["geometry"]["max_roots_at_one_origin"] == 1
    assert result["source_sha256"] == baseline_fixture("small")[1]


def test_standalone_boundary_variant_preserves_pinned_content_and_validates(tmp_path):
    fixture, _ = baseline_fixture("1000")
    original = fixture.model_dump(mode="json")
    variant = standalone_boundary_fixture(fixture)
    changed = [(before, after) for before, after in zip(fixture.scene_flow_boundaries, variant.scene_flow_boundaries)
        if before != after]
    assert len(changed) == 1
    before, after = changed[0]
    assert before.entry_node_id != after.entry_node_id
    assert not any(row.flow_id == after.flow_id and row.source_node_id == after.scene_node_id
        and row.target_node_id == after.entry_node_id for row in variant.flow_transitions)
    expected = fixture.model_dump(mode="json")
    next(row for row in expected["scene_flow_boundaries"] if row["id"] == after.id)["entry_node_id"] = after.entry_node_id
    expected["slug"] += "-standalone-boundary-v1"
    expected["manifest"]["name"] += " - Standalone Scene Boundary"
    assert variant.model_dump(mode="json") == expected
    assert fixture.model_dump(mode="json") == original
    path = tmp_path / "boundary.json"
    write_project_fixture(path, variant)
    assert load_project_fixture(path) == variant


def test_unknown_variant_is_rejected_before_creating_a_folder(tmp_path):
    directory = tmp_path / "not-created"
    with pytest.raises(ValueError, match="variant_unsupported"):
        prepare(directory, "small", "typo")
    assert not directory.exists()


def test_deep_detail_variant_changes_only_named_copy_geometry_and_preserves_all_canonical_records(tmp_path):
    fixture, _ = baseline_fixture("1000")
    original = fixture.model_dump(mode="json")
    variant = deep_detail_fixture(fixture)
    expected = fixture.model_dump(mode="json")
    expected["placements"] = variant.model_dump(mode="json")["placements"]
    expected["slug"] += "-deep-detail-v1"
    expected["manifest"]["name"] += " - Deep Detail"
    assert variant.model_dump(mode="json") == expected
    assert fixture.model_dump(mode="json") == original
    primary = {row.canonical_node_id: row for row in variant.placements if row.is_primary}
    depths = []
    for row in variant.placements:
        depth, seen, current = 0, set(), row
        while current.container_node_id is not None:
            assert current.id not in seen
            seen.add(current.id)
            parent = primary[current.container_node_id]
            assert current.x >= 0 and current.y >= 0
            assert current.x + current.width <= parent.width
            assert current.y + current.height <= parent.height
            current, depth = parent, depth + 1
        depths.append(depth)
    assert max(depths) == 7
    path = tmp_path / "detail.json"
    write_project_fixture(path, variant)
    assert load_project_fixture(path) == variant


def test_deep_detail_variant_rejects_inadequate_input_before_writing(tmp_path):
    directory = tmp_path / "not-created"
    with pytest.raises(ValueError, match="requires_locations"):
        prepare(directory, "small", "deep_detail_v1")
    assert not directory.exists()


def test_long_dialogue_variant_changes_only_one_owned_editor_document(tmp_path):
    fixture, _ = baseline_fixture("1000")
    original = fixture.model_dump(mode="json")
    variant = long_dialogue_fixture(fixture)
    payload = variant.model_dump(mode="json")
    expected = fixture.model_dump(mode="json")
    expected["dialogues"][0]["document"] = payload["dialogues"][0]["document"]
    expected["slug"] += "-long-dialogue-v1"
    expected["manifest"]["name"] += " - Long Dialogue"
    assert payload == expected and fixture.model_dump(mode="json") == original
    before = original["dialogues"][0]["document"]
    after = payload["dialogues"][0]["document"]
    assert len(after["elements"]) == 200
    assert after["elements"][:len(before["elements"])] == before["elements"]
    assert after["participants"] == before["participants"]
    assert len({element["id"] for element in after["elements"]}) == 200
    path = tmp_path / "long-dialogue.json"
    write_project_fixture(path, variant)
    assert load_project_fixture(path) == variant


def test_long_dialogue_variant_rejects_missing_participants_and_oversized_input():
    fixture, _ = baseline_fixture("small")
    empty = fixture.model_copy(update={"dialogues": []})
    with pytest.raises(ValueError, match="requires_participant"):
        long_dialogue_fixture(empty)
    payload = fixture.model_dump(mode="json")
    payload["dialogues"][0]["document"].update(participants=[], elements=[], entry_element_id=None)
    with pytest.raises(ValueError, match="requires_participant"):
        long_dialogue_fixture(type(fixture).model_validate(payload))
    payload = fixture.model_dump(mode="json")
    document = payload["dialogues"][0]["document"]
    document["elements"].extend(dict(id=f"extra-{index}", kind="line", text="Extra line",
        speaker_node_id=document["participants"][0], next_element_id=None) for index in range(201))
    with pytest.raises(ValueError, match="input_too_large"):
        long_dialogue_fixture(type(fixture).model_validate(payload))


def test_long_quest_variant_changes_only_one_owned_document_and_roundtrips(tmp_path):
    fixture, _ = baseline_fixture("1000")
    original = fixture.model_dump(mode="json")
    variant = long_quest_fixture(fixture)
    payload = variant.model_dump(mode="json")
    expected = fixture.model_dump(mode="json")
    expected["quests"][0]["document"] = payload["quests"][0]["document"]
    expected["slug"] += "-long-quest-v1"
    expected["manifest"]["name"] += " - Long Quest"
    assert payload == expected and fixture.model_dump(mode="json") == original
    before = original["quests"][0]["document"]
    after = payload["quests"][0]["document"]
    assert len(after["stages"]) == 200
    assert after["stages"][:len(before["stages"])] == before["stages"]
    for key in ("entry_stage_id", "objective", "quest_giver_node_id", "prerequisite_node_ids", "reward_node_ids"):
        assert after[key] == before[key]
    path = tmp_path / "long-quest.json"
    write_project_fixture(path, variant)
    assert load_project_fixture(path) == variant


def test_long_quest_variant_rejects_missing_or_oversized_input_and_initializes_empty_entry():
    fixture, _ = baseline_fixture("small")
    with pytest.raises(ValueError, match="requires_document"):
        long_quest_fixture(fixture.model_copy(update={"quests": []}))
    payload = fixture.model_dump(mode="json")
    document = payload["quests"][0]["document"]
    document["stages"], document["entry_stage_id"] = [], None
    empty = type(fixture).model_validate(payload)
    grown = long_quest_fixture(empty).quests[0].document
    assert grown.entry_stage_id == grown.stages[0].id
    payload = long_quest_fixture(empty).model_dump(mode="json")
    payload["quests"][0]["document"]["stages"].append(dict(id="extra-stage", title="Extra", description="", branches=[]))
    with pytest.raises(ValueError, match="input_too_large"):
        long_quest_fixture(type(fixture).model_validate(payload))
