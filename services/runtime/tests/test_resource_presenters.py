"""Unit coverage for persistence-neutral resource response projection."""

import pytest

from services.runtime.stt_runtime.domain.entities import (
    EdgeEntity,
    EngineTagEntity,
    IssueEntity,
    NodeEntity,
    ProjectEntity,
    SuggestionEntity,
)
from services.runtime.stt_runtime.schemas.resource_presenters import (
    edge_response,
    engine_tag_response,
    issue_response,
    node_response,
    project_response,
    suggestion_response,
)


@pytest.mark.parametrize(("entity", "present", "expected_id"), [
    (
        ProjectEntity(id="project-1", name="Project", path="/tmp/project", format_version=2),
        project_response,
        "project-1",
    ),
    (
        NodeEntity(id="node-1", project_id="project-1", type="Scene", title="Scene"),
        node_response,
        "node-1",
    ),
    (
        EdgeEntity(
            id="edge-1",
            project_id="project-1",
            source_node_id="node-1",
            target_node_id="node-2",
            type="causes",
        ),
        edge_response,
        "edge-1",
    ),
    (
        IssueEntity(id="issue-1", project_id="project-1", title="Issue"),
        issue_response,
        "issue-1",
    ),
    (
        SuggestionEntity(id="suggestion-1", project_id="project-1", title="Suggestion"),
        suggestion_response,
        "suggestion-1",
    ),
    (
        EngineTagEntity(
            id="tag-1",
            project_id="project-1",
            target_type="node",
            target_id="node-1",
            engine="runtime",
            key="role",
        ),
        engine_tag_response,
        "tag-1",
    ),
])
def test_resource_presenters_copy_complete_domain_records(
    entity: object,
    present,
    expected_id: str,
) -> None:
    """Every presenter keeps identity and all declared entity fields."""

    response = present(entity)

    assert response.id == expected_id
    assert response.model_dump().keys() == entity.__dataclass_fields__.keys()
