from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from services.runtime.stt_runtime.api.dependencies import get_uow
from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.db.session import create_session_factory
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.tests.test_crud_api import create_project
from services.runtime.tests.test_dialogue_api import create_typed_node


@contextmanager
def persistent_runtime(database_path: Path) -> Generator[TestClient, None, None]:
    """Starts one isolated runtime lifecycle against a reusable SQLite file."""
    import_model_metadata()
    engine = create_engine(f"sqlite:///{database_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session_factory = create_session_factory(engine)
    app = create_app()

    def override_uow() -> Generator[SqlAlchemyUnitOfWork, None, None]:
        with SqlAlchemyUnitOfWork(session_factory) as uow:
            yield uow

    app.dependency_overrides[get_uow] = override_uow
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()
        # Disposing the engine ensures the next context reads from disk through
        # new connections instead of reusing process-local connection state.
        engine.dispose()


def test_branching_dialogue_and_event_outcome_survive_runtime_restart(tmp_path: Path) -> None:
    database_path = tmp_path / "dialogue-workflow.sqlite"
    with persistent_runtime(database_path) as first_runtime:
        project = create_project(first_runtime)
        keeper = create_typed_node(first_runtime, project["id"], "Character", "Keeper")
        mara = create_typed_node(first_runtime, project["id"], "Character", "Mara")
        dialogue = create_typed_node(first_runtime, project["id"], "Dialogue", "Door negotiation")
        document = {
            "dialogue_version": 1,
            "entry_element_id": "line-question",
            "participants": [keeper["id"], mara["id"]],
            "elements": [
                {
                    "id": "line-question",
                    "kind": "line",
                    "speaker_node_id": keeper["id"],
                    "text": "Why should I open the door?",
                    "next_element_id": "choice-answer",
                },
                {
                    "id": "choice-answer",
                    "kind": "choice",
                    "prompt": "Choose an answer",
                    "options": [
                        {
                            "id": "answer-open",
                            "text": "Show the guild seal.",
                            "condition": "seal_acquired",
                            "next_element_id": None,
                        },
                        {
                            "id": "answer-refuse",
                            "text": "Refuse to explain.",
                            "condition": "",
                            "next_element_id": "line-refusal",
                        },
                    ],
                },
                {
                    "id": "line-refusal",
                    "kind": "line",
                    "speaker_node_id": mara["id"],
                    "text": "Then we find another way in.",
                    "next_element_id": None,
                },
            ],
        }
        created = first_runtime.post(
            "/api/dialogue-transitions",
            json={
                "dialogue_node_id": dialogue["id"],
                "dialogue_element_id": "answer-open",
                "dialogue_document": document,
                "new_target": {
                    "type": "Event",
                    "title": "Keeper Opens the Door",
                    "summary": "The guild seal convinces the keeper to unlock the door.",
                },
                "relationship_type": "leads_to",
                "label": "keeper opens the door",
            },
        )
        assert created.status_code == 201
        transition = created.json()
        event_id = transition["target_node"]["id"]
        edge_id = transition["edge"]["id"]

    with persistent_runtime(database_path) as restarted_runtime:
        persisted_document = restarted_runtime.get(f"/api/dialogues/{dialogue['id']}")
        persisted_nodes = restarted_runtime.get(f"/api/nodes?project_id={project['id']}")
        persisted_edges = restarted_runtime.get(f"/api/edges?project_id={project['id']}")

    assert persisted_document.status_code == 200
    assert persisted_document.json() == document
    assert any(node["id"] == event_id and node["type"] == "Event" for node in persisted_nodes.json())
    assert persisted_edges.json() == [
        {
            **transition["edge"],
            "id": edge_id,
            "source_node_id": dialogue["id"],
            "target_node_id": event_id,
            "metadata": {"dialogue_element_id": "answer-open"},
        }
    ]

