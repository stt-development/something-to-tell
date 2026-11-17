from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.project_document.patch import (
    ProjectPatchError,
    apply_project_patch,
    derive_project_patch,
    invert_project_patch,
)
from services.runtime.stt_runtime.project_fixture import _fixture_document, load_project_fixture
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectDocument,
    create_project_document,
)
from services.runtime.stt_runtime.schemas.project_patch import (
    PROJECT_RECORD_COLLECTIONS,
    ProjectPatch,
)

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
UPDATED_AT = datetime(2026, 8, 8, 12, 0, tzinfo=UTC)


def test_patch_round_trips_every_collection_metadata_and_manifest_without_mutation() -> None:
    source = _aurora_document()
    target = _changed_complete_document(source)
    source_snapshot = source.model_dump(mode="json")
    target_snapshot = target.model_dump(mode="json")

    forward = derive_project_patch(source, target)
    inverse = invert_project_patch(forward, source=source, target=target)

    assert len(PROJECT_RECORD_COLLECTIONS) == 24
    assert len(forward.operations) == 26
    assert {getattr(operation, "collection", None) for operation in forward.operations} >= set(
        PROJECT_RECORD_COLLECTIONS
    )
    applied = apply_project_patch(source, forward)
    restored = apply_project_patch(applied, inverse)
    assert applied.model_dump(mode="json") == target_snapshot
    assert restored.model_dump(mode="json") == source_snapshot
    assert source.model_dump(mode="json") == source_snapshot
    assert target.model_dump(mode="json") == target_snapshot


def test_diff_is_deterministic_and_represents_noop_without_operations() -> None:
    source = _aurora_document()
    target = _changed_complete_document(source)

    first = derive_project_patch(source, target)
    second = derive_project_patch(source, target)
    noop = derive_project_patch(source, source)

    assert first.model_dump(mode="json") == second.model_dump(mode="json")
    assert first.patch_id.startswith("project-patch-")
    assert noop.operations == []
    assert noop.source_checksum == noop.target_checksum == source.checksum


def test_patch_rejects_invalid_identity_order_and_missing_records() -> None:
    source = _aurora_document()
    target_checksum = "f" * 64 if source.checksum != "f" * 64 else "e" * 64
    node = source.nodes[0].model_dump(mode="json")

    with pytest.raises(ValidationError, match="record_id does not match"):
        ProjectPatch.model_validate(
            _patch_payload(
                source,
                target_checksum,
                [{"op": "put_record", "collection": "nodes", "record_id": "wrong", "record": node}],
            )
        )
    with pytest.raises(ValidationError, match="deterministic ordering"):
        ProjectPatch.model_validate(
            _patch_payload(
                source,
                target_checksum,
                [
                    {"op": "remove_record", "collection": "edges", "record_id": "z-edge"},
                    {"op": "remove_record", "collection": "nodes", "record_id": "z-node"},
                ],
            )
        )

    missing = ProjectPatch.model_validate(
        _patch_payload(
            source,
            target_checksum,
            [{"op": "remove_record", "collection": "nodes", "record_id": "missing"}],
        )
    )
    with pytest.raises(ProjectPatchError, match="cannot remove missing"):
        apply_project_patch(source, missing)


def test_patch_rejects_broken_dependencies_and_checksum_mismatches_atomically() -> None:
    source = _aurora_document()
    source_snapshot = source.model_dump(mode="json")
    referenced_node_id = source.edges[0].source_node_id
    target_checksum = "f" * 64 if source.checksum != "f" * 64 else "e" * 64
    broken = ProjectPatch.model_validate(
        _patch_payload(
            source,
            target_checksum,
            [{"op": "remove_record", "collection": "nodes", "record_id": referenced_node_id}],
        )
    )

    with pytest.raises(ProjectPatchError, match="invalid document"):
        apply_project_patch(source, broken)
    assert source.model_dump(mode="json") == source_snapshot

    target = _changed_complete_document(source)
    valid = derive_project_patch(source, target)
    wrong_source = valid.model_copy(update={"source_checksum": target.checksum})
    with pytest.raises(ProjectPatchError, match="source checksum"):
        apply_project_patch(source, wrong_source)
    wrong_target = valid.model_copy(update={"target_checksum": target.checksum[::-1]})
    with pytest.raises(ProjectPatchError, match="target checksum"):
        apply_project_patch(source, wrong_target)
    assert source.model_dump(mode="json") == source_snapshot


def test_patch_allows_authoring_settings_but_rejects_storage_and_identity_changes() -> None:
    source = _aurora_document()
    authoring_payload = source.model_dump(mode="python", exclude={"checksum"})
    authoring_payload["manifest"]["settings"]["ui_locale"] = "ru"
    authoring = create_project_document(**authoring_payload)
    assert apply_project_patch(source, derive_project_patch(source, authoring)) == authoring

    storage_payload = source.model_dump(mode="python", exclude={"checksum"})
    storage_payload["manifest"]["settings"]["storage"] = {
        "mode": "postgresql",
        "connection_profile_id": "test-postgres",
    }
    storage = create_project_document(**storage_payload)
    with pytest.raises(ProjectPatchError, match="storage settings"):
        derive_project_patch(source, storage)

    identity_payload = source.model_dump(mode="python", exclude={"checksum"})
    identity_payload["manifest"]["project_id"] = "another-project"
    for collection in PROJECT_RECORD_COLLECTIONS:
        for record in identity_payload.get(collection, []):
            if "project_id" in record:
                record["project_id"] = "another-project"
    identity = create_project_document(**identity_payload)
    with pytest.raises(ProjectPatchError, match="project identity"):
        derive_project_patch(source, identity)


def _aurora_document() -> ProjectDocument:
    # The production fixture is the cross-domain contract source for Phase 3.12;
    # conversion stays in memory and does not create a project or database.
    return _fixture_document(load_project_fixture(FIXTURE))


def _changed_complete_document(source: ProjectDocument) -> ProjectDocument:
    payload = source.model_dump(mode="python", exclude={"checksum"})
    manifest = payload["manifest"]
    manifest["name"] = "Project Aurora Revised"
    manifest["description"] = "Reversible patch acceptance document."
    manifest["updated_at"] = UPDATED_AT
    manifest["settings"]["ui_locale"] = "ru"
    manifest["settings"]["autosave"]["interval_seconds"] = 600
    payload["project_metadata"] = {**payload["project_metadata"], "history_test": True}

    for collection in PROJECT_RECORD_COLLECTIONS:
        records = payload.setdefault(collection, [])
        if collection == "suggestions":
            records.append(
                {
                    "id": "suggestion-history-test",
                    "project_id": manifest["project_id"],
                    "title": "Review reversible patch",
                    "description": "Contract-only test record.",
                    "status": "pending",
                    "patch": {},
                    "created_by": "local-user",
                    "metadata": {},
                    "created_at": UPDATED_AT,
                    "updated_at": UPDATED_AT,
                }
            )
        elif collection == "engine_tags":
            records.append(
                {
                    "id": "engine-tag-history-test",
                    "project_id": manifest["project_id"],
                    "target_type": "node",
                    "target_id": payload["nodes"][0]["id"],
                    "engine": "history-test",
                    "key": "reversible",
                    "value": "true",
                    "metadata": {},
                    "created_at": UPDATED_AT,
                    "updated_at": UPDATED_AT,
                }
            )
        elif collection == "engine_tag_definitions":
            records.append(
                {
                    "tag_version": 1,
                    "id": "definition-history-test",
                    "project_id": manifest["project_id"],
                    "key": "History.Reversible",
                    "normalized_key": "history.reversible",
                    "description": "Patch coverage definition.",
                    "status": "active",
                    "aliases": [],
                    "created_at": UPDATED_AT.isoformat(),
                    "updated_at": UPDATED_AT.isoformat(),
                }
            )
        elif collection == "engine_tag_bindings":
            records.append(
                {
                    "tag_version": 1,
                    "id": "binding-history-test",
                    "project_id": manifest["project_id"],
                    "definition_id": "definition-history-test",
                    "owner": {
                        "kind": "node",
                        "project_id": manifest["project_id"],
                        "node_id": payload["nodes"][0]["id"],
                    },
                    "value": "true",
                    "created_at": UPDATED_AT.isoformat(),
                    "updated_at": UPDATED_AT.isoformat(),
                }
            )
        elif collection == "legacy_engine_tags":
            records.append(
                {
                    "id": "legacy-history-test",
                    "project_id": manifest["project_id"],
                    "created_at": UPDATED_AT.isoformat(),
                    "updated_at": UPDATED_AT.isoformat(),
                    "target_type": "node",
                    "target_id": payload["nodes"][0]["id"],
                    "engine": "legacy-test",
                    "key": "reversible",
                    "value": "true",
                    "metadata": {},
                }
            )
        elif collection == "dialogues":
            records[0]["document"]["elements"][0]["text"] += " Reversible."
        elif collection == "quests":
            records[0]["document"]["objective"] += " and return safely"
        elif collection == "agent_memories":
            records.append(
                {
                    "memory_version": 1,
                    "id": "memory-history-test",
                    "project_id": manifest["project_id"],
                    "agent_id": "canon_checker",
                    "namespace": "canon_checker",
                    "scope": {"scope_version": 1, "kind": "project"},
                    "content_locale": "en",
                    "title": "Preserve reversible history",
                    "instruction": "Keep accepted memory inside authoring history.",
                    "rationale": None,
                    "status": "active",
                    "supersedes_id": None,
                    "created_at": UPDATED_AT,
                    "updated_at": UPDATED_AT,
                }
            )
        else:
            records[0]["updated_at"] = UPDATED_AT
        key = "node_id" if collection in ("dialogues", "quests") else "id"
        records.sort(key=lambda record: record[key])
    return create_project_document(**payload)


def _patch_payload(
    source: ProjectDocument,
    target_checksum: str,
    operations: list[dict[str, object]],
) -> dict[str, object]:
    return {
        "patch_version": 1,
        "patch_id": "project-patch-test",
        "project_id": source.manifest.project_id,
        "source_checksum": source.checksum,
        "target_checksum": target_checksum,
        "operations": deepcopy(operations),
    }
