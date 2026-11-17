import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.schemas.scene_analysis import GraphPatch, SceneAnalysisRequest, SceneAnalysisResponse


def test_scene_analysis_request_accepts_local_deterministic_provider() -> None:
    request = SceneAnalysisRequest(
        project_id="project-aurora",
        scene_text="Mara reaches Glass Harbor with the sealed ledger.",
        title="Harbor scene",
    )

    assert request.provider == "deterministic"
    assert request.metadata == {}


def test_scene_analysis_response_accepts_supported_patch_operations() -> None:
    response = SceneAnalysisResponse(
        project_id="project-aurora",
        suggestion_id="suggestion-1",
        extracted_facts=[
            {
                "id": "fact-character-mara",
                "kind": "node",
                "title": "Mara Vale",
                "summary": "Character mentioned in the scene.",
                "evidence": {"text": "Mara", "start": 0, "end": 4},
                "metadata": {"node_kind": "Character"},
            }
        ],
        patch={
            "title": "Scene graph update",
            "description": "Creates scene analysis graph records.",
            "operations": [
                {
                    "op": "create_node",
                    "client_id": "node-mara",
                    "node": {
                        "kind": "Character",
                        "title": "Mara Vale",
                        "summary": "Smuggler captain.",
                        "body": "",
                        "status": "suggested",
                        "metadata": {"evidence": "Mara"},
                    },
                },
                {
                    "op": "update_node",
                    "node_id": "node-existing-location",
                    "updates": {"summary": "Harbor location mentioned again."},
                },
                {
                    "op": "create_edge",
                    "client_id": "edge-mara-location",
                    "edge": {
                        "source": {"client_id": "node-mara"},
                        "target": {"node_id": "node-existing-location"},
                        "relationship_type": "located_in",
                        "label": "located in",
                        "condition": "",
                        "metadata": {"evidence": "Glass Harbor"},
                    },
                },
                {
                    "op": "update_edge",
                    "edge_id": "edge-existing",
                    "updates": {"relationship_type": "reveals", "label": "reveals"},
                },
            ],
        },
    )

    assert response.patch.operations[0].op == "create_node"
    assert response.patch.operations[2].op == "create_edge"


@pytest.mark.parametrize(
    "patch",
    [
        {
            "title": "Unknown operation",
            "operations": [{"op": "delete_node", "node_id": "node-1"}],
        },
        {
            "title": "Unknown node kind",
            "operations": [
                {
                    "op": "create_node",
                    "client_id": "node-1",
                    "node": {"kind": "Relationship", "title": "Invalid"},
                }
            ],
        },
        {
            "title": "Ambiguous endpoint",
            "operations": [
                {
                    "op": "create_edge",
                    "client_id": "edge-1",
                    "edge": {
                        "source": {"node_id": "node-1", "client_id": "node-local"},
                        "target": {"node_id": "node-2"},
                    },
                }
            ],
        },
        {
            "title": "Self edge",
            "operations": [
                {
                    "op": "create_edge",
                    "client_id": "edge-1",
                    "edge": {
                        "source": {"node_id": "node-1"},
                        "target": {"node_id": "node-1"},
                    },
                }
            ],
        },
    ],
)
def test_graph_patch_rejects_invalid_operations(patch: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        GraphPatch.model_validate(patch)


def test_evidence_span_rejects_reversed_offsets() -> None:
    with pytest.raises(ValidationError):
        SceneAnalysisResponse(
            project_id="project-aurora",
            extracted_facts=[
                {
                    "id": "fact-1",
                    "kind": "node",
                    "title": "Mara",
                    "evidence": {"text": "Mara", "start": 8, "end": 2},
                }
            ],
            patch={"title": "No-op preview", "operations": [{"op": "update_node", "node_id": "node-1", "updates": {"summary": "Updated"}}]},
        )
