"""Scoped in-place Discard/history restores without rewriting unchanged structure."""

from dataclasses import replace

from ..dialogue.service import DIALOGUE_METADATA_KEY
from ..domain.entities import NodeEntity, VisualPlacementEntity
from ..quest.service import QUEST_METADATA_KEY
from ..schemas.project_document import ProjectDocument
from .service import ProjectDocumentService


def restore_in_place(uow, current: ProjectDocument, target: ProjectDocument) -> bool:
    """Return false before any write if structural reconciliation is still needed."""
    return _restore(uow, current, target, specialized=False)


def restore_history_in_place(uow, current: ProjectDocument, target: ProjectDocument) -> bool:
    """History may restore sidecar text without rewriting unrelated durable records."""
    return _restore(uow, current, target, specialized=True)


def _restore(uow, current, target, *, specialized):
    target = ProjectDocument.model_validate(target.model_dump(mode="json"))
    if (target.manifest.project_id != current.manifest.project_id
            or target.manifest.settings.storage != current.manifest.settings.storage):
        raise ValueError("restore_project_scope_mismatch")
    mutable = {"checksum", "manifest", "project_metadata", "nodes", "placements"}
    if specialized:
        mutable |= {"dialogues", "quests", "engine_tag_definitions", "engine_tag_bindings"}
    if any(getattr(current, field) != getattr(target, field)
           for field in type(target).model_fields if field not in mutable):
        return False
    before_nodes = {item.id: item for item in current.nodes}
    before_placements = {item.id: item for item in current.placements}
    if (before_nodes.keys() != {item.id for item in target.nodes}
            or before_placements.keys() != {item.id for item in target.placements}
            or any(before_nodes[item.id].type != item.type for item in target.nodes)):
        return False

    # Check the entire eligibility boundary before touching any repository.
    dialogues = {item.node_id: item.document for item in target.dialogues}
    quests = {item.node_id: item.document for item in target.quests}
    before_dialogues = {item.node_id: item.document for item in current.dialogues} if specialized else dialogues
    before_quests = {item.node_id: item.document for item in current.quests} if specialized else quests
    if dialogues.keys() != before_dialogues.keys() or quests.keys() != before_quests.keys():
        return False
    # First edits of older sparse-tag fixtures create initial definitions/bindings
    # in the same command. Restore only added/removed rows, never rewrite tags or
    # attempt transient unique-key swaps between changed existing definitions.
    old_definitions = {item.id: item for item in current.engine_tag_definitions}
    new_definitions = {item.id: item for item in target.engine_tag_definitions}
    old_bindings = {item.id: item for item in current.engine_tag_bindings}
    new_bindings = {item.id: item for item in target.engine_tag_bindings}
    if any(old[key] != new[key] for old, new in ((old_definitions, new_definitions), (old_bindings, new_bindings))
           for key in old.keys() & new.keys()):
        return False
    project = uow.projects.get(target.manifest.project_id)
    if project is None:
        raise ValueError("restore_project_not_found")
    updates = dict(name=target.manifest.name, metadata=target.project_metadata,
        format_version=target.manifest.format_version, created_at=target.manifest.created_at,
        updated_at=target.manifest.updated_at)
    restored_project = replace(project, **updates)
    if restored_project != project:
        uow.projects.update(restored_project)
    for key in sorted(old_bindings.keys() - new_bindings.keys()):
        uow.engine_tag_bindings.delete(key)
    for key in sorted(old_definitions.keys() - new_definitions.keys()):
        uow.engine_tag_definitions.delete(key)
    for record in target.nodes:
        if (before_nodes[record.id] == record
                and dialogues.get(record.id) == before_dialogues.get(record.id)
                and quests.get(record.id) == before_quests.get(record.id)):
            continue
        metadata = dict(record.metadata)
        if record.id in dialogues:
            metadata[DIALOGUE_METADATA_KEY] = dialogues[record.id].model_dump(mode="json")
        if record.id in quests:
            metadata[QUEST_METADATA_KEY] = quests[record.id].model_dump(mode="json")
        uow.nodes.update(NodeEntity(**record.model_dump(mode="python", exclude={"metadata"}), metadata=metadata))
    for record in target.placements:
        if before_placements[record.id] != record:
            uow.visual_placements.update(VisualPlacementEntity(**record.model_dump(mode="python")))
    added_definitions = [new_definitions[key] for key in sorted(new_definitions.keys() - old_definitions.keys())]
    added_bindings = [new_bindings[key] for key in sorted(new_bindings.keys() - old_bindings.keys())]
    if added_definitions:
        ProjectDocumentService._add_engine_tag_definitions(uow, added_definitions)
    if added_bindings:
        ProjectDocumentService._add_engine_tag_bindings(uow, added_bindings)
    # Transaction, saved revision, history and publication belong to the caller.
    return True
