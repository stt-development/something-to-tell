from pathlib import Path

from services.runtime.stt_runtime.analysis.extractor import DeterministicSceneExtractor, SceneExtractor
from services.runtime.stt_runtime.analysis.graph_builder import GraphPatchBuilder
from services.runtime.stt_runtime.domain.entities import NodeEntity
from services.runtime.stt_runtime.schemas.scene_analysis import SceneAnalysisRequest


SCENE_FIXTURE = (Path(__file__).parent / "fixtures" / "project_aurora_scene.txt").read_text(encoding="utf-8")


def test_deterministic_extractor_implements_provider_interface() -> None:
    extractor: SceneExtractor = DeterministicSceneExtractor()

    assert extractor.provider == "deterministic"


def test_deterministic_extractor_finds_node_facts_from_structured_scene_text() -> None:
    facts = DeterministicSceneExtractor().extract(
        SceneAnalysisRequest(project_id="project-aurora", title="Harbor Inspection", scene_text=SCENE_FIXTURE)
    )

    node_facts = [fact for fact in facts if fact.kind == "node"]
    facts_by_title = {fact.title: fact for fact in node_facts}

    assert facts_by_title["Mara Vale"].metadata["node_kind"] == "Character"
    assert facts_by_title["Glass Harbor"].metadata["node_kind"] == "Location"
    assert facts_by_title["Sealed Ledger"].metadata["node_kind"] == "Item"
    assert facts_by_title["Dockmaster Warning"].metadata["node_kind"] == "Dialogue"
    assert facts_by_title["Dockmaster Warning"].summary == "No legal passage without guild papers."


def test_deterministic_extractor_finds_relationship_facts_with_evidence() -> None:
    facts = DeterministicSceneExtractor().extract(
        SceneAnalysisRequest(project_id="project-aurora", title="Harbor Inspection", scene_text=SCENE_FIXTURE)
    )

    relationships = [fact for fact in facts if fact.kind == "edge"]

    assert relationships[0].title == "Mara Vale located in Glass Harbor"
    assert relationships[0].metadata == {
        "relationship_type": "located_in",
        "source_title": "Mara Vale",
        "target_title": "Glass Harbor",
    }
    assert relationships[0].evidence.text == "Relationship: Mara Vale located_in Glass Harbor - Mara reaches the harbor at dusk."
    assert SCENE_FIXTURE[relationships[0].evidence.start : relationships[0].evidence.end] == relationships[0].evidence.text
    assert relationships[1].metadata["relationship_type"] == "reveals"


def test_deterministic_extractor_ignores_unknown_lines_without_network_or_side_effects() -> None:
    facts = DeterministicSceneExtractor().extract(
        SceneAnalysisRequest(
            project_id="project-aurora",
            scene_text="\nMood: tense\nRelationship: Mara Vale unknown_type Glass Harbor\nCreature: Invalid\n",
        )
    )

    assert facts == []


def test_project_aurora_fixture_builds_visible_node_and_edge_suggestions() -> None:
    request = SceneAnalysisRequest(project_id="project-aurora", title="Harbor Inspection", scene_text=SCENE_FIXTURE)
    facts = DeterministicSceneExtractor().extract(request)
    existing_nodes = [
        NodeEntity(id="node-hero", project_id="project-aurora", type="Character", title="Mara Vale", summary="Old character summary."),
        NodeEntity(id="node-harbor", project_id="project-aurora", type="Location", title="Glass Harbor", summary="Old location summary."),
        NodeEntity(id="node-ledger", project_id="project-aurora", type="Item", title="Sealed Ledger", summary="Old item summary."),
        NodeEntity(id="node-dialogue", project_id="project-aurora", type="Dialogue", title="Dockmaster Warning", summary="Old dialogue summary."),
    ]

    patch = GraphPatchBuilder().build_patch(
        existing_edges=[],
        existing_nodes=existing_nodes,
        extracted_facts=facts,
        title=request.title,
    )

    assert [operation.op for operation in patch.operations].count("update_node") == 4
    assert [operation.op for operation in patch.operations].count("create_edge") == 2
