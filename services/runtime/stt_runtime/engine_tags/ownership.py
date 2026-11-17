"""Pure owner-scope matching shared by domain deletion commands."""

from collections.abc import Collection, Mapping
from typing import Any


_NODE_ID_FIELDS = ("node_id", "dialogue_node_id", "quest_node_id")


def owner_removed_with_node(owner: Mapping[str, Any], node_id: str) -> bool:
    """Match only owners whose complete aggregate is deleted with one node."""

    return any(owner.get(field) == node_id for field in _NODE_ID_FIELDS)


def owner_removed_with_relationships(
    owner: Mapping[str, Any],
    edge_ids: Collection[str],
) -> bool:
    """Match relationship bindings for the exact deleted semantic edges."""

    return owner.get("kind") == "relationship" and owner.get("edge_id") in edge_ids

