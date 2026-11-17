from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient
from httpx import Response

from services.runtime.stt_runtime.api.dependencies import CORE_HISTORY_COMMANDS
from services.runtime.stt_runtime.app import create_app
from services.runtime.tests.test_composition_api import frame_payload, placement_payload, update_payload


Mutation = Callable[[dict[str, str]], Response]


def _open_project(client: TestClient, path: Path) -> tuple[str, str]:
    """Create a real project session so mutations use durable project history."""

    created = client.post(
        "/api/project-sessions/create",
        json={"path": str(path), "name": "Core history"},
    )
    assert created.status_code == 201
    payload = created.json()
    return payload["session"]["session_id"], payload["session"]["project_id"]


def _session_headers(session_id: str, history_revision: int | None = None) -> dict[str, str]:
    headers = {"X-Project-Session-Id": session_id}
    if history_revision is not None:
        headers["X-Project-History-Revision"] = str(history_revision)
    return headers


def _history(client: TestClient, session_id: str) -> dict[str, Any]:
    return client.get(f"/api/project-sessions/{session_id}/history").json()


def _document(client: TestClient, session_id: str) -> dict[str, Any]:
    return client.get(f"/api/project-sessions/{session_id}").json()["document"]


def _mutate_and_round_trip(
    client: TestClient,
    session_id: str,
    mutation: Mutation,
    *,
    command_kind: str,
    expected_status: int,
) -> Response:
    """Assert one endpoint call creates one reversible command with exact documents."""

    before = _document(client, session_id)
    summary = _history(client, session_id)
    response = mutation(_session_headers(session_id, summary["history_revision"]))
    assert response.status_code == expected_status, response.text
    after = _document(client, session_id)
    recorded = _history(client, session_id)
    assert recorded["history_revision"] == summary["history_revision"] + 1
    assert recorded["undo_depth"] == min(
        summary["undo_depth"] + 1,
        recorded["capacity"],
    )
    assert recorded["next_undo"]["command_kind"] == command_kind

    undone = client.post(
        f"/api/project-sessions/{session_id}/history/undo",
        json={"expected_history_revision": recorded["history_revision"]},
    )
    assert undone.status_code == 200, undone.text
    assert undone.json()["project"]["document"]["checksum"] == before["checksum"]

    redone = client.post(
        f"/api/project-sessions/{session_id}/history/redo",
        json={"expected_history_revision": undone.json()["history"]["history_revision"]},
    )
    assert redone.status_code == 200, redone.text
    assert redone.json()["project"]["document"]["checksum"] == after["checksum"]
    return response


def test_core_graph_and_membership_endpoints_record_reversible_commands(tmp_path: Path) -> None:
    """Node, relationship, and membership CRUD share one authoritative history."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_project(client, tmp_path / "GraphHistory.narrative")

        def create_node(kind: str, title: str) -> dict[str, Any]:
            response = _mutate_and_round_trip(
                client,
                session_id,
                lambda headers: client.post(
                    "/api/nodes",
                    headers=headers,
                    json={"project_id": project_id, "type": kind, "title": title},
                ),
                command_kind="create_node",
                expected_status=201,
            )
            return response.json()

        faction = create_node("Faction", "Trade Guild")
        character = create_node("Character", "Mara")
        event = create_node("Event", "Door opens")

        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                f"/api/nodes/{event['id']}",
                headers=headers,
                json={"project_id": project_id, "type": "Event", "title": "Door opens quietly"},
            ),
            command_kind="update_node",
            expected_status=200,
        )
        edge = _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                "/api/edges",
                headers=headers,
                json={
                    "project_id": project_id,
                    "source_node_id": character["id"],
                    "target_node_id": event["id"],
                    "type": "causes",
                    "label": "opens",
                },
            ),
            command_kind="create_edge",
            expected_status=201,
        ).json()
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                f"/api/edges/{edge['id']}",
                headers=headers,
                json={
                    "project_id": project_id,
                    "source_node_id": character["id"],
                    "target_node_id": event["id"],
                    "type": "enables",
                    "label": "unlocks",
                },
            ),
            command_kind="update_edge",
            expected_status=200,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.delete(f"/api/edges/{edge['id']}", headers=headers),
            command_kind="delete_edge",
            expected_status=204,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                f"/api/factions/{faction['id']}/members",
                headers=headers,
                json={"character_node_id": character["id"]},
            ),
            command_kind="add_faction_member",
            expected_status=201,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.delete(
                f"/api/factions/{faction['id']}/members/{character['id']}",
                headers=headers,
            ),
            command_kind="remove_faction_member",
            expected_status=204,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.delete(f"/api/nodes/{event['id']}", headers=headers),
            command_kind="delete_node",
            expected_status=204,
        )


def test_engine_tag_crud_uses_the_same_reversible_document_boundary(
    tmp_path: Path,
) -> None:
    """Engine integration metadata cannot bypass the project history chain."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_project(
            client,
            tmp_path / "EngineTagHistory.narrative",
        )
        node = client.post(
            "/api/nodes",
            headers=_session_headers(session_id),
            json={"project_id": project_id, "type": "Event", "title": "Export target"},
        ).json()
        payload = {
            "project_id": project_id,
            "target_type": "node",
            "target_id": node["id"],
            "engine": "unity",
            "key": "guid",
            "value": "history-guid",
        }
        created = _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post("/api/engine-tags", headers=headers, json=payload),
            command_kind="create_engine_tag",
            expected_status=201,
        ).json()
        revised = {**payload, "value": "history-guid-revised"}
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                f"/api/engine-tags/{created['id']}",
                headers=headers,
                json=revised,
            ),
            command_kind="update_engine_tag",
            expected_status=200,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.delete(
                f"/api/engine-tags/{created['id']}",
                headers=headers,
            ),
            command_kind="delete_engine_tag",
            expected_status=204,
        )


def test_composition_gestures_and_cascade_delete_are_single_history_entries(tmp_path: Path) -> None:
    """Compound frame, batch movement, and cascade deletion each undo atomically."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_project(client, tmp_path / "CompositionHistory.narrative")
        frame = _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                "/api/compositions/frames",
                headers=headers,
                json=frame_payload(project_id),
            ),
            command_kind="create_composition_frame",
            expected_status=201,
        ).json()

        nodes: list[dict[str, Any]] = []
        for kind, title in (("Character", "Mara"), ("Item", "Ledger")):
            response = _mutate_and_round_trip(
                client,
                session_id,
                lambda headers, kind=kind, title=title: client.post(
                    "/api/nodes",
                    headers=headers,
                    json={"project_id": project_id, "type": kind, "title": title},
                ),
                command_kind="create_node",
                expected_status=201,
            )
            nodes.append(response.json())

        placements: list[dict[str, Any]] = []
        for index, node in enumerate(nodes):
            response = _mutate_and_round_trip(
                client,
                session_id,
                lambda headers, node=node, index=index: client.post(
                    "/api/compositions/placements",
                    headers=headers,
                    json=placement_payload(project_id, node["id"], x=100 + index * 300),
                ),
                command_kind="create_placement",
                expected_status=201,
            )
            placements.append(
                next(
                    item
                    for item in response.json()["placements"]
                    if item["canonical_node_id"] == node["id"]
                )
            )

        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                "/api/compositions/placements",
                headers=headers,
                json={
                    "project_id": project_id,
                    "placements": [
                        {
                            "placement_id": placement["id"],
                            **update_payload(
                                project_id,
                                frame["node"]["id"],
                                is_primary=True,
                                x=180 + index * 280,
                            ),
                        }
                        for index, placement in enumerate(placements)
                    ],
                },
            ),
            command_kind="update_placements",
            expected_status=200,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.delete(
                f"/api/compositions/entities/{frame['node']['id']}",
                headers=headers,
            ),
            command_kind="delete_composition_entity",
            expected_status=204,
        )


def test_failed_and_stale_core_mutations_do_not_change_document_or_history(tmp_path: Path) -> None:
    """Endpoint validation and optimistic revision conflicts leave both stores intact."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_project(client, tmp_path / "ConflictHistory.narrative")
        headers = _session_headers(session_id)
        created = client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Existing"},
        )
        assert created.status_code == 201
        before = _document(client, session_id)
        summary = _history(client, session_id)

        invalid = client.post(
            "/api/edges",
            headers=_session_headers(session_id, summary["history_revision"]),
            json={
                "project_id": project_id,
                "source_node_id": created.json()["id"],
                "target_node_id": "missing-node",
                "type": "causes",
            },
        )
        assert invalid.status_code in {404, 409}
        assert _document(client, session_id)["checksum"] == before["checksum"]
        assert _history(client, session_id) == summary

        stale = client.post(
            "/api/nodes",
            headers=_session_headers(session_id, summary["history_revision"] - 1),
            json={"project_id": project_id, "type": "Event", "title": "Stale"},
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["code"] == "history_revision_stale"
        assert _document(client, session_id)["checksum"] == before["checksum"]
        assert _history(client, session_id) == summary


def test_core_history_inventory_covers_all_phase_three_core_routes() -> None:
    """Keep command ownership explicit when core API routes are renamed or added."""

    assert set(CORE_HISTORY_COMMANDS) == {
        "add_faction_member",
        "create_composition_frame",
        "create_edge_resource",
        "create_issue_resource",
        "create_engine_tag_resource",
        "create_node_resource",
        "create_visual_placement",
        "delete_composition_entity",
        "delete_edge_resource",
        "delete_issue_resource",
        "delete_engine_tag_resource",
        "delete_node_resource",
        "remove_faction_member",
        "remove_visual_placement",
        "update_edge_resource",
        "update_issue_resource",
        "update_engine_tag_resource",
        "update_node_resource",
        "update_visual_placement",
        "update_visual_placements",
    }
