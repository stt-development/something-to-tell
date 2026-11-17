"""Pure, storage-free visual projection for validated Impact alternatives."""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from dataclasses import dataclass
import json
import re
from typing import Any, Iterable

from ..canon.projection import CanonFactProjector
from ..schemas.canon_check import CanonOwnerRef
from ..schemas.impact_resolution import (
    IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
    ImpactPreviewPlacement,
    ImpactVisualChange,
    ImpactVisualDiffProjection,
    ImpactVisualFieldChange,
    ImpactVisualSurface,
    impact_visual_change_fingerprint,
)
from ..schemas.project_document import ProjectDocument, ProjectPlacementRecord
from ..schemas.project_patch import project_record_id
from .builders import resource_ref


class ImpactVisualProjectionError(ValueError):
    """Reject a candidate whose reviewed visual representation is unsafe."""


@dataclass(frozen=True)
class _VisualRecord:
    """Normalized presentation owner and payload for one authoring surface."""

    owner: CanonOwnerRef
    payload: dict[str, Any]


_COLLECTION_SURFACES: dict[str, tuple[tuple[ImpactVisualSurface, str], ...]] = {
    "nodes": (("graph", "node"),),
    "edges": (("graph", "edge"),),
    "engine_tags": (("graph", "engine_tag"),),
    "placements": (("composition", "placement"),),
    "story_flows": (("flow", "flow"), ("story", "flow")),
    "story_flow_nodes": (("flow", "flow_member"), ("story", "flow_member")),
    "flow_transitions": (("flow", "flow_transition"), ("story", "flow_transition")),
    "scene_flow_boundaries": (("flow", "scene_boundary"), ("story", "scene_boundary")),
    "flow_invocations": (("flow", "flow_invocation"), ("story", "flow_invocation")),
    "flow_exits": (("flow", "flow_exit"), ("story", "flow_exit")),
    "flow_exit_bindings": (("flow", "flow_exit_binding"), ("story", "flow_exit_binding")),
    "flow_initial_states": (("temporal", "initial_state"),),
    "narrative_effects": (("temporal", "effect"),),
    "narrative_effect_bindings": (("temporal", "effect_binding"),),
    "issues": (("canon", "issue"),),
}
_IDENTITY_FIELDS = frozenset({"id", "node_id", "project_id", "created_at", "updated_at"})
_PLACEMENT_FIELDS = ("x", "y", "width", "height")
_PATH_PART = re.compile(r"[^a-zA-Z0-9_-]+")
_OWNER_LANES = (
    "flow", "flow_member", "flow_transition", "scene_boundary", "flow_invocation",
    "flow_exit", "flow_exit_binding", "nested", "initial_state", "effect",
    "effect_binding", "fact",
)


class ImpactVisualPatchProjector:
    """Derive stable changes without mutating either complete project document."""

    def __init__(self, *, fact_projector: CanonFactProjector | None = None) -> None:
        self._fact_projector = fact_projector or CanonFactProjector()

    def project(
        self,
        source: ProjectDocument,
        candidate: ProjectDocument,
        *,
        alternative_fingerprint: str,
        max_changes: int = IMPACT_RESOLUTION_MAX_VISUAL_CHANGES,
    ) -> ImpactVisualDiffProjection:
        before = ProjectDocument.model_validate(source.model_dump(mode="json"))
        after = ProjectDocument.model_validate(candidate.model_dump(mode="json"))
        if before.manifest.project_id != after.manifest.project_id:
            raise ImpactVisualProjectionError("visual projection project identity changed")
        self._require_explicit_new_node_placements(before, after)

        changes: list[ImpactVisualChange] = []
        for collection, surfaces in _COLLECTION_SURFACES.items():
            before_records = _records(before, collection)
            after_records = _records(after, collection)
            for surface, owner_type in surfaces:
                changes.extend(self._record_changes(
                    before,
                    after,
                    surface,
                    owner_type,
                    before_records,
                    after_records,
                    collection=collection,
                ))
        changes.extend(self._nested_changes(before, after, "dialogue"))
        changes.extend(self._nested_changes(before, after, "quest"))
        changes.extend(self._canon_changes(before, after))
        if len(changes) > max_changes:
            raise ImpactVisualProjectionError("visual projection exceeds configured change limit")
        return ImpactVisualDiffProjection(
            alternative_fingerprint=alternative_fingerprint,
            source_checksum=before.checksum,
            target_checksum=after.checksum,
            changes=changes,
        )

    def _record_changes(
        self,
        source: ProjectDocument,
        candidate: ProjectDocument,
        surface: ImpactVisualSurface,
        owner_type: str,
        before: dict[str, dict[str, Any]],
        after: dict[str, dict[str, Any]],
        *,
        collection: str,
    ) -> list[ImpactVisualChange]:
        changes: list[ImpactVisualChange] = []
        changed_ids = [key for key in sorted(before.keys() | after.keys()) if before.get(key) != after.get(key)]
        preview = _preview_lanes(surface, owner_type, changed_ids)
        for record_id in changed_ids:
            old = before.get(record_id)
            new = after.get(record_id)
            old_owner = resource_ref(owner_type, record_id) if old is not None else None
            new_owner = resource_ref(owner_type, record_id) if new is not None else None
            old_placement = _resource_placement(source, collection, record_id, old) or preview.get(record_id)
            new_placement = _resource_placement(candidate, collection, record_id, new) or preview.get(record_id)
            changes.append(_change(
                surface=surface,
                before_owner=old_owner,
                after_owner=new_owner,
                before_payload=old,
                after_payload=new,
                before_placement=old_placement if old is not None else None,
                after_placement=new_placement if new is not None else None,
                move=collection == "placements" and _geometry_changed(old, new),
            ))
        return changes

    def _nested_changes(
        self,
        source: ProjectDocument,
        candidate: ProjectDocument,
        domain: str,
    ) -> list[ImpactVisualChange]:
        surface: ImpactVisualSurface = "dialogue" if domain == "dialogue" else "quest"
        before = _dialogue_records(source) if domain == "dialogue" else _quest_records(source)
        after = _dialogue_records(candidate) if domain == "dialogue" else _quest_records(candidate)
        changed_keys = [key for key in sorted(before.keys() | after.keys()) if before.get(key) != after.get(key)]
        preview = _preview_lanes(surface, "nested", ["\u0000".join(key) for key in changed_keys])
        result: list[ImpactVisualChange] = []
        for key in changed_keys:
            old = before.get(key)
            new = after.get(key)
            lane_key = "\u0000".join(key)
            result.append(_change(
                surface=surface,
                before_owner=old.owner if old else None,
                after_owner=new.owner if new else None,
                before_payload=old.payload if old else None,
                after_payload=new.payload if new else None,
                before_placement=preview[lane_key] if old else None,
                after_placement=preview[lane_key] if new else None,
            ))
        return result

    def _canon_changes(
        self,
        source: ProjectDocument,
        candidate: ProjectDocument,
    ) -> list[ImpactVisualChange]:
        before = {_fact_key(fact): fact for fact in self._fact_projector.project(source).facts}
        after = {_fact_key(fact): fact for fact in self._fact_projector.project(candidate).facts}
        fields: dict[tuple[str, str, str, str], list[ImpactVisualFieldChange]] = defaultdict(list)
        owners: dict[tuple[str, str, str, str], CanonOwnerRef] = {}
        for key in sorted(before.keys() | after.keys()):
            old = before.get(key)
            new = after.get(key)
            if _payload(old) == _payload(new):
                continue
            owner = (old or new).scope
            owner_key = owner.stable_key()
            owners[owner_key] = owner
            suffix = key[-1][:10]
            code = _PATH_PART.sub("-", (old or new).code).strip("-") or "fact"
            fields[owner_key].append(ImpactVisualFieldChange(
                path=f"facts.{code}-{suffix}",
                before=_payload(old),
                after=_payload(new),
            ))
        result: list[ImpactVisualChange] = []
        lane = _preview_lanes("canon", "fact", ["\u0000".join(key) for key in sorted(fields)])
        for owner_key in sorted(fields):
            owner = owners[owner_key]
            placement = lane["\u0000".join(owner_key)]
            result.append(_change(
                surface="canon",
                before_owner=owner,
                after_owner=owner,
                before_payload={item.path: item.before for item in fields[owner_key]},
                after_payload={item.path: item.after for item in fields[owner_key]},
                before_placement=placement,
                after_placement=placement,
                explicit_fields=fields[owner_key],
            ))
        return result

    @staticmethod
    def _require_explicit_new_node_placements(
        source: ProjectDocument,
        candidate: ProjectDocument,
    ) -> None:
        existing = {node.id for node in source.nodes}
        added = {node.id for node in candidate.nodes} - existing
        placed = {placement.canonical_node_id for placement in candidate.placements}
        missing = sorted(added - placed)
        if missing:
            raise ImpactVisualProjectionError(
                f"new canvas node requires explicit placement: {missing[0]}"
            )


def _change(
    *,
    surface: ImpactVisualSurface,
    before_owner: CanonOwnerRef | None,
    after_owner: CanonOwnerRef | None,
    before_payload: dict[str, Any] | None,
    after_payload: dict[str, Any] | None,
    before_placement: ImpactPreviewPlacement | None = None,
    after_placement: ImpactPreviewPlacement | None = None,
    move: bool = False,
    explicit_fields: Iterable[ImpactVisualFieldChange] | None = None,
) -> ImpactVisualChange:
    if before_payload is None:
        kind = "add"
        fields: tuple[ImpactVisualFieldChange, ...] = ()
    elif after_payload is None:
        kind = "remove"
        fields = ()
    else:
        kind = "move" if move else "modify"
        fields = tuple(explicit_fields or _field_changes(before_payload, after_payload))
        if not fields and not move:
            raise ImpactVisualProjectionError("modified visual owner has no field delta")
    fingerprint = impact_visual_change_fingerprint(
        kind=kind,
        surface=surface,
        before_resource=before_owner,
        after_resource=after_owner,
        field_paths=[item.path for item in fields],
    )
    return ImpactVisualChange(
        id=fingerprint,
        kind=kind,
        surface=surface,
        before_resource=before_owner,
        after_resource=after_owner,
        field_changes=fields,
        before_placement=before_placement,
        after_placement=after_placement,
    )


def _field_changes(before: dict[str, Any], after: dict[str, Any]) -> tuple[ImpactVisualFieldChange, ...]:
    changes: list[ImpactVisualFieldChange] = []
    for key in sorted(before.keys() | after.keys()):
        if key in _IDENTITY_FIELDS:
            continue
        old = before.get(key)
        new = after.get(key)
        if old == new:
            continue
        changes.append(ImpactVisualFieldChange(path=key, before=old, after=new))
    if len(changes) > 50:
        raise ImpactVisualProjectionError("one visual owner exceeds the field change limit")
    return tuple(changes)


def _records(document: ProjectDocument, collection: str) -> dict[str, dict[str, Any]]:
    return {
        project_record_id(collection, payload): payload
        for record in getattr(document, collection)
        for payload in [record.model_dump(mode="json")]
    }


def _dialogue_records(document: ProjectDocument) -> dict[tuple[str, ...], _VisualRecord]:
    records: dict[tuple[str, ...], _VisualRecord] = {}
    for owned in document.dialogues:
        root = resource_ref("node", owned.node_id)
        records[root.stable_key()] = _VisualRecord(root, {
            "entry_element_id": owned.document.entry_element_id,
            "participants": list(owned.document.participants),
        })
        for element in owned.document.elements:
            owner = resource_ref("dialogue_element", element.id, context=root)
            raw = element.model_dump(mode="json")
            records[owner.stable_key()] = _VisualRecord(owner, {
                key: value for key, value in raw.items() if key != "options"
            })
            for option in raw.get("options", []):
                option_owner = resource_ref("dialogue_option", option["id"], context=owner)
                records[option_owner.stable_key()] = _VisualRecord(option_owner, option)
    return records


def _quest_records(document: ProjectDocument) -> dict[tuple[str, ...], _VisualRecord]:
    records: dict[tuple[str, ...], _VisualRecord] = {}
    for owned in document.quests:
        root = resource_ref("node", owned.node_id)
        raw = owned.document.model_dump(mode="json")
        records[root.stable_key()] = _VisualRecord(root, {
            key: value for key, value in raw.items() if key != "stages"
        })
        for stage in owned.document.stages:
            owner = resource_ref("quest_stage", stage.id, context=root)
            stage_raw = stage.model_dump(mode="json")
            records[owner.stable_key()] = _VisualRecord(owner, {
                key: value for key, value in stage_raw.items() if key != "branches"
            })
            for branch in stage.branches:
                branch_owner = resource_ref("quest_branch", branch.id, context=owner)
                records[branch_owner.stable_key()] = _VisualRecord(
                    branch_owner, branch.model_dump(mode="json")
                )
    return records


def _resource_placement(
    document: ProjectDocument,
    collection: str,
    record_id: str,
    record: dict[str, Any] | None,
) -> ImpactPreviewPlacement | None:
    if record is None:
        return None
    if collection == "placements":
        return _placement(ProjectPlacementRecord.model_validate(record))
    if collection != "nodes":
        return None
    matches = sorted(
        (item for item in document.placements if item.canonical_node_id == record_id),
        key=lambda item: (not item.is_primary, item.scope_key, item.id),
    )
    return _placement(matches[0]) if matches else None


def _placement(record: ProjectPlacementRecord) -> ImpactPreviewPlacement:
    return ImpactPreviewPlacement(
        x=record.x,
        y=record.y,
        width=record.width,
        height=record.height,
        preview_only=False,
    )


def _preview_lanes(
    surface: ImpactVisualSurface,
    owner_type: str,
    record_ids: list[str],
) -> dict[str, ImpactPreviewPlacement]:
    dimensions = {
        "flow": (240.0, 128.0, 300.0, 168.0),
        "story": (720.0, 72.0, 760.0, 96.0),
        "dialogue": (560.0, 80.0, 600.0, 104.0),
        "quest": (560.0, 80.0, 600.0, 104.0),
        "temporal": (520.0, 72.0, 560.0, 96.0),
        "canon": (520.0, 72.0, 560.0, 96.0),
    }
    if surface not in dimensions:
        return {}
    width, height, column, row = dimensions[surface]
    lane = _OWNER_LANES.index(owner_type) if owner_type in _OWNER_LANES else len(_OWNER_LANES)
    return {
        record_id: ImpactPreviewPlacement(
            x=lane * column,
            y=index * row,
            width=width,
            height=height,
            preview_only=True,
        )
        for index, record_id in enumerate(sorted(record_ids))
    }


def _geometry_changed(before: dict[str, Any] | None, after: dict[str, Any] | None) -> bool:
    return bool(
        before is not None
        and after is not None
        and any(before.get(field) != after.get(field) for field in (*_PLACEMENT_FIELDS, "container_node_id"))
    )


def _fact_key(fact: Any) -> tuple[str, ...]:
    signature = json.dumps(
        fact.model_dump(mode="json", exclude={"source_revision"}),
        sort_keys=True,
        separators=(",", ":"),
    )
    return (*fact.scope.stable_key(), fact.code, _digest(signature))


def _payload(value: Any | None) -> Any:
    return None if value is None else deepcopy(
        value.model_dump(mode="json", exclude={"source_revision"})
    )


def _digest(value: str) -> str:
    from hashlib import sha256

    return sha256(value.encode("utf-8")).hexdigest()
