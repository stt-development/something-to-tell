from copy import deepcopy
from hashlib import sha256
from typing import Any

from pydantic import ValidationError

from ..project_format.manifest import ProjectManifestV2
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.project_patch import (
    PROJECT_RECORD_COLLECTIONS,
    ProjectPatch,
    ProjectPatchOperation,
    PutProjectRecordOperation,
    RemoveProjectRecordOperation,
    ReplaceManifestOperation,
    ReplaceProjectMetadataOperation,
    project_record_id,
)


class ProjectPatchError(ValueError):
    """Reject a patch before any caller-owned ProjectDocument can change."""


def derive_project_patch(source: ProjectDocument, target: ProjectDocument) -> ProjectPatch:
    """Derive one deterministic, input-immutable patch between validated documents."""

    source_document = _validated_copy(source)
    target_document = _validated_copy(target)
    project_id = source_document.manifest.project_id
    if target_document.manifest.project_id != project_id:
        raise ProjectPatchError("project patch cannot change project identity")

    operations: list[ProjectPatchOperation] = []
    if source_document.manifest != target_document.manifest:
        _require_reversible_manifest_change(
            source_document.manifest.model_dump(mode="json"),
            target_document.manifest.model_dump(mode="json"),
        )
        operations.append(
            ReplaceManifestOperation(manifest=target_document.manifest)
        )
    if source_document.project_metadata != target_document.project_metadata:
        operations.append(
            ReplaceProjectMetadataOperation(
                value=deepcopy(target_document.project_metadata)
            )
        )

    for collection in PROJECT_RECORD_COLLECTIONS:
        source_records = _records_by_id(source_document, collection)
        target_records = _records_by_id(target_document, collection)
        for record_id in sorted(source_records.keys() | target_records.keys()):
            source_record = source_records.get(record_id)
            target_record = target_records.get(record_id)
            if source_record == target_record:
                continue
            if target_record is None:
                operations.append(
                    RemoveProjectRecordOperation(
                        collection=collection,
                        record_id=record_id,
                    )
                )
            else:
                operations.append(
                    PutProjectRecordOperation(
                        collection=collection,
                        record_id=record_id,
                        record=target_record,
                    )
                )

    return ProjectPatch(
        patch_id=_patch_id(source_document.checksum, target_document.checksum),
        project_id=project_id,
        source_checksum=source_document.checksum,
        target_checksum=target_document.checksum,
        operations=operations,
    )


def apply_project_patch(document: ProjectDocument, patch: ProjectPatch) -> ProjectDocument:
    """Apply a complete candidate in memory and accept it only after checksum validation."""

    source = _validated_copy(document)
    if patch.project_id != source.manifest.project_id:
        raise ProjectPatchError("project patch belongs to another project")
    if patch.source_checksum != source.checksum:
        raise ProjectPatchError("project patch source checksum does not match")
    try:
        validated_patch = ProjectPatch.model_validate(patch.model_dump(mode="json"))
    except ValidationError as error:
        raise ProjectPatchError(f"project patch contract is invalid: {error}") from error

    payload = source.model_dump(mode="python", exclude={"checksum"})
    for operation in validated_patch.operations:
        if isinstance(operation, ReplaceManifestOperation):
            current_manifest = payload["manifest"]
            target_manifest = operation.manifest.model_dump(mode="python")
            _require_reversible_manifest_change(
                _json_value(current_manifest),
                operation.manifest.model_dump(mode="json"),
            )
            payload["manifest"] = target_manifest
        elif isinstance(operation, ReplaceProjectMetadataOperation):
            payload["project_metadata"] = deepcopy(operation.value)
        else:
            _apply_record_operation(payload, operation)

    for collection in PROJECT_RECORD_COLLECTIONS:
        payload[collection] = sorted(
            payload.get(collection, []),
            key=lambda record: project_record_id(collection, _json_value(record)),
        )
    try:
        result = create_project_document(**payload)
    except (TypeError, ValueError) as error:
        raise ProjectPatchError(f"project patch produces an invalid document: {error}") from error
    if result.checksum != validated_patch.target_checksum:
        raise ProjectPatchError("project patch target checksum does not match")
    return result


def invert_project_patch(
    patch: ProjectPatch,
    *,
    source: ProjectDocument,
    target: ProjectDocument,
) -> ProjectPatch:
    """Build and verify the deterministic inverse for a known source/target pair."""

    forward = apply_project_patch(source, patch)
    if forward.checksum != target.checksum:
        raise ProjectPatchError("project patch target document does not match")
    return derive_project_patch(target, source)


def _apply_record_operation(
    payload: dict[str, Any],
    operation: PutProjectRecordOperation | RemoveProjectRecordOperation,
) -> None:
    collection = operation.collection
    records = payload.get(collection, [])
    by_id = {
        project_record_id(collection, _json_value(record)): record
        for record in records
    }
    if isinstance(operation, RemoveProjectRecordOperation):
        if operation.record_id not in by_id:
            raise ProjectPatchError(
                f"project patch cannot remove missing {collection} record: {operation.record_id}"
            )
        del by_id[operation.record_id]
    else:
        by_id[operation.record_id] = deepcopy(operation.record)
    payload[collection] = list(by_id.values())


def _records_by_id(
    document: ProjectDocument,
    collection: str,
) -> dict[str, dict[str, Any]]:
    records = getattr(document, collection)
    result: dict[str, dict[str, Any]] = {}
    for record in records:
        value = record.model_dump(mode="json")
        result[project_record_id(collection, value)] = value
    return result


def _require_reversible_manifest_change(
    source: dict[str, Any],
    target: dict[str, Any],
) -> None:
    source_copy = ProjectManifestV2.model_validate(source).model_dump(mode="json")
    target_copy = ProjectManifestV2.model_validate(target).model_dump(mode="json")
    source_settings = source_copy.pop("settings")
    target_settings = target_copy.pop("settings")
    source_storage = source_settings.pop("storage")
    target_storage = target_settings.pop("storage")
    if source_storage != target_storage:
        raise ProjectPatchError("project patch cannot change storage settings")
    for key in ("name", "description", "updated_at"):
        source_copy.pop(key)
        target_copy.pop(key)
    if source_copy != target_copy:
        raise ProjectPatchError("project patch changes immutable manifest fields")
    # All non-storage settings are versioned authoring settings, including
    # future namespaced Phase 4 configuration retained as Pydantic extras.
    if not isinstance(source_settings, dict) or not isinstance(target_settings, dict):
        raise ProjectPatchError("project patch manifest settings must be objects")


def _validated_copy(document: ProjectDocument) -> ProjectDocument:
    return ProjectDocument.model_validate(document.model_dump(mode="json"))


def _json_value(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    return deepcopy(value)


def _patch_id(source_checksum: str, target_checksum: str) -> str:
    digest = sha256(f"{source_checksum}:{target_checksum}".encode("ascii")).hexdigest()
    return f"project-patch-{digest[:24]}"
