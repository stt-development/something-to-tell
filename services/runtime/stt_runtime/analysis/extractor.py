from __future__ import annotations

import re
from collections import defaultdict
from typing import Protocol

from ..schemas.scene_analysis import EDGE_TYPES, NODE_KINDS, EvidenceSpan, ExtractedFact, SceneAnalysisRequest

NODE_KIND_BY_LOWER = {kind.lower(): kind for kind in NODE_KINDS}
EDGE_TYPE_SET = set(EDGE_TYPES)


class SceneExtractor(Protocol):
    provider: str

    def extract(self, request: SceneAnalysisRequest) -> list[ExtractedFact]:
        """Extract narrative facts from scene text without mutating canon."""


class DeterministicSceneExtractor:
    provider = "deterministic"

    # Phase 3 starts with an explicit line grammar so extraction is offline and
    # deterministic while the patch preview and approval workflow are built.
    _node_pattern = re.compile(r"^\s*(?P<kind>[A-Za-z]+)\s*:\s*(?P<title>[^-\n]+?)(?:\s+-\s*(?P<summary>.+))?\s*$")
    _relationship_pattern = re.compile(
        r"^\s*Relationship\s*:\s*(?P<source>.+?)\s+(?P<relationship_type>[a-z_]+)\s+(?P<target>.+?)(?:\s+-\s*(?P<summary>.+))?\s*$"
    )

    def extract(self, request: SceneAnalysisRequest) -> list[ExtractedFact]:
        facts: list[ExtractedFact] = []
        seen_ids: defaultdict[str, int] = defaultdict(int)

        for line, start, end in iter_non_empty_lines(request.scene_text):
            relationship = self._relationship_pattern.match(line)
            if relationship:
                relationship_type = relationship.group("relationship_type")
                if relationship_type in EDGE_TYPE_SET:
                    source = clean_value(relationship.group("source"))
                    target = clean_value(relationship.group("target"))
                    summary = clean_value(relationship.group("summary") or f"{source} {relationship_type.replace('_', ' ')} {target}.")
                    title = f"{source} {relationship_type.replace('_', ' ')} {target}"
                    facts.append(
                        ExtractedFact(
                            id=stable_fact_id("edge", title, seen_ids),
                            kind="edge",
                            title=title,
                            summary=summary,
                            evidence=EvidenceSpan(text=line.strip(), start=start, end=end),
                            metadata={
                                "relationship_type": relationship_type,
                                "source_title": source,
                                "target_title": target,
                            },
                        )
                    )
                continue

            node = self._node_pattern.match(line)
            if node:
                node_kind = NODE_KIND_BY_LOWER.get(node.group("kind").lower())
                if node_kind:
                    title = clean_value(node.group("title"))
                    summary = clean_value(node.group("summary") or f"{node_kind} mentioned in scene.")
                    facts.append(
                        ExtractedFact(
                            id=stable_fact_id("node", f"{node_kind}-{title}", seen_ids),
                            kind="node",
                            title=title,
                            summary=summary,
                            evidence=EvidenceSpan(text=line.strip(), start=start, end=end),
                            metadata={"node_kind": node_kind},
                        )
                    )

        return facts


def iter_non_empty_lines(text: str):
    cursor = 0
    for raw_line in text.splitlines(keepends=True):
        line_start = cursor
        cursor += len(raw_line)
        line = raw_line.rstrip("\r\n")
        stripped = line.strip()
        if stripped:
            leading_space = len(line) - len(line.lstrip())
            start = line_start + leading_space
            yield line, start, start + len(stripped)


def clean_value(value: str) -> str:
    return value.strip().strip('"').strip()


def stable_fact_id(kind: str, value: str, seen_ids: defaultdict[str, int]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-") or "fact"
    fact_id = f"fact-{kind}-{base}"
    seen_ids[fact_id] += 1
    if seen_ids[fact_id] == 1:
        return fact_id
    return f"{fact_id}-{seen_ids[fact_id]}"
