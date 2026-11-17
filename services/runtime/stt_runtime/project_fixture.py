import json
import shutil
from dataclasses import dataclass
from pathlib import Path

from pydantic import ValidationError

from .project_document.service import ProjectDocumentService
from .project_format.service import (
    PROJECT_CONFIG_FILE,
    create_project_folder,
    write_project_manifest,
)
from .project_format.manifest import parse_project_manifest
from .project_session.service import ProjectSessionRegistry
from .schemas.project_document import ProjectDocument, create_project_document
from .schemas.project_fixture import ProjectFixtureEnvelope


class ProjectFixtureError(ValueError):
    """Rejects malformed fixtures before creating a destination project."""


@dataclass(frozen=True)
class ImportedProjectFixture:
    path: Path
    document: ProjectDocument


def load_project_fixture(path: Path) -> ProjectFixtureEnvelope:
    """Parse a versioned source fixture without creating durable artifacts."""

    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        # Fixtures are durable authoring assets and use the project manifest's
        # sequential migration boundary before the complete envelope validates.
        payload["manifest"] = parse_project_manifest(payload["manifest"]).model_dump(mode="json")
        fixture = ProjectFixtureEnvelope.model_validate(payload)
    except (OSError, json.JSONDecodeError, ValidationError) as error:
        raise ProjectFixtureError(f"Project fixture is invalid: {path}") from error
    _validate_expected_counts(fixture)
    # Building the canonical document applies ownership, references, ordering,
    # specialized-document, and checksum validation in one schema boundary.
    _fixture_document(fixture)
    return fixture


def write_project_fixture(path: Path, fixture: ProjectFixtureEnvelope) -> None:
    """Validate and atomically write a deterministic, reviewable fixture file."""

    _validate_expected_counts(fixture)
    _fixture_document(fixture)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    payload = fixture.model_dump(mode="json")
    try:
        temporary.write_text(
            json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(path)
    finally:
        # A failed write must not leave an artifact that looks importable.
        temporary.unlink(missing_ok=True)


def import_project_fixture(fixture_path: Path, destination: Path) -> ImportedProjectFixture:
    """Create a disposable .narrative project and transactionally import a fixture."""

    fixture = load_project_fixture(fixture_path)
    # Bootstrap with no default reference because the empty database does not
    # own fixture profiles until the first complete-document reconcile.
    bootstrap_settings = fixture.manifest.settings.model_copy(
        update={
            "style_system": fixture.manifest.settings.style_system.model_copy(
                update={"default_style_profile_id": None}
            )
        }
    )
    create_project_folder(
        destination,
        fixture.manifest.name,
        description=fixture.manifest.description,
        settings=bootstrap_settings,
    )
    bootstrap_manifest = fixture.manifest.model_copy(
        update={"settings": bootstrap_settings}
    )
    write_project_manifest(destination / PROJECT_CONFIG_FILE, bootstrap_manifest)

    # Opening once runs the same schema migrations and project-root creation as
    # the application before the storage-neutral document is reconciled.
    registry = ProjectSessionRegistry()
    opened = registry.open(destination)
    try:
        with registry.unit_of_work(opened.session.session_id) as uow:
            document = ProjectDocumentService().reconcile(uow, _fixture_document(fixture))
    finally:
        registry.close(opened.session.session_id)
    write_project_manifest(destination / PROJECT_CONFIG_FILE, fixture.manifest)

    # The first Open checkpointed the intentionally empty database before the
    # fixture reconcile. Rebuild that same saved revision from populated data
    # so Discard and crash recovery cannot erase imported aggregates.
    checkpoint = (
        destination
        / "snapshots"
        / f"revision-{fixture.manifest.saved_revision:08d}"
    )
    shutil.rmtree(checkpoint, ignore_errors=True)
    verified = registry.open(destination)
    try:
        document = verified.document
    finally:
        registry.close(verified.session.session_id)
    return ImportedProjectFixture(path=destination.resolve(), document=document)


def _fixture_document(fixture: ProjectFixtureEnvelope) -> ProjectDocument:
    return create_project_document(
        manifest=fixture.manifest,
        project_metadata=fixture.project_metadata,
        nodes=fixture.nodes,
        edges=fixture.edges,
        issues=fixture.issues,
        suggestions=fixture.suggestions,
        engine_tags=fixture.engine_tags,
        engine_tag_definitions=fixture.engine_tag_definitions,
        engine_tag_bindings=fixture.engine_tag_bindings,
        legacy_engine_tags=fixture.legacy_engine_tags,
        placements=fixture.placements,
        dialogues=fixture.dialogues,
        quests=fixture.quests,
        story_flows=fixture.story_flows,
        story_flow_nodes=fixture.story_flow_nodes,
        flow_transitions=fixture.flow_transitions,
        scene_flow_boundaries=fixture.scene_flow_boundaries,
        flow_invocations=fixture.flow_invocations,
        flow_exits=fixture.flow_exits,
        flow_exit_bindings=fixture.flow_exit_bindings,
        flow_initial_states=fixture.flow_initial_states,
        narrative_effects=fixture.narrative_effects,
        narrative_effect_bindings=fixture.narrative_effect_bindings,
        style_profiles=fixture.style_profiles,
        scene_style_assignments=fixture.scene_style_assignments,
        agent_memories=fixture.agent_memories,
    )


def _validate_expected_counts(fixture: ProjectFixtureEnvelope) -> None:
    expected = fixture.expected_validation
    actual = {
        "canonical_node_count": len(fixture.nodes),
        "edge_count": len(fixture.edges),
        "issue_count": len(fixture.issues),
        "placement_count": len(fixture.placements),
        "story_flow_count": len(fixture.story_flows),
        "dialogue_count": len(fixture.dialogues),
        "quest_count": len(fixture.quests),
        "flow_invocation_count": len(fixture.flow_invocations),
        "flow_exit_count": len(fixture.flow_exits),
        "flow_exit_binding_count": len(fixture.flow_exit_bindings),
        "flow_initial_state_count": len(fixture.flow_initial_states),
        "narrative_effect_count": len(fixture.narrative_effects),
        "narrative_effect_binding_count": len(fixture.narrative_effect_bindings),
        "style_profile_count": len(fixture.style_profiles),
        "scene_style_assignment_count": len(fixture.scene_style_assignments),
        "agent_memory_count": len(fixture.agent_memories),
        "engine_tag_definition_count": len(fixture.engine_tag_definitions),
        "engine_tag_binding_count": len(fixture.engine_tag_bindings),
        "legacy_engine_tag_count": len(fixture.legacy_engine_tags),
    }
    mismatches = {
        key: {"expected": getattr(expected, key), "actual": value}
        for key, value in actual.items()
        if getattr(expected, key) != value
    }
    if mismatches:
        raise ProjectFixtureError(f"Project fixture counts do not match: {mismatches}")
