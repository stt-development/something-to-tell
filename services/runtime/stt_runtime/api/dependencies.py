from collections.abc import Generator

from fastapi import Header, HTTPException, Request, status

from ..db.session import SessionLocal
from ..playback.traversal_service import PlaybackSessionService
from ..canon.coordinator import CanonRunCoordinator
from ..impact.coordinator import ImpactRunCoordinator
from ..impact.resolution_coordinator import ImpactResolutionCoordinator
from ..style_system.rewrite_coordinator import StyleRewriteCoordinator
from ..agent_memory.candidate_coordinator import AgentMemoryCandidateCoordinator
from ..project_history.service import ProjectHistoryError
from ..project_session.service import ProjectSessionError
from ..repositories.interfaces import UnitOfWork
from ..repositories.sqlite import SqlAlchemyUnitOfWork
from ..repositories.project_scope import ProjectScopeError

PROJECT_SESSION_HEADER = "X-Project-Session-Id"
PROJECT_HISTORY_REVISION_HEADER = "X-Project-History-Revision"
AUTHORING_METHODS = {"DELETE", "PATCH", "POST", "PUT"}

# Route names are stable internal command owners. Narrative-specific mutations
# remain outside this Phase 3.12 core inventory until P3.12-004.
CORE_HISTORY_COMMANDS: dict[str, tuple[str, str]] = {
    "create_node_resource": ("create_node", "history.command.createNode"),
    "update_node_resource": ("update_node", "history.command.updateNode"),
    "delete_node_resource": ("delete_node", "history.command.deleteNode"),
    "create_edge_resource": ("create_edge", "history.command.createEdge"),
    "update_edge_resource": ("update_edge", "history.command.updateEdge"),
    "delete_edge_resource": ("delete_edge", "history.command.deleteEdge"),
    "delete_composition_entity": ("delete_composition_entity", "history.command.deleteNode"),
    "create_composition_frame": ("create_composition_frame", "history.command.createFrame"),
    "create_visual_placement": ("create_placement", "history.command.createPlacement"),
    "update_visual_placement": ("update_placement", "history.command.updatePlacement"),
    "update_visual_placements": ("update_placements", "history.command.updatePlacements"),
    "remove_visual_placement": ("remove_placement", "history.command.removePlacement"),
    "add_faction_member": ("add_faction_member", "history.command.addFactionMember"),
    "remove_faction_member": ("remove_faction_member", "history.command.removeFactionMember"),
    "create_issue_resource": ("create_issue", "history.command.createIssue"),
    "update_issue_resource": ("update_issue", "history.command.updateIssue"),
    "delete_issue_resource": ("delete_issue", "history.command.deleteIssue"),
    "create_engine_tag_resource": ("create_engine_tag", "history.command.createEngineTag"),
    "update_engine_tag_resource": ("update_engine_tag", "history.command.updateEngineTag"),
    "delete_engine_tag_resource": ("delete_engine_tag", "history.command.deleteEngineTag"),
}

# Aggregate editors commit complete user drafts through one endpoint. Keeping
# this inventory next to core commands makes every runtime-owned boundary
# auditable without coupling route modules to the history implementation.
NARRATIVE_HISTORY_COMMANDS: dict[str, tuple[str, str]] = {
    "create_style_profile": ("create_style_profile", "history.command.createStyleProfile"),
    "update_style_profile": ("update_style_profile", "history.command.updateStyleProfile"),
    "upsert_scene_style_assignment": (
        "update_scene_style",
        "history.command.updateSceneStyle",
    ),
    "clear_scene_style_assignment": (
        "update_scene_style",
        "history.command.updateSceneStyle",
    ),
    "change_canon_issue_status": (
        "update_canon_issue_status",
        "history.command.updateCanonIssueStatus",
    ),
    "create_story_flow": ("create_story_flow", "history.command.createStoryFlow"),
    "bootstrap_story_flow": ("bootstrap_story_flow", "history.command.bootstrapStoryFlow"),
    "update_story_flow": ("update_story_flow", "history.command.updateStoryFlow"),
    "archive_story_flow": ("archive_story_flow", "history.command.archiveStoryFlow"),
    "delete_story_flow": ("delete_story_flow", "history.command.deleteStoryFlow"),
    "add_story_flow_membership": ("add_story_flow_membership", "history.command.addFlowMember"),
    "set_story_flow_entry": ("set_story_flow_entry", "history.command.setFlowEntry"),
    "remove_story_flow_membership": ("remove_story_flow_membership", "history.command.removeFlowMember"),
    "create_flow_transition": ("create_flow_transition", "history.command.createFlowTransition"),
    "update_flow_transition": ("update_flow_transition", "history.command.updateFlowTransition"),
    "delete_flow_transition": ("delete_flow_transition", "history.command.deleteFlowTransition"),
    "reorder_flow_transitions": ("reorder_flow_transitions", "history.command.reorderFlowTransitions"),
    "upsert_scene_flow_boundary": ("upsert_scene_flow_boundary", "history.command.updateSceneBoundary"),
    "delete_scene_flow_boundary": ("delete_scene_flow_boundary", "history.command.deleteSceneBoundary"),
    "continue_with_existing": ("continue_with_existing", "history.command.continueStoryFlow"),
    "continue_with_new": ("continue_with_new", "history.command.continueStoryFlow"),
    "create_invocation": ("create_flow_invocation", "history.command.createFlowInvocation"),
    "update_invocation": ("update_flow_invocation", "history.command.updateFlowInvocation"),
    "delete_invocation": ("delete_flow_invocation", "history.command.deleteFlowInvocation"),
    "create_outcome_side_flow": ("create_outcome_side_flow", "history.command.createOutcomeSideFlow"),
    "create_exit": ("create_flow_exit", "history.command.createFlowExit"),
    "update_exit": ("update_flow_exit", "history.command.updateFlowExit"),
    "delete_exit": ("delete_flow_exit", "history.command.deleteFlowExit"),
    "create_flow_exit_binding": ("create_flow_exit_binding", "history.command.createFlowExitBinding"),
    "update_flow_exit_binding": ("update_flow_exit_binding", "history.command.updateFlowExitBinding"),
    "delete_flow_exit_binding": ("delete_flow_exit_binding", "history.command.deleteFlowExitBinding"),
    "update_dialogue_document": ("update_dialogue", "history.command.updateDialogue"),
    "create_dialogue_transition": ("create_dialogue_transition", "history.command.createDialogueTransition"),
    "update_dialogue_transition": ("update_dialogue_transition", "history.command.updateDialogueTransition"),
    "update_quest_document": ("update_quest", "history.command.updateQuest"),
    "create_quest_transition": ("create_quest_transition", "history.command.createQuestTransition"),
    "update_quest_transition": ("update_quest_transition", "history.command.updateQuestTransition"),
    "upsert_initial_state": ("upsert_initial_state", "history.command.updateInitialState"),
    "delete_initial_state": ("delete_initial_state", "history.command.deleteInitialState"),
    "create_effect": ("create_effect", "history.command.createEffect"),
    "update_effect": ("update_effect", "history.command.updateEffect"),
    "delete_effect": ("delete_effect", "history.command.deleteEffect"),
    "create_effect_binding": ("create_effect_binding", "history.command.createEffectBinding"),
    "update_effect_binding": ("update_effect_binding", "history.command.updateEffectBinding"),
    "delete_effect_binding": ("delete_effect_binding", "history.command.deleteEffectBinding"),
    "reorder_bindings": ("reorder_effect_bindings", "history.command.reorderEffectBindings"),
    "apply_relationship_import": ("apply_relationship_import", "history.command.importRelationshipState"),
    "analyze_scene": ("analyze_scene", "history.command.analyzeScene"),
    "create_suggestion_resource": ("create_suggestion", "history.command.createAnalysisSuggestion"),
    "update_suggestion_resource": ("update_suggestion", "history.command.updateAnalysisSuggestion"),
    "delete_suggestion_resource": ("delete_suggestion", "history.command.deleteAnalysisSuggestion"),
    "approve_suggestion_resource": ("approve_suggestion", "history.command.acceptAnalysisSuggestion"),
    "reject_suggestion_resource": ("reject_suggestion", "history.command.rejectAnalysisSuggestion"),
    "approve_suggestion_operation_resource": (
        "approve_suggestion_operation",
        "history.command.acceptAnalysisSuggestion",
    ),
    "reject_suggestion_operation_resource": (
        "reject_suggestion_operation",
        "history.command.rejectAnalysisSuggestion",
    ),
    "accept_progression_migration": ("accept_progression_migration", "history.command.acceptProgressionMigration"),
    "reject_progression_migration": ("reject_progression_migration", "history.command.rejectProgressionMigration"),
}

AUTHORING_HISTORY_COMMANDS = {**CORE_HISTORY_COMMANDS, **NARRATIVE_HISTORY_COMMANDS}

# These routes use the project-session service because they coordinate changes
# that span a patch, audit record, or portable manifest checkpoint.
DIRECT_HISTORY_COMMANDS: dict[str, tuple[str, str]] = {
    "apply_engine_tag_registry_command": (
        "engine_tag_command",
        "history.command.engineTag",
    ),
    "apply_agent_memory_command": (
        "agent_memory_command",
        "history.command.agentMemory",
    ),
    "accept_agent_memory_candidate": (
        "accept_agent_memory_candidate",
        "history.command.acceptAgentMemory",
    ),
    "delete_style_profile": (
        "delete_style_profile",
        "history.command.deleteStyleProfile",
    ),
    "approve_style_rewrite_recommendation": (
        "approve_style_rewrite",
        "history.command.approveStyleRewrite",
    ),
    "approve_impact_resolution_alternative": (
        "approve_impact_resolution",
        "history.command.approveImpactResolution",
    ),
    "approve_canon_fix_suggestion": (
        "approve_canon_fix",
        "history.command.approveCanonFix",
    ),
    "reject_canon_fix_suggestion": (
        "reject_canon_fix",
        "history.command.rejectCanonFix",
    ),
    "update_project_settings": (
        "update_project_settings",
        "history.command.updateProjectSettings",
    ),
}

# Every mutating route outside authoring history must declare its ownership.
# The global inventory test compares this list with FastAPI's live route table.
HISTORY_EXCLUDED_MUTATIONS: dict[str, str] = {
    "create_export_plan": "read-only process-local export preview lifecycle",
    "write_export_artifact": "external artifact installation without project mutation",
    "preview_engine_tag_registry": "read-only checksum-bound engine compatibility projection",
    "resolve_agent_memory": "read-only checksum-bound memory disclosure projection",
    "start_agent_memory_candidate_run": "read-only process-local memory candidate lifecycle",
    "cancel_agent_memory_candidate_run": "process-local memory candidate lifecycle",
    "retry_agent_memory_candidate_run": "read-only immutable memory candidate retry",
    "reject_agent_memory_candidate_run": "process-local reviewed rejection without persistence",
    "resolve_effective_style": "read-only effective Style context projection",
    "start_style_rewrite_run": "read-only process-local Style recommendation lifecycle",
    "cancel_style_rewrite_run": "process-local Style recommendation lifecycle",
    "retry_style_rewrite_run": "read-only immutable Style recommendation retry",
    "start_impact_run": "read-only process-local impact lifecycle",
    "cancel_impact_run": "process-local impact lifecycle",
    "build_impact_resolution_context": "read-only bounded provider context projection",
    "start_impact_resolution_run": "read-only process-local provider explanation lifecycle",
    "cancel_impact_resolution_run": "process-local provider explanation lifecycle",
    "edit_impact_resolution_alternative": "process-local draft validation without authoring mutation",
    "reject_impact_resolution_alternative": "durable non-authoring decision fingerprint",
    "start_canon_run": "process-local canon lifecycle with explicit reconciliation history",
    "cancel_canon_run": "process-local canon lifecycle",
    "request_canon_issue_suggestion": "read-only checksum-bound fixer preview",
    "start_canon_issue_impact_analysis": "read-only Canon-to-Impact bridge",
    "prepare_playback": "read-only playback definition preparation",
    "start_playback": "process-local playback lifecycle",
    "choose_playback_transition": "process-local playback traversal",
    "back_playback": "process-local playback history",
    "restart_playback": "process-local playback lifecycle",
    "reconnect_remote_storage": "explicit remote receipt resolution, reload and lease reacquisition",
    "begin_remote_reconnect": "tracked explicit reconnect lifecycle, not an authoring command",
    "abandon_remote_reconnect": "cancel tracked local lifecycle candidate, no Save or Discard",
    "release_remote_storage": "explicit local lifecycle release, no document capture, authoring command or Saved checkpoint",
    "close_playback": "process-local playback lifecycle",
    "create_project_session": "project lifecycle",
    "open_project_session": "project lifecycle",
    "undo_project_history": "authoring history control",
    "redo_project_history": "authoring history control",
    "save_project_session": "save checkpoint lifecycle",
    "save_project_session_as": "project lifecycle barrier",
    "discard_project_session": "project lifecycle barrier",
    "close_project_session": "project lifecycle barrier",
    "exit_project_session": "project lifecycle barrier",
    "create_storage_profile": "machine-local credential administration",
    "create_canon_provider_profile": "machine-local encrypted credential administration",
    "update_canon_provider_profile": "machine-local encrypted credential administration",
    "delete_canon_provider_profile": "machine-local encrypted credential administration",
    "test_storage_profile": "read-only connection validation",
    "inspect_storage_profile": "read-only schema/profile capability inspection without opening a project",
    "available_storage_profiles": "read-only canonical-folder encrypted profile summaries without Open or SQL",
    "create_folder_storage_profile": "explicit encrypted profile configuration in a validated folder, no SQL or authoring history",
    "prepare_storage_schema_plan": "read-only SQL observation and process-local schema review plan",
    "attest_storage_schema_backup": "fresh read-only SQL observation and process-local operator acknowledgement",
    "execute_storage_schema_plan": "explicit schema administration; reviewed single-use plan and schema transaction, not project authoring",
    "migrate_storage": "storage lifecycle barrier",
    "create_project_resource": "legacy process database compatibility API",
    "update_project_resource": "legacy process database compatibility API",
    "delete_project_resource": "legacy process database compatibility API",
    "create_folder": "unopened project-folder lifecycle",
    "validate_folder": "read-only folder validation",
    "get_owner_impact": "read-only deletion impact preview",
    "preview_relationship_import": "read-only state import preview",
}


def get_uow(
    request: Request,
    project_session_id: str | None = Header(default=None, alias=PROJECT_SESSION_HEADER),
    project_history_revision: int | None = Header(
        default=None,
        alias=PROJECT_HISTORY_REVISION_HEADER,
        ge=0,
    ),
) -> Generator[UnitOfWork, None, None]:
    """Route repositories to the active project database when a session is supplied."""

    if project_session_id is None:
        with SqlAlchemyUnitOfWork(SessionLocal) as uow:
            yield uow
        return
    registry = request.app.state.project_sessions
    try:
        if request.scope["route"].name in {"create_project_resource", "update_project_resource", "delete_project_resource"}:
            # Legacy root lifecycle belongs only to the process database. Open
            # projects use session settings/close APIs, never root CRUD bypasses.
            raise ProjectScopeError()
        command = AUTHORING_HISTORY_COMMANDS.get(request.scope["route"].name)
        if request.method in AUTHORING_METHODS and command is not None:
            with registry.authoring_unit_of_work(
                project_session_id,
                command_kind=command[0],
                label_key=command[1],
                expected_history_revision=project_history_revision,
            ) as uow:
                yield uow
        else:
            with registry.unit_of_work(
                project_session_id,
                mark_dirty=False,
            ) as uow:
                yield uow
    except ProjectHistoryError as error:
        conflict_codes = {
            "history_revision_stale",
            "history_document_stale",
            "history_command_duplicate",
        }
        raise HTTPException(
            status_code=(
                status.HTTP_409_CONFLICT
                if error.code in conflict_codes
                else status.HTTP_400_BAD_REQUEST
            ),
            detail={
                "code": error.code,
                "message_key": f"history.error.{error.code}",
                "parameters": error.parameters,
            },
        ) from error
    except ProjectSessionError as error:
        raise HTTPException(
            status_code=(status.HTTP_503_SERVICE_UNAVAILABLE if error.code in {
                "remote_storage_unavailable", "remote_storage_timeout"
            } else status.HTTP_409_CONFLICT if error.code.startswith("remote_")
            else status.HTTP_404_NOT_FOUND),
            detail={
                "code": error.code,
                "message_key": f"project_session.{error.code}",
                "parameters": error.parameters,
            },
        ) from error
def get_playback_sessions(request: Request) -> PlaybackSessionService:
    """Return the process-local session service owned by this FastAPI app."""

    return request.app.state.playback_sessions


def get_canon_runs(request: Request) -> CanonRunCoordinator:
    """Return process-local canon operational state owned by this app instance."""

    return request.app.state.canon_runs


def get_impact_runs(request: Request) -> ImpactRunCoordinator:
    """Return process-local prospective analysis owned by this app instance."""

    return request.app.state.impact_runs


def get_impact_resolution_runs(request: Request) -> ImpactResolutionCoordinator:
    """Return optional process-local Impact explanation state."""

    return request.app.state.impact_resolution_runs


def get_style_rewrite_runs(request: Request) -> StyleRewriteCoordinator:
    """Return process-local Style Rewriter operation state."""

    return request.app.state.style_rewrite_runs


def get_agent_memory_candidate_runs(request: Request) -> AgentMemoryCandidateCoordinator:
    """Return process-local Agent Memory candidate state owned by this app."""

    return request.app.state.agent_memory_candidate_runs
