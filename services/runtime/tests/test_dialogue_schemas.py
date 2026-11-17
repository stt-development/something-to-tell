import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.dialogue import DialogueDocument


def test_dialogue_document_accepts_branching_multi_character_flow() -> None:
    document = DialogueDocument.model_validate(
        {
            "dialogue_version": 1,
            "entry_element_id": "line-question",
            "participants": ["character-keeper", "character-player"],
            "elements": [
                {
                    "id": "line-question",
                    "kind": "line",
                    "speaker_node_id": "character-keeper",
                    "text": "Why should I open the door?",
                    "next_element_id": "choice-answer",
                },
                {
                    "id": "choice-answer",
                    "kind": "choice",
                    "prompt": "Choose an answer",
                    "options": [
                        {"id": "answer-truth", "text": "Show the seal.", "condition": "seal_acquired"},
                        {"id": "answer-leave", "text": "Leave.", "condition": ""},
                    ],
                },
            ],
        }
    )

    assert document.dialogue_version == 1
    assert len(document.participants) == 2
    assert document.elements[1].kind == "choice"


def test_dialogue_document_accepts_cycles_and_empty_documents() -> None:
    cycle = DialogueDocument.model_validate(
        {
            "entry_element_id": "line-a",
            "participants": ["character-a", "character-b"],
            "elements": [
                {"id": "line-a", "kind": "line", "speaker_node_id": "character-a", "text": "Again?", "next_element_id": "line-b"},
                {"id": "line-b", "kind": "line", "speaker_node_id": "character-b", "text": "Again.", "next_element_id": "line-a"},
            ],
        }
    )

    assert cycle.elements[1].next_element_id == "line-a"
    assert DialogueDocument().model_dump() == {
        "dialogue_version": 1,
        "entry_element_id": None,
        "participants": [],
        "elements": [],
    }


@pytest.mark.parametrize(
    ("document", "message"),
    [
        (
            {
                "entry_element_id": "missing",
                "participants": ["character-a"],
                "elements": [{"id": "line-a", "kind": "line", "speaker_node_id": "character-a", "text": "Hello"}],
            },
            "entry element does not exist",
        ),
        (
            {
                "entry_element_id": "line-a",
                "participants": [],
                "elements": [{"id": "line-a", "kind": "line", "speaker_node_id": "character-a", "text": "Hello"}],
            },
            "speaker is not a participant",
        ),
        (
            {
                "entry_element_id": "line-a",
                "participants": ["character-a"],
                "elements": [
                    {"id": "line-a", "kind": "line", "speaker_node_id": "character-a", "text": "Hello", "next_element_id": "missing"}
                ],
            },
            "next element does not exist",
        ),
        (
            {
                "entry_element_id": "choice-a",
                "participants": [],
                "elements": [
                    {"id": "choice-a", "kind": "choice", "options": [{"id": "choice-a", "text": "Duplicate"}]}
                ],
            },
            "ids must be unique",
        ),
    ],
)
def test_dialogue_document_rejects_invalid_graph_references(document: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        DialogueDocument.model_validate(document)
