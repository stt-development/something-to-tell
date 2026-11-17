"""Pure project-document mutations for the Phase 7 engine-tag registry."""

from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json
from typing import Callable
from uuid import uuid4

from ..schemas.engine_tags import (
    ENGINE_TAG_AUTHORING_TARGETS,
    EngineTagBindingV1,
    EngineTagCatalogV1,
    EngineTagDefinitionV1,
    EngineTagIntegrityFindingV1,
    EngineTagIntegrityReportV1,
    EngineTagMutationCommandV1,
    EngineTagOwnerV1,
    normalize_engine_tag_key,
)
from ..schemas.project_document import ProjectDocument, create_project_document
from .aliases import initial_target_aliases


class EngineTagRegistryError(ValueError):
    """Stable, serializable registry failure for API and command tests."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class EngineTagRegistryService:
    """Apply one validated registry command to an immutable project document."""

    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._clock = clock

    def catalog(self, document: ProjectDocument) -> EngineTagCatalogV1:
        """Return a stable view used by both API responses and the UI."""

        return EngineTagCatalogV1(
            project_id=document.manifest.project_id,
            definitions=list(document.engine_tag_definitions),
            bindings=list(document.engine_tag_bindings),
            legacy_count=len(document.legacy_engine_tags),
        )

    def impact_fingerprint(self, document: ProjectDocument, definition_id: str) -> str:
        """Fingerprint the definition and its bindings before destructive review."""

        definition = self._definition(document, definition_id)
        bindings = [
            binding.model_dump(mode="json")
            for binding in document.engine_tag_bindings
            if binding.definition_id == definition_id
        ]
        payload = {"definition": definition.model_dump(mode="json"), "bindings": bindings}
        return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def integrity(self, document: ProjectDocument) -> EngineTagIntegrityReportV1:
        """Report exact registry conflicts without mutating the project or Canon state."""

        findings: list[EngineTagIntegrityFindingV1] = []
        definitions = list(document.engine_tag_definitions)
        by_key: dict[str, list[EngineTagDefinitionV1]] = {}
        for definition in definitions:
            by_key.setdefault(definition.normalized_key, []).append(definition)
        for normalized_key, matches in by_key.items():
            if len(matches) > 1:
                for definition in matches:
                    findings.append(EngineTagIntegrityFindingV1(
                        code="duplicate_normalized_key", severity="error",
                        message_key="engine_tags.integrity.duplicate-key",
                        definition_id=definition.id,
                        details={"normalized_key": normalized_key},
                    ))

        aliases: dict[tuple[str, str], list[EngineTagDefinitionV1]] = {}
        for definition in definitions:
            for alias in definition.aliases:
                aliases.setdefault((alias.target, alias.external_identifier.casefold()), []).append(definition)
        for (target, external_identifier), matches in aliases.items():
            if len(matches) > 1:
                for definition in matches:
                    findings.append(EngineTagIntegrityFindingV1(
                        code="duplicate_alias", severity="error",
                        message_key="engine_tags.integrity.duplicate-alias",
                        definition_id=definition.id,
                        details={"target": target, "external_identifier": external_identifier},
                    ))

        definition_by_id = {definition.id: definition for definition in definitions}
        for binding in document.engine_tag_bindings:
            definition = definition_by_id.get(binding.definition_id)
            if definition is None or not self._owner_exists(document, binding.owner):
                findings.append(EngineTagIntegrityFindingV1(
                    code="missing_owner", severity="error",
                    message_key="engine_tags.integrity.missing-owner",
                    definition_id=binding.definition_id, binding_id=binding.id,
                    owner=binding.owner,
                ))
            elif definition.status == "archived":
                findings.append(EngineTagIntegrityFindingV1(
                    code="archived_binding", severity="warning",
                    message_key="engine_tags.integrity.archived-binding",
                    definition_id=definition.id, binding_id=binding.id, owner=binding.owner,
                ))

        if document.legacy_engine_tags:
            findings.append(EngineTagIntegrityFindingV1(
                code="legacy_unreviewed", severity="warning",
                message_key="engine_tags.integrity.legacy-unreviewed",
                details={"count": str(len(document.legacy_engine_tags))},
            ))
        for definition in definitions:
            if definition.status != "active":
                continue
            for target in ENGINE_TAG_AUTHORING_TARGETS:
                if not any(alias.target == target for alias in definition.aliases):
                    findings.append(EngineTagIntegrityFindingV1(
                        code="target_incompatibility", severity="info",
                        message_key="engine_tags.integrity.target-incompatibility",
                        definition_id=definition.id, details={"target": target},
                    ))
        severity_order = {"error": 0, "warning": 1, "info": 2}
        findings.sort(key=lambda item: (severity_order[item.severity], item.code, item.definition_id or "", item.binding_id or ""))
        return EngineTagIntegrityReportV1(
            project_id=document.manifest.project_id, source_checksum=document.checksum,
            findings=findings,
            error_count=sum(item.severity == "error" for item in findings),
            warning_count=sum(item.severity == "warning" for item in findings),
            info_count=sum(item.severity == "info" for item in findings),
        )

    @staticmethod
    def _owner_exists(document: ProjectDocument, owner: EngineTagOwnerV1) -> bool:
        """Resolve one typed owner inside its aggregate instead of matching loose IDs."""

        if owner.project_id != document.manifest.project_id:
            return False
        if owner.kind == "project":
            return True
        if owner.kind == "node":
            return any(record.id == owner.node_id for record in document.nodes)
        if owner.kind == "relationship":
            return any(record.id == owner.edge_id for record in document.edges)
        if owner.kind.startswith("dialogue_"):
            dialogue = next((record.document for record in document.dialogues if record.node_id == owner.dialogue_node_id), None)
            if dialogue is None:
                return False
            element_id = owner.line_id or owner.choice_id
            element = next((record for record in dialogue.elements if record.id == element_id), None)
            if owner.kind == "dialogue_line":
                return element is not None and element.kind == "line"
            if owner.kind == "dialogue_choice":
                return element is not None and element.kind == "choice"
            return element is not None and element.kind == "choice" and any(option.id == owner.option_id for option in element.options)
        if owner.kind.startswith("quest_"):
            quest = next((record.document for record in document.quests if record.node_id == owner.quest_node_id), None)
            if quest is None:
                return False
            stage = next((record for record in quest.stages if record.id == owner.stage_id), None)
            if owner.kind == "quest_stage":
                return stage is not None
            return stage is not None and any(branch.id == owner.branch_id for branch in stage.branches)
        collections = {
            "story_flow": (document.story_flows, owner.flow_id),
            "flow_transition": (document.flow_transitions, owner.transition_id),
            "flow_invocation": (document.flow_invocations, owner.invocation_id),
            "flow_exit": (document.flow_exits, owner.exit_id),
            "narrative_effect": (document.narrative_effects, owner.effect_id),
        }
        records, identity = collections[owner.kind]
        return identity is not None and any(record.id == identity for record in records)

    @staticmethod
    def _flatten(value: object) -> list[object]:
        if isinstance(value, dict):
            return [item for child in value.values() for item in EngineTagRegistryService._flatten(child)]
        if isinstance(value, list):
            return [item for child in value for item in EngineTagRegistryService._flatten(child)]
        return [value]

    def apply(
        self,
        document: ProjectDocument,
        command: EngineTagMutationCommandV1,
    ) -> tuple[ProjectDocument, str | None]:
        """Return a validated replacement document and optional impact fingerprint."""

        if document.checksum != command.expected_source_checksum:
            raise EngineTagRegistryError("engine_tag_identity_stale", source_checksum=document.checksum)
        if command.owner is not None:
            self._require_owner(document, command.owner)
        for owner in command.owners:
            self._require_owner(document, owner)
        definitions = list(document.engine_tag_definitions)
        bindings = list(document.engine_tag_bindings)
        now = self._clock().isoformat()
        impact: str | None = None

        if command.action in {"create_definition", "create_and_bind"}:
            normalized = self._key(command.key)
            self._require_key_free(definitions, normalized)
            definition_id = f"tagdef-{uuid4().hex}"
            definitions.append(EngineTagDefinitionV1(
                id=definition_id, project_id=document.manifest.project_id,
                key=command.key or normalized, normalized_key=normalized,
                description=(command.description or "").strip(), status="active",
                aliases=initial_target_aliases(normalized, [alias for item in definitions for alias in item.aliases]),
                created_at=now, updated_at=now,
            ))
            if command.action == "create_and_bind":
                # Definition creation and contextual assignment form one undoable authoring command.
                create_owners = [command.owner] if command.owner is not None else command.owners
                if len({self._owner_key(owner) for owner in create_owners}) != len(create_owners):
                    raise EngineTagRegistryError("engine_tag_key_collision")
                for owner in create_owners:
                    bindings.append(EngineTagBindingV1(
                        id=f"tagbind-{uuid4().hex}", project_id=document.manifest.project_id,
                        definition_id=definition_id, owner=owner, value=command.value or "",
                        created_at=now, updated_at=now,
                    ))
        elif command.action == "convert_legacy":
            # Conversion starts from a quarantined row, so no definition exists yet.
            pass
        else:
            current = self._definition(document, command.definition_id or "")
            index = definitions.index(current)
            if command.action == "update_definition":
                definitions[index] = current.model_copy(update={
                    "description": (command.description if command.description is not None else current.description).strip(),
                    "updated_at": now,
                })
            elif command.action == "rename_definition":
                normalized = self._key(command.key)
                self._require_key_free(definitions, normalized, current.id)
                definitions[index] = current.model_copy(update={
                    "key": command.key or normalized,
                    "normalized_key": normalized,
                    "description": (command.description if command.description is not None else current.description).strip(),
                    "updated_at": now,
                })
            elif command.action in {"archive_definition", "restore_definition"}:
                if command.action == "restore_definition":
                    for alias in current.aliases:
                        self._require_alias_free(definitions, alias, current.id)
                definitions[index] = current.model_copy(update={
                    "status": "archived" if command.action == "archive_definition" else "active",
                    "updated_at": now,
                })
            elif command.action in {"set_alias", "remove_alias"}:
                aliases = list(current.aliases)
                assert command.alias is not None
                if command.action == "set_alias":
                    self._require_alias_free(definitions, command.alias, current.id)
                aliases = [alias for alias in aliases if alias.target != command.alias.target]
                if command.action == "set_alias":
                    aliases.append(command.alias)
                definitions[index] = current.model_copy(update={"aliases": aliases, "updated_at": now})
            elif command.action in {"batch_bind", "batch_unbind"}:
                owner_keys = [self._owner_key(owner) for owner in command.owners]
                if len(owner_keys) != len(set(owner_keys)):
                    raise EngineTagRegistryError("engine_tag_key_collision")
                for owner in command.owners:
                    owner_key = self._owner_key(owner)
                    existing = next((item for item in bindings if item.definition_id == current.id and self._owner_key(item.owner) == owner_key), None)
                    if command.action == "batch_unbind":
                        if existing is not None:
                            bindings = [item for item in bindings if item.id != existing.id]
                    else:
                        bindings = [item for item in bindings if item.id != (existing.id if existing else "")]
                        bindings.append(EngineTagBindingV1(
                            id=existing.id if existing else f"tagbind-{uuid4().hex}",
                            project_id=document.manifest.project_id, definition_id=current.id,
                            owner=owner, value=command.value or "",
                            created_at=existing.created_at if existing else now, updated_at=now,
                        ))
            elif command.action in {"bind", "unbind"}:
                assert command.owner is not None
                owner_key = self._owner_key(command.owner)
                existing = next((item for item in bindings if item.definition_id == current.id and self._owner_key(item.owner) == owner_key), None)
                if command.action == "bind":
                    replacement = EngineTagBindingV1(
                        id=existing.id if existing else f"tagbind-{uuid4().hex}",
                        project_id=document.manifest.project_id, definition_id=current.id,
                        owner=command.owner, value=command.value or "",
                        created_at=existing.created_at if existing else now, updated_at=now,
                    )
                    bindings = [item for item in bindings if item.id != (existing.id if existing else "")]
                    bindings.append(replacement)
                elif existing is not None:
                    bindings = [item for item in bindings if item.id != existing.id]
            elif command.action == "merge":
                target = self._definition(document, command.target_definition_id or "")
                if target.id == current.id:
                    raise EngineTagRegistryError("engine_tag_key_collision")
                impact = self.impact_fingerprint(document, current.id)
                if command.reviewed_impact_fingerprint != impact:
                    raise EngineTagRegistryError("engine_tag_identity_stale", definition_id=current.id)
                if any(self._owner_key(item.owner) in {
                    self._owner_key(binding.owner) for binding in bindings if binding.definition_id == target.id
                } for item in bindings if item.definition_id == current.id):
                    raise EngineTagRegistryError("engine_tag_key_collision")
                bindings = [
                    item.model_copy(update={"definition_id": target.id, "updated_at": now})
                    if item.definition_id == current.id else item
                    for item in bindings
                ]
                definitions = [item for item in definitions if item.id != current.id]
            elif command.action == "delete_definition":
                impact = self.impact_fingerprint(document, current.id)
                if command.reviewed_impact_fingerprint != impact:
                    raise EngineTagRegistryError("engine_tag_identity_stale", definition_id=current.id)
                if any(item.definition_id == current.id for item in bindings):
                    raise EngineTagRegistryError("engine_tag_key_collision")
                definitions = [item for item in definitions if item.id != current.id]
        if command.action == "convert_legacy":
            legacy = next((item for item in document.legacy_engine_tags if item.id == command.legacy_id), None)
            if legacy is None or command.owner is None:
                raise EngineTagRegistryError("engine_tag_identity_stale", legacy_id=command.legacy_id)
            normalized = self._key(command.key or legacy.key)
            self._require_key_free(definitions, normalized)
            definition_id = f"tagdef-{uuid4().hex}"
            definitions.append(EngineTagDefinitionV1(
                id=definition_id, project_id=document.manifest.project_id, key=command.key or normalized,
                normalized_key=normalized, description=f"Converted from legacy tag {legacy.id}",
                status="active",
                aliases=initial_target_aliases(normalized, [alias for item in definitions for alias in item.aliases]),
                created_at=now, updated_at=now,
            ))
            bindings.append(EngineTagBindingV1(
                id=f"tagbind-{uuid4().hex}", project_id=document.manifest.project_id,
                definition_id=definition_id, owner=command.owner, value=command.value or legacy.value,
                created_at=now, updated_at=now,
            ))

        definitions.sort(key=lambda item: item.id)
        bindings.sort(key=lambda item: item.id)
        payload = document.model_dump(mode="python", exclude={"checksum"})
        target = create_project_document(**{**payload, "engine_tag_definitions": definitions, "engine_tag_bindings": bindings})
        return target, impact

    @staticmethod
    def _key(value: str | None) -> str:
        if not value:
            raise EngineTagRegistryError("engine_tag_key_invalid")
        try:
            return normalize_engine_tag_key(value)
        except ValueError as error:
            raise EngineTagRegistryError("engine_tag_key_invalid") from error

    @staticmethod
    def _definition(document: ProjectDocument, definition_id: str) -> EngineTagDefinitionV1:
        definition = next((item for item in document.engine_tag_definitions if item.id == definition_id), None)
        if definition is None:
            raise EngineTagRegistryError("engine_tag_identity_stale", definition_id=definition_id)
        return definition

    @staticmethod
    def _require_key_free(definitions: list[EngineTagDefinitionV1], normalized: str, ignored_id: str | None = None) -> None:
        if any(item.normalized_key == normalized and item.id != ignored_id for item in definitions):
            raise EngineTagRegistryError("engine_tag_key_collision", normalized_key=normalized)

    @staticmethod
    def _require_alias_free(
        definitions: list[EngineTagDefinitionV1], alias: object, ignored_id: str,
    ) -> None:
        target = getattr(alias, "target", None)
        external_identifier = getattr(alias, "external_identifier", None)
        if any(
            definition.id != ignored_id
            and any(
                item.target == target
                and item.external_identifier.casefold() == str(external_identifier).casefold()
                for item in definition.aliases
            )
            for definition in definitions
        ):
            raise EngineTagRegistryError("engine_tag_key_collision", alias=external_identifier)

    @staticmethod
    def _owner_key(owner: EngineTagOwnerV1) -> str:
        return json.dumps(owner.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))

    @classmethod
    def _require_owner(cls, document: ProjectDocument, owner: EngineTagOwnerV1) -> None:
        if not cls._owner_exists(document, owner):
            identities = [value for key, value in owner.model_dump().items() if key not in {"kind", "project_id"} and value]
            raise EngineTagRegistryError("engine_tag_owner_invalid", owner=identities[-1] if identities else None)

    @staticmethod
    def _flatten(value: object) -> list[object]:
        if isinstance(value, dict):
            return [item for child in value.values() for item in EngineTagRegistryService._flatten(child)]
        if isinstance(value, list):
            return [item for child in value for item in EngineTagRegistryService._flatten(child)]
        return [value]
