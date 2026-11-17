"""Factual-safety and isolated text-patch tests for P6-006."""

import json
from pathlib import Path

import pytest

from services.runtime.stt_runtime.project_document.patch import ProjectPatchError, apply_project_patch
from services.runtime.stt_runtime.project_fixture import import_project_fixture
from services.runtime.stt_runtime.project_session.service import ProjectSessionRegistry
from services.runtime.stt_runtime.schemas.project_document import create_project_document
from services.runtime.stt_runtime.schemas.impact_analysis import ImpactAnalysisRequest
from services.runtime.stt_runtime.schemas.style_rewrite import (
    StyleProviderDisclosureV1,
    StyleRewriteRequestV1,
)
from services.runtime.stt_runtime.style_system.rewrite_agent import StyleRewriteAgentResponse
from services.runtime.stt_runtime.style_system.rewrite_context import StyleRewriteContextBuilder
from services.runtime.stt_runtime.style_system.rewrite_validation import StyleRewriteValidator

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"


def test_node_rewrite_builds_one_compatible_record_patch_and_preserves_unrelated_data(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        context = _context(sessions, session_id, {
            "kind": "node_text", "node_id": "node-customs-office"
        })
        recommendation = StyleRewriteValidator().validate(
            document,
            context,
            _response("Rain veiled the inspection office inside Glass Harbor."),
            _disclosure(),
            "recommendation-node",
        )

        assert recommendation.validation_status == "valid"
        assert recommendation.patch is not None
        assert len(recommendation.patch.operations) == 1
        assert recommendation.patch.operations[0].collection == "nodes"
        candidate = apply_project_patch(document, recommendation.patch)
        target = next(item for item in candidate.nodes if item.id == "node-customs-office")
        assert target.summary == target.body == recommendation.rewritten_text
        assert candidate.edges == document.edges
        assert candidate.dialogues == document.dialogues
        assert candidate.style_profiles == document.style_profiles
        impact_request = ImpactAnalysisRequest(
            observed_saved_revision=document.manifest.saved_revision,
            expected_history_revision=0,
            source_checksum=document.checksum,
            scenario={"type": "patch", "patch": recommendation.patch},
        )
        assert impact_request.scenario.type == "patch"
        with pytest.raises(ProjectPatchError):
            apply_project_patch(candidate, recommendation.patch)
    finally:
        sessions.close_all()


def test_dialogue_rewrite_changes_only_one_option_text_and_retains_structure(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        context = _context(sessions, session_id, {
            "kind": "dialogue_field",
            "node_id": "node-dock-dialogue",
            "field_kind": "option_text",
            "element_id": "choice-mara-response",
            "option_id": "answer-show-ledger",
        }, scene_id="node-opening")
        recommendation = StyleRewriteValidator().validate(
            document,
            context,
            _response("Show Ilya the sealed ledger now."),
            _disclosure(),
            "recommendation-dialogue",
        )

        assert recommendation.validation_status == "valid"
        assert recommendation.patch is not None
        assert recommendation.patch.operations[0].collection == "dialogues"
        candidate = apply_project_patch(document, recommendation.patch)
        before = next(item for item in document.dialogues if item.node_id == "node-dock-dialogue")
        after = next(item for item in candidate.dialogues if item.node_id == "node-dock-dialogue")
        before_payload = before.model_dump(mode="json")
        after_payload = after.model_dump(mode="json")
        before_payload["document"]["elements"][2]["options"][0]["text"] = after_payload["document"]["elements"][2]["options"][0]["text"]
        assert after_payload == before_payload
    finally:
        sessions.close_all()


@pytest.mark.parametrize(
    ("target", "rewritten_text", "changed_path"),
    [
        (
            {
                "kind": "quest_field",
                "node_id": "node-smuggler-route",
                "field_kind": "objective",
                "stage_id": None,
            },
            "Secure the forged embargo proof and reopen Glass Harbor's escape route.",
            ("objective", None),
        ),
        (
            {
                "kind": "quest_field",
                "node_id": "node-smuggler-route",
                "field_kind": "stage_description",
                "stage_id": "stage-secure-ledger",
            },
            "Recover the Trade Guild evidence behind the forged embargo order.",
            ("stage_description", "stage-secure-ledger"),
        ),
    ],
)
def test_quest_rewrite_changes_only_the_selected_prose_field(
    tmp_path: Path,
    target: dict,
    rewritten_text: str,
    changed_path: tuple[str, str | None],
) -> None:
    """Quest style patches must preserve stages, branches, and unrelated prose."""

    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        context = _context(sessions, session_id, target)
        recommendation = StyleRewriteValidator().validate(
            document,
            context,
            _response(rewritten_text),
            _disclosure(),
            f"recommendation-quest-{changed_path[0]}",
        )

        assert recommendation.validation_status == "valid"
        assert recommendation.patch is not None
        operation = recommendation.patch.operations[0]
        assert operation.collection == "quests"
        assert operation.record_id == "node-smuggler-route"

        before = next(item for item in document.quests if item.node_id == "node-smuggler-route")
        after_document = apply_project_patch(document, recommendation.patch)
        after = next(item for item in after_document.quests if item.node_id == "node-smuggler-route")
        if changed_path[0] == "objective":
            assert after.document.objective == rewritten_text
            assert after.document.stages == before.document.stages
        else:
            target_stage = next(item for item in after.document.stages if item.id == changed_path[1])
            before_stage = next(item for item in before.document.stages if item.id == changed_path[1])
            assert target_stage.description == rewritten_text
            assert target_stage.title == before_stage.title
            assert target_stage.branches == before_stage.branches
            assert after.document.objective == before.document.objective
    finally:
        sessions.close_all()


def test_missing_protected_name_blocks_patch_and_explains_preview(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        context = _context(sessions, session_id, {
            "kind": "node_text", "node_id": "node-customs-office"
        })
        recommendation = StyleRewriteValidator().validate(
            document,
            context,
            _response("Rain veiled the inspection office."),
            _disclosure(),
            "recommendation-unsafe",
        )

        assert recommendation.validation_status == "blocked"
        assert recommendation.patch is None
        missing = [item for item in recommendation.protected_value_results if not item.preserved]
        assert [(item.kind, item.value) for item in missing] == [("name", "Glass Harbor")]
        assert recommendation.validation_diagnostics[0].code == "style_rewrite_protected_value_missing"
        assert {item.kind for item in recommendation.diff} >= {"delete", "insert"}
    finally:
        sessions.close_all()


def test_no_op_is_blocked_even_when_provider_claims_a_style_change(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        context = _context(sessions, session_id, {
            "kind": "node_text", "node_id": "node-customs-office"
        })
        recommendation = StyleRewriteValidator().validate(
            document,
            context,
            _response(context.source_text),
            _disclosure(),
            "recommendation-no-op",
        )

        assert recommendation.validation_status == "blocked"
        assert recommendation.patch is None
        assert [item.code for item in recommendation.validation_diagnostics] == [
            "style_rewrite_no_op"
        ]
    finally:
        sessions.close_all()


def test_state_references_quantities_and_quoted_terms_are_protected(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        original = sessions.inspect(session_id).document
        payload = original.model_dump(mode="python", exclude={"checksum"})
        target = next(item for item in payload["nodes"] if item["id"] == "node-customs-office")
        authored = 'Glass Harbor opens when flags.route.open reaches 3 and "silver seal" remains.'
        target["summary"] = target["body"] = authored
        document = create_project_document(**payload)
        request = StyleRewriteRequestV1(
            session_id=session_id,
            target={"kind": "node_text", "node_id": "node-customs-office"},
            observed_source_checksum=document.checksum,
            expected_history_revision=0,
            content_consent=True,
        )
        context = StyleRewriteContextBuilder().build(document, 0, request)

        recommendation = StyleRewriteValidator().validate(
            document,
            context,
            _response("The harbor opens when the route is ready."),
            _disclosure(),
            "recommendation-adversarial",
        )

        assert recommendation.validation_status == "blocked"
        assert {
            (item.kind, item.value)
            for item in recommendation.protected_value_results
            if not item.preserved
        } == {
            ("name", "Glass Harbor"),
            ("state_reference", "flags.route.open"),
            ("quantity", "3"),
            ("quoted_term", "silver seal"),
        }
    finally:
        sessions.close_all()


def test_protected_values_reject_prefix_and_unquoted_substitutions(tmp_path: Path) -> None:
    sessions, session_id = _open_aurora(tmp_path)
    try:
        document = sessions.inspect(session_id).document
        context = _context(sessions, session_id, {
            "kind": "dialogue_field",
            "node_id": "node-dock-dialogue",
            "field_kind": "line_text",
            "element_id": "line-dockmaster-warning",
            "option_id": None,
        }, scene_id="node-opening")
        authored = context.model_copy(update={
            "source_text": 'Ilya Voss waits for 3 turns at flags.route.open with "silver seal".'
        })

        recommendation = StyleRewriteValidator().validate(
            document,
            authored,
            _response("Ilya Vossian waits for 30 turns at flags.route.opened with silver seal."),
            _disclosure(),
            "recommendation-prefixes",
        )

        assert recommendation.validation_status == "blocked"
        assert {item.kind for item in recommendation.protected_value_results if not item.preserved} == {
            "name", "state_reference", "quantity", "quoted_term"
        }
        assert "style_rewrite_target_changed" in {
            item.code for item in recommendation.validation_diagnostics
        }
    finally:
        sessions.close_all()


def _context(
    sessions: ProjectSessionRegistry,
    session_id: str,
    target: dict,
    *,
    scene_id: str | None = None,
):
    """Build the same checksum-bound context used by the coordinator."""

    current = sessions.inspect(session_id)
    request = StyleRewriteRequestV1(
        session_id=session_id,
        target=target,
        style_context=(
            {"scene_node_id": scene_id} if scene_id is not None else None
        ),
        observed_source_checksum=current.document.checksum,
        expected_history_revision=0,
        content_consent=True,
    )
    return StyleRewriteContextBuilder().build(current.document, 0, request)


def _response(text: str) -> StyleRewriteAgentResponse:
    return StyleRewriteAgentResponse(
        rewritten_text=text,
        explanation="The revision follows the selected profile.",
        applied_traits=("concise",),
        factual_risks=(),
    )


def _disclosure() -> StyleProviderDisclosureV1:
    return StyleProviderDisclosureV1(
        provider="openai",
        provider_profile_id="provider-one",
        model_id="model-one",
        content_locale="en",
    )


def _open_aurora(tmp_path: Path) -> tuple[ProjectSessionRegistry, str]:
    """Use the canonical fixture instead of a validator-specific document stub."""

    source = tmp_path / "aurora.json"
    source.write_text(json.dumps(json.loads(FIXTURE.read_text())))
    project_path = tmp_path / "Aurora.narrative"
    import_project_fixture(source, project_path)
    sessions = ProjectSessionRegistry()
    opened = sessions.open(project_path)
    return sessions, opened.session.session_id
