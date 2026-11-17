from dataclasses import replace
from datetime import UTC, datetime

import pytest

from services.runtime.stt_runtime.schemas.project_document import (
    ProjectNodeRecord,
    ProjectPlacementRecord,
)
from services.runtime.stt_runtime.schemas.style_resolution import StyleContextRefV1
from services.runtime.stt_runtime.schemas.style_system import (
    SceneStyleAssignmentV1,
    StyleProfileV1,
)
from services.runtime.stt_runtime.style_system.resolver import (
    EffectiveStyleResolver,
    StyleResolutionError,
    StyleResolutionSnapshot,
)

NOW = datetime(2026, 9, 6, 12, 0, tzinfo=UTC)
PROJECT_ID = "project-style-resolution"


def _node(node_id: str, kind: str, title: str | None = None) -> ProjectNodeRecord:
    return ProjectNodeRecord(
        id=node_id,
        project_id=PROJECT_ID,
        type=kind,
        title=title or node_id,
        status="canon",
        created_at=NOW,
        updated_at=NOW,
    )


def _placement(
    placement_id: str,
    node_id: str,
    container_id: str | None,
) -> ProjectPlacementRecord:
    return ProjectPlacementRecord(
        id=placement_id,
        project_id=PROJECT_ID,
        canonical_node_id=node_id,
        scope_key=container_id or "root",
        x=0,
        y=0,
        width=240,
        height=140,
        container_node_id=container_id,
        is_primary=container_id is None,
        presentation_state="expanded",
        created_at=NOW,
        updated_at=NOW,
    )


def _profile(profile_id: str, name: str | None = None) -> StyleProfileV1:
    return StyleProfileV1(
        id=profile_id,
        project_id=PROJECT_ID,
        name=name or profile_id,
        guidance="Use precise, restrained prose.",
        created_at=NOW,
        updated_at=NOW,
    )


def _assignment(scene_id: str, profile_id: str) -> SceneStyleAssignmentV1:
    return SceneStyleAssignmentV1(
        id=f"assignment-{scene_id}",
        project_id=PROJECT_ID,
        scene_node_id=scene_id,
        style_profile_id=profile_id,
        created_at=NOW,
        updated_at=NOW,
    )


def _snapshot(
    *,
    nodes: tuple[ProjectNodeRecord, ...],
    placements: tuple[ProjectPlacementRecord, ...] = (),
    profiles: tuple[StyleProfileV1, ...] = (),
    assignments: tuple[SceneStyleAssignmentV1, ...] = (),
    default_profile_id: str | None = None,
) -> StyleResolutionSnapshot:
    return StyleResolutionSnapshot(
        project_id=PROJECT_ID,
        default_style_profile_id=default_profile_id,
        nodes=nodes,
        placements=placements,
        profiles=profiles,
        scene_assignments=assignments,
    )


def test_resolves_project_default_without_scene_context() -> None:
    snapshot = _snapshot(
        nodes=(_node("event-root", "Event"),),
        profiles=(_profile("style-project", "Project voice"),),
        default_profile_id="style-project",
    )

    resolved = EffectiveStyleResolver().resolve(snapshot, target_node_id="event-root")

    assert resolved.status == "resolved"
    assert resolved.source == "project_default"
    assert resolved.scene_context is None
    assert resolved.profile is not None
    assert resolved.profile.name == "Project voice"


def test_scene_override_has_priority_over_project_default() -> None:
    snapshot = _snapshot(
        nodes=(
            _node("scene-docks", "Scene", "Docks"),
            _node("event-arrival", "Event"),
        ),
        placements=(_placement("event-in-docks", "event-arrival", "scene-docks"),),
        profiles=(_profile("style-project"), _profile("style-docks")),
        assignments=(_assignment("scene-docks", "style-docks"),),
        default_profile_id="style-project",
    )

    resolved = EffectiveStyleResolver().resolve(snapshot, target_node_id="event-arrival")

    assert resolved.source == "scene_override"
    assert resolved.style_profile_id == "style-docks"
    assert resolved.scene_context is not None
    assert resolved.scene_context.scene_node_id == "scene-docks"


def test_nested_locations_resolve_their_containing_scene() -> None:
    snapshot = _snapshot(
        nodes=(
            _node("scene-citadel", "Scene", "Citadel"),
            _node("location-yard", "Location"),
            _node("location-vault", "Location"),
            _node("item-key", "Item"),
        ),
        placements=(
            _placement("yard-in-scene", "location-yard", "scene-citadel"),
            _placement("vault-in-yard", "location-vault", "location-yard"),
            _placement("key-in-vault", "item-key", "location-vault"),
        ),
        profiles=(_profile("style-citadel"),),
        assignments=(_assignment("scene-citadel", "style-citadel"),),
    )

    resolved = EffectiveStyleResolver().resolve(snapshot, target_node_id="item-key")

    assert resolved.status == "resolved"
    assert resolved.style_profile_id == "style-citadel"
    assert resolved.scene_context is not None
    assert resolved.scene_context.scene_node_id == "scene-citadel"


def test_shared_node_requires_context_and_exact_placement_proves_selection() -> None:
    snapshot = _snapshot(
        nodes=(
            _node("scene-alpha", "Scene", "Alpha"),
            _node("scene-beta", "Scene", "Beta"),
            _node("character-shared", "Character"),
        ),
        placements=(
            _placement("shared-beta", "character-shared", "scene-beta"),
            _placement("shared-alpha", "character-shared", "scene-alpha"),
        ),
        profiles=(_profile("style-alpha"), _profile("style-beta")),
        assignments=(
            _assignment("scene-alpha", "style-alpha"),
            _assignment("scene-beta", "style-beta"),
        ),
    )

    ambiguous = EffectiveStyleResolver().resolve(
        snapshot, target_node_id="character-shared"
    )
    selected = EffectiveStyleResolver().resolve(
        snapshot,
        target_node_id="character-shared",
        context=StyleContextRefV1(
            scene_node_id="scene-beta",
            placement_id="shared-beta",
        ),
    )

    assert ambiguous.status == "context_required"
    assert [item.scene_node_id for item in ambiguous.candidate_contexts] == [
        "scene-alpha",
        "scene-beta",
    ]
    assert selected.style_profile_id == "style-beta"


def test_no_authored_style_is_explicitly_unconfigured() -> None:
    snapshot = _snapshot(nodes=(_node("event-root", "Event"),))

    resolved = EffectiveStyleResolver().resolve(snapshot, target_node_id="event-root")

    assert resolved.status == "unconfigured"
    assert resolved.source == "unconfigured"
    assert resolved.style_profile_id is None


def test_missing_scene_override_stays_visible_without_default_fallback() -> None:
    snapshot = _snapshot(
        nodes=(_node("scene-a", "Scene"), _node("event-a", "Event")),
        placements=(_placement("event-a-placement", "event-a", "scene-a"),),
        profiles=(_profile("style-project"),),
        assignments=(_assignment("scene-a", "style-deleted"),),
        default_profile_id="style-project",
    )

    resolved = EffectiveStyleResolver().resolve(snapshot, target_node_id="event-a")

    assert resolved.status == "unavailable"
    assert resolved.source == "scene_override"
    assert resolved.style_profile_id == "style-deleted"
    assert resolved.unavailable_reason == "style_profile_missing"
    assert resolved.profile is None


def test_candidate_order_is_stable_and_unreachable_context_is_rejected() -> None:
    base = _snapshot(
        nodes=(
            _node("scene-z", "Scene", "Same"),
            _node("scene-a", "Scene", "same"),
            _node("item-shared", "Item"),
        ),
        placements=(
            _placement("item-z", "item-shared", "scene-z"),
            _placement("item-a", "item-shared", "scene-a"),
        ),
    )
    reordered = replace(
        base,
        nodes=tuple(reversed(base.nodes)),
        placements=tuple(reversed(base.placements)),
    )

    first = EffectiveStyleResolver().resolve(base, target_node_id="item-shared")
    second = EffectiveStyleResolver().resolve(reordered, target_node_id="item-shared")

    assert first == second
    assert [item.scene_node_id for item in first.candidate_contexts] == [
        "scene-a",
        "scene-z",
    ]
    with pytest.raises(StyleResolutionError, match="style_context_unreachable"):
        EffectiveStyleResolver().resolve(
            base,
            target_node_id="item-shared",
            context=StyleContextRefV1(
                scene_node_id="scene-z",
                placement_id="item-a",
            ),
        )
