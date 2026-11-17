"""P9-001 deterministic synthetic narrative clusters; no runtime fixture seeding."""

import argparse
import json
import re
from pathlib import Path

from services.runtime.stt_runtime.project_fixture import load_project_fixture, write_project_fixture
from services.runtime.stt_runtime.schemas.project_document import create_project_document
from services.runtime.stt_runtime.schemas.project_fixture import ProjectFixtureEnvelope

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "fixtures/projects/project-aurora-export.v1.json"
EXCLUDED = {"fixture_version", "slug", "playback_effects", "expected_validation"}
COUNTS = {
    "canonical_node_count": "nodes", "edge_count": "edges", "issue_count": "issues",
    "placement_count": "placements", "story_flow_count": "story_flows",
    "dialogue_count": "dialogues", "quest_count": "quests",
    "flow_invocation_count": "flow_invocations", "flow_exit_count": "flow_exits",
    "flow_exit_binding_count": "flow_exit_bindings", "flow_initial_state_count": "flow_initial_states",
    "narrative_effect_count": "narrative_effects", "narrative_effect_binding_count": "narrative_effect_bindings",
    "style_profile_count": "style_profiles", "scene_style_assignment_count": "scene_style_assignments",
    "agent_memory_count": "agent_memories", "engine_tag_definition_count": "engine_tag_definitions",
    "engine_tag_binding_count": "engine_tag_bindings", "legacy_engine_tag_count": "legacy_engine_tags",
}


def _identifiers(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "id" and isinstance(item, str):
                yield item
            yield from _identifiers(item)
    elif isinstance(value, list):
        for item in value:
            yield from _identifiers(item)


def _rebind(value, identities, tokens):
    """Map structured references, JSON-valued tags and identifiers inside DSL text.

    Only known source IDs are tokens. This is synthetic-fixture namespacing, not
    an application Save As remapper or an alternative condition parser.
    """
    if isinstance(value, dict):
        return {identities.get(key, key): _rebind(item, identities, tokens) for key, item in value.items()}
    if isinstance(value, list):
        return [_rebind(item, identities, tokens) for item in value]
    if isinstance(value, str):
        if value in identities:
            return identities[value]
        if value.startswith(("{", "[")):
            try:
                parsed = json.loads(value)
            except json.JSONDecodeError:
                pass
            else:
                return json.dumps(_rebind(parsed, identities, tokens), sort_keys=True, separators=(",", ":"))
        return tokens.sub(lambda match: identities[match.group()], value)
    return value


def generate_scale_fixture(node_count: int) -> ProjectFixtureEnvelope:
    """Return an exact-size, reproducible fixture validated as a complete document."""
    if type(node_count) is not int or not 16 <= node_count <= 10_000:
        raise ValueError("scale_node_count_out_of_range")
    source = load_project_fixture(SOURCE).model_dump(mode="json")
    project_id = f"project-scale-v1-{node_count}"
    ids = set(_identifiers(source)) | {source["manifest"]["project_id"]}
    tokens = re.compile(r"(?<![A-Za-z0-9_-])(?:" + "|".join(re.escape(item) for item in sorted(ids, key=lambda item: (-len(item), item))) + r")(?![A-Za-z0-9_-])")
    collections = {key: [] for key, value in source.items() if isinstance(value, list)}
    cluster_size = len(source["nodes"])
    manifest = None
    for index in range(node_count // cluster_size):
        prefix = f"s{index:04d}-"
        identities = {item: prefix + item for item in ids}
        identities[source["manifest"]["project_id"]] = project_id
        tile = _rebind(source, identities, tokens)
        if manifest is None:
            manifest = tile["manifest"]
        # Names/registry keys are project-unique independently of canonical IDs.
        for flow in tile["story_flows"]:
            flow["name"] = prefix + flow["name"]
            flow["normalized_name"] = flow["name"].casefold()
        for profile in tile["style_profiles"]:
            profile["name"] = prefix + profile["name"]
        for memory in tile["agent_memories"]:
            memory["title"] = prefix + memory["title"]
        for definition in tile["engine_tag_definitions"]:
            definition["key"] = f"Scale{index:04d}." + definition["key"]
            definition["normalized_key"] = definition["key"].casefold()
            for alias in definition["aliases"]:
                alias["external_identifier"] = f"s{index:04d}_" + alias["external_identifier"]
        if index % 8:
            for key in ("agent_memories", "engine_tag_definitions", "engine_tag_bindings", "engine_tags", "legacy_engine_tags"):
                tile[key] = []
        # A modest fixed text payload keeps size comparisons about structure, not lorem volume.
        for node in tile["nodes"]:
            node["body"] = ("The harbor watch records this turning point while the crew weighs its next decision. " * 4).strip()
        for key in collections:
            collections[key].extend(tile[key])
    template = source["nodes"][0]
    for index in range(node_count % cluster_size):
        collections["nodes"].append({**template, "id": f"padding-{index:04d}", "project_id": project_id,
                                      "type": "Lore", "title": f"Unconnected fact {index}", "metadata": {}})
    for records in collections.values():
        records.sort(key=lambda record: record.get("id", record.get("node_id", "")))
    manifest.update(project_id=project_id, name=f"Storage Scale {node_count}", description="P9-001 synthetic offline workload")
    payload = {"fixture_version": 1, "slug": f"storage-scale-v1-{node_count}", "manifest": manifest,
               "project_metadata": {}, **collections,
               "expected_validation": {key: len(collections[value]) for key, value in COUNTS.items()}}
    fixture = ProjectFixtureEnvelope.model_validate(payload)
    document_for(fixture)
    return fixture


def document_for(fixture):
    return create_project_document(**fixture.model_dump(mode="python", exclude=EXCLUDED))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nodes", type=int, choices=(1000, 10000), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    write_project_fixture(args.output, generate_scale_fixture(args.nodes))


if __name__ == "__main__":
    main()
