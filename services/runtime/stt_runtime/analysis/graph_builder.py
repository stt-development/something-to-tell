from __future__ import annotations

import re
from collections.abc import Sequence

from ..domain.entities import EdgeEntity, NodeEntity
from ..schemas.scene_analysis import (
    EDGE_TYPES,
    NODE_KINDS,
    CreateEdgeOperation,
    CreateNodeOperation,
    EdgeType,
    ExtractedFact,
    GraphPatch,
    NodeKind,
    PatchEdgeCreate,
    PatchEndpointRef,
    PatchNodeCreate,
    PatchNodeUpdate,
    UpdateNodeOperation,
)

NODE_KIND_SET = set(NODE_KINDS)
EDGE_TYPE_SET = set(EDGE_TYPES)


class GraphPatchBuilder:
    """Build reviewable graph patches from extracted facts without mutating canon."""

    def build_patch(
        self,
        *,
        existing_edges: Sequence[EdgeEntity],
        existing_nodes: Sequence[NodeEntity],
        extracted_facts: Sequence[ExtractedFact],
        title: str,
    ) -> GraphPatch:
        node_index = {node_key(node.type, node.title): node for node in existing_nodes}
        edge_index = {edge_key(edge.source_node_id, edge.target_node_id, edge.type): edge for edge in existing_edges}
        client_nodes: dict[str, str] = {}
        node_refs_by_title: dict[str, PatchEndpointRef] = {normalize_title(node.title): PatchEndpointRef(node_id=node.id) for node in existing_nodes}
        operations = []

        for fact in extracted_facts:
            if fact.kind != "node":
                continue
            node_kind = node_kind_from_fact(fact)
            if node_kind is None:
                continue

            existing_node = node_index.get(node_key(node_kind, fact.title))
            evidence_metadata = evidence_metadata_for_fact(fact)
            if existing_node:
                if fact.summary and fact.summary != existing_node.summary:
                    operations.append(
                        UpdateNodeOperation(
                            op="update_node",
                            node_id=existing_node.id,
                            updates=PatchNodeUpdate(
                                summary=fact.summary,
                                metadata=merge_metadata(existing_node.metadata, evidence_metadata),
                            ),
                        )
                    )
                node_refs_by_title[normalize_title(fact.title)] = PatchEndpointRef(node_id=existing_node.id)
                continue

            client_id = client_id_for("node", node_kind, fact.title)
            client_nodes[normalize_title(fact.title)] = client_id
            node_refs_by_title[normalize_title(fact.title)] = PatchEndpointRef(client_id=client_id)
            operations.append(
                CreateNodeOperation(
                    op="create_node",
                    client_id=client_id,
                    node=PatchNodeCreate(
                        kind=node_kind,
                        title=fact.title,
                        summary=fact.summary,
                        body="",
                        status="suggested",
                        metadata=evidence_metadata,
                    ),
                )
            )

        for fact in extracted_facts:
            if fact.kind != "edge":
                continue
            relationship_type = edge_type_from_fact(fact)
            source_title = string_metadata(fact, "source_title")
            target_title = string_metadata(fact, "target_title")
            if relationship_type is None or not source_title or not target_title:
                continue

            source_ref = node_refs_by_title.get(normalize_title(source_title))
            target_ref = node_refs_by_title.get(normalize_title(target_title))
            if source_ref is None or target_ref is None or source_ref == target_ref:
                continue

            existing_edge = existing_edge_for_refs(source_ref, target_ref, relationship_type, edge_index)
            if existing_edge:
                continue

            operations.append(
                CreateEdgeOperation(
                    op="create_edge",
                    client_id=client_id_for("edge", source_title, relationship_type, target_title),
                    edge=PatchEdgeCreate(
                        source=source_ref,
                        target=target_ref,
                        relationship_type=relationship_type,
                        label=relationship_type.replace("_", " "),
                        condition="",
                        metadata=evidence_metadata_for_fact(fact),
                    ),
                )
            )

        return GraphPatch(
            title=f"{title} graph suggestions",
            description="Suggested graph updates extracted from scene text.",
            operations=operations,
            metadata={"source": "scene_analysis", "client_nodes": client_nodes},
        )


def node_kind_from_fact(fact: ExtractedFact) -> NodeKind | None:
    value = fact.metadata.get("node_kind")
    return value if isinstance(value, str) and value in NODE_KIND_SET else None


def edge_type_from_fact(fact: ExtractedFact) -> EdgeType | None:
    value = fact.metadata.get("relationship_type")
    return value if isinstance(value, str) and value in EDGE_TYPE_SET else None


def string_metadata(fact: ExtractedFact, key: str) -> str | None:
    value = fact.metadata.get(key)
    return value if isinstance(value, str) and value.strip() else None


def evidence_metadata_for_fact(fact: ExtractedFact) -> dict[str, object]:
    return {
        "evidence": {
            "fact_id": fact.id,
            "text": fact.evidence.text,
            "start": fact.evidence.start,
            "end": fact.evidence.end,
        }
    }


def merge_metadata(current: dict[str, object], update: dict[str, object]) -> dict[str, object]:
    return {**current, **update}


def existing_edge_for_refs(
    source: PatchEndpointRef,
    target: PatchEndpointRef,
    relationship_type: EdgeType,
    edge_index: dict[tuple[str, str, str], EdgeEntity],
) -> EdgeEntity | None:
    if source.node_id is None or target.node_id is None:
        return None
    return edge_index.get(edge_key(source.node_id, target.node_id, relationship_type))


def node_key(kind: str, title: str) -> tuple[str, str]:
    return (kind, normalize_title(title))


def edge_key(source_id: str, target_id: str, relationship_type: str) -> tuple[str, str, str]:
    return (source_id, target_id, relationship_type)


def normalize_title(title: str) -> str:
    return " ".join(title.casefold().split())


def client_id_for(*parts: str) -> str:
    slug = "-".join(re.sub(r"[^a-z0-9]+", "-", part.casefold()).strip("-") for part in parts)
    return slug.strip("-") or "suggested"
