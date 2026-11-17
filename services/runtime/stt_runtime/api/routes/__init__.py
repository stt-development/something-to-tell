from fastapi import APIRouter

from .analysis import router as analysis_router
from .agent_memory import engine_tag_router, router as agent_memory_router
from .canon_checks import router as canon_checks_router
from .canon_providers import router as canon_providers_router
from .compositions import router as compositions_router
from .composable_story_flows import router as composable_story_flows_router
from .dialogues import router as dialogues_router
from .dialogue_transitions import router as dialogue_transitions_router
from .edges import router as edges_router
from .engine_tags import router as engine_tags_router
from .exports import router as exports_router
from .health import router as health_router
from .impact_analysis import router as impact_analysis_router
from .issues import router as issues_router
from .memberships import router as memberships_router
from .narrative_state import router as narrative_state_router
from .nodes import router as nodes_router
from .playback import router as playback_router
from .projects import router as projects_router
from .project_sessions import router as project_sessions_router
from .progression_migrations import router as progression_migrations_router
from .quests import router as quests_router
from .quest_transitions import router as quest_transitions_router
from .suggestions import router as suggestions_router
from .story_flows import router as story_flows_router
from .storage import router as storage_router
from .style_resolution import router as style_resolution_router
from .style_rewrites import router as style_rewrites_router
from .styles import router as styles_router

runtime_routers: tuple[APIRouter, ...] = (
    health_router,
    agent_memory_router,
    engine_tag_router,
    playback_router,
    canon_checks_router,
    impact_analysis_router,
    canon_providers_router,
    project_sessions_router,
    storage_router,
    style_resolution_router,
    style_rewrites_router,
    styles_router,
    projects_router,
    progression_migrations_router,
    nodes_router,
    dialogues_router,
    dialogue_transitions_router,
    quests_router,
    quest_transitions_router,
    compositions_router,
    composable_story_flows_router,
    story_flows_router,
    edges_router,
    memberships_router,
    narrative_state_router,
    issues_router,
    suggestions_router,
    engine_tags_router,
    exports_router,
    analysis_router,
)
