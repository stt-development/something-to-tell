from services.runtime.stt_runtime.analysis.graph_builder import GraphPatchBuilder
from services.runtime.stt_runtime.domain.entities import EdgeEntity, NodeEntity
from services.runtime.stt_runtime.schemas.scene_analysis import EvidenceSpan, ExtractedFact


def node_fact(fact_id: str, title: str, kind: str, summary: str = "Extracted summary.") -> ExtractedFact:
    return ExtractedFact(
        id=fact_id,
        kind="node",
        title=title,
        summary=summary,
        evidence=EvidenceSpan(text=f"{kind}: {title}", start=0, end=len(f"{kind}: {title}")),
        metadata={"node_kind": kind},
    )


def edge_fact(fact_id: str, source: str, relationship_type: str, target: str) -> ExtractedFact:
    text = f"Relationship: {source} {relationship_type} {target}"
    return ExtractedFact(
        id=fact_id,
        kind="edge",
        title=f"{source} {relationship_type.replace('_', ' ')} {target}",
        summary=f"{source} {relationship_type.replace('_', ' ')} {target}.",
        evidence=EvidenceSpan(text=text, start=0, end=len(text)),
        metadata={"relationship_type": relationship_type, "source_title": source, "target_title": target},
    )


def test_graph_patch_builder_creates_nodes_and_edges_from_extracted_facts() -> None:
    patch = GraphPatchBuilder().build_patch(
        existing_edges=[],
        existing_nodes=[],
        extracted_facts=[
            node_fact("fact-mara", "Mara Vale", "Character", "Smuggler captain."),
            node_fact("fact-harbor", "Glass Harbor", "Location", "Neutral port."),
            edge_fact("fact-edge", "Mara Vale", "located_in", "Glass Harbor"),
        ],
        title="Harbor Inspection",
    )

    assert patch.title == "Harbor Inspection graph suggestions"
    assert [operation.op for operation in patch.operations] == ["create_node", "create_node", "create_edge"]
    assert patch.operations[0].client_id == "node-character-mara-vale"
    assert patch.operations[0].node.kind == "Character"
    assert patch.operations[0].node.metadata["evidence"]["fact_id"] == "fact-mara"
    assert patch.operations[2].edge.source.client_id == "node-character-mara-vale"
    assert patch.operations[2].edge.target.client_id == "node-location-glass-harbor"
    assert patch.operations[2].edge.relationship_type == "located_in"


def test_graph_patch_builder_updates_existing_node_instead_of_creating_duplicate() -> None:
    existing_node = NodeEntity(
        id="node-mara",
        project_id="project-aurora",
        type="Character",
        title="Mara Vale",
        summary="Old summary.",
    )

    patch = GraphPatchBuilder().build_patch(
        existing_edges=[],
        existing_nodes=[existing_node],
        extracted_facts=[node_fact("fact-mara", "mara vale", "Character", "Updated summary.")],
        title="Harbor Inspection",
    )

    assert [operation.op for operation in patch.operations] == ["update_node"]
    assert patch.operations[0].node_id == "node-mara"
    assert patch.operations[0].updates.summary == "Updated summary."
    assert patch.operations[0].updates.metadata["evidence"]["fact_id"] == "fact-mara"


def test_graph_patch_builder_links_to_existing_nodes_and_skips_existing_edges() -> None:
    mara = NodeEntity(id="node-mara", project_id="project-aurora", type="Character", title="Mara Vale")
    harbor = NodeEntity(id="node-harbor", project_id="project-aurora", type="Location", title="Glass Harbor")
    edge = EdgeEntity(
        id="edge-existing",
        project_id="project-aurora",
        source_node_id="node-mara",
        target_node_id="node-harbor",
        type="located_in",
    )

    create_patch = GraphPatchBuilder().build_patch(
        existing_edges=[],
        existing_nodes=[mara, harbor],
        extracted_facts=[edge_fact("fact-edge", "Mara Vale", "located_in", "Glass Harbor")],
        title="Harbor Inspection",
    )
    assert create_patch.operations[0].op == "create_edge"
    assert create_patch.operations[0].edge.source.node_id == "node-mara"
    assert create_patch.operations[0].edge.target.node_id == "node-harbor"

    skip_patch = GraphPatchBuilder().build_patch(
        existing_edges=[edge],
        existing_nodes=[mara, harbor],
        extracted_facts=[edge_fact("fact-edge", "Mara Vale", "located_in", "Glass Harbor")],
        title="Harbor Inspection",
    )
    assert skip_patch.operations == []


def test_graph_patch_builder_ignores_invalid_or_unresolved_facts() -> None:
    patch = GraphPatchBuilder().build_patch(
        existing_edges=[],
        existing_nodes=[],
        extracted_facts=[
            node_fact("fact-invalid-node", "Relationship", "Relationship"),
            edge_fact("fact-unresolved-edge", "Unknown Source", "located_in", "Unknown Target"),
        ],
        title="Harbor Inspection",
    )

    assert patch.operations == []
