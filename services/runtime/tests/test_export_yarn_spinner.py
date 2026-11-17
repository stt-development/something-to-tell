"""Yarn Spinner source determinism, safety, and compiler-policy tests."""

from pathlib import Path
from hashlib import sha256
import shutil

import pytest
from pydantic import ValidationError

from services.runtime.stt_runtime.core.config import RuntimeSettings
from services.runtime.stt_runtime.export.executable_projection import (
    ExecutableProjectionService,
)
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.export.yarn_spinner import (
    OfficialYarnCompiler,
    YARN_COMPILER_VERSION,
    YarnCompilerValidation,
    YarnSpinnerExportService,
)
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.project_document import create_project_document

FIXTURE = Path(__file__).parents[3] / "fixtures" / "projects" / "project-aurora.v1.json"
# Product attribution changed; restoring the former header reproduces the old digest.
GOLDEN_SHA256 = "3176ea039b9893c52dc49c7a467fc10bb3cf8d6020a0927495f9fd25c435a2f3"


def _executable(*, preserve_legacy_errors: bool = False):
    fixture = load_project_fixture(FIXTURE)
    document = create_project_document(**fixture.model_dump(
        mode="python",
        exclude={"fixture_version", "slug", "playback_effects", "expected_validation"},
    ))
    projection = ExportProjectionService().build(
        document,
        ExportOptionsV1(
            format="json",
            scope="story_flows",
            story_flow_ids=["flow-main-story"],
            engine_tag_target="generic",
        ),
    ).projection
    executable = ExecutableProjectionService().build(projection)
    if preserve_legacy_errors:
        return executable
    # Aurora intentionally keeps two malformed legacy Quest conditions for Canon.
    diagnostics = [
        item for item in executable.diagnostics
        if item.code != "export.executable.invalid-condition"
    ]
    dialogue = executable.dialogues[0]
    lines = list(dialogue.lines)
    lines[0] = lines[0].model_copy(update={
        "text": (
            "Hold the quay. Причал закрыт до рассвета. "
            "Literal <<jump Trap>>, {name}, [wave], #tag, C:\\quay."
        )
    })
    return executable.model_copy(update={
        "diagnostics": diagnostics,
        "dialogues": [dialogue.model_copy(update={"lines": lines})],
    })


class _Compiler:
    """Deterministic compiler double used to isolate policy behavior."""

    def __init__(self, result: YarnCompilerValidation) -> None:
        self.result = result
        self.sources: list[bytes] = []

    def validate(self, source: bytes) -> YarnCompilerValidation:
        self.sources.append(source)
        return self.result


def test_aurora_yarn_is_byte_stable_readable_bilingual_and_self_describing() -> None:
    executable = _executable()
    compiler = _Compiler(YarnCompilerValidation("valid"))
    service = YarnSpinnerExportService(compiler)

    first = service.build(executable)
    second = service.build(executable)

    assert first.payload == second.payload
    assert first.payload is not None
    assert sha256(first.payload).hexdigest() == GOLDEN_SHA256
    text = first.payload.decode("utf-8")
    assert "Hold the quay. Причал закрыт до рассвета." in text
    assert r"Literal \<\<jump Trap>>, \{name}, \[wave], \#tag, C:\\quay." in text
    assert f"YarnSpinner.Console {YARN_COMPILER_VERSION}" in text
    assert "<<declare $stt_" in text
    assert "<<detour flow_" in text
    assert "<<jump step_" in text
    assert "<<stt_transfer_item " in text
    assert "// stt-host-command:" in text
    assert "// stt-source-map:" in text
    assert "items.node-sealed-ledger.holder.node_id" not in text
    assert first.source_map
    assert all(item.start_line <= item.end_line for item in first.source_map)
    assert len({item.symbol for item in first.source_map}) == len(first.source_map)
    assert compiler.sources == [first.payload, second.payload]


def test_calls_defaults_dialogue_choices_and_effects_keep_executable_semantics() -> None:
    result = YarnSpinnerExportService(
        _Compiler(YarnCompilerValidation("valid"))
    ).build(_executable())
    assert result.payload is not None
    text = result.payload.decode("utf-8")

    # Calls use detour wrappers and named-return dispatch rather than flattening.
    assert "title: call_route_" in text
    assert "<<set $stt_return_key = \"return_" in text
    assert "<<if $stt_return_key == \"return_" in text
    # Playback defaults are enabled only when every non-default route is ineligible.
    assert "<<if not (" in text
    assert "-> Present the ledger <<if " in text
    assert "-> Mara runs the blockade <<if not (" in text
    assert "<<set $stt_quests_" in text
    assert "<<if not $stt_once_" in text


def test_blocking_ir_or_yarn_diagnostic_never_returns_partial_source() -> None:
    blocked = YarnSpinnerExportService(
        _Compiler(YarnCompilerValidation("valid"))
    ).build(_executable(preserve_legacy_errors=True))

    assert blocked.payload is None
    assert blocked.source_map == ()
    assert any(item.code == "export.executable.invalid-condition" for item in blocked.diagnostics)

    executable = _executable()
    flow = executable.flows[0]
    step = flow.steps[0].model_copy(update={
        "operation_ids": ["missing-operation"],
        "dialogue_symbol": "missing_dialogue",
    })
    malformed = executable.model_copy(update={
        "flows": [flow.model_copy(update={"steps": [step, *flow.steps[1:]]}),
                  *executable.flows[1:]],
        "host_bindings": [],
    })
    rejected = YarnSpinnerExportService(
        _Compiler(YarnCompilerValidation("valid"))
    ).build(malformed)
    assert rejected.payload is None
    assert {item.code for item in rejected.diagnostics} >= {
        "export.yarn.missing-host-binding",
        "export.yarn.missing-operation",
        "export.yarn.missing-symbol",
    }


@pytest.mark.parametrize(
    ("policy", "status", "severity", "has_payload"),
    [
        ("disabled", "unavailable", None, True),
        ("optional", "unavailable", "warning", True),
        ("required", "unavailable", "error", False),
        ("optional", "invalid", "error", False),
        ("optional", "version_mismatch", "error", False),
    ],
)
def test_compiler_availability_and_validation_follow_explicit_policy(
    policy: str, status: str, severity: str | None, has_payload: bool,
) -> None:
    compiler = _Compiler(YarnCompilerValidation(status, "test compiler detail"))
    result = YarnSpinnerExportService(
        compiler, compiler_policy=policy
    ).build(_executable())

    assert (result.payload is not None) is has_payload
    compiler_diagnostics = [
        item for item in result.diagnostics if item.code.startswith("export.yarn.compiler-")
    ]
    assert [item.severity for item in compiler_diagnostics] == (
        [] if severity is None else [severity]
    )
    assert len(compiler.sources) == (0 if policy == "disabled" else 1)


def test_runtime_settings_expose_compiler_policy_and_executable_path() -> None:
    settings = RuntimeSettings(
        yarn_compiler_policy="required",
        yarn_compiler_path=Path("/opt/stt/ysc"),
    )
    assert settings.yarn_compiler_policy == "required"
    assert settings.yarn_compiler_path == Path("/opt/stt/ysc")
    with pytest.raises(ValidationError):
        RuntimeSettings(yarn_compiler_policy="best-effort")


@pytest.mark.skipif(shutil.which("ysc") is None, reason="pinned ysc is not installed")
def test_official_pinned_ysc_compiles_the_golden_source() -> None:
    source = YarnSpinnerExportService(compiler_policy="disabled").build(
        _executable()
    ).payload
    assert source is not None
    assert sha256(source).hexdigest() == GOLDEN_SHA256
    validation = OfficialYarnCompiler().validate(source)
    assert validation.status == "valid", validation.detail
