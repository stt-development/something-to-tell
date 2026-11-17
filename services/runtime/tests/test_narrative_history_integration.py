from copy import deepcopy
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from services.runtime.stt_runtime.api.dependencies import NARRATIVE_HISTORY_COMMANDS
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.tests.test_core_history_integration import (
    _document,
    _mutate_and_round_trip,
    _session_headers,
)


FIXTURE_PATH = Path("fixtures/projects/project-aurora.v1.json")


def _open_aurora(client: TestClient, destination: Path) -> tuple[str, str]:
    """Open an isolated durable Aurora fixture with an initially empty history."""

    import_project_fixture(FIXTURE_PATH, destination)
    opened = client.post("/api/project-sessions/open", json={"path": str(destination)})
    assert opened.status_code == 200, opened.text
    payload = opened.json()
    return payload["session"]["session_id"], payload["session"]["project_id"]


def _saved_revision(client: TestClient, session_id: str) -> int:
    """Read the checkpoint revision required by legacy revisioned domain APIs."""

    return client.get(f"/api/project-sessions/{session_id}").json()["session"][
        "saved_revision"
    ]


def test_dialogue_quest_and_specialized_transitions_round_trip_exactly(
    tmp_path: Path,
) -> None:
    """Aggregate order and specialized edge metadata survive exact redo."""

    with TestClient(create_app()) as client:
        session_id, _ = _open_aurora(client, tmp_path / "Documents.narrative")
        headers = _session_headers(session_id)

        dialogue = client.get(
            "/api/dialogues/node-dock-dialogue",
            headers=headers,
        ).json()
        revised_dialogue = deepcopy(dialogue)
        revised_dialogue["elements"][0]["text"] = "No ship leaves before dawn."
        _mutate_and_round_trip(
            client,
            session_id,
            lambda command_headers: client.put(
                "/api/dialogues/node-dock-dialogue",
                headers=command_headers,
                json=revised_dialogue,
            ),
            command_kind="update_dialogue",
            expected_status=200,
        )
        assert client.get(
            "/api/dialogues/node-dock-dialogue",
            headers=headers,
        ).json() == revised_dialogue

        quest = client.get(
            "/api/quests/node-smuggler-route",
            headers=headers,
        ).json()
        revised_quest = deepcopy(quest)
        revised_quest["objective"] = "Open the route without losing the ledger."
        _mutate_and_round_trip(
            client,
            session_id,
            lambda command_headers: client.put(
                "/api/quests/node-smuggler-route",
                headers=command_headers,
                json=revised_quest,
            ),
            command_kind="update_quest",
            expected_status=200,
        )
        restored_quest = client.get(
            "/api/quests/node-smuggler-route",
            headers=headers,
        ).json()
        assert restored_quest == revised_quest
        assert [stage["id"] for stage in restored_quest["stages"]] == [
            stage["id"] for stage in quest["stages"]
        ]

        _mutate_and_round_trip(
            client,
            session_id,
            lambda command_headers: client.put(
                "/api/dialogue-transitions/edge-dialogue-blockade",
                headers=command_headers,
                json={
                    "dialogue_element_id": "line-mara-orders-run",
                    "target_node_id": "node-mara-runs-blockade",
                    "relationship_type": "leads_to",
                    "label": "Run the blockade now",
                    "condition": "",
                    "outcome_flow_composition": {
                        "invocation_id": "flow-invocation-dialogue-smuggler-route",
                        "source_flow_id": "flow-main-story",
                        "target_flow_id": "flow-z-blockade-outcome",
                    },
                },
            ),
            command_kind="update_dialogue_transition",
            expected_status=200,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda command_headers: client.put(
                "/api/quest-transitions/edge-quest-blockade-route",
                headers=command_headers,
                json={
                    "quest_stage_id": "stage-choose-route",
                    "quest_branch_id": "branch-blockade-route",
                    "target_node_id": "node-mara-runs-blockade",
                    "relationship_type": "leads_to",
                    "label": "Start the revised blockade run",
                    "condition": "",
                },
            ),
            command_kind="update_quest_transition",
            expected_status=200,
        )


def test_story_flow_and_composable_outcome_commands_round_trip_atomically(
    tmp_path: Path,
) -> None:
    """Flow transitions, calls, and replacement side flows remain single commands."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_aurora(client, tmp_path / "Flows.narrative")
        saved_revision = _saved_revision(client, session_id)

        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                "/api/story-flows/flow-smuggler-route/transitions/flow-transition-blockade-cycle",
                headers=headers,
                json={
                    "project_id": project_id,
                    "source_node_id": "node-mara-runs-blockade",
                    "target_node_id": "node-smuggler-route",
                    "priority": 1,
                    "kind": "return",
                    "label": "Circle back after the patrol",
                    "condition": "",
                    "is_default": False,
                },
            ),
            command_kind="update_flow_transition",
            expected_status=200,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                "/api/flow-composition/invocations/flow-invocation-inspection-smuggler-route",
                headers=headers,
                json={
                    "project_id": project_id,
                    "expected_revision": saved_revision,
                    "source_flow_id": "flow-main-story",
                    "source_node_id": "node-inspection",
                    "target_flow_id": "flow-smuggler-route",
                    "label": "Call the revised covert route",
                    "condition": "",
                    "priority": 1,
                    "is_default": False,
                },
            ),
            command_kind="update_flow_invocation",
            expected_status=200,
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                "/api/flow-composition/outcomes/new-side-flow",
                headers=headers,
                json={
                    "project_id": project_id,
                    "expected_revision": saved_revision,
                    "edge_id": "edge-dialogue-blockade",
                    "source_flow_id": "flow-main-story",
                    "name": "Revised blockade outcome",
                    "description": "A replacement outcome authored atomically.",
                    "label": "Take the revised blockade route",
                    "condition": "",
                    "priority": 1,
                    "is_default": True,
                },
            ),
            command_kind="create_outcome_side_flow",
            expected_status=201,
        )
        document = _document(client, session_id)
        replacement = next(
            flow
            for flow in document["story_flows"]
            if flow["name"] == "Revised blockade outcome"
        )
        assert any(
            invocation["target_flow_id"] == replacement["id"]
            for invocation in document["flow_invocations"]
        )


def test_temporal_state_and_reviewed_relationship_import_round_trip(
    tmp_path: Path,
) -> None:
    """State aggregates reverse independently while semantic ownership remains."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_aurora(client, tmp_path / "State.narrative")
        saved_revision = _saved_revision(client, session_id)
        snapshot = client.get(
            f"/api/narrative-state/projects/{project_id}",
            headers=_session_headers(session_id),
        ).json()
        main_state = next(
            state for state in snapshot["initial_states"] if state["flow_id"] == "flow-main-story"
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                "/api/narrative-state/initial-states",
                headers=headers,
                json={
                    "project_id": project_id,
                    "expected_revision": saved_revision,
                    "flow_id": "flow-main-story",
                    "flags": {**main_state["flags"], "harbor_alert": True},
                    "item_custody": main_state["item_custody"],
                    "quest_statuses": main_state["quest_statuses"],
                },
            ),
            command_kind="upsert_initial_state",
            expected_status=200,
        )

        effect = next(
            item for item in snapshot["effects"] if item["id"] == "effect-02-quest-route-completed"
        )
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                f"/api/narrative-state/effects/{effect['id']}",
                headers=headers,
                json={
                    "project_id": project_id,
                    "expected_revision": saved_revision,
                    "effect": {
                        "id": effect["id"],
                        "project_id": project_id,
                        "operation": effect["operation"],
                        "payload": effect["payload"],
                        "repeat_policy": effect["repeat_policy"],
                        "explanation": "Complete the route after the revised outcome.",
                    },
                },
            ),
            command_kind="update_effect",
            expected_status=200,
        )

        quest_bindings = [
            binding
            for binding in snapshot["bindings"]
            if binding["owner"]["owner_kind"] == "quest_outcome"
            and binding["owner"]["owner_id"] == "branch-blockade-route"
        ]
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.put(
                "/api/narrative-state/bindings/reorder",
                headers=headers,
                json={
                    "project_id": project_id,
                    "expected_revision": saved_revision,
                    "owner": quest_bindings[0]["owner"],
                    "bindings": [
                        {
                            "binding_id": binding["id"],
                            "application_order": len(quest_bindings) - index - 1,
                        }
                        for index, binding in enumerate(quest_bindings)
                    ],
                },
            ),
            command_kind="reorder_effect_bindings",
            expected_status=200,
        )

        item = client.post(
            "/api/nodes",
            headers=_session_headers(session_id),
            json={"project_id": project_id, "type": "Item", "title": "Harbor key"},
        ).json()
        edge = client.post(
            "/api/edges",
            headers=_session_headers(session_id),
            json={
                "project_id": project_id,
                "source_node_id": "node-hero",
                "target_node_id": item["id"],
                "type": "owns",
            },
        ).json()
        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                "/api/narrative-state/relationship-imports",
                headers=headers,
                json={
                    "project_id": project_id,
                    "expected_revision": saved_revision,
                    "edge_id": edge["id"],
                    "flow_id": "flow-main-story",
                    "impact_reviewed": True,
                },
            ),
            command_kind="apply_relationship_import",
            expected_status=200,
        )
        assert client.get(f"/api/edges/{edge['id']}", headers=_session_headers(session_id)).status_code == 200


def test_analysis_review_records_patch_only_when_approved(tmp_path: Path) -> None:
    """Analysis review state is reversible and graph resources appear on approval."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_aurora(client, tmp_path / "Analysis.narrative")
        node_ids_before = {node["id"] for node in _document(client, session_id)["nodes"]}
        analysis = _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                "/api/analysis/scenes",
                headers=headers,
                json={
                    "project_id": project_id,
                    "title": "New witness",
                    "scene_text": "Character: Nyra Quill - A witness at the harbor.",
                },
            ),
            command_kind="analyze_scene",
            expected_status=201,
        ).json()
        assert {node["id"] for node in _document(client, session_id)["nodes"]} == node_ids_before

        _mutate_and_round_trip(
            client,
            session_id,
            lambda headers: client.post(
                f"/api/suggestions/{analysis['suggestion_id']}/approve",
                headers=headers,
            ),
            command_kind="approve_suggestion",
            expected_status=200,
        )
        created = [
            node
            for node in _document(client, session_id)["nodes"]
            if node["id"] not in node_ids_before
        ]
        assert [(node["type"], node["title"]) for node in created] == [
            ("Character", "Nyra Quill")
        ]


def test_mixed_authoring_stack_restores_every_intermediate_checksum(
    tmp_path: Path,
) -> None:
    """One stack may cross all authoring aggregates without losing exact order."""

    with TestClient(create_app()) as client:
        session_id, project_id = _open_aurora(
            client,
            tmp_path / "MixedHistory.narrative",
        )
        saved_revision = _saved_revision(client, session_id)
        checksums = [_document(client, session_id)["checksum"]]

        def commit(method: str, path: str, payload: dict[str, Any], status: int) -> None:
            revision = len(checksums) - 1
            response = client.request(
                method,
                path,
                headers=_session_headers(session_id, revision),
                json=payload,
            )
            assert response.status_code == status, response.text
            checksums.append(_document(client, session_id)["checksum"])

        commit(
            "POST",
            "/api/nodes",
            {"project_id": project_id, "type": "Lore", "title": "Mixed history lore"},
            201,
        )
        commit(
            "PUT",
            "/api/story-flows/flow-smuggler-route",
            {
                "project_id": project_id,
                "name": "Smuggler Route",
                "description": "Optional route verified by mixed history.",
                "kind": "side",
                "status": "active",
                "metadata": {"fixture": "project-aurora"},
            },
            200,
        )
        dialogue = client.get(
            "/api/dialogues/node-dock-dialogue",
            headers=_session_headers(session_id),
        ).json()
        dialogue["elements"][0]["text"] = "Mixed history confirms the harbor warning."
        commit("PUT", "/api/dialogues/node-dock-dialogue", dialogue, 200)
        quest = client.get(
            "/api/quests/node-smuggler-route",
            headers=_session_headers(session_id),
        ).json()
        quest["objective"] = "Verify every mixed history boundary."
        commit("PUT", "/api/quests/node-smuggler-route", quest, 200)
        commit(
            "POST",
            "/api/narrative-state/effects",
            {
                "project_id": project_id,
                "expected_revision": saved_revision,
                "effect": {
                    "id": "effect-mixed-history",
                    "project_id": project_id,
                    "operation": "set_flag",
                    "payload": {"flag": "mixed_history_verified"},
                    "explanation": "Marks the mixed history verification path.",
                },
            },
            201,
        )
        settings = _document(client, session_id)["manifest"]["settings"]
        commit(
            "PUT",
            f"/api/project-sessions/{session_id}/settings",
            {
                "name": "Project Aurora History",
                "description": "Mixed authoring verification project.",
                "settings": {**settings, "content_locale": "ru"},
                "expected_history_revision": 5,
            },
            200,
        )
        commit(
            "POST",
            "/api/analysis/scenes",
            {
                "project_id": project_id,
                "title": "Mixed history witness",
                "scene_text": "Character: Toma Reed - A witness to the history test.",
            },
            201,
        )

        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert history["undo_depth"] == 7
        for expected_checksum in reversed(checksums[:-1]):
            undone = client.post(
                f"/api/project-sessions/{session_id}/history/undo",
                json={"expected_history_revision": history["history_revision"]},
            ).json()
            assert undone["project"]["document"]["checksum"] == expected_checksum
            history = undone["history"]
        for expected_checksum in checksums[1:]:
            redone = client.post(
                f"/api/project-sessions/{session_id}/history/redo",
                json={"expected_history_revision": history["history_revision"]},
            ).json()
            assert redone["project"]["document"]["checksum"] == expected_checksum
            history = redone["history"]


def test_narrative_history_inventory_is_explicit_and_localization_ready() -> None:
    """Every Phase 3.12 narrative command has an auditable stable label key."""

    required_routes = {
        "accept_progression_migration",
        "add_story_flow_membership",
        "analyze_scene",
        "apply_relationship_import",
        "approve_suggestion_operation_resource",
        "approve_suggestion_resource",
        "archive_story_flow",
        "bootstrap_story_flow",
        "change_canon_issue_status",
        "continue_with_existing",
        "continue_with_new",
        "create_effect_binding",
        "create_flow_exit_binding",
        "create_dialogue_transition",
        "create_effect",
        "create_exit",
        "create_flow_transition",
        "create_invocation",
        "create_outcome_side_flow",
        "create_quest_transition",
            "create_story_flow",
            "create_style_profile",
        "create_suggestion_resource",
        "delete_effect_binding",
        "delete_flow_exit_binding",
        "delete_effect",
        "delete_exit",
        "delete_flow_transition",
        "delete_initial_state",
        "delete_invocation",
        "delete_scene_flow_boundary",
        "delete_story_flow",
        "delete_suggestion_resource",
        "reject_progression_migration",
        "reject_suggestion_operation_resource",
        "reject_suggestion_resource",
        "remove_story_flow_membership",
        "reorder_bindings",
        "reorder_flow_transitions",
        "set_story_flow_entry",
        "update_effect_binding",
        "update_flow_exit_binding",
        "update_dialogue_document",
        "update_dialogue_transition",
        "update_effect",
        "update_exit",
        "update_flow_transition",
        "update_invocation",
        "update_quest_document",
        "update_quest_transition",
            "update_story_flow",
            "update_style_profile",
            "update_suggestion_resource",
            "upsert_initial_state",
            "upsert_scene_flow_boundary",
            "upsert_scene_style_assignment",
            "clear_scene_style_assignment",
    }
    assert required_routes == NARRATIVE_HISTORY_COMMANDS.keys()
    assert all(
        label_key.startswith("history.command.")
        for _, label_key in NARRATIVE_HISTORY_COMMANDS.values()
    )
