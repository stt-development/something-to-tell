from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
import sqlite3

from alembic import command
from alembic.config import Config
import pytest
from pydantic import TypeAdapter
from sqlalchemy import create_engine, inspect

from services.runtime.stt_runtime.domain.entities import (
    FlowInitialStateEntity,
    NarrativeEffectBindingEntity,
    NarrativeEffectEntity,
    NodeEntity,
    StoryFlowEntity,
    StoryFlowNodeEntity,
)
from services.runtime.stt_runtime.narrative_state.compatibility import (
    adapt_v1_inventory_effect,
)
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_format.interchange import (
    export_project_interchange,
    import_project_interchange,
)
from services.runtime.stt_runtime.project_fixture import (
    import_project_fixture,
    load_project_fixture,
    write_project_fixture,
)
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.playback import PlaybackTypedEffect
from services.runtime.stt_runtime.schemas.project_document import (
    ProjectFlowInitialStateRecord,
    ProjectNarrativeEffectBindingRecord,
    ProjectNarrativeEffectRecord,
    create_project_document,
)
from services.runtime.stt_runtime.schemas.project_interchange import ProjectInterchangeDocument

NOW = datetime(2026, 8, 7, 12, 0, tzinfo=UTC)
STATE_TABLES = {
    "flow_initial_states",
    "narrative_effects",
    "narrative_effect_bindings",
}
PLAYBACK_EFFECT_ADAPTER = TypeAdapter(PlaybackTypedEffect)


def _seed_state_records(uow, project_id: str) -> None:
    """Create one complete explicit custody transfer without semantic inference."""

    uow.nodes.add(
        NodeEntity(
            id="character-mara",
            project_id=project_id,
            type="Character",
            title="Mara",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.nodes.add(
        NodeEntity(
            id="item-ledger",
            project_id=project_id,
            type="Item",
            title="Ledger",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.story_flows.add(
        StoryFlowEntity(
            id="flow-main",
            project_id=project_id,
            name="Main Story",
            normalized_name="main story",
            status="active",
            entry_node_id="character-mara",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.story_flow_nodes.add(
        StoryFlowNodeEntity(
            id="member-mara",
            project_id=project_id,
            flow_id="flow-main",
            node_id="character-mara",
            presentation_order=0,
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.flow_initial_states.add(
        FlowInitialStateEntity(
            id="state-main",
            project_id=project_id,
            flow_id="flow-main",
            flags={"ledger_known": False},
            item_custody=[{
                "custody_version": 1,
                "item_node_id": "item-ledger",
                "holder": {"holder_version": 1, "kind": "unowned"},
            }],
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.narrative_effects.add(
        NarrativeEffectEntity(
            id="effect-take-ledger",
            project_id=project_id,
            operation="transfer_item",
            payload={
                "item_node_id": "item-ledger",
                "from_holder": {"holder_version": 1, "kind": "unowned"},
                "to_holder": {
                    "holder_version": 1,
                    "kind": "character",
                    "node_id": "character-mara",
                },
            },
            explanation="Mara takes the ledger.",
            created_at=NOW,
            updated_at=NOW,
        )
    )
    uow.narrative_effect_bindings.add(
        NarrativeEffectBindingEntity(
            id="binding-take-ledger",
            project_id=project_id,
            effect_id="effect-take-ledger",
            owner_kind="node_entry",
            owner_id="character-mara",
            application_order=0,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def test_state_survives_save_restart_discard_and_independent_save_as(tmp_path: Path) -> None:
    source_path = tmp_path / "StateSource.narrative"
    registry = ProjectSessionRegistry()
    opened = registry.create(source_path, "State Source")
    with registry.unit_of_work(opened.session.session_id, mark_dirty=True) as uow:
        _seed_state_records(uow, opened.session.project_id)
        uow.commit()
    saved = registry.save(
        opened.session.session_id,
        expected_revision=opened.session.saved_revision,
        reason="manual",
    )
    saved_payload = saved.document.model_dump(mode="json")
    registry.close(opened.session.session_id)

    restarted = ProjectSessionRegistry()
    reopened = restarted.open(source_path)
    assert reopened.document.model_dump(mode="json") == saved_payload
    with restarted.unit_of_work(reopened.session.session_id, mark_dirty=True) as uow:
        effect = uow.narrative_effects.get("effect-take-ledger")
        assert effect is not None
        uow.narrative_effects.update(replace(effect, explanation="Unsaved change."))
        uow.commit()
    discarded = restarted.discard(reopened.session.session_id)
    assert discarded.document.narrative_effects[0].explanation == "Mara takes the ledger."

    copy_path = tmp_path / "StateCopy.narrative"
    copied = restarted.save_as(
        reopened.session.session_id,
        destination=copy_path,
        expected_revision=discarded.session.saved_revision,
        identity="regenerate",
        replace_existing=False,
    )
    restarted.close(reopened.session.session_id)
    copied_session = restarted.open(copy_path)
    try:
        assert copied.project_id != opened.session.project_id
        assert {item.project_id for item in copied_session.document.flow_initial_states} == {
            copied.project_id
        }
        assert {item.project_id for item in copied_session.document.narrative_effects} == {
            copied.project_id
        }
        assert [item.id for item in copied_session.document.narrative_effect_bindings] == [
            "binding-take-ledger"
        ]
    finally:
        restarted.close(copied_session.session.session_id)


def test_state_interchange_round_trip_and_legacy_omission_stay_explicit(tmp_path: Path) -> None:
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "Interchange.narrative", "Interchange")
    project_id = opened.session.project_id
    with registry.unit_of_work(opened.session.session_id) as uow:
        _seed_state_records(uow, project_id)
        uow.commit()
        exported = export_project_interchange(uow, project_id)
        for repository in (
            uow.narrative_effect_bindings,
            uow.narrative_effects,
            uow.flow_initial_states,
            uow.story_flow_nodes,
            uow.story_flows,
        ):
            for record in repository.list(project_id=project_id):
                repository.delete(record.id)
        uow.commit()
        assert import_project_interchange(uow, exported) == 1
        restored = export_project_interchange(uow, project_id)

    assert restored.model_dump(mode="json") == exported.model_dump(mode="json")
    assert restored.narrative_state is not None
    assert restored.narrative_state.section_version == 1
    assert [item.id for item in restored.narrative_state.effects] == ["effect-take-ledger"]
    with registry.unit_of_work(opened.session.session_id) as uow:
        before = len(uow.flow_initial_states.list(project_id=project_id))
        assert import_project_interchange(
            uow, ProjectInterchangeDocument(project_id=project_id)
        ) == 0
        assert len(uow.flow_initial_states.list(project_id=project_id)) == before
    registry.close(opened.session.session_id)


def test_complete_document_reconcile_rolls_back_all_state_records(tmp_path: Path) -> None:
    registry = ProjectSessionRegistry()
    opened = registry.create(tmp_path / "Rollback.narrative", "Rollback")
    with registry.unit_of_work(opened.session.session_id) as uow:
        _seed_state_records(uow, opened.session.project_id)
        uow.commit()
    original = registry.inspect(opened.session.session_id).document
    payload = original.model_dump(mode="python", exclude={"checksum"})
    payload["narrative_effects"] = [
        original.narrative_effects[0].model_copy(update={"explanation": "Must roll back."})
    ]
    changed = create_project_document(**payload)

    with registry.unit_of_work(opened.session.session_id) as uow:
        def fail_commit() -> None:
            raise RuntimeError("injected state commit failure")

        uow.commit = fail_commit  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="injected state commit failure"):
            ProjectDocumentService().reconcile(uow, changed)

    after = registry.inspect(opened.session.session_id).document
    registry.close(opened.session.session_id)
    assert after.model_dump(mode="json") == original.model_dump(mode="json")


def test_migration_creates_empty_state_tables_without_inference(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.sqlite"
    config = Config("services/runtime/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path}")
    command.upgrade(config, "20260803_0004")
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            """
            INSERT INTO projects
                (id, name, path, format_version, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("legacy", "Legacy", "/tmp/Legacy.narrative", 2, "{}", NOW.isoformat(), NOW.isoformat()),
        )
        connection.commit()

    command.upgrade(config, "20260807_0005")
    engine = create_engine(f"sqlite:///{database_path}")
    assert STATE_TABLES.issubset(inspect(engine).get_table_names())
    with sqlite3.connect(database_path) as connection:
        for table in STATE_TABLES:
            assert connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)

    command.downgrade(config, "20260803_0004")
    assert STATE_TABLES.isdisjoint(inspect(engine).get_table_names())
    with sqlite3.connect(database_path) as connection:
        assert connection.execute("SELECT name FROM projects WHERE id = 'legacy'").fetchone() == (
            "Legacy",
        )
    engine.dispose()


def test_fixture_import_can_replace_production_aurora_explicit_state(
    tmp_path: Path,
) -> None:
    source_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    source = load_project_fixture(source_path)
    state = ProjectFlowInitialStateRecord(
        id="state-fixture-main",
        project_id=source.manifest.project_id,
        flow_id="flow-main-story",
        item_custody=[{
            "item_node_id": "node-sealed-ledger",
            "holder": {
                "kind": "character",
                "node_id": "node-hero",
            },
        }],
        created_at=NOW,
        updated_at=NOW,
    )
    effect = ProjectNarrativeEffectRecord(
        id="effect-fixture-ledger",
        project_id=source.manifest.project_id,
        operation="transfer_item",
        payload={
            "item_node_id": "node-sealed-ledger",
            "from_holder": {
                "holder_version": 1,
                "kind": "character",
                "node_id": "node-hero",
            },
            "to_holder": {"holder_version": 1, "kind": "player"},
        },
        repeat_policy="once",
        explanation="Mara hands over the ledger.",
        created_at=NOW,
        updated_at=NOW,
    )
    binding = ProjectNarrativeEffectBindingRecord(
        id="binding-fixture-ledger",
        project_id=source.manifest.project_id,
        effect_id=effect.id,
        owner_kind="node_entry",
        owner_id="node-hero",
        application_order=0,
        created_at=NOW,
        updated_at=NOW,
    )
    fixture = source.model_copy(update={
        "flow_initial_states": [state],
        "narrative_effects": [effect],
        "narrative_effect_bindings": [binding],
        "expected_validation": source.expected_validation.model_copy(update={
            "flow_initial_state_count": 1,
            "narrative_effect_count": 1,
            "narrative_effect_binding_count": 1,
        }),
    })
    generated = tmp_path / "state-aurora.v1.json"
    write_project_fixture(generated, fixture)

    imported = import_project_fixture(generated, tmp_path / "StateAurora.narrative")

    assert imported.document.flow_initial_states == [state]
    assert imported.document.narrative_effects == [effect]
    assert imported.document.narrative_effect_bindings == [binding]
    production = load_project_fixture(source_path)
    assert len(production.flow_initial_states) == 2
    assert len(production.narrative_effects) == 4
    assert len(production.narrative_effect_bindings) == 4


@pytest.mark.parametrize(
    ("operation", "source", "destination"),
    [
        ("add_inventory", "unowned", "player"),
        ("remove_inventory", "player", "unowned"),
    ],
)
def test_v1_inventory_adapter_preserves_id_owner_and_behavior(
    operation: str,
    source: str,
    destination: str,
) -> None:
    effect = PLAYBACK_EFFECT_ADAPTER.validate_python({
        "effect_version": 1,
        "id": f"legacy-{operation}",
        "project_id": "project-legacy",
        "flow_id": "flow-main",
        "owner_transition_id": "transition-ledger",
        "review_status": "accepted",
        "repeatable": True,
        "explanation": "Legacy inventory behavior.",
        "operation": operation,
        "payload": {"node_id": "item-ledger"},
    })

    adapted = adapt_v1_inventory_effect(effect)  # type: ignore[arg-type]

    assert adapted.definition.id == effect.id
    assert adapted.binding.id == effect.id
    assert adapted.binding.owner.owner_kind == "flow_transition"
    assert adapted.binding.owner.owner_id == "transition-ledger"
    assert adapted.definition.repeat_policy == "per_visit"
    assert adapted.definition.payload.from_holder.kind == source  # type: ignore[union-attr]
    assert adapted.definition.payload.to_holder.kind == destination  # type: ignore[union-attr]
