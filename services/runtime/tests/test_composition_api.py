from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyEdgeRepository, SqlAlchemyNodeRepository, SqlAlchemyVisualPlacementRepository
from services.runtime.tests.test_crud_api import client, create_project
from services.runtime.tests.test_dialogue_api import create_typed_node
from services.runtime.tests.test_dialogue_workflow import persistent_runtime


def placement_payload(
    project_id: str,
    canonical_node_id: str,
    container_node_id: str | None = None,
    *,
    is_primary: bool = False,
    x: float = 120,
) -> dict[str, object]:
    return {
        "project_id": project_id,
        "container_node_id": container_node_id,
        "canonical_node_id": canonical_node_id,
        "position": {"x": x, "y": 80},
        "size": {"width": 240, "height": 140},
        "is_primary": is_primary,
        "presentation_state": "expanded",
        "metadata": {"source": "test"},
    }


def update_payload(
    project_id: str,
    container_node_id: str | None,
    *,
    is_primary: bool = False,
    x: float = 160,
) -> dict[str, object]:
    payload = placement_payload(project_id, "unused", container_node_id, is_primary=is_primary, x=x)
    payload.pop("canonical_node_id")
    return payload


def frame_payload(project_id: str, kind: str = "Scene") -> dict[str, object]:
    return {
        "project_id": project_id,
        "kind": kind,
        "title": f"New {kind}",
        "summary": "Free-drawn frame",
        "body": "Free-drawn frame",
        "status": "canon",
        "position": {"x": 140, "y": 90},
        "size": {"width": 520, "height": 360},
        "metadata": {"tags": ["composition"]},
    }


def test_creates_frame_node_and_root_placement_atomically(client: TestClient) -> None:
    project = create_project(client)

    response = client.post("/api/compositions/frames", json=frame_payload(project["id"], "Location"))

    assert response.status_code == 201
    created = response.json()
    assert created["node"]["type"] == "Location"
    assert created["node"]["metadata"]["composition_frame"] is True
    assert created["node"]["metadata"]["root_placement_id"] == created["placement"]["id"]
    assert created["placement"] == {
        "placement_version": 1,
        "id": created["placement"]["id"],
        "project_id": project["id"],
        "container_node_id": None,
        "canonical_node_id": created["node"]["id"],
        "position": {"x": 140.0, "y": 90.0},
        "size": {"width": 520.0, "height": 360.0},
        "is_primary": True,
        "presentation_state": "expanded",
        "metadata": {"created_with_frame": True},
    }


def test_rolls_back_frame_node_when_root_placement_creation_fails(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = create_project(client)

    def fail_placement(self: SqlAlchemyVisualPlacementRepository, placement: object):
        raise RuntimeError("forced frame placement failure")

    monkeypatch.setattr(SqlAlchemyVisualPlacementRepository, "add", fail_placement)
    with pytest.raises(RuntimeError, match="forced frame placement failure"):
        client.post("/api/compositions/frames", json=frame_payload(project["id"]))

    assert client.get(f"/api/nodes?project_id={project['id']}").json() == []


def test_deletion_impact_and_entity_delete_preserve_orphaned_children(client: TestClient) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Opening")
    character = create_typed_node(client, project["id"], "Character", "Mara")
    client.post("/api/compositions/placements", json=placement_payload(project["id"], scene["id"], is_primary=True, x=100))
    client.post("/api/compositions/placements", json=placement_payload(project["id"], character["id"], scene["id"], is_primary=True, x=40))

    impact = client.get(f"/api/compositions/entities/{scene['id']}/impact")
    deletion = client.delete(f"/api/compositions/entities/{scene['id']}")
    snapshot = client.get(f"/api/compositions?project_id={project['id']}").json()

    assert impact.status_code == 200
    impact_payload = impact.json()
    assert len(impact_payload.pop("engine_tag_binding_ids")) == 1
    assert impact_payload == {
        "node_id": scene["id"],
        "placement_count": 1,
        "contained_instance_count": 1,
        "edge_count": 1,
        "agent_memory_ids": [],
    }
    assert deletion.status_code == 204
    assert client.get(f"/api/nodes/{scene['id']}").status_code == 404
    assert snapshot["placements"][0]["canonical_node_id"] == character["id"]
    assert snapshot["placements"][0]["container_node_id"] is None


def test_rolls_back_composition_entity_delete_when_node_delete_fails(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Opening")
    client.post("/api/compositions/placements", json=placement_payload(project["id"], scene["id"], is_primary=True))

    def fail_delete(self: SqlAlchemyNodeRepository, node_id: str) -> None:
        raise RuntimeError("forced entity delete failure")

    monkeypatch.setattr(SqlAlchemyNodeRepository, "delete", fail_delete)
    with pytest.raises(RuntimeError, match="forced entity delete failure"):
        client.delete(f"/api/compositions/entities/{scene['id']}")

    assert client.get(f"/api/nodes/{scene['id']}").status_code == 200
    assert len(client.get(f"/api/compositions?project_id={project['id']}").json()["placements"]) == 1


def test_legacy_project_lists_empty_composition_without_migration_errors(client: TestClient) -> None:
    project = create_project(client)

    response = client.get(f"/api/compositions?project_id={project['id']}")

    assert response.status_code == 200
    assert response.json() == {
        "composition_version": 1,
        "project_id": project["id"],
        "placements": [],
        "semantic_relationships": [],
    }


def test_lazily_backfills_legacy_node_geometry_as_idempotent_root_placements(client: TestClient) -> None:
    project = create_project(client)
    node = create_typed_node(
        client,
        project["id"],
        "Scene",
        "Legacy scene",
        {"position": {"x": 44, "y": 88}, "width": 420, "height": 260, "owner": "author"},
    )

    first = client.get(f"/api/compositions?project_id={project['id']}")
    second = client.get(f"/api/compositions?project_id={project['id']}")

    assert first.status_code == 200
    assert first.json() == second.json()
    assert len(first.json()["placements"]) == 1
    assert first.json()["placements"][0] == {
        "placement_version": 1,
        "id": first.json()["placements"][0]["id"],
        "project_id": project["id"],
        "container_node_id": None,
        "canonical_node_id": node["id"],
        "position": {"x": 44.0, "y": 88.0},
        "size": {"width": 420.0, "height": 260.0},
        "is_primary": True,
        "presentation_state": "expanded",
        "metadata": {"migrated_from_node_metadata": True},
    }
    assert client.get(f"/api/nodes/{node['id']}").json()["metadata"]["owner"] == "author"


def test_creates_root_and_linked_placement_with_hidden_contains_edge(client: TestClient) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Dock scene")
    character = create_typed_node(client, project["id"], "Character", "Mara")

    root = client.post("/api/compositions/placements", json=placement_payload(project["id"], character["id"]))
    linked = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], character["id"], scene["id"]),
    )

    assert root.status_code == 201
    assert root.json()["placements"][0]["is_primary"] is True
    assert linked.status_code == 201
    assert len(linked.json()["placements"]) == 2
    assert sum(placement["is_primary"] for placement in linked.json()["placements"]) == 1
    assert linked.json()["semantic_relationships"] == [
        {
            "edge_id": linked.json()["semantic_relationships"][0]["edge_id"],
            "project_id": project["id"],
            "relationship_type": "contains",
            "source_node_id": scene["id"],
            "target_node_id": character["id"],
            "canvas_visibility": "hidden",
            "metadata": {"semantic_scope": "composition", "canvas_visibility": "hidden"},
        }
    ]
    scoped = client.get(
        f"/api/compositions/placements?project_id={project['id']}&container_node_id={scene['id']}"
    )
    assert [placement["id"] for placement in scoped.json()] == [linked.json()["placements"][1]["id"]]


def test_moves_placement_and_updates_contains_edge_atomically(client: TestClient) -> None:
    project = create_project(client)
    location = create_typed_node(client, project["id"], "Location", "Warehouse")
    item = create_typed_node(client, project["id"], "Item", "Ledger")
    created = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], item["id"], is_primary=True),
    ).json()
    placement_id = created["placements"][0]["id"]

    moved = client.put(
        f"/api/compositions/placements/{placement_id}",
        json=update_payload(project["id"], location["id"], is_primary=True),
    )
    restored = client.put(
        f"/api/compositions/placements/{placement_id}",
        json=update_payload(project["id"], None, is_primary=True, x=320),
    )

    assert moved.status_code == 200
    assert moved.json()["placements"][0]["container_node_id"] == location["id"]
    assert len(moved.json()["semantic_relationships"]) == 1
    assert restored.status_code == 200
    assert restored.json()["placements"][0]["container_node_id"] is None
    assert restored.json()["placements"][0]["position"]["x"] == 320
    assert restored.json()["semantic_relationships"] == []


def test_moves_multiple_placements_in_one_composition_transaction(client: TestClient) -> None:
    project = create_project(client)
    first = create_typed_node(client, project["id"], "Character", "Mara")
    second = create_typed_node(client, project["id"], "Item", "Ledger")
    first_placement = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], first["id"], is_primary=True, x=100),
    ).json()["placements"][0]
    second_placement = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], second["id"], is_primary=True, x=300),
    ).json()["placements"][1]

    response = client.put(
        "/api/compositions/placements",
        json={
            "project_id": project["id"],
            "placements": [
                {"placement_id": first_placement["id"], **update_payload(project["id"], None, is_primary=True, x=180)},
                {"placement_id": second_placement["id"], **update_payload(project["id"], None, is_primary=True, x=380)},
            ],
        },
    )

    assert response.status_code == 200
    positions = {item["canonical_node_id"]: item["position"]["x"] for item in response.json()["placements"]}
    assert positions == {first["id"]: 180.0, second["id"]: 380.0}


def test_rolls_back_every_group_placement_when_one_update_fails(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    project = create_project(client)
    first = create_typed_node(client, project["id"], "Character", "Mara")
    second = create_typed_node(client, project["id"], "Item", "Ledger")
    created_first = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], first["id"], is_primary=True, x=100),
    ).json()["placements"][0]
    created_second = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], second["id"], is_primary=True, x=300),
    ).json()["placements"][1]
    original_update = SqlAlchemyVisualPlacementRepository.update
    update_count = 0

    def fail_second_update(self: SqlAlchemyVisualPlacementRepository, placement: object):
        nonlocal update_count
        update_count += 1
        if update_count == 2:
            raise RuntimeError("forced group placement failure")
        return original_update(self, placement)

    monkeypatch.setattr(SqlAlchemyVisualPlacementRepository, "update", fail_second_update)
    with pytest.raises(RuntimeError, match="forced group placement failure"):
        client.put(
            "/api/compositions/placements",
            json={
                "project_id": project["id"],
                "placements": [
                    {"placement_id": created_first["id"], **update_payload(project["id"], None, is_primary=True, x=180)},
                    {"placement_id": created_second["id"], **update_payload(project["id"], None, is_primary=True, x=380)},
                ],
            },
        )

    restored = client.get(f"/api/compositions?project_id={project['id']}").json()
    positions = {item["canonical_node_id"]: item["position"]["x"] for item in restored["placements"]}
    assert positions == {first["id"]: 100.0, second["id"]: 300.0}


def test_rejects_group_location_cycle_without_moving_any_placement(client: TestClient) -> None:
    project = create_project(client)
    harbor = create_typed_node(client, project["id"], "Location", "Harbor")
    warehouse = create_typed_node(client, project["id"], "Location", "Warehouse")
    first_snapshot = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], harbor["id"], is_primary=True, x=100),
    ).json()
    second_snapshot = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], warehouse["id"], is_primary=True, x=300),
    ).json()
    harbor_placement = next(item for item in first_snapshot["placements"] if item["canonical_node_id"] == harbor["id"])
    warehouse_placement = next(item for item in second_snapshot["placements"] if item["canonical_node_id"] == warehouse["id"])

    response = client.put(
        "/api/compositions/placements",
        json={
            "project_id": project["id"],
            "placements": [
                {
                    "placement_id": harbor_placement["id"],
                    **update_payload(project["id"], warehouse["id"], is_primary=True, x=180),
                },
                {
                    "placement_id": warehouse_placement["id"],
                    **update_payload(project["id"], harbor["id"], is_primary=True, x=380),
                },
            ],
        },
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "composition_location_cycle"
    restored = client.get(f"/api/compositions?project_id={project['id']}").json()
    assert {
        item["canonical_node_id"]: (item["container_node_id"], item["position"]["x"])
        for item in restored["placements"]
    } == {harbor["id"]: (None, 100.0), warehouse["id"]: (None, 300.0)}


def test_removing_last_contained_instance_restores_root_and_preserves_node(client: TestClient) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Dock scene")
    event = create_typed_node(client, project["id"], "Event", "Door opens")
    created = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], event["id"], scene["id"]),
    ).json()

    response = client.delete(f"/api/compositions/placements/{created['placements'][0]['id']}")

    assert response.status_code == 200
    assert len(response.json()["placements"]) == 1
    assert response.json()["placements"][0]["container_node_id"] is None
    assert response.json()["placements"][0]["canonical_node_id"] == event["id"]
    assert response.json()["placements"][0]["is_primary"] is True
    assert response.json()["semantic_relationships"] == []
    assert client.get(f"/api/nodes/{event['id']}").status_code == 200


def test_rejects_invalid_missing_cross_project_and_duplicate_placements(client: TestClient) -> None:
    project = create_project(client)
    other_project = create_project(client)
    location = create_typed_node(client, project["id"], "Location", "Harbor")
    scene = create_typed_node(client, project["id"], "Scene", "Arrival")
    external = create_typed_node(client, other_project["id"], "Character", "External")

    invalid_kind = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], scene["id"], location["id"]),
    )
    missing = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], "missing", location["id"]),
    )
    cross_project = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], external["id"], location["id"]),
    )
    first = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], location["id"], None),
    )
    duplicate = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], location["id"], None),
    )

    assert invalid_kind.json()["detail"]["code"] == "composition_child_kind_invalid"
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "composition_canonical_not_found"
    assert cross_project.json()["detail"]["code"] == "composition_cross_project_node"
    assert first.status_code == 201
    assert duplicate.json()["detail"]["code"] == "composition_duplicate_placement"


def test_rejects_direct_and_indirect_location_containment_cycles(client: TestClient) -> None:
    project = create_project(client)
    harbor = create_typed_node(client, project["id"], "Location", "Harbor")
    warehouse = create_typed_node(client, project["id"], "Location", "Warehouse")
    office = create_typed_node(client, project["id"], "Location", "Office")
    assert client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], warehouse["id"], harbor["id"]),
    ).status_code == 201
    assert client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], office["id"], warehouse["id"]),
    ).status_code == 201

    cycle = client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], harbor["id"], office["id"]),
    )

    assert cycle.status_code == 409
    assert cycle.json()["detail"]["code"] == "composition_cycle"
    snapshot = client.get(f"/api/compositions?project_id={project['id']}").json()
    assert len(snapshot["placements"]) == 3
    assert len(snapshot["semantic_relationships"]) == 2
    assert all(
        not (
            relationship["source_node_id"] == office["id"]
            and relationship["target_node_id"] == harbor["id"]
        )
        for relationship in snapshot["semantic_relationships"]
    )


def test_reserved_edges_and_node_deletion_require_composition_services(client: TestClient) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Dock scene")
    character = create_typed_node(client, project["id"], "Character", "Mara")
    assert client.post(
        "/api/compositions/placements",
        json=placement_payload(project["id"], character["id"], scene["id"]),
    ).status_code == 201

    reserved = client.post(
        "/api/edges",
        json={
            "project_id": project["id"],
            "source_node_id": scene["id"],
            "target_node_id": character["id"],
            "type": "contains",
        },
    )
    deletion = client.delete(f"/api/nodes/{character['id']}")

    assert reserved.status_code == 409
    assert reserved.json()["detail"]["code"] == "reserved_semantic_edge_type"
    assert deletion.status_code == 409
    assert deletion.json()["detail"]["code"] == "composition_delete_requires_impact"


def test_rolls_back_placement_when_contains_edge_creation_fails(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = create_project(client)
    scene = create_typed_node(client, project["id"], "Scene", "Dock scene")
    character = create_typed_node(client, project["id"], "Character", "Mara")
    original_add = SqlAlchemyEdgeRepository.add

    def fail_contains(self: SqlAlchemyEdgeRepository, edge: object):
        if getattr(edge, "type", None) == "contains":
            raise RuntimeError("forced contains edge failure")
        return original_add(self, edge)

    monkeypatch.setattr(SqlAlchemyEdgeRepository, "add", fail_contains)
    with pytest.raises(RuntimeError, match="forced contains edge failure"):
        client.post(
            "/api/compositions/placements",
            json=placement_payload(project["id"], character["id"], scene["id"]),
        )

    snapshot = client.get(f"/api/compositions?project_id={project['id']}").json()
    assert {placement["canonical_node_id"] for placement in snapshot["placements"]} == {scene["id"], character["id"]}
    assert all(placement["container_node_id"] is None for placement in snapshot["placements"])
    assert snapshot["semantic_relationships"] == []
    assert client.get(f"/api/edges?project_id={project['id']}").json() == []


def test_composition_geometry_and_membership_survive_runtime_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "composition-restart.sqlite"
    with persistent_runtime(database_path) as first_runtime:
        project = create_project(first_runtime)
        location = create_typed_node(first_runtime, project["id"], "Location", "Warehouse")
        item = create_typed_node(first_runtime, project["id"], "Item", "Ledger")
        created = first_runtime.post(
            "/api/compositions/placements",
            json=placement_payload(project["id"], item["id"], location["id"], is_primary=True, x=275),
        )
        assert created.status_code == 201
        placement_id = created.json()["placements"][0]["id"]
        relationship_id = created.json()["semantic_relationships"][0]["edge_id"]

    with persistent_runtime(database_path) as restarted_runtime:
        restored = restarted_runtime.get(f"/api/compositions?project_id={project['id']}")

    assert restored.status_code == 200
    assert restored.json()["placements"][0] == {
        "placement_version": 1,
        "id": placement_id,
        "project_id": project["id"],
        "container_node_id": location["id"],
        "canonical_node_id": item["id"],
        "position": {"x": 275.0, "y": 80.0},
        "size": {"width": 240.0, "height": 140.0},
        "is_primary": True,
        "presentation_state": "expanded",
        "metadata": {"source": "test"},
    }
    assert restored.json()["semantic_relationships"][0]["edge_id"] == relationship_id
    assert restored.json()["semantic_relationships"][0]["canvas_visibility"] == "hidden"
