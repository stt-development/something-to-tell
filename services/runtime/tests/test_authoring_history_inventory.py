from fastapi.routing import APIRoute

from services.runtime.stt_runtime.api.dependencies import (
    AUTHORING_METHODS,
    AUTHORING_HISTORY_COMMANDS,
    DIRECT_HISTORY_COMMANDS,
    HISTORY_EXCLUDED_MUTATIONS,
)
from services.runtime.stt_runtime.app import create_app


def test_every_mutating_route_is_coordinated_or_explicitly_excluded() -> None:
    """Fail when a new write-shaped API route has no declared history owner."""

    app = create_app()
    mutating_routes = {
        route.name
        for route in app.routes
        if isinstance(route, APIRoute) and route.methods & AUTHORING_METHODS
    }
    coordinated = AUTHORING_HISTORY_COMMANDS.keys() | DIRECT_HISTORY_COMMANDS.keys()
    excluded = HISTORY_EXCLUDED_MUTATIONS.keys()

    assert coordinated.isdisjoint(excluded)
    assert mutating_routes == coordinated | excluded
    assert all(reason.strip() for reason in HISTORY_EXCLUDED_MUTATIONS.values())
