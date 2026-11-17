from fastapi.testclient import TestClient

from services.runtime.stt_runtime.dialogue.integrity_service import analyze_dialogue_integrity
from services.runtime.stt_runtime.domain.entities import EdgeEntity, NodeEntity
from services.runtime.tests.test_crud_api import client, create_project
from services.runtime.tests.test_dialogue_api import create_typed_node


def test_analyzer_reports_every_integrity_fact_category_with_stable_ownership() -> None:
    dialogue = NodeEntity(id="dialogue-a", project_id="project-a", type="Dialogue", title="Broken conversation")
    stale_transition = EdgeEntity(
        id="edge-stale",
        project_id="project-a",
        source_node_id=dialogue.id,
        target_node_id="event-a",
        type="leads_to",
        metadata={"dialogue_element_id": "answer-removed"},
    )
    stored = {
        "entry_element_id": "line-entry",
        "participants": ["character-missing"],
        "elements": [
            {
                "id": "line-entry",
                "kind": "line",
                "speaker_node_id": "character-not-declared",
                "text": "Where next?",
                "next_element_id": "line-removed",
            },
            {
                "id": "choice-orphan",
                "kind": "choice",
                "prompt": "Unused choice",
                "options": [{"id": "answer-end", "text": "Stop", "next_element_id": None}],
            },
        ],
    }

    report = analyze_dialogue_integrity(dialogue, stored, {"character-missing": None}, [stale_transition])

    assert {fact.code for fact in report.facts} == {
        "missing_participant",
        "broken_reference",
        "unreachable_element",
        "dead_end",
        "stale_external_transition_origin",
    }
    assert any(fact.element_id == "line-entry" and fact.reference_id == "line-removed" for fact in report.facts)
    assert any(fact.element_id == "choice-orphan" and fact.code == "unreachable_element" for fact in report.facts)
    assert any(fact.element_id == "answer-end" and fact.code == "dead_end" for fact in report.facts)
    assert any(fact.edge_id == "edge-stale" and fact.reference_id == "answer-removed" for fact in report.facts)
    assert all(fact.action for fact in report.facts)


def test_analyzer_reports_cycles_as_valid_topology_without_failure_facts() -> None:
    dialogue = NodeEntity(id="dialogue-cycle", project_id="project-a", type="Dialogue", title="Repeat")
    first = NodeEntity(id="character-a", project_id="project-a", type="Character", title="A")
    second = NodeEntity(id="character-b", project_id="project-a", type="Character", title="B")
    stored = {
        "entry_element_id": "line-a",
        "participants": [first.id, second.id],
        "elements": [
            {
                "id": "line-a",
                "kind": "line",
                "speaker_node_id": first.id,
                "text": "Again?",
                "next_element_id": "line-b",
            },
            {
                "id": "line-b",
                "kind": "line",
                "speaker_node_id": second.id,
                "text": "Again.",
                "next_element_id": "line-a",
            },
        ],
    }

    report = analyze_dialogue_integrity(dialogue, stored, {first.id: first, second.id: second}, [])

    assert report.facts == []
    assert [cycle.element_ids for cycle in report.cycles] == [["line-a", "line-b"]]
    assert report.cycles[0].message.startswith("Valid dialogue cycle")


def test_external_transition_turns_terminal_origin_into_a_continuation() -> None:
    dialogue = NodeEntity(id="dialogue-outcome", project_id="project-a", type="Dialogue", title="Outcome")
    stored = {
        "entry_element_id": "choice-a",
        "participants": [],
        "elements": [
            {
                "id": "choice-a",
                "kind": "choice",
                "prompt": "Act?",
                "options": [{"id": "answer-act", "text": "Act", "next_element_id": None}],
            }
        ],
    }
    transition = EdgeEntity(
        id="edge-outcome",
        project_id="project-a",
        source_node_id=dialogue.id,
        target_node_id="event-a",
        type="leads_to",
        metadata={"dialogue_element_id": "answer-act"},
    )

    report = analyze_dialogue_integrity(dialogue, stored, {}, [transition])

    assert report.facts == []
    assert report.cycles == []


def test_integrity_endpoint_is_read_only_and_does_not_create_canon_issues(client: TestClient) -> None:
    project = create_project(client)
    document = {
        "dialogue_version": 1,
        "entry_element_id": "choice-end",
        "participants": [],
        "elements": [
            {
                "id": "choice-end",
                "kind": "choice",
                "prompt": "Leave?",
                "options": [{"id": "answer-leave", "text": "Leave", "next_element_id": None}],
            }
        ],
    }
    dialogue = create_typed_node(
        client,
        project["id"],
        "Dialogue",
        "Read-only check",
        {"dialogue_document": document, "owner": "author"},
    )

    response = client.get(f"/api/dialogues/{dialogue['id']}/integrity")

    assert response.status_code == 200
    assert response.json()["dialogue_node_id"] == dialogue["id"]
    assert response.json()["facts"][0]["code"] == "dead_end"
    assert response.json()["facts"][0]["element_id"] == "answer-leave"
    assert client.get(f"/api/issues?project_id={project['id']}").json() == []
    assert client.get(f"/api/nodes/{dialogue['id']}").json()["metadata"] == {
        "dialogue_document": document,
        "owner": "author",
    }

