from collections.abc import Generator
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from services.runtime.stt_runtime.api.dependencies import get_uow
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.narrative_state.service import (
    NarrativeStateAuthoringService,
)
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.narrative_state_api import (
    NarrativeEffectBindingBatch,
)
from services.runtime.tests.test_story_flow_api import (
    create_flow,
    create_node,
    create_project,
    make_engine,
)


@pytest.fixture
def authoring_client() -> Generator[tuple[TestClient, sessionmaker[Session]], None, None]:
    """Share one transaction-capable in-memory database across authoring API calls."""

    engine = make_engine("sqlite://", static_pool=True)
    factory = sessionmaker(
        bind=engine, autoflush=False, autocommit=False, expire_on_commit=False
    )
    app: FastAPI = create_app()

    def override_uow() -> Generator[SqlAlchemyUnitOfWork, None, None]:
        with SqlAlchemyUnitOfWork(factory) as uow:
            yield uow

    app.dependency_overrides[get_uow] = override_uow
    with TestClient(app) as client:
        yield client, factory


def _effect_payload(project_id: str, effect_id: str, flag: str) -> dict:
    """Build the minimal typed set-flag command used by CRUD tests."""

    return {
        "project_id": project_id,
        "expected_revision": 0,
        "effect": {
            "id": effect_id,
            "project_id": project_id,
            "operation": "set_flag",
            "payload": {"flag": flag},
            "explanation": f"Set {flag}.",
        },
    }


def _binding_payload(project_id: str, effect_id: str, node_id: str, order: int) -> dict:
    """Build one canonical node-entry binding request."""

    return {
        "project_id": project_id,
        "expected_revision": 0,
        "effect_id": effect_id,
        "owner": {"owner_kind": "node_entry", "owner_id": node_id},
        "application_order": order,
    }


def _seed_effects(client: TestClient) -> dict[str, object]:
    """Create one project with a Flow, canonical nodes, and two ordered effects."""

    project = create_project(client)
    flow = create_flow(client, project["id"])
    event = create_node(client, project["id"], "Event", "Open the gate")
    character = create_node(client, project["id"], "Character", "Mara")
    item = create_node(client, project["id"], "Item", "Ledger")
    for effect_id, flag in (("effect-first", "first"), ("effect-second", "second")):
        response = client.post(
            "/api/narrative-state/effects",
            json=_effect_payload(project["id"], effect_id, flag),
        )
        assert response.status_code == 201, response.text
    bindings = []
    for order, effect_id in enumerate(("effect-first", "effect-second")):
        response = client.post(
            "/api/narrative-state/bindings",
            json=_binding_payload(project["id"], effect_id, event["id"], order),
        )
        assert response.status_code == 201, response.text
        bindings.append(response.json())
    return {
        "project": project,
        "flow": flow,
        "event": event,
        "character": character,
        "item": item,
        "bindings": bindings,
    }


def test_crud_snapshot_integrity_conflicts_and_stable_errors(authoring_client) -> None:
    client, _ = authoring_client
    seeded = _seed_effects(client)
    project_id = seeded["project"]["id"]
    flow_id = seeded["flow"]["id"]

    state = client.put(
        "/api/narrative-state/initial-states",
        json={
            "project_id": project_id,
            "flow_id": flow_id,
            "flags": {"gate_open": False},
            "item_custody": [
                {
                    "item_node_id": seeded["item"]["id"],
                    "holder": {"kind": "unowned"},
                }
            ],
        },
    )
    assert state.status_code == 200, state.text
    assert state.json()["flags"] == {"gate_open": False}

    conflict = client.post(
        "/api/narrative-state/bindings",
        json=_binding_payload(project_id, "effect-first", seeded["event"]["id"], 0),
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"] == {
        "code": "narrative_state_reference_invalid",
        "message_key": "narrativeState.error.narrative_state_reference_invalid",
        "parameters": {},
    }

    missing_owner = client.post(
        "/api/narrative-state/bindings",
        json=_binding_payload(project_id, "effect-first", "missing-node", 2),
    )
    assert missing_owner.status_code == 409
    assert missing_owner.json()["detail"]["code"] == "narrative_state_owner_missing"
    assert missing_owner.json()["detail"]["message_key"] == (
        "narrativeState.error.narrative_state_owner_missing"
    )

    missing_item = client.post(
        "/api/narrative-state/effects",
        json={
            "project_id": project_id,
            "effect": {
                "id": "effect-missing-item",
                "project_id": project_id,
                "operation": "transfer_item",
                "payload": {
                    "item_node_id": "missing-item",
                    "from_holder": {"kind": "unowned"},
                    "to_holder": {"kind": "player"},
                },
                "explanation": "Invalid canonical reference.",
            },
        },
    )
    assert missing_item.status_code == 409
    assert missing_item.json()["detail"]["code"] == (
        "narrative_state_reference_invalid"
    )

    snapshot = client.get(f"/api/narrative-state/projects/{project_id}")
    assert snapshot.status_code == 200
    assert len(snapshot.json()["initial_states"]) == 1
    assert [item["id"] for item in snapshot.json()["effects"]] == [
        "effect-first",
        "effect-second",
    ]
    assert snapshot.json()["integrity"]["facts"] == []

    owner_impact = client.post(
        "/api/narrative-state/owners/impact",
        json={
            "project_id": project_id,
            "owner": {
                "owner_kind": "node_entry",
                "owner_id": seeded["event"]["id"],
            },
        },
    )
    assert owner_impact.status_code == 200
    assert owner_impact.json()["binding_ids"] == sorted(
        item["id"] for item in seeded["bindings"]
    )

    updated_effect_payload = _effect_payload(project_id, "effect-first", "updated")
    updated_effect_payload["effect"]["explanation"] = "Updated explanation."
    updated_effect = client.put(
        "/api/narrative-state/effects/effect-first",
        json=updated_effect_payload,
    )
    assert updated_effect.status_code == 200
    assert updated_effect.json()["explanation"] == "Updated explanation."

    moved_binding = client.put(
        f"/api/narrative-state/bindings/{seeded['bindings'][0]['id']}",
        json=_binding_payload(
            project_id,
            "effect-first",
            seeded["character"]["id"],
            0,
        ),
    )
    assert moved_binding.status_code == 200
    assert moved_binding.json()["owner"]["owner_id"] == seeded["character"]["id"]
    deleted_binding = client.request(
        "DELETE",
        f"/api/narrative-state/bindings/{seeded['bindings'][1]['id']}",
        json={"project_id": project_id, "expected_revision": 0},
    )
    assert deleted_binding.status_code == 204
    deleted_state = client.request(
        "DELETE",
        f"/api/narrative-state/initial-states/{state.json()['id']}",
        json={"project_id": project_id, "expected_revision": 0},
    )
    assert deleted_state.status_code == 204


def test_ordered_batch_is_input_immutable_and_rolls_back_on_failure(
    authoring_client, monkeypatch
) -> None:
    client, factory = authoring_client
    seeded = _seed_effects(client)
    project_id = seeded["project"]["id"]
    bindings = seeded["bindings"]
    payload = NarrativeEffectBindingBatch.model_validate(
        {
            "project_id": project_id,
            "owner": {
                "owner_kind": "node_entry",
                "owner_id": seeded["event"]["id"],
            },
            "bindings": [
                {"binding_id": bindings[0]["id"], "application_order": 1},
                {"binding_id": bindings[1]["id"], "application_order": 0},
            ],
        }
    )
    original_payload = deepcopy(payload.model_dump(mode="json"))

    with SqlAlchemyUnitOfWork(factory) as uow:
        original_update = uow.narrative_effect_bindings.update
        calls = 0

        def fail_second_update(entity):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise RuntimeError("simulated batch failure")
            return original_update(entity)

        monkeypatch.setattr(uow.narrative_effect_bindings, "update", fail_second_update)
        with pytest.raises(RuntimeError, match="simulated batch failure"):
            NarrativeStateAuthoringService().reorder_bindings(uow, payload)

    assert payload.model_dump(mode="json") == original_payload
    snapshot = client.get(f"/api/narrative-state/projects/{project_id}").json()
    assert [item["effect_id"] for item in snapshot["bindings"]] == [
        "effect-first",
        "effect-second",
    ]
    assert [item["application_order"] for item in snapshot["bindings"]] == [0, 1]

    reordered = client.put(
        "/api/narrative-state/bindings/reorder",
        json=payload.model_dump(mode="json"),
    )
    assert reordered.status_code == 200, reordered.text
    assert [item["effect_id"] for item in reordered.json()] == [
        "effect-second",
        "effect-first",
    ]


def test_effect_deletion_requires_impact_and_rolls_back(authoring_client, monkeypatch) -> None:
    client, factory = authoring_client
    seeded = _seed_effects(client)
    project_id = seeded["project"]["id"]
    effect_id = "effect-first"

    impact = client.get(f"/api/narrative-state/effects/{effect_id}/impact")
    assert impact.status_code == 200
    assert impact.json()["binding_ids"] == [seeded["bindings"][0]["id"]]
    rejected = client.request(
        "DELETE",
        f"/api/narrative-state/effects/{effect_id}",
        json={"project_id": project_id, "expected_revision": 0},
    )
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "narrative_state_delete_requires_review"

    with SqlAlchemyUnitOfWork(factory) as uow:
        def fail_effect_delete(_: str) -> None:
            raise RuntimeError("simulated effect delete failure")

        monkeypatch.setattr(uow.narrative_effects, "delete", fail_effect_delete)
        with pytest.raises(RuntimeError, match="simulated effect delete failure"):
            NarrativeStateAuthoringService().delete_effect(
                uow, effect_id, project_id, impact_reviewed=True
            )

    snapshot = client.get(f"/api/narrative-state/projects/{project_id}").json()
    assert effect_id in {item["id"] for item in snapshot["effects"]}
    assert seeded["bindings"][0]["id"] in {
        item["id"] for item in snapshot["bindings"]
    }


def test_reviewed_relationship_conversion_is_idempotent_and_retains_edge(
    authoring_client,
) -> None:
    client, _ = authoring_client
    seeded = _seed_effects(client)
    project_id = seeded["project"]["id"]
    edge = client.post(
        "/api/edges",
        json={
            "project_id": project_id,
            "source_node_id": seeded["character"]["id"],
            "target_node_id": seeded["item"]["id"],
            "type": "owns",
        },
    ).json()
    selection = {
        "project_id": project_id,
        "edge_id": edge["id"],
        "flow_id": seeded["flow"]["id"],
    }
    preview = client.post(
        "/api/narrative-state/relationship-imports/preview", json=selection
    )
    assert preview.status_code == 200
    assert preview.json()["already_applied"] is False
    unreviewed = client.post(
        "/api/narrative-state/relationship-imports",
        json={**selection, "expected_revision": 0},
    )
    assert unreviewed.status_code == 409
    assert unreviewed.json()["detail"]["code"] == (
        "narrative_state_relationship_review_required"
    )

    accepted = client.post(
        "/api/narrative-state/relationship-imports",
        json={**selection, "expected_revision": 0, "impact_reviewed": True},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["changed"] is True
    repeated = client.post(
        "/api/narrative-state/relationship-imports",
        json={**selection, "expected_revision": 0, "impact_reviewed": True},
    )
    assert repeated.status_code == 200
    assert repeated.json()["changed"] is False
    assert len(repeated.json()["initial_state"]["item_custody"]) == 1
    assert client.get(f"/api/edges/{edge['id']}").status_code == 200


def test_session_revision_guard_rejects_stale_state_command(
    authoring_client, tmp_path: Path
) -> None:
    client, _ = authoring_client
    created = client.post(
        "/api/project-sessions/create",
        json={"path": str(tmp_path / "StateRevision.narrative"), "name": "State Revision"},
    ).json()
    session_id = created["session"]["session_id"]
    saved = client.post(
        f"/api/project-sessions/{session_id}/save",
        json={"expected_revision": 0, "reason": "manual"},
    )
    assert saved.json()["session"]["saved_revision"] == 1
    response = client.post(
        "/api/narrative-state/effects",
        headers={"X-Project-Session-Id": session_id},
        json=_effect_payload(created["session"]["project_id"], "stale-effect", "stale"),
    )
    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "narrative_state_revision_stale",
        "message_key": "narrativeState.error.narrative_state_revision_stale",
        "parameters": {"expected_revision": 0, "saved_revision": 1},
    }
