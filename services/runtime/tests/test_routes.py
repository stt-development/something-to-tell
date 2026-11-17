from services.runtime.stt_runtime.api.routes import runtime_routers


def test_runtime_routers_are_separated_by_resource_tag() -> None:
    tags = {tag for router in runtime_routers for tag in router.tags}

    assert tags == {
        "analysis",
        "agent-memory",
        "canon-checks",
        "canon-providers",
        "compositions",
        "dialogues",
        "dialogue-transitions",
        "health",
        "impact-analysis",
        "projects",
        "project-sessions",
        "progression-migrations",
        "quests",
        "quest-transitions",
        "nodes",
        "playback",
        "edges",
        "faction-memberships",
        "issues",
        "narrative-state",
        "suggestions",
            "engine-tags",
            "exports",
            "flow-composition",
        "story-flows",
        "storage",
        "style-resolution",
            "style-rewrites",
            "styles",
        }
