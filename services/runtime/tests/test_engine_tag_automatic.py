"""Engine Tags are initialized by entity creation, never by opening an editor."""

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from services.runtime.stt_runtime.api.crud import create_node
from services.runtime.stt_runtime.db.base import Base, import_model_metadata
from services.runtime.stt_runtime.dialogue.service import DialogueService
from services.runtime.stt_runtime.domain.entities import ProjectEntity
from services.runtime.stt_runtime.quest.service import QuestService
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.dialogue import DialogueDocument
from services.runtime.stt_runtime.schemas.quest import QuestDocument
from services.runtime.stt_runtime.schemas.resources import NodeCreate


def _session_factory():
    import_model_metadata()
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def _create_node(uow: SqlAlchemyUnitOfWork, project_id: str, kind: str, title: str) -> str:
    response = create_node(uow, NodeCreate(project_id=project_id, type=kind, title=title))
    return response.id


def test_node_and_dialogue_elements_receive_one_tag_at_creation() -> None:
    factory = _session_factory()
    with SqlAlchemyUnitOfWork(factory) as uow:
        project = uow.projects.add(ProjectEntity(name="Tags", path="/tmp/tags.narrative", format_version=1))
        uow.commit()
        speaker_id = _create_node(uow, project.id, "Character", "Ilya")
        dialogue_id = _create_node(uow, project.id, "Dialogue", "Gate bargain")
        document = DialogueDocument.model_validate({
            "entry_element_id": "line-1",
            "participants": [speaker_id],
            "elements": [
                {"id": "line-1", "kind": "line", "speaker_node_id": speaker_id, "text": "Open the gate.", "next_element_id": "choice-1"},
                {"id": "choice-1", "kind": "choice", "prompt": "Your answer", "options": [
                    {"id": "option-1", "text": "Show the seal.", "next_element_id": None},
                ]},
            ],
        })

        DialogueService().update_document(uow, dialogue_id, document)
        first_bindings = list(uow.engine_tag_bindings.list(project_id=project.id))
        definitions = uow.engine_tag_definitions.list(project_id=project.id)
        assert all({alias["target"] for alias in item.aliases} == {"ink", "yarn_spinner"} for item in definitions)
        original_aliases = {item.id: item.aliases for item in definitions}
        assert [binding.owner["kind"] for binding in first_bindings].count("node") == 2
        assert {binding.owner["kind"] for binding in first_bindings} >= {
            "dialogue_line", "dialogue_choice", "dialogue_option",
        }
        assert any(definition.key.startswith("Node.DialogueGateBargain") for definition in uow.engine_tag_definitions.list(project_id=project.id))

        # Re-saving an unchanged aggregate must not continuously generate tags.
        DialogueService().update_document(uow, dialogue_id, document)
        assert len(uow.engine_tag_bindings.list(project_id=project.id)) == len(first_bindings)
        assert {item.id: item.aliases for item in uow.engine_tag_definitions.list(project_id=project.id)} == original_aliases

        expanded_payload = document.model_dump(mode="json")
        expanded_payload["elements"][1]["options"].append(
            {"id": "option-2", "text": "Threaten the guard.", "next_element_id": None}
        )
        expanded = DialogueDocument.model_validate(expanded_payload)
        DialogueService().update_document(uow, dialogue_id, expanded)
        assert len(uow.engine_tag_bindings.list(project_id=project.id)) == len(first_bindings) + 1


def test_quest_stages_and_branches_receive_tags_at_creation() -> None:
    factory = _session_factory()
    with SqlAlchemyUnitOfWork(factory) as uow:
        project = uow.projects.add(ProjectEntity(name="Tags", path="/tmp/quest-tags.narrative", format_version=1))
        uow.commit()
        quest_id = _create_node(uow, project.id, "Quest", "Smuggler route")
        document = QuestDocument.model_validate({
            "entry_stage_id": "stage-1",
            "stages": [{
                "id": "stage-1",
                "title": "Reach the tunnel",
                "description": "",
                "branches": [{"id": "branch-1", "label": "Take the lower path", "target_stage_id": None}],
            }],
        })

        QuestService().update_document(uow, quest_id, document)
        bindings = list(uow.engine_tag_bindings.list(project_id=project.id))
        assert all({alias["target"] for alias in item.aliases} == {"ink", "yarn_spinner"}
                   for item in uow.engine_tag_definitions.list(project_id=project.id))
        assert {binding.owner["kind"] for binding in bindings} == {"node", "quest_stage", "quest_branch"}
        assert any(definition.key.startswith("QuestBranch.QuestSmugglerRoute") for definition in uow.engine_tag_definitions.list(project_id=project.id))

        QuestService().update_document(uow, quest_id, document)
        assert len(uow.engine_tag_bindings.list(project_id=project.id)) == len(bindings)
