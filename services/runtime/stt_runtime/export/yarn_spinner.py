"""Deterministic Yarn Spinner 3 source rendering and official compiler validation."""

from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from typing import Literal, Protocol

from ..schemas.executable_export import (
    ExecutableChoiceV1,
    ExecutableConditionBinaryV1,
    ExecutableConditionLiteralV1,
    ExecutableConditionNodeV1,
    ExecutableConditionStateV1,
    ExecutableConditionUnaryV1,
    ExecutableNarrativeProjectionV1,
    ExecutableOperationV1,
    ExecutableRouteV1,
)
from ..schemas.export import EXPORT_MAX_OUTPUT_BYTES, ExportDiagnosticV1, ExportOwnerV1

YARN_LANGUAGE_VERSION = "3.0.2"
YARN_COMPILER_VERSION = "3.0.2"
YarnCompilerPolicy = Literal["disabled", "optional", "required"]


@dataclass(frozen=True, slots=True)
class YarnSourceMapLine:
    """One exact generated line range mapped back to an authored owner."""

    symbol: str
    start_line: int
    end_line: int
    owner: ExportOwnerV1


@dataclass(frozen=True, slots=True)
class YarnCompilerValidation:
    """Compiler outcome independent from renderer and coordinator concerns."""

    status: Literal["disabled", "unavailable", "valid", "invalid", "version_mismatch"]
    detail: str = ""


@dataclass(frozen=True, slots=True)
class YarnSourceBuild:
    """Complete source-adapter result; errors intentionally suppress payload bytes."""

    payload: bytes | None
    source_map: tuple[YarnSourceMapLine, ...]
    diagnostics: tuple[ExportDiagnosticV1, ...]
    compiler: YarnCompilerValidation


class YarnCompiler(Protocol):
    """Narrow substitution boundary for the official compiler process."""

    def validate(self, source: bytes) -> YarnCompilerValidation:
        """Compile one complete source artifact without exposing compiler output files."""


class OfficialYarnCompiler:
    """Invoke the pinned official ``ysc`` CLI without shell interpretation."""

    def __init__(self, executable: str | None = None) -> None:
        self._configured = executable

    def validate(self, source: bytes) -> YarnCompilerValidation:
        executable = self._configured or shutil.which("ysc")
        if executable is None:
            return YarnCompilerValidation("unavailable", "ysc was not found")
        try:
            version = subprocess.run(
                [executable, "--version"], capture_output=True, text=True,
                timeout=10, check=False,
            )
        except (OSError, subprocess.SubprocessError) as error:
            return YarnCompilerValidation("unavailable", str(error))
        version_text = f"{version.stdout}\n{version.stderr}".strip()
        if version.returncode != 0 or YARN_COMPILER_VERSION not in version_text:
            return YarnCompilerValidation("version_mismatch", version_text[:500])
        try:
            with tempfile.TemporaryDirectory(prefix="stt-yarn-") as directory:
                root = Path(directory)
                source_path = root / "narrative.yarn"
                output_path = root / "compiled"
                output_path.mkdir()
                source_path.write_bytes(source)
                compiled = subprocess.run(
                    [
                        executable, "compile", "--output-directory", str(output_path),
                        "--output-name", "narrative", str(source_path),
                    ],
                    capture_output=True, text=True, timeout=30, check=False,
                )
        except (OSError, subprocess.SubprocessError) as error:
            return YarnCompilerValidation("unavailable", str(error))
        detail = f"{compiled.stdout}\n{compiled.stderr}".strip()[:2_000]
        return YarnCompilerValidation(
            "valid" if compiled.returncode == 0 else "invalid", detail
        )


@dataclass(slots=True)
class _SourceWriter:
    """Track generated lines and exact owner ranges while rendering."""

    owners: dict[str, ExportOwnerV1]
    lines: list[str] = field(default_factory=list)
    mappings: list[YarnSourceMapLine] = field(default_factory=list)

    def add(self, *lines: str) -> None:
        self.lines.extend(lines)

    def mapped(self, symbol: str, *lines: str) -> None:
        start = len(self.lines) + 1
        self.lines.extend(lines)
        owner = self.owners.get(symbol)
        if owner is not None:
            self.mappings.append(YarnSourceMapLine(symbol, start, len(self.lines), owner))

    def node(self, symbol: str, body: list[str], *, tags: str) -> None:
        self.mapped(
            symbol,
            f"title: {symbol}",
            f"tags: {tags}",
            "---",
            *body,
            "===",
            "",
        )


class YarnSpinnerExportService:
    """Lower target-neutral executable IR into readable Yarn Spinner source."""

    media_type = "text/x-yarnspinner"
    extension = ".yarn"

    def __init__(
        self,
        compiler: YarnCompiler | None = None,
        *,
        compiler_policy: YarnCompilerPolicy = "optional",
    ) -> None:
        self._compiler = compiler or OfficialYarnCompiler()
        self._policy = compiler_policy

    def build(self, executable: ExecutableNarrativeProjectionV1) -> YarnSourceBuild:
        diagnostics = list(executable.diagnostics)
        if any(item.severity == "error" for item in diagnostics):
            return YarnSourceBuild(
                None, (), tuple(diagnostics), YarnCompilerValidation("disabled")
            )
        owners = {entry.symbol: entry.owner for entry in executable.source_map}
        writer = _SourceWriter(owners)
        operations = {item.id: item for item in executable.operations}
        diagnostics.extend(self._validate(executable))
        if any(item.severity == "error" for item in diagnostics):
            return YarnSourceBuild(
                None, (), tuple(self._stable_diagnostics(diagnostics)),
                YarnCompilerValidation("disabled"),
            )

        self._header(writer, executable)
        variables = self._variables(executable)
        self._declarations(writer, variables)
        self._flows(writer, executable, operations)
        self._dialogues(writer, executable, operations)
        self._quests(writer, executable, operations)
        self._metadata(writer, executable, writer.mappings)
        payload = ("\n".join(writer.lines).rstrip() + "\n").encode("utf-8")
        if len(payload) > EXPORT_MAX_OUTPUT_BYTES:
            diagnostics.append(self._diagnostic(
                "limit-exceeded", "error", None,
                {"bytes": len(payload), "limit": EXPORT_MAX_OUTPUT_BYTES},
            ))
        if any(item.severity == "error" for item in diagnostics):
            return YarnSourceBuild(
                None,
                tuple(writer.mappings),
                tuple(self._stable_diagnostics(diagnostics)),
                YarnCompilerValidation("disabled"),
            )

        compiler = (
            YarnCompilerValidation("disabled")
            if self._policy == "disabled"
            else self._compiler.validate(payload)
        )
        compiler_diagnostic = self._compiler_diagnostic(compiler)
        if compiler_diagnostic is not None:
            diagnostics.append(compiler_diagnostic)
        if any(item.severity == "error" for item in diagnostics):
            payload = None
        return YarnSourceBuild(
            payload,
            tuple(writer.mappings),
            tuple(self._stable_diagnostics(diagnostics)),
            compiler,
        )

    @staticmethod
    def _header(writer: _SourceWriter, executable: ExecutableNarrativeProjectionV1) -> None:
        writer.add(
            "// Generated by Something To Tell Engine. Do not edit generated symbols.",
            f"// stt-yarn-language: {YARN_LANGUAGE_VERSION}",
            f"// stt-yarn-compiler: YarnSpinner.Console {YARN_COMPILER_VERSION}",
            f"// stt-source-checksum: {executable.source.source_checksum}",
            *[f"// stt-entry: {flow.symbol}" for flow in executable.flows if flow.is_root],
            "",
        )

    def _declarations(self, writer: _SourceWriter, variables: dict[str, object]) -> None:
        body = [
            f"<<declare ${name} = {self._literal(value)}>>"
            for name, value in sorted(variables.items())
        ] or ["// No narrative state variables are required."]
        writer.node("STT_Declarations", body, tags="stt generated declarations")

    def _flows(
        self,
        writer: _SourceWriter,
        executable: ExecutableNarrativeProjectionV1,
        operations: dict[str, ExecutableOperationV1],
    ) -> None:
        returns = {
            item.source_step_symbol: item
            for flow in executable.flows
            for item in flow.returns
        }
        initial = {item.flow_id: item for item in executable.initial_states}
        for flow in executable.flows:
            body: list[str] = []
            state = initial.get(flow.id)
            if flow.is_root and state is not None:
                body.extend(self._initial_state_commands(state))
            if flow.is_root:
                body.append(f"<<jump {flow.entry_step_symbol}>>")
            else:
                body.extend([f"<<detour {flow.entry_step_symbol}>>", "<<return>>"])
            writer.node(flow.symbol, body, tags="stt generated flow entry")
            for step in flow.steps:
                writer.node(
                    step.symbol,
                    self._step_body(step, returns.get(step.symbol), operations),
                    tags=f"stt generated step {self._tag(step.node_kind)}",
                )
                for route in step.routes:
                    if route.kind == "call":
                        owner = writer.owners.get(route.symbol)
                        if owner is not None:
                            writer.owners[self._call_symbol(route)] = owner
                        writer.node(
                            self._call_symbol(route),
                            self._call_body(route),
                            tags="stt generated invocation",
                        )

    def _step_body(self, step, flow_return, operations) -> list[str]:
        body = self._text_lines(step.text)
        body.extend(self._operation_commands(step.operation_ids, operations))
        if step.dialogue_symbol:
            body.append(f"<<detour {step.dialogue_symbol}>>")
        body.extend(self._route_options(step.routes, operations))
        if not step.routes and flow_return is not None:
            body.extend(self._operation_commands(flow_return.operation_ids, operations))
            body.extend([
                f"<<set $stt_return_key = {self._literal(flow_return.symbol)}>>",
                "<<return>>",
            ])
        elif not step.routes:
            body.append("<<return>>")
        return body

    def _route_options(self, routes, operations) -> list[str]:
        if not routes:
            return []
        body: list[str] = []
        non_default = [route for route in routes if not route.is_default]
        fallback = self._fallback_condition(non_default)
        for route in routes:
            condition = fallback if route.is_default else self._condition(route.condition)
            label = self._line_text(route.label or route.symbol)
            suffix = f" <<if {condition}>>" if condition else ""
            body.append(f"-> {label}{suffix}")
            body.extend(f"    {line}" for line in self._operation_commands(
                route.operation_ids, operations
            ))
            target = self._call_symbol(route) if route.kind == "call" else route.target_symbol
            body.extend([f"    <<detour {target}>>", "    <<return>>"])
        return body

    def _call_body(self, route: ExecutableRouteV1) -> list[str]:
        # Invocation operations run at the caller option before this wrapper.
        body = [f"<<detour {route.target_symbol}>>"]
        for binding in route.return_bindings:
            body.extend([
                f"<<if $stt_return_key == {self._literal(binding.exit_symbol)}>>",
                f"    <<detour {binding.target_step_symbol}>>",
                "    <<return>>",
                "<<endif>>",
            ])
        body.extend([
            f'<<stt_unbound_return "{route.symbol}" $stt_return_key>>',
            "<<return>>",
        ])
        return body

    def _dialogues(self, writer, executable, operations) -> None:
        speakers = {item.symbol: item.display_name for item in executable.speakers}
        for dialogue in executable.dialogues:
            entry = dialogue.entry_symbol
            body = [f"<<detour {entry}>>", "<<return>>"] if entry else ["<<return>>"]
            writer.node(dialogue.symbol, body, tags="stt generated dialogue entry")
            for line in dialogue.lines:
                prefix = f"{self._line_text(speakers.get(line.speaker_symbol, 'Narrator'))}: "
                body = self._text_lines(line.text, prefix=prefix)
                body.extend(self._operation_commands(line.operation_ids, operations))
                body.extend(self._next_or_return(line.next_symbol))
                writer.node(line.symbol, body, tags="stt generated dialogue line")
            for choice in dialogue.choices:
                writer.node(
                    choice.symbol,
                    self._choice_body(choice, operations),
                    tags="stt generated dialogue choice",
                )

    def _choice_body(self, choice: ExecutableChoiceV1, operations) -> list[str]:
        body = self._text_lines(choice.prompt) if choice.prompt else []
        body.extend(self._operation_commands(choice.operation_ids, operations))
        for option in choice.options:
            condition = self._condition(option.condition)
            suffix = f" <<if {condition}>>" if condition else ""
            body.append(f"-> {self._line_text(option.text)}{suffix}")
            body.extend(f"    {line}" for line in self._operation_commands(
                option.operation_ids, operations
            ))
            body.extend(f"    {line}" for line in self._next_or_return(option.next_symbol))
        return body or ["<<return>>"]

    def _quests(self, writer, executable, operations) -> None:
        for quest in executable.quests:
            body = self._text_lines(quest.objective) if quest.objective else []
            body.extend(
                [f"<<detour {quest.entry_stage_symbol}>>", "<<return>>"]
                if quest.entry_stage_symbol else ["<<return>>"]
            )
            writer.node(quest.symbol, body, tags="stt generated quest entry")
            for stage in quest.stages:
                body = self._text_lines(stage.description or stage.title)
                for branch in stage.branches:
                    condition = self._condition(branch.condition)
                    suffix = f" <<if {condition}>>" if condition else ""
                    body.append(f"-> {self._line_text(branch.label)}{suffix}")
                    body.extend(f"    {line}" for line in self._operation_commands(
                        branch.operation_ids, operations
                    ))
                    body.extend(f"    {line}" for line in self._next_or_return(
                        branch.target_stage_symbol
                    ))
                if not stage.branches:
                    body.append("<<return>>")
                writer.node(stage.symbol, body, tags="stt generated quest stage")

    def _operation_commands(self, ids, operations) -> list[str]:
        commands: list[str] = []
        for identifier in ids:
            operation = operations[identifier]
            effect = operation.effect
            if effect.operation == "set_flag":
                command = f"<<set ${self._state_variable(['flags', effect.payload.flag])} = true>>"
            elif effect.operation == "clear_flag":
                command = f"<<set ${self._state_variable(['flags', effect.payload.flag])} = false>>"
            elif effect.operation == "set_quest_status":
                variable = self._state_variable([
                    "quests", effect.payload.quest_node_id, "status"
                ])
                command = f"<<set ${variable} = {self._literal(effect.payload.status)}>>"
            elif effect.operation == "record_dialogue_choice":
                variable = self._state_variable([
                    "dialogue", "choices", effect.payload.dialogue_node_id
                ])
                command = f"<<set ${variable} = {self._literal(effect.payload.choice_id)}>>"
            else:
                payload = effect.payload
                command = "<<stt_transfer_item {} {} {} {} {}>>".format(
                    self._literal(payload.item_node_id),
                    self._literal(payload.from_holder.kind),
                    self._literal(payload.from_holder.node_id or ""),
                    self._literal(payload.to_holder.kind),
                    self._literal(payload.to_holder.node_id or ""),
                )
            if effect.repeat_policy == "once":
                guard = f"stt_once_{self._digest(operation.symbol)}"
                commands.extend([
                    f"<<if not ${guard}>>", f"    {command}",
                    f"    <<set ${guard} = true>>", "<<endif>>",
                ])
            else:
                commands.append(command)
        return commands

    def _variables(self, executable) -> dict[str, object]:
        variables: dict[str, object] = {"stt_return_key": ""}
        for state in executable.initial_states:
            for flag, value in state.flags.items():
                variables[self._state_variable(["flags", flag])] = value
            for item in state.item_custody:
                root = ["items", item.item_node_id, "holder"]
                variables[self._state_variable([*root, "kind"])] = item.holder.kind
                variables[self._state_variable([*root, "node_id"])] = item.holder.node_id or ""
            for quest, status in state.quest_statuses.items():
                variables[self._state_variable(["quests", quest, "status"])] = status
        for operation in executable.operations:
            effect = operation.effect
            if effect.repeat_policy == "once":
                variables[f"stt_once_{self._digest(operation.symbol)}"] = False
            if effect.operation in {"set_flag", "clear_flag"}:
                variables.setdefault(self._state_variable(["flags", effect.payload.flag]), False)
            elif effect.operation == "set_quest_status":
                variables.setdefault(self._state_variable([
                    "quests", effect.payload.quest_node_id, "status"
                ]), "inactive")
            elif effect.operation == "record_dialogue_choice":
                variables.setdefault(self._state_variable([
                    "dialogue", "choices", effect.payload.dialogue_node_id
                ]), "")
            elif effect.operation == "transfer_item":
                root = ["items", effect.payload.item_node_id, "holder"]
                variables.setdefault(self._state_variable([*root, "kind"]), "unowned")
                variables.setdefault(self._state_variable([*root, "node_id"]), "")
        for condition in self._all_conditions(executable):
            for path in self._condition_paths(condition):
                variables.setdefault(self._state_variable(path), self._path_default(path))
        return variables

    def _initial_state_commands(self, state) -> list[str]:
        commands = [
            f"<<set ${self._state_variable(['flags', key])} = {self._literal(value)}>>"
            for key, value in sorted(state.flags.items())
        ]
        for item in sorted(state.item_custody, key=lambda value: value.item_node_id):
            root = ["items", item.item_node_id, "holder"]
            commands.extend([
                f"<<set ${self._state_variable([*root, 'kind'])} = {self._literal(item.holder.kind)}>>",
                f"<<set ${self._state_variable([*root, 'node_id'])} = {self._literal(item.holder.node_id or '')}>>",
            ])
        commands.extend(
            f"<<set ${self._state_variable(['quests', key, 'status'])} = {self._literal(value)}>>"
            for key, value in sorted(state.quest_statuses.items())
        )
        return commands

    def _condition(self, node: ExecutableConditionNodeV1 | None) -> str:
        if node is None:
            return ""
        if isinstance(node, ExecutableConditionLiteralV1):
            return self._literal(node.value)
        if isinstance(node, ExecutableConditionStateV1):
            return f"${self._state_variable(node.path)}"
        if isinstance(node, ExecutableConditionUnaryV1):
            return f"not ({self._condition(node.operand)})"
        operators = {
            "and": "and", "or": "or", "eq": "==", "ne": "!=",
            "lt": "<", "lte": "<=", "gt": ">", "gte": ">=",
        }
        if node.operator in {"in", "not_in"}:
            raise ValueError("membership conditions must be diagnosed before rendering")
        return (
            f"({self._condition(node.left)} {operators[node.operator]} "
            f"{self._condition(node.right)})"
        )

    def _fallback_condition(self, routes: list[ExecutableRouteV1]) -> str:
        if not routes:
            return ""
        conditions = [self._condition(route.condition) or "true" for route in routes]
        return f"not ({' or '.join(conditions)})"

    def _validate(self, executable) -> list[ExportDiagnosticV1]:
        diagnostics: list[ExportDiagnosticV1] = []
        if not any(flow.is_root for flow in executable.flows):
            diagnostics.append(self._diagnostic(
                "missing-entry", "error", ExportOwnerV1(kind="project", id=executable.source.project_id),
                {"reason": "no root Story Flow is selected"},
            ))
        symbols = [entry.symbol.lower() for entry in executable.source_map]
        if len(symbols) != len(set(symbols)):
            diagnostics.append(self._diagnostic(
                "identifier-collision", "error", None,
                {"reason": "Yarn node titles are case-insensitively ambiguous"},
            ))
        for condition in self._all_conditions(executable):
            if self._contains_membership(condition):
                diagnostics.append(self._diagnostic(
                    "unsupported-condition", "error", None,
                    {"operator": "in/not_in"},
                ))
        for text in self._all_text(executable):
            if "\x00" in text:
                diagnostics.append(self._diagnostic(
                    "unsafe-text", "error", None, {"reason": "NUL character"}
                ))
                break
        operation_ids = {item.id for item in executable.operations}
        for identifier in sorted(
            set(self._referenced_operation_ids(executable)) - operation_ids
        ):
            diagnostics.append(self._diagnostic(
                "missing-operation", "error", None, {"operation_id": identifier}
            ))
        host_ids = {item.id for item in executable.host_bindings}
        for operation in executable.operations:
            if operation.host_binding_id and operation.host_binding_id not in host_ids:
                diagnostics.append(self._diagnostic(
                    "missing-host-binding", "error", None,
                    {"operation_id": operation.id, "binding_id": operation.host_binding_id},
                ))
        defined, references = self._node_symbols(executable)
        for symbol in sorted(references - defined):
            diagnostics.append(self._diagnostic(
                "missing-symbol", "error", None, {"symbol": symbol}
            ))
        return diagnostics

    def _compiler_diagnostic(self, result: YarnCompilerValidation) -> ExportDiagnosticV1 | None:
        if result.status in {"disabled", "valid"}:
            return None
        severity = "warning" if result.status == "unavailable" and self._policy == "optional" else "error"
        return self._diagnostic(
            f"compiler-{result.status}", severity, None,
            {"compiler": f"YarnSpinner.Console {YARN_COMPILER_VERSION}", "detail": result.detail},
        )

    @staticmethod
    def _metadata(writer, executable, mappings) -> None:
        for binding in executable.host_bindings:
            parameters = (
                ["item_node_id", "from_holder_kind", "from_holder_node_id",
                 "to_holder_kind", "to_holder_node_id"]
                if binding.operation == "transfer_item"
                else binding.parameter_names
            )
            value = {
                "command": f"{binding.namespace.replace('.', '_')}_{binding.name}",
                "operation": binding.operation,
                "parameters": parameters,
                "result_type": binding.result_type,
                "version": binding.binding_version,
            }
            writer.add(f"// stt-host-command: {json.dumps(value, ensure_ascii=False, sort_keys=True)}")
        for mapping in mappings:
            value = {
                "end_line": mapping.end_line,
                "owner": mapping.owner.model_dump(mode="json"),
                "start_line": mapping.start_line,
                "symbol": mapping.symbol,
            }
            writer.add(f"// stt-source-map: {json.dumps(value, ensure_ascii=False, sort_keys=True)}")

    @staticmethod
    def _next_or_return(symbol: str | None) -> list[str]:
        return [f"<<detour {symbol}>>", "<<return>>"] if symbol else ["<<return>>"]

    @staticmethod
    def _call_symbol(route: ExecutableRouteV1) -> str:
        return f"call_{route.symbol}"

    @staticmethod
    def _state_variable(path: list[str]) -> str:
        readable = "_".join(re.sub(r"[^A-Za-z0-9]+", "_", part).strip("_") for part in path)
        readable = re.sub(r"_+", "_", readable).strip("_").lower()[:80] or "state"
        return f"stt_{readable}_{YarnSpinnerExportService._digest('.'.join(path))}"

    @staticmethod
    def _digest(value: str) -> str:
        return sha256(value.encode("utf-8")).hexdigest()[:10]

    @staticmethod
    def _literal(value: object) -> str:
        if value is True:
            return "true"
        if value is False:
            return "false"
        if value is None:
            return '""'
        if isinstance(value, (int, float)):
            return str(value)
        return json.dumps(str(value), ensure_ascii=False)

    @staticmethod
    def _line_text(value: str) -> str:
        # Yarn uses backslash escapes for interpolation, markup, command, and tag tokens.
        return (value.replace("\\", "\\\\").replace("{", "\\{")
                .replace("[", "\\[").replace("<<", "\\<\\<")
                .replace("#", "\\#").replace("\r", " ").replace("\n", " "))

    def _text_lines(self, value: str, *, prefix: str = "Narrator: ") -> list[str]:
        lines = value.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        return [f"{prefix}{self._line_text(line)}" for line in lines if line.strip()] or [f"{prefix}"]

    @staticmethod
    def _tag(value: str) -> str:
        return re.sub(r"[^A-Za-z0-9_]+", "_", value).strip("_").lower() or "node"

    @staticmethod
    def _path_default(path: list[str]) -> object:
        if path[0] == "flags":
            return False
        return ""

    @classmethod
    def _condition_paths(cls, node):
        if isinstance(node, ExecutableConditionStateV1):
            yield node.path
        elif isinstance(node, ExecutableConditionUnaryV1):
            yield from cls._condition_paths(node.operand)
        elif isinstance(node, ExecutableConditionBinaryV1):
            yield from cls._condition_paths(node.left)
            yield from cls._condition_paths(node.right)

    @staticmethod
    def _all_conditions(executable):
        for flow in executable.flows:
            for step in flow.steps:
                for route in step.routes:
                    if route.condition is not None:
                        yield route.condition
        for dialogue in executable.dialogues:
            for choice in dialogue.choices:
                for option in choice.options:
                    if option.condition is not None:
                        yield option.condition
        for quest in executable.quests:
            for stage in quest.stages:
                for branch in stage.branches:
                    if branch.condition is not None:
                        yield branch.condition

    @classmethod
    def _contains_membership(cls, node) -> bool:
        if isinstance(node, ExecutableConditionBinaryV1):
            return node.operator in {"in", "not_in"} or cls._contains_membership(
                node.left
            ) or cls._contains_membership(node.right)
        if isinstance(node, ExecutableConditionUnaryV1):
            return cls._contains_membership(node.operand)
        return False

    @staticmethod
    def _all_text(executable):
        for flow in executable.flows:
            for step in flow.steps:
                yield step.text
                yield from (route.label for route in step.routes)
        for dialogue in executable.dialogues:
            yield from (line.text for line in dialogue.lines)
            for choice in dialogue.choices:
                yield choice.prompt
                yield from (option.text for option in choice.options)
        for quest in executable.quests:
            yield quest.objective
            for stage in quest.stages:
                yield stage.title
                yield stage.description
                yield from (branch.label for branch in stage.branches)

    @staticmethod
    def _referenced_operation_ids(executable):
        for flow in executable.flows:
            for step in flow.steps:
                yield from step.operation_ids
                for route in step.routes:
                    yield from route.operation_ids
            for flow_return in flow.returns:
                yield from flow_return.operation_ids
        for dialogue in executable.dialogues:
            for line in dialogue.lines:
                yield from line.operation_ids
            for choice in dialogue.choices:
                yield from choice.operation_ids
                for option in choice.options:
                    yield from option.operation_ids
        for quest in executable.quests:
            for stage in quest.stages:
                for branch in stage.branches:
                    yield from branch.operation_ids

    @classmethod
    def _node_symbols(cls, executable) -> tuple[set[str], set[str]]:
        defined = {"STT_Declarations"}
        references: set[str] = set()
        for flow in executable.flows:
            defined.add(flow.symbol)
            references.add(flow.entry_step_symbol)
            for step in flow.steps:
                defined.add(step.symbol)
                if step.dialogue_symbol:
                    references.add(step.dialogue_symbol)
                for route in step.routes:
                    target = cls._call_symbol(route) if route.kind == "call" else route.target_symbol
                    references.add(target)
                    if route.kind == "call":
                        defined.add(target)
                        references.add(route.target_symbol)
                        references.update(
                            item.target_step_symbol for item in route.return_bindings
                        )
        for dialogue in executable.dialogues:
            defined.add(dialogue.symbol)
            if dialogue.entry_symbol:
                references.add(dialogue.entry_symbol)
            for line in dialogue.lines:
                defined.add(line.symbol)
                if line.next_symbol:
                    references.add(line.next_symbol)
            for choice in dialogue.choices:
                defined.add(choice.symbol)
                references.update(
                    option.next_symbol for option in choice.options if option.next_symbol
                )
        for quest in executable.quests:
            defined.add(quest.symbol)
            if quest.entry_stage_symbol:
                references.add(quest.entry_stage_symbol)
            for stage in quest.stages:
                defined.add(stage.symbol)
                references.update(
                    branch.target_stage_symbol
                    for branch in stage.branches
                    if branch.target_stage_symbol
                )
        return defined, references

    @staticmethod
    def _diagnostic(code, severity, owner, parameters) -> ExportDiagnosticV1:
        return ExportDiagnosticV1(
            code=f"export.yarn.{code}", severity=severity,
            message_key=f"export.diagnostic.yarn-{code}", owner=owner,
            parameters=parameters,
        )

    @staticmethod
    def _stable_diagnostics(diagnostics):
        return sorted(
            diagnostics,
            key=lambda item: (
                item.severity, item.code,
                item.owner.kind if item.owner else "",
                item.owner.id if item.owner else "",
            ),
        )
