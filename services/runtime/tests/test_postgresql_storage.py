import json
import os
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from time import sleep
import sys

from services.runtime.tests.remote_support import GuardedTestClient as TestClient
import pytest
from sqlalchemy import create_engine, make_url, text
from sqlalchemy.orm import sessionmaker

from services.runtime.stt_runtime.app import create_app
from services.runtime.stt_runtime.canon.engine import (
    CanonRuleEngine,
    initial_canon_rule_pack,
)
from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.domain.entities import AgentMemoryEntity, ProjectEntity
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.scripts.build_export_examples import render_example
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_format.manifest import PROJECT_SETTINGS_VERSION
from services.runtime.stt_runtime.project_document.service import ProjectDocumentService
from services.runtime.stt_runtime.project_session.service import (
    PROJECT_DOCUMENT_CHECKPOINT_FILE,
    ProjectSessionError,
    ProjectSessionRegistry,
)
from services.runtime.stt_runtime.project_session.database import upgrade_external_database
from services.runtime.stt_runtime.repositories.sqlite import SqlAlchemyUnitOfWork
from services.runtime.stt_runtime.schemas.impact_resolution import (
    ImpactResolutionDecision,
)
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.project_document import ProjectDocument
from services.runtime.stt_runtime.storage_profiles import (
    PostgreSqlProfile,
    StorageProfileRegistry,
)
from services.runtime.scripts.benchmark_storage import disposable_database

POSTGRES_URL = os.getenv("STT_TEST_POSTGRES_URL")
pytestmark = pytest.mark.skipif(
    not POSTGRES_URL,
    reason="STT_TEST_POSTGRES_URL is required for Docker-backed PostgreSQL tests",
)


@pytest.fixture(autouse=True)
def clean_postgresql_schema(monkeypatch):
    """Never reset the configured schema: each case owns a generated database."""

    if not POSTGRES_URL:
        yield
        return
    with disposable_database() as isolated:
        url = isolated.render_as_string(hide_password=False)
        monkeypatch.setenv("STT_TEST_POSTGRES_URL", url)
        monkeypatch.setattr(sys.modules[__name__], "POSTGRES_URL", url)
        yield


def test_postgresql_profile_migration_restart_and_return_to_local(
    tmp_path: Path,
) -> None:
    profile_file = _profile_file(tmp_path)
    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    project_path = tmp_path / "PostgresAurora.narrative"
    imported = import_project_fixture(fixture_path, project_path)
    # Production Aurora is the storage-neutral P3.11 acceptance story; the
    # migration must preserve its real specialized owners without test seeding.
    expected_invocations = [item.id for item in imported.document.flow_invocations]
    expected_exits = [item.id for item in imported.document.flow_exits]
    expected_bindings = [item.id for item in imported.document.flow_exit_bindings]
    expected_initial_states = [item.id for item in imported.document.flow_initial_states]
    expected_effects = [item.id for item in imported.document.narrative_effects]
    expected_effect_bindings = [
        item.id for item in imported.document.narrative_effect_bindings
    ]
    expected_effect_owners = [
        (item.owner_kind, item.owner_id, item.context_node_id)
        for item in imported.document.narrative_effect_bindings
    ]
    expected_style_profiles = [item.id for item in imported.document.style_profiles]
    expected_style_assignments = [
        item.id for item in imported.document.scene_style_assignments
    ]
    expected_agent_memories = [
        item.id for item in imported.document.agent_memories
    ]
    expected_engine_tag_definitions = [
        item.id for item in imported.document.engine_tag_definitions
    ]
    expected_engine_tag_bindings = [
        item.id for item in imported.document.engine_tag_bindings
    ]
    expected_engine_tag_aliases = {
        item.id: [alias.model_dump(mode="json") for alias in item.aliases]
        for item in imported.document.engine_tag_definitions
    }
    expected_agent_providers = (
        imported.document.manifest.settings.agent_providers.model_dump(mode="json")
    )
    assert len(expected_initial_states) == 2
    assert len(expected_effects) == 4
    assert len(expected_effect_bindings) == 4
    # Aurora may gain additional portable showcase profiles; the assertions
    # below still require every exact profile ID to survive both migrations.
    assert len(expected_style_profiles) >= 2
    assert len(expected_style_assignments) == 1
    assert len(expected_agent_memories) == 10
    assert len(expected_engine_tag_definitions) == 9
    assert len(expected_engine_tag_bindings) == 9
    settings = RuntimeSettings(storage_profiles_file=profile_file)

    with TestClient(create_app(settings)) as client:
        profile_test = client.post(
            "/api/storage-profiles/test",
            json={"profile_id": "docker-postgres"},
        )
        assert profile_test.status_code == 200
        assert profile_test.json()["schema_status"] == "empty"
        assert profile_test.json()["permissions_valid"] is True
        assert "stt_test_password" not in profile_test.text

        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        ).json()
        export_options = ExportOptionsV1(
            format="json",
            scope="whole_project",
            story_flow_ids=[],
            engine_tag_target="generic",
        )
        local_export = ExportProjectionService().build(
            ProjectDocument.model_validate(opened["document"]),
            export_options,
        )
        session_id = opened["session"]["session_id"]
        headers = {"X-Project-Session-Id": session_id}
        history_node = opened["document"]["nodes"][0]
        history_update = {
            key: value
            for key, value in history_node.items()
            if key not in {"id", "created_at", "updated_at"}
        }
        history_update["summary"] = "Temporary pre-migration edit."
        assert client.put(
            f"/api/nodes/{history_node['id']}",
            headers=headers,
            json=history_update,
        ).status_code == 200
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": history["history_revision"]},
        ).status_code == 200
        assert client.get(f"/api/project-sessions/{session_id}/history").json()["redo_depth"] == 1
        migrated = client.post(
            "/api/storage-migrations",
            json={
                "session_id": session_id,
                "expected_revision": opened["session"]["saved_revision"],
                "target_mode": "postgresql",
                "target_profile_id": "docker-postgres",
            },
        )
        assert migrated.status_code == 200, migrated.json()
        migrated_payload = migrated.json()
        assert migrated_payload["source_mode"] == "local_sqlite"
        assert migrated_payload["target_mode"] == "postgresql"
        assert migrated_payload["project"]["session"]["storage_mode"] == "postgresql"
        assert client.get(f"/api/project-sessions/{session_id}/history").json()["redo_depth"] == 0
        assert migrated_payload["record_count"] > 20
        assert migrated_payload["verified_checksum"] != imported.document.checksum
        postgresql_export = ExportProjectionService().build(
            ProjectDocument.model_validate(migrated_payload["project"]["document"]),
            export_options,
        )
        # Storage mode is intentionally excluded. Normalize only the checksum,
        # which covers the internal manifest storage setting by design.
        local_payload = local_export.model_dump(mode="json")
        postgresql_payload = postgresql_export.model_dump(mode="json")
        local_payload["projection"]["manifest"]["source"]["source_checksum"] = "storage-neutral"
        postgresql_payload["projection"]["manifest"]["source"]["source_checksum"] = "storage-neutral"
        local_payload["projection"]["engine_tags"]["source_checksum"] = "storage-neutral"
        postgresql_payload["projection"]["engine_tags"]["source_checksum"] = "storage-neutral"
        assert postgresql_payload == local_payload
        assert [
            item["id"] for item in migrated_payload["project"]["document"]["flow_invocations"]
        ] == expected_invocations
        assert [
            item["id"] for item in migrated_payload["project"]["document"]["flow_exits"]
        ] == expected_exits
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["flow_exit_bindings"]
        ] == expected_bindings
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["flow_initial_states"]
        ] == expected_initial_states
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["narrative_effects"]
        ] == expected_effects
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["narrative_effect_bindings"]
        ] == expected_effect_bindings
        assert [
            (item["owner_kind"], item["owner_id"], item["context_node_id"])
            for item in migrated_payload["project"]["document"]["narrative_effect_bindings"]
        ] == expected_effect_owners
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["style_profiles"]
        ] == expected_style_profiles
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["scene_style_assignments"]
        ] == expected_style_assignments
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["style_profiles"]
        ] == expected_style_profiles
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"][
                "scene_style_assignments"
            ]
        ] == expected_style_assignments
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["agent_memories"]
        ] == expected_agent_memories
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["engine_tag_definitions"]
        ] == expected_engine_tag_definitions
        assert [
            item["id"]
            for item in migrated_payload["project"]["document"]["engine_tag_bindings"]
        ] == expected_engine_tag_bindings
        assert {
            item["id"]: item["aliases"]
            for item in migrated_payload["project"]["document"]["engine_tag_definitions"]
        } == expected_engine_tag_aliases
        assert "stt_test_password" not in migrated.text

        node = migrated_payload["project"]["document"]["nodes"][0]
        postgres_base_checksum = migrated_payload["project"]["document"]["checksum"]
        update = {
            key: value
            for key, value in node.items()
            if key not in {"id", "created_at", "updated_at"}
        }
        update["summary"] = "Persisted in PostgreSQL."
        assert client.put(
            f"/api/nodes/{node['id']}",
            headers={"X-Project-Session-Id": session_id},
            json=update,
        ).status_code == 200
        history = client.get(f"/api/project-sessions/{session_id}/history").json()
        assert history["undo_depth"] == 1
        undone = client.post(
            f"/api/project-sessions/{session_id}/history/undo",
            json={"expected_history_revision": history["history_revision"]},
        ).json()
        assert undone["project"]["document"]["checksum"] == postgres_base_checksum
        redone = client.post(
            f"/api/project-sessions/{session_id}/history/redo",
            json={
                "expected_history_revision": undone["history"]["history_revision"]
            },
        ).json()
        assert redone["project"]["document"]["nodes"][0]["summary"] == "Persisted in PostgreSQL."
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        saved = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={
                "expected_revision": inspected["session"]["saved_revision"],
                "reason": "manual",
            },
        ).json()
        saved_checksum = saved["document"]["checksum"]
        checkpoint_document = (
            project_path
            / "snapshots"
            / f"revision-{saved['session']['saved_revision']:08d}"
            / PROJECT_DOCUMENT_CHECKPOINT_FILE
        )
        assert checkpoint_document.is_file()
        checkpoint_text = checkpoint_document.read_text(encoding="utf-8")
        assert "stt_test_password" not in checkpoint_text
        assert "history_revision" not in checkpoint_text
        assert "undo_depth" not in checkpoint_text
        assert client.get(f"/api/project-sessions/{session_id}/history").json()["undo_depth"] == 1
        assert client.post(
            f"/api/project-sessions/{session_id}/close"
        ).status_code == 200

    with TestClient(create_app(settings)) as restarted:
        reopened = restarted.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        )
        assert reopened.status_code == 200
        assert reopened.json()["document"]["checksum"] == saved_checksum
        assert [
            item["id"] for item in reopened.json()["document"]["style_profiles"]
        ] == expected_style_profiles
        assert [
            item["id"]
            for item in reopened.json()["document"]["scene_style_assignments"]
        ] == expected_style_assignments
        assert [
            item["id"] for item in reopened.json()["document"]["agent_memories"]
        ] == expected_agent_memories
        assert [
            item["id"] for item in reopened.json()["document"]["engine_tag_definitions"]
        ] == expected_engine_tag_definitions
        assert [
            item["id"] for item in reopened.json()["document"]["engine_tag_bindings"]
        ] == expected_engine_tag_bindings
        session_id = reopened.json()["session"]["session_id"]
        assert restarted.get(
            f"/api/project-sessions/{session_id}/history"
        ).json()["history_revision"] == 0
        canon_input = restarted.app.state.project_sessions.capture_canon_input(
            session_id
        )
        assert canon_input.source_checksum == saved_checksum
        assert canon_input.saved_revision == reopened.json()["session"]["saved_revision"]
        assert {fact.domain for fact in canon_input.facts} == {
            "graph",
            "composition",
            "flow",
            "dialogue",
            "quest",
            "temporal",
            "playback",
        }
        canon_candidates = CanonRuleEngine().evaluate(canon_input)
        assert canon_candidates
        assert canon_candidates == CanonRuleEngine().evaluate(canon_input)
        reconciled = restarted.app.state.project_sessions.reconcile_canon_issues(
            session_id,
            canon_input,
            canon_candidates,
            checked_rule_ids=tuple(
                rule.descriptor.id for rule in initial_canon_rule_pack().rules
            ),
            observed_at=datetime(2026, 8, 20, 14, 0, tzinfo=UTC),
            expected_history_revision=0,
        )
        assert len(reconciled.opened_ids) == len(canon_candidates)
        with_generated = restarted.app.state.project_sessions.inspect(session_id)
        assert len(with_generated.document.issues) > len(canon_input.document.issues)
        undone = restarted.app.state.project_sessions.undo_history(
            session_id,
            expected_history_revision=1,
        )
        assert undone.project.document.checksum == saved_checksum
        assert undone.project.session.save_status == "clean"
        returned = restarted.post(
            "/api/storage-migrations",
            json={
                "session_id": session_id,
                "expected_revision": reopened.json()["session"]["saved_revision"],
                "target_mode": "local_sqlite",
                "target_profile_id": None,
            },
        )
        assert returned.status_code == 200
        assert returned.json()["project"]["session"]["storage_mode"] == "local_sqlite"
        returned_document = returned.json()["project"]["document"]
        assert [item["id"] for item in returned_document["flow_initial_states"]] == expected_initial_states
        assert [item["id"] for item in returned_document["narrative_effects"]] == expected_effects
        assert [item["id"] for item in returned_document["narrative_effect_bindings"]] == expected_effect_bindings
        assert [item["id"] for item in returned_document["style_profiles"]] == expected_style_profiles
        assert [
            item["id"] for item in returned_document["scene_style_assignments"]
        ] == expected_style_assignments
        assert [item["id"] for item in returned_document["agent_memories"]] == (
            expected_agent_memories
        )
        assert [item["id"] for item in returned_document["engine_tag_definitions"]] == (
            expected_engine_tag_definitions
        )
        assert [item["id"] for item in returned_document["engine_tag_bindings"]] == (
            expected_engine_tag_bindings
        )
        assert {
            item["id"]: item["aliases"]
            for item in returned_document["engine_tag_definitions"]
        } == expected_engine_tag_aliases
        assert [
            (item["owner_kind"], item["owner_id"], item["context_node_id"])
            for item in returned_document["narrative_effect_bindings"]
        ] == expected_effect_owners
        assert [item["id"] for item in returned_document["style_profiles"]] == (
            expected_style_profiles
        )
        assert [
            item["id"] for item in returned_document["scene_style_assignments"]
        ] == expected_style_assignments
        assert restarted.post(
            f"/api/project-sessions/{session_id}/close"
        ).status_code == 200

    manifest = json.loads(
        (project_path / "project.config.json").read_text(encoding="utf-8")
    )
    assert manifest["settings"]["storage"] == {
        "mode": "local_sqlite",
        "connection_profile_id": None,
    }
    assert manifest["settings_version"] == PROJECT_SETTINGS_VERSION
    assert manifest["settings"]["canon_check"] == {
        "canon_check_version": 1,
        "deterministic_enabled": True,
        "enabled_rules": {},
        "severity_overrides": {},
        "agent_mode": "disabled",
        "content_policy": "never",
        "model_preference": None,
        "provider_profile_id": None,
    }
    assert manifest["settings"]["agent_providers"] == expected_agent_providers
    assert manifest["settings"]["impact_resolver"] == {
        "impact_resolver_version": 1,
        "agent_mode": "disabled",
        "content_policy": "never",
    }
    assert "stt_test_password" not in json.dumps(manifest)


def test_failed_postgresql_copy_preserves_local_authority(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    project_path = tmp_path / "RollbackAurora.narrative"
    imported = import_project_fixture(fixture_path, project_path)
    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile()]))
    opened = registry.open(project_path)
    original_reconcile = ProjectDocumentService.reconcile

    def fail_target_copy(self, uow, document):
        if document.manifest.settings.storage.mode == "postgresql":
            raise RuntimeError("injected target copy failure")
        return original_reconcile(self, uow, document)

    monkeypatch.setattr(ProjectDocumentService, "reconcile", fail_target_copy)

    with pytest.raises(ProjectSessionError, match="storage_migration_failed"):
        registry.migrate_storage(
            opened.session.session_id,
            expected_revision=opened.session.saved_revision,
            target_mode="postgresql",
            target_profile_id="docker-postgres",
        )

    inspected = registry.inspect(opened.session.session_id)
    manifest = json.loads(
        (project_path / "project.config.json").read_text(encoding="utf-8")
    )
    assert inspected.session.storage_mode == "local_sqlite"
    assert inspected.document.checksum == imported.document.checksum
    assert manifest["settings"]["storage"]["mode"] == "local_sqlite"
    registry.close(opened.session.session_id)


def test_project_encrypted_profile_drives_postgresql_migration(
    tmp_path: Path,
) -> None:
    fixture_path = Path(__file__).parents[3] / "fixtures/projects/citadel-branch.v1.json"
    project_path = tmp_path / "EncryptedProfile.narrative"
    import_project_fixture(fixture_path, project_path)
    source = _profile()
    profiles = StorageProfileRegistry(
        master_key_file=tmp_path / "machine" / "storage.key"
    )
    summary = profiles.add(
        project_path,
        label=source.label,
        host=source.host,
        port=source.port,
        database=source.database,
        username=source.username,
        password=source.password,
        tls_policy=source.tls_policy,
    )
    invalidated_projects: list[str] = []
    registry = ProjectSessionRegistry(
        profiles,
        on_authoring_committed=invalidated_projects.append,
    )
    opened = registry.open(project_path)

    migrated = registry.migrate_storage(
        opened.session.session_id,
        expected_revision=opened.session.saved_revision,
        target_mode="postgresql",
        target_profile_id=summary.profile_id,
    )

    assert migrated.project.session.storage_mode == "postgresql"
    assert invalidated_projects == [opened.session.project_id]
    assert b"stt_test_password" not in (
        project_path / "storage-profiles.enc"
    ).read_bytes()
    registry.close(opened.session.session_id)


def test_canon_reconciliation_matches_after_postgresql_migration(
    tmp_path: Path,
) -> None:
    """Canon fingerprints and reviewed lifecycle survive a storage backend change."""

    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    project_path = tmp_path / "CanonParity.narrative"
    import_project_fixture(fixture_path, project_path)
    settings = RuntimeSettings(storage_profiles_file=_profile_file(tmp_path))

    with TestClient(create_app(settings)) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        ).json()
        session_id = opened["session"]["session_id"]
        project_id = opened["session"]["project_id"]
        first_run = client.post(
            "/api/canon-checks/runs",
            json={
                "session_id": session_id,
                "observed_saved_revision": opened["session"]["saved_revision"],
                "expected_history_revision": 0,
                "mode": "deterministic",
            },
        )
        assert first_run.status_code == 201
        local_issues = client.get(
            f"/api/canon-checks/projects/{project_id}/issues"
        ).json()["issues"]
        reviewed_id = local_issues[0]["id"]
        reviewed = client.post(
            f"/api/canon-checks/issues/{reviewed_id}/status",
            json={
                "session_id": session_id,
                "expected_history_revision": 1,
                "status": "review",
            },
        )
        assert reviewed.status_code == 200
        local_issues = client.get(
            f"/api/canon-checks/projects/{project_id}/issues"
        ).json()["issues"]
        local_signature = _canon_issue_signature(local_issues)
        inspected = client.get(f"/api/project-sessions/{session_id}").json()
        _assert_repair_checksums(local_issues, inspected["document"]["checksum"])
        saved = client.post(
            f"/api/project-sessions/{session_id}/save",
            json={
                "expected_revision": inspected["session"]["saved_revision"],
                "reason": "manual",
            },
        ).json()
        migrated = client.post(
            "/api/storage-migrations",
            json={
                "session_id": session_id,
                "expected_revision": saved["session"]["saved_revision"],
                "target_mode": "postgresql",
                "target_profile_id": "docker-postgres",
            },
        )
        assert migrated.status_code == 200, migrated.json()
        postgres_project = migrated.json()["project"]
        rerun = client.post(
            "/api/canon-checks/runs",
            json={
                "session_id": session_id,
                "observed_saved_revision": postgres_project["session"]["saved_revision"],
                "expected_history_revision": 0,
                "mode": "deterministic",
            },
        )
        assert rerun.status_code == 201
        postgres_issues = client.get(
            f"/api/canon-checks/projects/{project_id}/issues"
        ).json()["issues"]
        postgres_snapshot = client.get(f"/api/project-sessions/{session_id}").json()

        assert _canon_issue_signature(postgres_issues) == local_signature
        _assert_repair_checksums(
            postgres_issues,
            postgres_snapshot["document"]["checksum"],
        )
        assert next(item for item in postgres_issues if item["id"] == reviewed_id)["status"] == "review"


def _canon_issue_signature(issues: list[dict]) -> list[tuple[object, ...]]:
    """Compare durable fact identity and dynamic repair policy across storage."""

    return sorted(
        (
            item["metadata"]["fingerprint"],
            item["metadata"]["rule_id"],
            json.dumps(item["metadata"].get("diagnostic"), sort_keys=True),
            item["status"],
            item["repair"]["kind"],
            item["repair"]["action"],
            item["repair"]["available"],
            item["repair"].get("unavailable_reason"),
        )
        for item in issues
    )


def _assert_repair_checksums(issues: list[dict], checksum: str) -> None:
    """Capabilities must be recalculated against the currently loaded snapshot."""

    assert {item["repair"]["source_checksum"] for item in issues} == {checksum}


def test_impact_analysis_matches_after_postgresql_migration(tmp_path: Path) -> None:
    """Impact traversal remains storage-neutral across the live API boundary."""

    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    project_path = tmp_path / "ImpactParity.narrative"
    import_project_fixture(fixture_path, project_path)
    settings = RuntimeSettings(storage_profiles_file=_profile_file(tmp_path))

    with TestClient(create_app(settings)) as client:
        opened = client.post(
            "/api/project-sessions/open",
            json={"path": str(project_path)},
        ).json()
        session_id = opened["session"]["session_id"]
        local = _impact_run(client, session_id, opened)

        migrated = client.post(
            "/api/storage-migrations",
            json={
                "session_id": session_id,
                "expected_revision": opened["session"]["saved_revision"],
                "target_mode": "postgresql",
                "target_profile_id": "docker-postgres",
            },
        )
        assert migrated.status_code == 200, migrated.json()
        postgres_project = migrated.json()["project"]
        postgres = _impact_run(client, session_id, postgres_project)

        # Storage migration changes project settings, so each run must retain
        # its own authoritative snapshot rather than reuse the old checksum.
        assert local["source_checksum"] == opened["document"]["checksum"]
        assert postgres["source_checksum"] == postgres_project["document"]["checksum"]
        assert postgres["status"] == "completed"
        assert postgres["findings"] == local["findings"]
        assert postgres["summary"] == local["summary"]
        assert postgres["diagnostics"] == local["diagnostics"]


def test_impact_resolution_settings_and_decisions_match_after_migration(
    tmp_path: Path,
) -> None:
    """Provider selection and review memory remain project-owned in PostgreSQL."""

    fixture_path = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
    project_path = tmp_path / "ImpactResolutionParity.narrative"
    import_project_fixture(fixture_path, project_path)
    config_path = project_path / "project.config.json"
    manifest = json.loads(config_path.read_text(encoding="utf-8"))
    manifest["settings"]["agent_providers"] = {
        "agent_providers_version": 1,
        "default_provider_profile_id": "shared-provider",
        "agents": {
            "canon_checker": {
                "provider_source": "project_default",
                "provider_profile_override_id": None,
                "model_id": "canon-model",
            },
            "impact_resolver": {
                "provider_source": "override",
                "provider_profile_override_id": "impact-provider",
                "model_id": "impact-model",
            },
        },
    }
    manifest["settings"]["impact_resolver"] = {
        "impact_resolver_version": 1,
        "agent_mode": "configured",
        "content_policy": "bounded_evidence",
    }
    config_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    registry = ProjectSessionRegistry(StorageProfileRegistry([_profile()]))
    opened = registry.open(project_path)
    decision = ImpactResolutionDecision(
        finding_fingerprints=("1" * 64,),
        proposal_semantic_fingerprint="2" * 64,
        source_checksum=opened.document.checksum,
        decision="rejected",
        decided_at=datetime(2026, 9, 2, 10, 0, tzinfo=UTC),
    )
    registry.review_impact_resolution(
        opened.session.session_id,
        patch=None,
        decision=decision,
        expected_history_revision=0,
    )
    local_settings = registry.inspect(opened.session.session_id).document.manifest.settings
    local_decisions = registry.list_impact_resolution_decisions(opened.session.session_id)

    migrated = registry.migrate_storage(
        opened.session.session_id,
        expected_revision=opened.session.saved_revision,
        target_mode="postgresql",
        target_profile_id="docker-postgres",
    )
    postgres_settings = migrated.project.document.manifest.settings
    postgres_decisions = registry.list_impact_resolution_decisions(opened.session.session_id)

    assert postgres_settings.agent_providers == local_settings.agent_providers
    assert postgres_settings.impact_resolver == local_settings.impact_resolver
    assert postgres_decisions == local_decisions == (decision,)
    registry.close(opened.session.session_id)


def _impact_run(client: TestClient, session_id: str, project: dict) -> dict:
    history_revision = client.get(
        f"/api/project-sessions/{session_id}/history"
    ).json()["history_revision"]
    response = client.post(
        f"/api/project-sessions/{session_id}/impact-analysis/runs",
        json={
            "observed_saved_revision": project["session"]["saved_revision"],
            "expected_history_revision": history_revision,
            "source_checksum": project["document"]["checksum"],
            "scenario": {
                "type": "selection",
                "intent": "modify",
                "seeds": [
                    {"resource": {"owner_type": "node", "owner_id": "node-opening"}}
                ],
            },
            "direction": "downstream",
        },
    )
    assert response.status_code == 201, response.json()
    run_id = response.json()["run"]["id"]
    for _ in range(300):
        run = client.get(
            f"/api/project-sessions/{session_id}/impact-analysis/runs/{run_id}"
        ).json()["run"]
        if run["status"] in {"completed", "failed", "cancelled", "stale"}:
            return run
        sleep(0.01)
    raise AssertionError(f"impact run did not finish: {run_id}")


def test_agent_memory_repository_has_postgresql_crud_and_ordering_parity() -> None:
    assert POSTGRES_URL is not None
    database_url = make_url(POSTGRES_URL)
    upgrade_external_database(database_url)
    engine = create_engine(database_url)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    project_id = "project-postgres-memory"
    try:
        with SqlAlchemyUnitOfWork(factory) as uow:
            uow.projects.add(
                ProjectEntity(
                    id=project_id,
                    name="PostgreSQL memory",
                    path="/tmp/PostgresMemory.narrative",
                    format_version=2,
                )
            )
            later = AgentMemoryEntity(
                id="memory-z",
                project_id=project_id,
                agent_id="canon_checker",
                namespace="canon_checker",
                scope={"scope_version": 1, "kind": "project"},
                content_locale="en",
                title="Later",
                instruction="Keep the later reviewed instruction.",
                created_at=datetime(2026, 9, 12, 12, 1, tzinfo=UTC),
                updated_at=datetime(2026, 9, 12, 12, 1, tzinfo=UTC),
            )
            earlier = AgentMemoryEntity(
                id="memory-a",
                project_id=project_id,
                agent_id="impact_resolver",
                namespace="impact_resolver",
                scope={"scope_version": 1, "kind": "project"},
                content_locale="ru",
                title="Earlier",
                instruction="Keep the earlier reviewed instruction.",
                created_at=datetime(2026, 9, 12, 12, 0, tzinfo=UTC),
                updated_at=datetime(2026, 9, 12, 12, 0, tzinfo=UTC),
            )
            uow.agent_memories.add(later)
            uow.agent_memories.add(earlier)
            uow.commit()

        with SqlAlchemyUnitOfWork(factory) as uow:
            assert [
                memory.id for memory in uow.agent_memories.list(project_id=project_id)
            ] == ["memory-a", "memory-z"]
            uow.agent_memories.update(
                replace(
                    later,
                    status="archived",
                    updated_at=datetime(2026, 9, 12, 12, 2, tzinfo=UTC),
                )
            )
            uow.agent_memories.delete(earlier.id)
            uow.commit()
        with SqlAlchemyUnitOfWork(factory) as uow:
            records = uow.agent_memories.list(project_id=project_id)
            assert [(memory.id, memory.status) for memory in records] == [
                ("memory-z", "archived")
            ]
    finally:
        engine.dispose()


def test_unavailable_profile_returns_a_redacted_stable_error(tmp_path: Path) -> None:
    profile_file = tmp_path / "storage-profiles.json"
    profile_file.write_text(
        json.dumps(
            {
                "profiles": [
                    {
                        "profile_id": "offline",
                        "label": "Offline database",
                        "host": "127.0.0.1",
                        "port": 1,
                        "database": "missing",
                        "username": "writer",
                        "password": "top-secret-password",
                        "tls_policy": "disable",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    response = TestClient(
        create_app(RuntimeSettings(storage_profiles_file=profile_file))
    ).post("/api/storage-profiles/test", json={"profile_id": "offline"})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "storage_profile_unavailable"
    assert "top-secret-password" not in response.text


@pytest.mark.parametrize("fixture_name", ["project-aurora-export.v1.json", "citadel-branch.v1.json"])
def test_export_bytes_match_after_sqlite_and_postgresql_repository_round_trip(
    tmp_path: Path, fixture_name: str,
) -> None:
    """Equal portable documents must produce identical bytes, without checksum rewriting."""

    assert POSTGRES_URL is not None
    fixture_path = Path(__file__).parents[3] / "fixtures/projects" / fixture_name
    imported = import_project_fixture(fixture_path, tmp_path / "ExportParity.narrative")
    original = imported.document
    database_url = make_url(POSTGRES_URL)
    upgrade_external_database(database_url)
    engine = create_engine(database_url)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    service = ProjectDocumentService()
    try:
        with SqlAlchemyUnitOfWork(factory) as uow:
            uow.projects.add(ProjectEntity(
                id=original.manifest.project_id,
                name=original.manifest.name,
                path=str(imported.path),
                format_version=original.manifest.format_version,
            ))
            uow.commit()
        with SqlAlchemyUnitOfWork(factory) as uow:
            service.reconcile(uow, original)
        with SqlAlchemyUnitOfWork(factory) as uow:
            # The same portable manifest is deliberate: changing storage settings
            # changes source identity, which is not a serialization parity test.
            postgresql = service.load(uow, original.manifest)
        assert postgresql == original
        before = postgresql.model_dump(mode="json")
        scopes = ["whole_project", "story_flows"] if original.story_flows else ["whole_project"]
        formats = ["json", "yaml", "ink", "yarn_spinner"] if original.story_flows else ["json", "yaml"]
        for scope in scopes:
            for format in formats:
                options = ExportOptionsV1(
                    format=format, scope=scope,
                    story_flow_ids=["flow-main-story"] if scope == "story_flows" else [],
                    engine_tag_target=format if format in {"ink", "yarn_spinner"} else "generic",
                )
                assert render_example(original, options) == render_example(postgresql, options)
        with SqlAlchemyUnitOfWork(factory) as uow:
            assert service.load(uow, original.manifest).model_dump(mode="json") == before
    finally:
        engine.dispose()


def _profile_file(tmp_path: Path) -> Path:
    """Translate the test URL into the runtime-only structured profile file."""

    assert POSTGRES_URL is not None
    url = make_url(POSTGRES_URL)
    profile_file = tmp_path / "storage-profiles.json"
    profile_file.write_text(
        json.dumps(
            {
                "profiles": [
                    {
                        "profile_id": "docker-postgres",
                        "label": "Docker PostgreSQL",
                        "host": url.host,
                        "port": url.port or 5432,
                        "database": url.database,
                        "username": url.username,
                        "password": url.password,
                        "tls_policy": "disable",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    return profile_file


def _profile() -> PostgreSqlProfile:
    """Build the same secret profile directly for registry-level rollback tests."""

    assert POSTGRES_URL is not None
    url = make_url(POSTGRES_URL)
    return PostgreSqlProfile(
        profile_id="docker-postgres",
        label="Docker PostgreSQL",
        host=url.host or "127.0.0.1",
        port=url.port or 5432,
        database=url.database or "something_to_tell_test",
        username=url.username or "stt_test",
        password=url.password or "",
        tls_policy="disable",
    )
