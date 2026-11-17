import json
from typing import Any

from ..project_format.manifest import ProjectManifestV2
from ..schemas.project_document import ProjectDocument, create_project_document


def document_with_manifest(
    document: ProjectDocument,
    manifest: ProjectManifestV2,
) -> ProjectDocument:
    """Recompute a document checksum after changing portable manifest authority."""

    payload = document.model_dump(mode="python", exclude={"checksum", "manifest"})
    return create_project_document(manifest=manifest, **payload)


def document_with_project_identity(
    document: ProjectDocument,
    manifest: ProjectManifestV2,
    source_project_id: str,
) -> ProjectDocument:
    """Rebind typed and JSON-encoded project owners without changing entity ids."""

    payload = document.model_dump(mode="python", exclude={"checksum", "manifest"})
    rebound = replace_project_identity(
        payload,
        source_project_id,
        manifest.project_id,
    )
    return create_project_document(manifest=manifest, **rebound)


def replace_project_identity(
    value: Any,
    source_project_id: str,
    destination_project_id: str,
) -> Any:
    """Replace project-id fields, including structured JSON stored in tag values."""

    if isinstance(value, dict):
        return {
            key: (
                destination_project_id
                if key == "project_id" and item == source_project_id
                else replace_project_identity(
                    item,
                    source_project_id,
                    destination_project_id,
                )
            )
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [
            replace_project_identity(
                item,
                source_project_id,
                destination_project_id,
            )
            for item in value
        ]
    if isinstance(value, str) and value[:1] in {"{", "["}:
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return value
        rebound = replace_project_identity(
            decoded,
            source_project_id,
            destination_project_id,
        )
        return json.dumps(
            rebound,
            ensure_ascii=True,
            separators=(",", ":"),
            sort_keys=True,
        )
    return value


def document_record_count(document: ProjectDocument) -> int:
    """Count every typed owner used by storage migration parity checks."""

    return 1 + sum(
        len(records)
        for records in (
            document.nodes,
            document.edges,
            document.issues,
            document.suggestions,
            document.engine_tags,
            document.placements,
            document.dialogues,
            document.quests,
            document.story_flows,
            document.story_flow_nodes,
            document.flow_transitions,
            document.scene_flow_boundaries,
            document.flow_invocations,
            document.flow_exits,
            document.flow_exit_bindings,
            document.flow_initial_states,
            document.narrative_effects,
            document.narrative_effect_bindings,
            document.style_profiles,
            document.scene_style_assignments,
            document.agent_memories,
        )
    )
