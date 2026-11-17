"""Unit tests for checksum-bound, read-only engine target projections."""

from datetime import UTC, datetime
import pytest

from services.runtime.stt_runtime.engine_tags.projection import EngineTagProjectionService
from services.runtime.stt_runtime.schemas.engine_tags import (
    EngineTagBindingV1,
    EngineTagDefinitionV1,
    EngineTagTargetAliasV1,
    EngineTagOwnerV1,
)
from services.runtime.stt_runtime.schemas.project_document import create_project_document

from test_engine_tag_registry_service import _document


def _with_definitions(*definitions):
    document = _document()
    return create_project_document(
        **{
            **document.model_dump(mode="python", exclude={"checksum"}),
            "engine_tag_definitions": list(definitions),
        }
    )


def _definition(identifier: str, *, alias: str | None = None) -> EngineTagDefinitionV1:
    now = datetime(2026, 1, 2, tzinfo=UTC).isoformat()
    aliases = [] if alias is None else [
        EngineTagTargetAliasV1(target="ink", external_identifier=alias),
    ]
    return EngineTagDefinitionV1(
        id=identifier, project_id="project", key=f"Story.{identifier.title()}",
        normalized_key=f"story.{identifier}", description="", status="active",
        aliases=aliases, created_at=now, updated_at=now,
    )


def test_projection_is_read_only_and_reports_missing_target_alias() -> None:
    document = _with_definitions(_definition("main"))
    projection = EngineTagProjectionService().project(document, "ink")
    assert projection.source_checksum == document.checksum
    assert projection.entries == []
    assert projection.omitted[0].code == "missing_target_alias"
    assert document.engine_tag_definitions[0].aliases == []


@pytest.mark.parametrize("other_alias", ["open_door", "OPEN_DOOR"])
def test_projection_uses_target_alias_and_reports_stable_collisions(other_alias: str) -> None:
    document = _with_definitions(_definition("main", alias="open_door"), _definition("other", alias=other_alias))
    projection = EngineTagProjectionService().project(document, "ink")
    assert projection.entries == []
    assert [item.code for item in projection.diagnostics] == ["target_collision"]
    assert {item.code for item in projection.omitted} == {"duplicate_target_alias"}


@pytest.mark.parametrize("target", ["generic", "ink", "yarn_spinner"])
def test_one_definition_can_project_multiple_exact_owners_without_a_collision(target: str):
    document = _document()
    definition = _definition("main", alias="story_main")
    definition = definition.model_copy(update={"aliases": [
        EngineTagTargetAliasV1(target="ink", external_identifier="story_main"),
        EngineTagTargetAliasV1(target="yarn_spinner", external_identifier="story_main"),
    ]})
    owners = [EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1"),
              EngineTagOwnerV1(kind="project", project_id="project")]
    bindings = [EngineTagBindingV1(
        id=f"binding-{index}", project_id="project", definition_id=definition.id, owner=owner,
        created_at=definition.created_at, updated_at=definition.updated_at,
    ) for index, owner in enumerate(owners)]
    document = create_project_document(**{
        **document.model_dump(mode="python", exclude={"checksum"}),
        "engine_tag_definitions": [definition], "engine_tag_bindings": bindings,
    })
    projection = EngineTagProjectionService().project(document, target)
    assert len(projection.entries) == 2
    assert {entry.owner.kind for entry in projection.entries} == {"node", "project"}
    assert projection.diagnostics == []
    assert projection.omitted == []
    assert EngineTagProjectionService().project(document, target) == projection


def test_generic_projection_reports_quarantined_legacy_rows() -> None:
    document = _document()
    raw = document.model_dump(mode="python", exclude={"checksum"})
    raw["legacy_engine_tags"] = [{
        "id": "legacy-1", "project_id": "project", "created_at": "2026-01-02T00:00:00+00:00",
        "updated_at": "2026-01-02T00:00:00+00:00", "target_type": "node", "target_id": "node-1",
        "engine": "ink", "key": "legacy.key", "value": "x", "metadata": {},
    }]
    document = create_project_document(**raw)
    projection = EngineTagProjectionService().project(document, "generic")
    assert projection.entries == []
    assert projection.omitted[-1].code == "legacy_quarantine"
    assert projection.diagnostics[0].code == "legacy_quarantine"


def test_scoped_projection_does_not_promote_filtered_binding_to_project_owner() -> None:
    document = _document()
    now = datetime(2026, 1, 2, tzinfo=UTC).isoformat()
    definition = _definition("main")
    binding = EngineTagBindingV1(
        id="binding-main",
        project_id="project",
        definition_id=definition.id,
        owner=EngineTagOwnerV1(kind="node", project_id="project", node_id="node-1"),
        created_at=now,
        updated_at=now,
    )
    document = create_project_document(**{
        **document.model_dump(mode="python", exclude={"checksum"}),
        "engine_tag_definitions": [definition],
        "engine_tag_bindings": [binding],
    })

    projection = EngineTagProjectionService().project(
        document,
        "generic",
        owner_filter=lambda owner: owner.kind == "project",
    )

    assert projection.entries == []
    assert len(projection.omitted) == 1
    assert projection.omitted[0].code == "out_of_scope"
    assert projection.omitted[0].binding_id == "binding-main"
    assert projection.omitted[0].owner == binding.owner
