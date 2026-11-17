"""Pure compatibility projections for stable Engine Tag identities."""

from __future__ import annotations

import re
from collections.abc import Callable

from ..schemas.engine_tags import (
    EngineTagProjectionDiagnosticV1,
    EngineTagProjectionEntryV1,
    EngineTagProjectionOmissionV1,
    EngineTagProjectionTarget,
    EngineTagProjectionV1,
    EngineTagOwnerV1,
)
from ..schemas.project_document import ProjectDocument

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")


class EngineTagProjectionService:
    """Build stable target views without writing files or changing source data."""

    def project(
        self,
        document: ProjectDocument,
        target: EngineTagProjectionTarget,
        *,
        owner_filter: Callable[[EngineTagOwnerV1], bool] | None = None,
    ) -> EngineTagProjectionV1:
        """Project active definitions and bindings in deterministic identity order."""

        entries: list[EngineTagProjectionEntryV1] = []
        omitted: list[EngineTagProjectionOmissionV1] = []
        diagnostics: list[EngineTagProjectionDiagnosticV1] = []
        bindings = sorted(document.engine_tag_bindings, key=lambda item: item.id)
        used: dict[str, list[str]] = {}
        definitions_by_identifier: dict[str, set[str]] = {}

        for definition in sorted(document.engine_tag_definitions, key=lambda item: item.id):
            if definition.status == "archived":
                omitted.append(EngineTagProjectionOmissionV1(
                    definition_id=definition.id, code="archived_definition",
                ))
                continue
            source_bindings = [item for item in bindings if item.definition_id == definition.id]
            excluded_bindings = [
                item for item in source_bindings
                if owner_filter is not None
                and self._owner_exists(document, item.owner)
                and not owner_filter(item.owner)
            ]
            omitted.extend(
                EngineTagProjectionOmissionV1(
                    definition_id=definition.id,
                    binding_id=item.id,
                    owner=item.owner,
                    code="out_of_scope",
                    details={"target": target},
                )
                for item in excluded_bindings
            )
            definition_bindings = [
                item for item in source_bindings
                if owner_filter is None
                or not self._owner_exists(document, item.owner)
                or owner_filter(item.owner)
            ]
            # Only genuinely unbound definitions may become project-owned. A
            # fully filtered definition is reported but never compatibility-checked.
            if source_bindings and not definition_bindings:
                continue
            if not definition_bindings:
                project_owner = EngineTagOwnerV1(
                    kind="project", project_id=document.manifest.project_id
                )
                if owner_filter is not None and not owner_filter(project_owner):
                    continue
                definition_bindings = [None]

            aliases = [alias for alias in definition.aliases if target != "generic" and alias.target == target]
            if target == "generic":
                identifier = definition.normalized_key
                if not _IDENTIFIER.fullmatch(identifier):
                    omitted.append(EngineTagProjectionOmissionV1(
                        definition_id=definition.id, code="target_identifier_invalid",
                    ))
                    continue
                selected_alias = None
            else:
                if not aliases:
                    omitted.append(EngineTagProjectionOmissionV1(
                        definition_id=definition.id, code="missing_target_alias",
                        details={"target": target},
                    ))
                    continue
                aliases.sort(key=lambda alias: alias.external_identifier)
                selected_alias = aliases[0]
                if len({alias.external_identifier.casefold() for alias in aliases}) != len(aliases):
                    omitted.append(EngineTagProjectionOmissionV1(
                        definition_id=definition.id, code="duplicate_target_alias",
                        details={"target": target},
                    ))
                    continue
                identifier = selected_alias.external_identifier
                if not _IDENTIFIER.fullmatch(identifier):
                    omitted.append(EngineTagProjectionOmissionV1(
                        definition_id=definition.id, code="target_identifier_invalid",
                        details={"target": target},
                    ))
                    continue

            for binding in definition_bindings:
                if binding is None:
                    key = f"{target}:{identifier.casefold()}"
                    used.setdefault(key, []).append(definition.id)
                    definitions_by_identifier.setdefault(key, set()).add(definition.id)
                    entries.append(EngineTagProjectionEntryV1(
                        definition_id=definition.id, normalized_key=definition.normalized_key,
                        owner={"kind": "project", "project_id": document.manifest.project_id},
                        identifier=identifier,
                    ))
                    continue
                if not self._owner_exists(document, binding.owner):
                    omitted.append(EngineTagProjectionOmissionV1(
                        definition_id=definition.id, binding_id=binding.id,
                        owner=binding.owner, code="missing_owner",
                    ))
                    diagnostics.append(EngineTagProjectionDiagnosticV1(
                        code="missing_owner", message_key="engine_tags.projection.missing-owner",
                        details={"binding_id": binding.id},
                    ))
                    continue
                key = f"{target}:{identifier.casefold()}"
                used.setdefault(key, []).append(binding.id)
                definitions_by_identifier.setdefault(key, set()).add(definition.id)
                entries.append(EngineTagProjectionEntryV1(
                    definition_id=definition.id, normalized_key=definition.normalized_key,
                    owner=binding.owner, identifier=identifier,
                ))

        for key, identities in sorted(used.items()):
            # One definition can intentionally tag many owners; only distinct
            # canonical definitions competing for the identifier are ambiguous.
            if len(definitions_by_identifier[key]) > 1:
                diagnostics.append(EngineTagProjectionDiagnosticV1(
                    code="target_collision", message_key="engine_tags.projection.target-collision",
                    details={"identifier": key.split(":", 1)[1], "binding_ids": ",".join(sorted(identities))},
                ))
                for entry in entries[:]:
                    if f"{target}:{entry.identifier.casefold()}" == key:
                        entries.remove(entry)
                        omitted.append(EngineTagProjectionOmissionV1(
                            definition_id=entry.definition_id, code="duplicate_target_alias",
                            details={"identifier": entry.identifier},
                        ))

        if document.legacy_engine_tags:
            diagnostics.append(EngineTagProjectionDiagnosticV1(
                code="legacy_quarantine", message_key="engine_tags.projection.legacy-quarantine",
                details={"count": str(len(document.legacy_engine_tags))},
            ))
            omitted.extend(
                EngineTagProjectionOmissionV1(
                    binding_id=row.id, code="legacy_quarantine",
                )
                for row in sorted(document.legacy_engine_tags, key=lambda item: item.id)
            )
        entries.sort(key=lambda item: (item.identifier, item.definition_id, item.owner.kind))
        omitted.sort(key=lambda item: (item.definition_id or "", item.binding_id or "", item.code))
        diagnostics.sort(key=lambda item: (item.code, sorted(item.details.items())))
        return EngineTagProjectionV1(
            project_id=document.manifest.project_id, source_checksum=document.checksum,
            target=target, entries=entries, omitted=omitted, diagnostics=diagnostics,
        )

    @staticmethod
    def _owner_exists(document: ProjectDocument, owner: EngineTagOwnerV1) -> bool:
        from .service import EngineTagRegistryService

        return EngineTagRegistryService._owner_exists(document, owner)

    @staticmethod
    def _flatten(value: object) -> list[object]:
        if isinstance(value, dict):
            return [item for child in value.values() for item in EngineTagProjectionService._flatten(child)]
        if isinstance(value, list):
            return [item for child in value for item in EngineTagProjectionService._flatten(child)]
        return [value]
