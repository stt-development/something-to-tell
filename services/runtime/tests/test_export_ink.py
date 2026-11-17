"""Ink source safety, compiler policy, and official-runtime traversal checks."""

from hashlib import sha256
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from services.runtime.stt_runtime.export.executable_projection import ExecutableProjectionService
from services.runtime.stt_runtime.export.ink import InkExportService
from services.runtime.stt_runtime.export.ink_compiler import InkCompilerValidation, OfficialInkCompiler
from services.runtime.stt_runtime.export.ink_state import variable
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.project_document import create_project_document
from services.runtime.stt_runtime.schemas.playback import PlaybackCanonicalNode, PlaybackState
from services.runtime.stt_runtime.schemas.playback_api import PlaybackPrepareCommand
from services.runtime.stt_runtime.schemas.executable_export import (
    ExecutableConditionBinaryV1, ExecutableConditionLiteralV1, ExecutableConditionStateV1,
)
from services.runtime.stt_runtime.playback.traversal_service import PlaybackSessionService

FIXTURE = Path(__file__).parents[3] / "fixtures/projects/project-aurora.v1.json"
COMPILER = os.environ.get("STT_TEST_INKLECATE") or shutil.which("inklecate")
# Product attribution changed; restoring the former header reproduces the old digest.
GOLDEN_SHA256 = "65be196e28ebc8a8172f63ce65087fcff653ffddff9c5f642738028226572f81"


def _executable(*, legacy=False):
    fixture = load_project_fixture(FIXTURE)
    document = create_project_document(**fixture.model_dump(
        mode="python", exclude={"fixture_version", "slug", "playback_effects", "expected_validation"},
    ))
    projection = ExportProjectionService().build(document, ExportOptionsV1(
        format="json", scope="story_flows", story_flow_ids=["flow-main-story"],
        engine_tag_target="generic",
    )).projection
    if not legacy:
        # Repair only this test copy's deliberately invalid legacy Quest conditions.
        projection = projection.model_copy(update={"quests": [
            quest.model_copy(update={"document": quest.document.model_copy(update={
                "stages": [stage.model_copy(update={"branches": [
                    branch.model_copy(update={"condition": "true"})
                    if branch.condition in {"ledger_acquired", "ledger_verified"}
                    else branch for branch in stage.branches
                ]}) for stage in quest.document.stages],
            })}) for quest in projection.quests
        ]})
    executable = ExecutableProjectionService().build(projection)
    return executable


class _Compiler:
    """Policy tests must not depend on a locally installed compiler."""

    def __init__(self, status):
        self.status = status
        self.sources = []

    def validate(self, source):
        self.sources.append(source)
        return InkCompilerValidation(self.status, "test compiler")


def _playback():
    """Run the application's authority, independently of generated Ink source."""
    fixture = load_project_fixture(FIXTURE)
    document = create_project_document(**fixture.model_dump(
        mode="python", exclude={"fixture_version", "slug", "playback_effects", "expected_validation"},
    ))
    snapshots = []
    for flow in document.story_flows:
        invocations = [item for item in document.flow_invocations if item.source_flow_id == flow.id]
        snapshots.append({
            "flow": flow.model_dump(mode="python", exclude={"normalized_name"}),
            "nodes": [item.model_dump(mode="python") for item in document.story_flow_nodes if item.flow_id == flow.id],
            "transitions": [item.model_dump(mode="python") for item in document.flow_transitions if item.flow_id == flow.id],
            "invocations": [item.model_dump(mode="python") for item in invocations],
            "exits": [item.model_dump(mode="python") for item in document.flow_exits if item.flow_id == flow.id],
            "bindings": [item.model_dump(mode="python") for item in document.flow_exit_bindings
                         if item.invocation_id in {invocation.id for invocation in invocations}],
        })
    initial = next(item for item in document.flow_initial_states if item.flow_id == "flow-main-story")
    effects = {item.id: item for item in document.narrative_effects}
    typed_effects = []
    for binding in document.narrative_effect_bindings:
        effect = effects[binding.effect_id]
        contextual_node = binding.owner_id if binding.owner_kind == "node_entry" else binding.context_node_id
        if contextual_node:
            flow_ids = {item.flow_id for item in document.story_flow_nodes if item.node_id == contextual_node}
        else:
            flow_ids = {item.flow_id for item in [*document.flow_transitions, *document.flow_exits]
                        if item.id == binding.owner_id}
        for flow_id in sorted(flow_ids):
            typed_effects.append({
                "id": f"{binding.id}:{flow_id}", "project_id": effect.project_id, "flow_id": flow_id,
                "owner_node_id": contextual_node,
                "owner_transition_id": binding.owner_id if not contextual_node else None,
                "review_status": "accepted", "repeatable": effect.repeat_policy == "per_visit",
                "authored_effect_id": effect.id, "owner_kind": binding.owner_kind,
                "owner_id": binding.owner_id, "context_node_id": binding.context_node_id,
                "application_order": binding.application_order, "explanation": effect.explanation,
                "operation": effect.operation, "payload": effect.payload,
            })
    service = PlaybackSessionService()
    prepared = service.prepare(PlaybackPrepareCommand(
        snapshot=next(item for item in snapshots if item["flow"]["id"] == "flow-main-story"),
        snapshots=snapshots,
        canonical_nodes=[PlaybackCanonicalNode(**item.model_dump(include={
            "id", "project_id", "type", "title", "summary", "body", "status", "metadata",
        })) for item in document.nodes if item.id in {
            *(member.node_id for member in document.story_flow_nodes), "node-dockmaster", "node-hero",
        }],
        dialogue_documents={item.node_id: item.document for item in document.dialogues},
        quest_documents={item.node_id: item.document for item in document.quests},
        typed_effects=typed_effects,
        initial_state=PlaybackState(
            item_holders={item.item_node_id: item.holder for item in initial.item_custody},
            quest_states=initial.quest_statuses,
        ), source_revision=document.checksum,
    ))
    assert prepared.definition is not None, prepared.facts
    return service, service.start(prepared.definition), document.checksum


def test_deterministic_source_has_owner_maps_and_preserves_bilingual_literal_text():
    executable = _executable()
    dialogue = executable.dialogues[0]
    line = dialogue.lines[0].model_copy(update={
        "text": "Причал закрыт. Hold the quay. {name} [choice] #tag -> END // comment",
    })
    executable = executable.model_copy(update={"dialogues": [dialogue.model_copy(update={
        "lines": [line, *dialogue.lines[1:]],
    })]})
    service = InkExportService(compiler_policy="disabled")
    first, second = service.build(executable), service.build(executable)
    assert first.payload is not None, first.diagnostics
    assert first.payload == second.payload
    text = first.payload.decode()
    assert r"Причал закрыт. Hold the quay. \{name\} \[choice\] \#tag \-\> END \/\/ comment" in text
    assert "ink/inklecate 1.2.1" in text
    assert "EXTERNAL stt_transfer_item" in text
    assert "// stt-source-map:" in text
    assert "stt_dialogue_outcome ==" in text
    assert first.source_map
    assert all(1 <= entry.start_line <= entry.end_line <= len(text.splitlines())
               for entry in first.source_map)


@pytest.mark.parametrize("policy,status,payload,severity", [
    ("disabled", "unavailable", True, None),
    ("optional", "unavailable", True, "warning"),
    ("required", "unavailable", False, "error"),
    ("optional", "invalid", False, "error"),
    ("optional", "version_mismatch", False, "error"),
])
def test_compiler_policy(policy, status, payload, severity):
    compiler = _Compiler(status)
    result = InkExportService(compiler, compiler_policy=policy).build(_executable())
    assert (result.payload is not None) is payload, result.diagnostics
    assert [item.severity for item in result.diagnostics if "compiler-" in item.code] == (
        [] if severity is None else [severity]
    )
    assert len(compiler.sources) == (0 if policy == "disabled" else 1)


def test_invalid_ir_and_references_never_publish_partial_source():
    service = InkExportService(compiler_policy="disabled")
    legacy = service.build(_executable(legacy=True))
    assert legacy.payload is None
    assert legacy.source_map == ()
    executable = _executable()
    flow = executable.flows[0]
    step = flow.steps[0].model_copy(update={"operation_ids": ["missing"]})
    invalid = executable.model_copy(update={"flows": [flow.model_copy(update={
        "steps": [step, *flow.steps[1:]],
    }), *executable.flows[1:]], "host_bindings": []})
    result = service.build(invalid)
    assert result.payload is None
    assert {item.code for item in result.diagnostics} >= {
        "export.ink.missing-operation", "export.ink.missing-host-binding",
    }


def test_wrong_compiler_binary_is_rejected_before_execution(tmp_path):
    executable = tmp_path / "inklecate"
    executable.write_bytes(b"not an official compiler")
    assert OfficialInkCompiler(str(executable)).validate(b"-> END").status == "version_mismatch"


@pytest.mark.parametrize("expression,code", [
    (ExecutableConditionBinaryV1(kind="binary", operator="in",
        left=ExecutableConditionLiteralV1(kind="literal", value_type="string", value="answer"),
        right=ExecutableConditionStateV1(kind="state", path=["dialogue", "node", "choices"])), "unsupported-condition"),
    (ExecutableConditionLiteralV1(kind="literal", value_type="null", value=None), "unsupported-null"),
    (ExecutableConditionLiteralV1(kind="literal", value_type="number", value=2**30), "unsupported-number"),
    (ExecutableConditionLiteralV1(kind="literal", value_type="string", value="{inject}"), "unsupported-string-literal"),
])
def test_unsupported_conditions_block_with_exact_route_owner(expression, code):
    executable = _executable()
    flow = executable.flows[0]
    step = next(item for item in flow.steps if item.routes)
    route = step.routes[0].model_copy(update={"condition": expression})
    changed = step.model_copy(update={"routes": [route, *step.routes[1:]]})
    executable = executable.model_copy(update={"flows": [flow.model_copy(update={
        "steps": [changed if item.symbol == step.symbol else item for item in flow.steps],
    }), *executable.flows[1:]]})
    result = InkExportService(compiler_policy="disabled").build(executable)
    assert result.payload is None
    issue = next(item for item in result.diagnostics if item.code == f"export.ink.{code}")
    assert issue.owner.id == route.id


def test_missing_roots_and_recursive_calls_block_before_compilation():
    executable = _executable()
    no_roots = executable.model_copy(update={"flows": [
        item.model_copy(update={"is_root": False}) for item in executable.flows
    ]})
    assert any(item.code == "export.ink.missing-entry" for item in
               InkExportService(compiler_policy="disabled").build(no_roots).diagnostics)
    flow = executable.flows[0]
    step = next(item for item in flow.steps if any(route.kind == "call" for route in item.routes))
    step = step.model_copy(update={"routes": [
        route.model_copy(update={"target_symbol": flow.symbol}) if route.kind == "call" else route
        for route in step.routes
    ]})
    recursive = executable.model_copy(update={"flows": [flow.model_copy(update={
        "steps": [step if item.symbol == step.symbol else item for item in flow.steps],
    }), *executable.flows[1:]]})
    result = InkExportService(compiler_policy="disabled").build(recursive)
    assert result.payload is None
    assert any(item.code == "export.ink.recursive-call" for item in result.diagnostics)


def test_golden_source_checksum_and_collision_resistant_state_identifiers():
    payload = InkExportService(compiler_policy="disabled").build(_executable()).payload
    assert payload is not None
    assert sha256(payload).hexdigest() == GOLDEN_SHA256
    assert variable(["flags", "a-b"]) != variable(["flags", "a_b"])
    assert variable(["flags", "a", "b"]) != variable(["flags", "a_b"])


def test_incomplete_return_maps_unsupported_effects_and_size_limits_block(monkeypatch):
    from services.runtime.stt_runtime.export import ink
    executable = _executable()
    operation = executable.operations[0]
    unsupported = operation.model_copy(update={"effect": operation.effect.model_copy(update={
        "operation": "invented_effect",
    })})
    result = InkExportService(compiler_policy="disabled").build(executable.model_copy(update={
        "operations": [unsupported, *executable.operations[1:]],
    }))
    assert result.payload is None
    assert any(item.code == "export.ink.unsupported-effect" for item in result.diagnostics)
    flow = executable.flows[0]
    step = next(item for item in flow.steps if any(route.kind == "call" for route in item.routes))
    changed = step.model_copy(update={"routes": [
        route.model_copy(update={"return_bindings": []}) if route.kind == "call" else route
        for route in step.routes
    ]})
    result = InkExportService(compiler_policy="disabled").build(executable.model_copy(update={
        "flows": [flow.model_copy(update={"steps": [
            changed if item.symbol == step.symbol else item for item in flow.steps
        ]}), *executable.flows[1:]],
    }))
    assert result.payload is None
    assert any(item.code == "export.ink.unbound-return" for item in result.diagnostics)
    monkeypatch.setattr(ink, "EXPORT_MAX_OUTPUT_BYTES", 1)
    result = InkExportService(compiler_policy="disabled").build(executable)
    assert result.payload is None
    assert any(item.code == "export.ink.limit-exceeded" for item in result.diagnostics)


def test_runtime_settings_read_the_documented_compiler_environment(monkeypatch):
    from services.runtime.stt_runtime.core.config import RuntimeSettings
    monkeypatch.setenv("STT_RUNTIME_INK_COMPILER_POLICY", "required")
    monkeypatch.setenv("STT_RUNTIME_INK_COMPILER_PATH", "/opt/stt/inklecate")
    settings = RuntimeSettings()
    assert settings.ink_compiler_policy == "required"
    assert settings.ink_compiler_path == Path("/opt/stt/inklecate")


def test_unknown_state_is_not_silently_replaced_by_empty_variables():
    executable = _executable().model_copy(update={"initial_states": []})
    result = InkExportService(compiler_policy="disabled").build(executable)
    assert result.payload is None
    issue = next(item for item in result.diagnostics if "state_path" in item.parameters)
    assert issue.owner is not None
    assert issue.parameters["state_path"].startswith("items.")


def test_compiler_requires_valid_output_and_cleans_temporary_files(tmp_path, monkeypatch):
    from services.runtime.stt_runtime.export import ink_compiler
    binary = tmp_path / "inklecate"
    binary.write_bytes(b"test compiler")
    monkeypatch.setattr(ink_compiler, "INKLECATE_DIGESTS", {sha256(binary.read_bytes()).hexdigest()})
    files = []
    def compile_source(command, **kwargs):
        assert kwargs["timeout"] == 30
        assert "shell" not in kwargs
        output, source = Path(command[2]), Path(command[3])
        files.extend([output, source])
        assert source.read_bytes() == b"-> END\n"
        output.write_text('{"inkVersion":21}', encoding="utf-8")
        return subprocess.CompletedProcess(command, 0, "", "")
    monkeypatch.setattr(ink_compiler.subprocess, "run", compile_source)
    assert OfficialInkCompiler(str(binary)).validate(b"-> END\n").status == "valid"
    assert all(not path.exists() for path in files)
    monkeypatch.setattr(ink_compiler.subprocess, "run", lambda *args, **kwargs:
                        subprocess.CompletedProcess(args[0], 0, "ERROR", ""))
    assert OfficialInkCompiler(str(binary)).validate(b"-> END\n").status == "invalid"


@pytest.mark.skipif(COMPILER is None, reason="official inklecate 1.2.1 is not installed")
def test_official_compiler_and_runtime_follow_aurora_dialogue_call_and_return(tmp_path):
    executable = _executable()
    result = InkExportService(OfficialInkCompiler(COMPILER), compiler_policy="required").build(executable)
    assert result.payload is not None, result.compiler.detail or result.diagnostics
    # Test-only external fallback emulates a successful host transfer. Production
    # source intentionally requires the real host to validate and execute custody.
    holder = variable(["items", "node-sealed-ledger", "holder", "kind"])
    source = result.payload.replace(b"-> END\n\n=== flow_", (
        f"STT_PROBE: {{{holder}}}\n-> END\n\n=== flow_"
    ).encode(), 1)
    source += b'\n=== function stt_transfer_item(item, from_kind, from_id, to_kind, to_id) ===\n~ return true\n'
    path = tmp_path / "aurora.ink"
    path.write_bytes(source)
    played = subprocess.run([COMPILER, "-p", str(path)], input="1\n2\n1\n",
                            text=True, capture_output=True, timeout=30, check=False)
    assert played.returncode == 0, played.stdout + played.stderr
    assert "ERROR" not in played.stdout, played.stdout
    assert "Mara runs the blockade" in played.stdout, played.stdout
    assert "Consequence of proving" in played.stdout, played.stdout
    service, session, revision = _playback()
    session = service.choose(session.id, "flow-transition-opening-dialogue", source_revision=revision)
    session = service.choose(session.id, None, dialogue_option_id="answer-run-blockade", source_revision=revision)
    assert [item.label for item in session.step.choices if item.eligible] == ["Mara runs the blockade"]
    session = service.choose(session.id, "flow-invocation-dialogue-smuggler-route", source_revision=revision)
    assert session.current_node_id == "node-route-consequence"
    assert [event.operation for event in session.trace[-1].events] == ["call", "exit", "return"]
    assert f"STT_PROBE: {session.state.item_holders['node-sealed-ledger'].kind}" in played.stdout


@pytest.mark.skipif(COMPILER is None, reason="official inklecate 1.2.1 is not installed")
def test_official_runtime_matches_quest_reward_and_exit_custody_effects(tmp_path):
    executable = _executable()
    result = InkExportService(OfficialInkCompiler(COMPILER), compiler_policy="required").build(executable)
    assert result.payload is not None, result.compiler.detail
    holder = variable(["items", "node-sealed-ledger", "holder", "kind"])
    quest = variable(["quests", "node-smuggler-route", "status"])
    source = result.payload.replace(b"-> END\n\n=== flow_", (
        f"STT_PROBE: {{{holder}}}/{{{quest}}}\n-> END\n\n=== flow_"
    ).encode(), 1)
    source += b'\n=== function stt_transfer_item(item, from_kind, from_id, to_kind, to_id) ===\n~ return true\n'
    path = tmp_path / "quest.ink"
    path.write_bytes(source)
    played = subprocess.run([COMPILER, "-p", str(path)], input="1\n1\n1\n2\n1\n1\n",
                            text=True, capture_output=True, timeout=30, check=False)
    assert played.returncode == 0 and "ERROR" not in played.stdout, played.stdout + played.stderr
    service, session, revision = _playback()
    session = service.choose(session.id, "flow-transition-opening-dialogue", source_revision=revision)
    session = service.choose(session.id, None, dialogue_option_id="answer-show-ledger", source_revision=revision)
    for transition in ["flow-transition-dialogue-inspection", "flow-invocation-inspection-smuggler-route",
                       "flow-transition-quest-blockade", "flow-transition-blockade-return"]:
        session = service.choose(session.id, transition, source_revision=revision)
    assert session.current_node_id == "node-route-consequence"
    assert session.state.item_holders["node-sealed-ledger"].kind == "player"
    assert session.state.quest_states["node-smuggler-route"] == "completed"
    assert "STT_PROBE: player/completed" in played.stdout, played.stdout


@pytest.mark.skipif(COMPILER is None, reason="official inklecate 1.2.1 is not installed")
def test_official_compiler_preserves_bilingual_prose_and_reserved_keywords(tmp_path):
    executable = _executable()
    flow = executable.flows[0]
    entry = next(item for item in flow.steps if item.symbol == flow.entry_step_symbol)
    prose = "Причал закрыт. Hold the quay. {literal} [literal] #tag -> END\nVAR trap = 1\nINCLUDE stolen.ink\nTODO not a directive"
    executable = executable.model_copy(update={"flows": [flow.model_copy(update={
        "steps": [item.model_copy(update={"text": prose}) if item.symbol == entry.symbol else item
                  for item in flow.steps],
    }), *executable.flows[1:]]})
    result = InkExportService(OfficialInkCompiler(COMPILER), compiler_policy="required").build(executable)
    assert result.payload is not None, result.compiler.detail
    path = tmp_path / "literal.ink"
    path.write_bytes(result.payload + b'\n=== function stt_transfer_item(item, from_kind, from_id, to_kind, to_id) ===\n~ return true\n')
    played = subprocess.run([COMPILER, "-p", str(path)], input="1\n2\n1\n",
                            text=True, capture_output=True, timeout=30, check=False)
    assert "ERROR" not in played.stdout, played.stdout
    assert prose in played.stdout
