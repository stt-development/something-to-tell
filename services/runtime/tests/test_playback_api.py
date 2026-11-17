from collections.abc import Generator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import TypeAdapter

from services.runtime.stt_runtime.api.dependencies import get_playback_sessions
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.playback.traversal_service import PlaybackSessionService
from services.runtime.stt_runtime.schemas.playback import (
    PlaybackCanonicalNode,
    PlaybackDefinition,
    PlaybackState,
    PlaybackTypedEffect,
)
from services.runtime.stt_runtime.schemas.composable_story_flow import ComposableFlowGraph, FlowExit, FlowExitBinding, FlowInvocation
from services.runtime.stt_runtime.schemas.story_flow import (
    FlowTransition,
    StoryFlow,
    StoryFlowNode,
    StoryFlowSnapshot,
)

NOW = datetime(2026, 7, 27, 15, 0, tzinfo=UTC)
EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)


def _definition(
    *,
    transitions: list[tuple[str, str, str, str]],
    entry: str = "event-entry",
    source_revision: str = "revision-1",
) -> PlaybackDefinition:
    node_ids = list(dict.fromkeys([
        entry,
        *(source for _, source, _, _ in transitions),
        *(target for _, _, target, _ in transitions),
    ]))
    flow = StoryFlow(
        id="flow-main",
        project_id="project-aurora",
        name="Main Story",
        kind="main",
        status="active",
        entry_node_id=entry,
        created_at=NOW,
        updated_at=NOW,
    )
    return PlaybackDefinition(
        project_id="project-aurora",
        flow_snapshot=StoryFlowSnapshot(
            flow=flow,
            nodes=[
                StoryFlowNode(
                    id=f"member-{node_id}",
                    project_id="project-aurora",
                    flow_id=flow.id,
                    node_id=node_id,
                    presentation_order=index,
                    created_at=NOW,
                    updated_at=NOW,
                )
                for index, node_id in enumerate(node_ids)
            ],
            transitions=[
                FlowTransition(
                    id=transition_id,
                    project_id="project-aurora",
                    flow_id=flow.id,
                    source_node_id=source,
                    target_node_id=target,
                    kind=kind,
                    priority=index,
                    created_at=NOW,
                    updated_at=NOW,
                )
                for index, (transition_id, source, target, kind) in enumerate(transitions)
            ],
        ),
        canonical_nodes=[
            PlaybackCanonicalNode(
                id=node_id,
                project_id="project-aurora",
                type="Event",
                title=node_id,
            )
            for node_id in node_ids
        ],
        source_revision=source_revision,
    )


def _call_definition() -> PlaybackDefinition:
    """Create the smallest API-visible call, exit, and return definition."""

    root = _definition(transitions=[])
    root.flow_snapshot.nodes.append(StoryFlowNode(id="member-root-ending", project_id="project-aurora", flow_id="flow-main", node_id="root-ending", presentation_order=1, created_at=NOW, updated_at=NOW))
    root.canonical_nodes.append(PlaybackCanonicalNode(id="root-ending", project_id="project-aurora", type="Outcome", title="Root ending"))
    side = StoryFlowSnapshot(
        flow=StoryFlow(id="flow-side", project_id="project-aurora", name="Side", kind="side", status="active", entry_node_id="side-exit", created_at=NOW, updated_at=NOW),
        nodes=[StoryFlowNode(id="member-side-exit", project_id="project-aurora", flow_id="flow-side", node_id="side-exit", presentation_order=0, created_at=NOW, updated_at=NOW)],
    )
    invocation = FlowInvocation(id="call-side", project_id="project-aurora", source_flow_id="flow-main", source_node_id="event-entry", target_flow_id="flow-side", label="Enter side", priority=0, created_at=NOW, updated_at=NOW)
    flow_exit = FlowExit(id="exit-side", project_id="project-aurora", flow_id="flow-side", key="success", label="Side success", source_node_id="side-exit", created_at=NOW, updated_at=NOW)
    binding = FlowExitBinding(id="binding-side", project_id="project-aurora", invocation_id=invocation.id, exit_id=flow_exit.id, target_node_id="root-ending", created_at=NOW, updated_at=NOW)
    root.flow_snapshots = [root.flow_snapshot, side]
    root.composition = ComposableFlowGraph(project_id="project-aurora", flows=[root.flow_snapshot.flow, side.flow], memberships=[*root.flow_snapshot.nodes, *side.nodes], invocations=[invocation], exits=[flow_exit], bindings=[binding])
    root.canonical_nodes.append(PlaybackCanonicalNode(id="side-exit", project_id="project-aurora", type="Event", title="Side exit"))
    return PlaybackDefinition.model_validate(root.model_dump())


@pytest.fixture
def client() -> Generator[TestClient, None, None]:
    app: FastAPI = create_app()
    service = PlaybackSessionService(
        clock=lambda: NOW,
        id_factory=lambda: "session-api",
    )
    app.dependency_overrides[get_playback_sessions] = lambda: service
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


def _start(
    client: TestClient,
    definition: PlaybackDefinition,
    *,
    visit_threshold: int = 3,
) -> dict:
    response = client.post(
        "/api/playback/sessions",
        json={
            "command_version": 1,
            "definition": definition.model_dump(mode="json"),
            "initial_state": None,
            "visit_threshold": visit_threshold,
        },
    )
    assert response.status_code == 201
    return response.json()


def test_prepare_and_complete_session_command_lifecycle(client: TestClient) -> None:
    definition = _definition(
        transitions=[
            ("transition-ending", "event-entry", "event-ending", "next"),
        ]
    )
    prepare = client.post(
        "/api/playback/prepare",
        json={
            "command_version": 1,
            "snapshot": definition.flow_snapshot.model_dump(mode="json"),
            "canonical_nodes": [
                node.model_dump(mode="json")
                for node in definition.canonical_nodes
            ],
            "dialogue_documents": {},
            "quest_documents": {},
            "typed_effects": [],
            "source_revision": "revision-1",
        },
    )
    assert prepare.status_code == 200
    prepared_definition = prepare.json()["definition"]
    assert prepared_definition["source_revision"] == "revision-1"

    started = _start(
        client,
        PlaybackDefinition.model_validate(prepared_definition),
    )
    inspected = client.get(
        f"/api/playback/sessions/{started['id']}?source_revision=revision-1"
    )
    chosen = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "transition_id": "transition-ending",
            "allow_visit_threshold": False,
        },
    )
    backed = client.post(
        f"/api/playback/sessions/{started['id']}/back",
        json={"command_version": 1, "source_revision": "revision-1"},
    )
    fresh = _definition(
        transitions=[
            ("transition-ending", "event-entry", "event-ending", "next"),
        ],
        source_revision="revision-2",
    )
    restarted = client.post(
        f"/api/playback/sessions/{started['id']}/restart",
        json={
            "command_version": 1,
            "definition": fresh.model_dump(mode="json"),
            "initial_state": None,
            "visit_threshold": 4,
        },
    )
    closed = client.delete(f"/api/playback/sessions/{started['id']}")
    missing = client.get(
        f"/api/playback/sessions/{started['id']}?source_revision=revision-2"
    )

    assert inspected.json()["current_node_id"] == "event-entry"
    assert chosen.json()["status"] == "ended"
    assert chosen.json()["facts"][0]["code"] == "ending_reached"
    assert chosen.json()["facts"][0]["node_id"] == "event-ending"
    assert len(chosen.json()["trace"]) == 1
    assert backed.json()["status"] == "active"
    assert backed.json()["trace"] == []
    assert restarted.json()["source_revision"] == "revision-2"
    assert restarted.json()["visit_threshold"] == 4
    assert closed.status_code == 204
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "playback_session_not_found"


def test_authoring_and_history_invalidate_playback_but_back_does_not_enter_history(
    tmp_path: Path,
) -> None:
    """Exercise the shared app wiring instead of an isolated Playback override."""

    app = create_app()
    with TestClient(app) as client:
        created = client.post(
            "/api/project-sessions/create",
            json={"path": str(tmp_path / "PlaybackHistory.narrative"), "name": "Playback history"},
        ).json()
        session_id = created["session"]["session_id"]
        project_id = created["session"]["project_id"]
        definition = PlaybackDefinition.model_validate(
            _replace_project_id(
                _definition(transitions=[("transition-ending", "event-entry", "event-ending", "next")]).model_dump(mode="json"),
                project_id,
            )
        )
        started = _start(client, definition)
        headers = {"X-Project-Session-Id": session_id}

        assert client.post(
            "/api/nodes",
            headers=headers,
            json={"project_id": project_id, "type": "Event", "title": "Invalidate Playback"},
        ).status_code == 201
        blocked = client.get(
            f"/api/playback/sessions/{started['id']}?source_revision=revision-1"
        ).json()
        assert blocked["status"] == "blocked"
        assert any(fact["code"] == "stale_source_revision" for fact in blocked["facts"])

        restarted = client.post(
            f"/api/playback/sessions/{started['id']}/restart",
            json={"command_version": 1, "definition": definition.model_dump(mode="json"), "initial_state": None, "visit_threshold": 3},
        )
        assert restarted.status_code == 200
        history_before_back = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert client.post(
            f"/api/playback/sessions/{started['id']}/choices",
            json={"command_version": 1, "source_revision": "revision-1", "transition_id": "transition-ending", "allow_visit_threshold": False},
        ).status_code == 200
        assert client.post(
            f"/api/playback/sessions/{started['id']}/back",
            json={"command_version": 1, "source_revision": "revision-1"},
        ).status_code == 200
        assert client.get(f"/api/project-sessions/{session_id}/history").json() == history_before_back

        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": history_before_back["history_revision"]},
        )
        assert undone.status_code == 200
        blocked_after_undo = client.get(
            f"/api/playback/sessions/{started['id']}?source_revision=revision-1"
        ).json()
        assert blocked_after_undo["status"] == "blocked"


def _replace_project_id(value: Any, project_id: str) -> Any:
    """Rebind the compact Playback fixture to a runtime-created project owner."""

    if isinstance(value, dict):
        return {key: _replace_project_id(item, project_id) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_project_id(item, project_id) for item in value]
    return project_id if value == "project-aurora" else value


def test_api_traverses_a_call_and_returns_through_the_named_exit(client: TestClient) -> None:
    definition = _call_definition()
    started = _start(client, definition)

    returned = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={"command_version": 1, "source_revision": definition.source_revision, "transition_id": "call-side", "allow_visit_threshold": False},
    )

    assert returned.status_code == 200
    payload = returned.json()
    assert payload["current_flow_id"] == "flow-main"
    assert payload["current_node_id"] == "root-ending"
    assert payload["call_stack"] == []
    assert [event["operation"] for event in payload["trace"][0]["events"]] == ["call", "exit", "return"]


def test_api_applies_exit_custody_and_restores_it_on_back_and_restart(client: TestClient) -> None:
    """The HTTP lifecycle preserves the same custody boundaries as traversal."""

    definition = _call_definition()
    definition.flow_snapshot.nodes.append(StoryFlowNode(id="member-item-ledger", project_id="project-aurora", flow_id="flow-main", node_id="item-ledger", presentation_order=2, created_at=NOW, updated_at=NOW))
    definition.flow_snapshots[0].nodes = definition.flow_snapshot.nodes
    definition.composition.memberships.append(definition.flow_snapshot.nodes[-1])
    definition.canonical_nodes.append(PlaybackCanonicalNode(id="item-ledger", project_id="project-aurora", type="Item", title="Ledger"))
    definition.initial_state = PlaybackState(item_holders={"item-ledger": {"kind": "character", "node_id": "event-entry"}})
    definition.canonical_nodes[0] = definition.canonical_nodes[0].model_copy(update={"type": "Character"})
    definition.typed_effect_definitions = [EFFECT_ADAPTER.validate_python({
        "effect_version": 1,
        "id": "binding-exit-transfer",
        "authored_effect_id": "effect-transfer-ledger",
        "project_id": "project-aurora",
        "flow_id": "flow-side",
        "owner_node_id": None,
        "owner_transition_id": "exit-side",
        "owner_kind": "flow_exit",
        "owner_id": "exit-side",
        "application_order": 0,
        "review_status": "accepted",
        "repeatable": False,
        "explanation": "Return the ledger to the party.",
        "operation": "transfer_item",
        "payload": {
            "item_node_id": "item-ledger",
            "from_holder": {"kind": "character", "node_id": "event-entry"},
            "to_holder": {"kind": "party"},
        },
    })]
    definition = PlaybackDefinition.model_validate(definition.model_dump())
    started = _start(client, definition)

    returned = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={"command_version": 1, "source_revision": definition.source_revision, "transition_id": "call-side", "allow_visit_threshold": False},
    ).json()
    backed = client.post(
        f"/api/playback/sessions/{started['id']}/back",
        json={"command_version": 1, "source_revision": definition.source_revision},
    ).json()
    restarted = client.post(
        f"/api/playback/sessions/{started['id']}/restart",
        json={"command_version": 1, "definition": definition.model_dump(mode="json"), "initial_state": None, "visit_threshold": 3},
    ).json()

    assert returned["state"]["item_holders"]["item-ledger"]["kind"] == "party"
    assert returned["trace"][0]["state_changes"][0]["authored_effect_id"] == "effect-transfer-ledger"
    assert backed["state"]["item_holders"]["item-ledger"]["kind"] == "character"
    assert restarted["state"]["item_holders"]["item-ledger"]["kind"] == "character"


def test_api_returns_stable_choice_and_back_errors(client: TestClient) -> None:
    started = _start(
        client,
        _definition(
            transitions=[
                ("transition-ending", "event-entry", "event-ending", "next"),
            ]
        ),
    )

    unknown = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "transition_id": "missing",
            "allow_visit_threshold": False,
        },
    )
    unavailable_back = client.post(
        f"/api/playback/sessions/{started['id']}/back",
        json={"command_version": 1, "source_revision": "revision-1"},
    )

    assert unknown.status_code == 409
    assert unknown.json()["detail"]["code"] == "playback_choice_not_found"
    assert unavailable_back.status_code == 409
    assert unavailable_back.json()["detail"]["code"] == "playback_back_unavailable"


def test_api_traverses_dialogue_reply_before_its_owned_flow_exit(
    client: TestClient,
) -> None:
    """Dialogue replies remain selectable independently from Flow default policy."""

    raw = _definition(
        entry="dialogue",
        transitions=[
            ("transition-proof", "dialogue", "proof", "next"),
            ("transition-run", "dialogue", "run", "next"),
        ],
    ).model_dump(mode="json")
    raw["canonical_nodes"][0]["type"] = "Dialogue"
    raw["dialogue_documents"] = {
        "dialogue": {
            "dialogue_version": 1,
            "entry_element_id": "line-entry",
            "participants": ["speaker"],
            "elements": [
                {
                    "id": "line-entry",
                    "kind": "line",
                    "speaker_node_id": "speaker",
                    "text": "Choose.",
                    "next_element_id": "choice-route",
                },
                {
                    "id": "choice-route",
                    "kind": "choice",
                    "prompt": "Which route?",
                    "options": [
                        {
                            "id": "answer-proof",
                            "text": "Present proof.",
                            "condition": "",
                            "next_element_id": "line-proof",
                        },
                        {
                            "id": "answer-run",
                            "text": "Run.",
                            "condition": "",
                            "next_element_id": "line-run",
                        },
                    ],
                },
                {
                    "id": "line-proof",
                    "kind": "line",
                    "speaker_node_id": "speaker",
                    "text": "Proof accepted.",
                    "next_element_id": None,
                },
                {
                    "id": "line-run",
                    "kind": "line",
                    "speaker_node_id": "speaker",
                    "text": "Run now.",
                    "next_element_id": None,
                },
            ],
        }
    }
    raw["flow_snapshot"]["transitions"][0]["metadata"] = {
        "dialogue_element_id": "line-proof"
    }
    raw["flow_snapshot"]["transitions"][0]["kind"] = "branch"
    raw["flow_snapshot"]["transitions"][0]["condition"] = "flags.proof"
    raw["flow_snapshot"]["transitions"][1]["kind"] = "branch"
    raw["flow_snapshot"]["transitions"][1]["is_default"] = True
    raw["flow_snapshot"]["transitions"][1]["metadata"] = {
        "dialogue_element_id": "line-run"
    }
    started = _start(client, PlaybackDefinition.model_validate(raw))

    assert started["step"]["choices"] == []
    assert [
        option["option_id"]
        for option in started["step"]["dialogue"]["options"]
    ] == ["answer-proof", "answer-run"]

    answered = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "dialogue_option_id": "answer-run",
            "allow_visit_threshold": False,
        },
    ).json()
    assert answered["step"]["dialogue"]["outcome_element_id"] == "line-run"
    assert [choice["transition_id"] for choice in answered["step"]["choices"]] == [
        "transition-run"
    ]
    assert answered["step"]["choices"][0]["eligible"] is True
    assert answered["state"]["dialogue_choice_ids"]["dialogue"] == ["answer-run"]
    assert answered["trace"][-1]["dialogue_option_id"] == "answer-run"

    backed = client.post(
        f"/api/playback/sessions/{started['id']}/back",
        json={"command_version": 1, "source_revision": "revision-1"},
    ).json()
    assert backed["step"]["dialogue"]["complete"] is False
    assert backed["state"]["dialogue_choice_ids"]["dialogue"] == []


def test_api_stale_revision_requires_restart(client: TestClient) -> None:
    definition = _definition(
        transitions=[
            ("transition-ending", "event-entry", "event-ending", "next"),
        ]
    )
    started = _start(client, definition)

    stale = client.get(
        f"/api/playback/sessions/{started['id']}?source_revision=revision-2"
    )
    blocked_choose = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "transition_id": "transition-ending",
            "allow_visit_threshold": False,
        },
    )
    fresh = definition.model_copy(
        update={"source_revision": "revision-2"},
        deep=True,
    )
    restarted = client.post(
        f"/api/playback/sessions/{started['id']}/restart",
        json={
            "command_version": 1,
            "definition": fresh.model_dump(mode="json"),
            "initial_state": None,
            "visit_threshold": None,
        },
    )

    assert stale.status_code == 200
    assert stale.json()["status"] == "blocked"
    assert stale.json()["facts"][-1]["code"] == "stale_source_revision"
    assert blocked_choose.json()["trace"] == []
    assert restarted.json()["status"] == "active"
    assert restarted.json()["facts"] == []


def test_api_cycle_threshold_requires_explicit_override(client: TestClient) -> None:
    definition = _definition(
        transitions=[
            ("transition-ab", "event-entry", "event-b", "next"),
            ("transition-ba", "event-b", "event-entry", "return"),
        ]
    )
    started = _start(client, definition, visit_threshold=1)
    at_b = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "transition_id": "transition-ab",
            "allow_visit_threshold": False,
        },
    ).json()
    blocked = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "transition_id": "transition-ba",
            "allow_visit_threshold": False,
        },
    ).json()
    continued = client.post(
        f"/api/playback/sessions/{started['id']}/choices",
        json={
            "command_version": 1,
            "source_revision": "revision-1",
            "transition_id": "transition-ba",
            "allow_visit_threshold": True,
        },
    ).json()

    assert at_b["current_node_id"] == "event-b"
    assert blocked["status"] == "blocked"
    assert blocked["facts"][-1]["code"] == "visit_threshold"
    assert blocked["facts"][-1]["transition_id"] == "transition-ba"
    assert continued["current_node_id"] == "event-entry"
    assert len(continued["trace"]) == 2


def test_api_exposes_owner_addressable_condition_default_and_blocked_facts(
    client: TestClient,
) -> None:
    missing_entry_definition = _definition(transitions=[])
    missing_entry_definition.flow_snapshot.flow.entry_node_id = None
    missing_entry = client.post(
        "/api/playback/prepare",
        json={
            "command_version": 1,
            "snapshot": missing_entry_definition.flow_snapshot.model_dump(mode="json"),
            "canonical_nodes": [
                node.model_dump(mode="json")
                for node in missing_entry_definition.canonical_nodes
            ],
            "dialogue_documents": {},
            "quest_documents": {},
            "typed_effects": [],
            "source_revision": "revision-missing-entry",
        },
    ).json()
    assert missing_entry["facts"][0]["code"] == "missing_entry"
    assert missing_entry["facts"][0]["flow_id"] == "flow-main"

    blocked_definition = _definition(
        transitions=[
            ("transition-invalid", "event-entry", "event-ending", "next"),
        ]
    )
    invalid_transition = blocked_definition.flow_snapshot.transitions[0].model_copy(
        update={"condition": "unknown.owner.path", "kind": "branch"},
        deep=True,
    )
    blocked_definition.flow_snapshot.transitions = [invalid_transition]
    blocked = _start(client, blocked_definition)

    assert blocked["status"] == "blocked"
    assert [fact["code"] for fact in blocked["facts"]] == [
        "missing_default_branch",
        "no_eligible_transition",
        "unknown_condition_path",
    ]
    condition_fact = blocked["facts"][-1]
    assert condition_fact["node_id"] == "event-entry"
    assert condition_fact["transition_id"] == "transition-invalid"

    default_definition = _definition(
        transitions=[
            ("transition-conditioned", "event-entry", "event-ending", "next"),
            ("transition-default", "event-entry", "event-fallback", "next"),
        ]
    )
    conditioned, default = default_definition.flow_snapshot.transitions
    default_definition.flow_snapshot.transitions = [
        conditioned.model_copy(update={"condition": "flags.ready", "kind": "branch"}, deep=True),
        default.model_copy(update={"is_default": True, "kind": "branch"}, deep=True),
    ]
    default_session = _start(client, default_definition)
    choices = {
        choice["transition_id"]: choice
        for choice in default_session["step"]["choices"]
    }

    assert choices["transition-conditioned"]["eligible"] is False
    assert choices["transition-default"]["eligible"] is True
