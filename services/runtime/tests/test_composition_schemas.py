import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.composition import (
    ProjectCompositionSnapshot,
    SemanticRelationship,
    VisualPlacement,
    allows_composition,
    has_location_containment_cycle,
)


def placement(
    placement_id: str,
    canonical_node_id: str,
    *,
    container_node_id: str | None = None,
    is_primary: bool = False,
) -> dict[str, object]:
    return {
        "id": placement_id,
        "project_id": "project-aurora",
        "container_node_id": container_node_id,
        "canonical_node_id": canonical_node_id,
        "position": {"x": 120, "y": 80},
        "size": {"width": 240, "height": 140},
        "is_primary": is_primary,
    }


def relationship(edge_id: str, source: str, target: str) -> SemanticRelationship:
    return SemanticRelationship(
        edge_id=edge_id,
        project_id="project-aurora",
        relationship_type="contains",
        source_node_id=source,
        target_node_id=target,
    )


def test_snapshot_accepts_root_and_multi_container_linked_placements() -> None:
    snapshot = ProjectCompositionSnapshot.model_validate(
        {
            "project_id": "project-aurora",
            "placements": [
                placement("placement-root", "character-mara", is_primary=True),
                placement("placement-scene", "character-mara", container_node_id="scene-dock"),
                placement("placement-harbor", "character-mara", container_node_id="location-harbor"),
            ],
            "semantic_relationships": [relationship("edge-scene-mara", "scene-dock", "character-mara")],
        }
    )

    assert snapshot.placements[0].placement_version == 1
    assert snapshot.placements[1].canonical_node_id == snapshot.placements[0].canonical_node_id
    assert snapshot.semantic_relationships[0].canvas_visibility == "hidden"


@pytest.mark.parametrize(
    "placements",
    [
        [placement("same", "character-a", is_primary=True), placement("same", "character-b", is_primary=True)],
        [placement("first", "character-a", is_primary=True), placement("second", "character-a", is_primary=True)],
        [placement("first", "character-a"), placement("second", "character-a", container_node_id="scene-a")],
    ],
)
def test_snapshot_rejects_duplicate_ids_scopes_and_invalid_primary_counts(placements: list[dict[str, object]]) -> None:
    with pytest.raises(ValidationError):
        ProjectCompositionSnapshot(project_id="project-aurora", placements=placements)


def test_placement_rejects_self_containment_and_invalid_geometry() -> None:
    with pytest.raises(ValidationError, match="cannot be placed inside itself"):
        VisualPlacement.model_validate(
            placement("placement-self", "scene-a", container_node_id="scene-a", is_primary=True)
        )
    with pytest.raises(ValidationError):
        VisualPlacement.model_validate(
            {
                **placement("placement-small", "scene-a", is_primary=True),
                "size": {"width": 0, "height": 140},
            }
        )


def test_composition_matrix_distinguishes_scene_and_location_children() -> None:
    assert allows_composition("Scene", "Dialogue") is True
    assert allows_composition("Scene", "Scene") is False
    assert allows_composition("Location", "Location") is True
    assert allows_composition("Location", "Dialogue") is False
    assert allows_composition("Location", "Scene") is False
    assert allows_composition("Faction", "Character") is False


def test_location_cycle_detection_allows_hierarchy_and_rejects_loops() -> None:
    node_kinds = {"harbor": "Location", "warehouse": "Location", "office": "Location"}
    hierarchy = [relationship("edge-1", "harbor", "warehouse"), relationship("edge-2", "warehouse", "office")]

    assert has_location_containment_cycle(node_kinds, hierarchy) is False
    assert has_location_containment_cycle(
        node_kinds,
        [*hierarchy, relationship("edge-3", "office", "harbor")],
    ) is True

