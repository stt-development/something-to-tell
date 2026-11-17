"""Automatic Engine Tag creation at authoring-entity lifecycle boundaries."""

from __future__ import annotations

import json

from ..domain.entities import EdgeEntity, EngineTagBindingEntity, EngineTagDefinitionEntity, NodeEntity
from ..repositories.interfaces import UnitOfWork
from ..schemas.dialogue import DialogueChoiceElement, DialogueDocument, DialogueLineElement
from ..schemas.engine_tags import EngineTagOwnerV1, EngineTagSuggestionRequestV1, EngineTagTargetAliasV1, suggest_engine_tag_key
from ..schemas.quest import QuestDocument
from .aliases import initial_target_aliases


def add_node_with_automatic_tag(uow: UnitOfWork, node: NodeEntity) -> NodeEntity:
    """Persist a canonical node and its initial tag inside the caller's transaction."""

    saved = uow.nodes.add(node)
    ensure_automatic_engine_tag(
        uow,
        EngineTagOwnerV1(kind="node", project_id=saved.project_id, node_id=saved.id),
        f"{saved.type} {saved.title}",
    )
    return saved


def add_relationship_with_automatic_tag(uow: UnitOfWork, edge: EdgeEntity) -> EdgeEntity:
    """Persist an authored relationship and its initial tag in one transaction."""

    saved = uow.edges.add(edge)
    ensure_automatic_engine_tag(
        uow,
        EngineTagOwnerV1(kind="relationship", project_id=saved.project_id, edge_id=saved.id),
        f"{saved.type} {saved.label or saved.source_node_id} {saved.target_node_id}",
    )
    return saved


def ensure_dialogue_engine_tags(
    uow: UnitOfWork,
    node: NodeEntity,
    document: DialogueDocument,
) -> None:
    """Create one initial tag for every newly persisted Dialogue element."""

    writer = _AutomaticTagWriter(uow, node.project_id)
    for element in document.elements:
        if isinstance(element, DialogueLineElement):
            writer.ensure(
                EngineTagOwnerV1(
                    kind="dialogue_line",
                    project_id=node.project_id,
                    dialogue_node_id=node.id,
                    line_id=element.id,
                ),
                f"Dialogue {node.title} {element.text}",
            )
            continue
        assert isinstance(element, DialogueChoiceElement)
        writer.ensure(
            EngineTagOwnerV1(
                kind="dialogue_choice",
                project_id=node.project_id,
                dialogue_node_id=node.id,
                choice_id=element.id,
            ),
            f"Dialogue {node.title} {element.prompt or element.id}",
        )
        for option in element.options:
            writer.ensure(
                EngineTagOwnerV1(
                    kind="dialogue_option",
                    project_id=node.project_id,
                    dialogue_node_id=node.id,
                    choice_id=element.id,
                    option_id=option.id,
                ),
                f"Dialogue {node.title} {element.prompt or element.id} {option.text}",
            )


def ensure_quest_engine_tags(
    uow: UnitOfWork,
    node: NodeEntity,
    document: QuestDocument,
) -> None:
    """Create one initial tag for every newly persisted Quest stage and branch."""

    writer = _AutomaticTagWriter(uow, node.project_id)
    for stage in document.stages:
        writer.ensure(
            EngineTagOwnerV1(
                kind="quest_stage",
                project_id=node.project_id,
                quest_node_id=node.id,
                stage_id=stage.id,
            ),
            f"Quest {node.title} {stage.title}",
        )
        for branch in stage.branches:
            writer.ensure(
                EngineTagOwnerV1(
                    kind="quest_branch",
                    project_id=node.project_id,
                    quest_node_id=node.id,
                    stage_id=stage.id,
                    branch_id=branch.id,
                ),
                f"Quest {node.title} {stage.title} {branch.label}",
            )


def ensure_automatic_engine_tag(
    uow: UnitOfWork,
    owner: EngineTagOwnerV1,
    label: str,
) -> bool:
    """Create and bind one deterministic initial tag unless its owner is already bound."""

    return _AutomaticTagWriter(uow, owner.project_id).ensure(owner, label)


class _AutomaticTagWriter:
    """Reuse one registry snapshot while initializing every member of an aggregate."""

    def __init__(self, uow: UnitOfWork, project_id: str) -> None:
        self._uow = uow
        self._project_id = project_id
        self._owner_keys = {
            _canonical_owner_key(binding.owner)
            for binding in uow.engine_tag_bindings.list(project_id=project_id)
        }
        definitions = uow.engine_tag_definitions.list(project_id=project_id)
        self._definition_keys = [definition.key for definition in definitions]
        self._aliases = [EngineTagTargetAliasV1.model_validate(alias) for definition in definitions for alias in definition.aliases]

    def ensure(self, owner: EngineTagOwnerV1, label: str) -> bool:
        """Create one definition/binding pair and update the in-transaction cache."""

        if owner.project_id != self._project_id:
            raise ValueError("automatic engine tag owner belongs to another project")
        serialized_owner = owner.model_dump(mode="json")
        owner_identity = _canonical_owner_key(serialized_owner)
        if owner_identity in self._owner_keys:
            return False
        suggestion = suggest_engine_tag_key(
            EngineTagSuggestionRequestV1(
                project_id=owner.project_id,
                owner=owner,
                label=label.strip() or "Unnamed",
                existing_keys=self._definition_keys,
            )
        )
        aliases = initial_target_aliases(suggestion.key, self._aliases)
        definition = self._uow.engine_tag_definitions.add(
            EngineTagDefinitionEntity(
                project_id=owner.project_id,
                key=suggestion.key,
                normalized_key=suggestion.normalized_key,
                description="",
                status="active",
                aliases=[alias.model_dump(mode="json") for alias in aliases],
            )
        )
        self._uow.engine_tag_bindings.add(
            EngineTagBindingEntity(
                project_id=owner.project_id,
                definition_id=definition.id,
                owner=serialized_owner,
                owner_key=json.dumps(serialized_owner, sort_keys=True, separators=(",", ":")),
            )
        )
        self._owner_keys.add(owner_identity)
        self._definition_keys.append(definition.key)
        self._aliases.extend(aliases)
        return True


def _canonical_owner_key(owner: dict[str, object]) -> str:
    """Compare old sparse owners and newer explicit-null owners as one identity."""

    return json.dumps(
        {key: value for key, value in owner.items() if value is not None},
        sort_keys=True,
        separators=(",", ":"),
    )
