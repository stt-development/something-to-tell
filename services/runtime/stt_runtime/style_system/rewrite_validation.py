"""Pure factual-safety validation and text-only ProjectPatch construction."""

from __future__ import annotations

from difflib import SequenceMatcher
from hashlib import sha256
import re
from typing import Iterable, Protocol

from ..project_document.patch import ProjectPatchError, apply_project_patch, derive_project_patch
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.project_patch import PutProjectRecordOperation
from ..schemas.style_rewrite import (
    DialogueFieldTargetV1,
    QuestFieldTargetV1,
    StyleProtectedValueResultV1,
    StyleProviderDisclosureV1,
    StyleRecommendationV1,
    StyleRewriteContextPackageV1,
    StyleRewriteTargetV1,
    StyleRewriteValidationDiagnosticV1,
    StyleTextDiffSegmentV1,
)

_STATE_REFERENCE = re.compile(r"\b(?:flags|items|quests)\.[A-Za-z0-9_.:-]+")
_QUANTITY = re.compile(r"(?<!\w)\d+(?:[.,]\d+)?(?:\s*%)?(?!\w)")
_QUOTED_TERM = re.compile(r'["“]([^"”]{1,200})["”]')
_TOKENS = re.compile(r"\s+|[\w'-]+|[^\w\s]", re.UNICODE)


class StyleRewriteValidationError(ValueError):
    """Internal invariant failure that must never become an approvable preview."""


class StyleRewriteCandidate(Protocol):
    """Minimal provider result consumed without depending on adapter implementation."""

    rewritten_text: str
    explanation: str
    applied_traits: tuple[str, ...]
    factual_risks: tuple[str, ...]


class StyleRewriteValidator:
    """Own factual checks and prove one exact record replacement is isolated."""

    def validate(
        self,
        document: ProjectDocument,
        context: StyleRewriteContextPackageV1,
        response: StyleRewriteCandidate,
        disclosure: StyleProviderDisclosureV1,
        recommendation_id: str,
    ) -> StyleRecommendationV1:
        diagnostics: list[StyleRewriteValidationDiagnosticV1] = []
        rewritten = response.rewritten_text.strip()
        if (
            document.checksum != context.document_checksum
            or sha256(context.source_text.encode("utf-8")).hexdigest()
            != context.source_text_checksum
            or self._current_text(document, context.target) != context.source_text
        ):
            diagnostics.append(_diagnostic("style_rewrite_target_changed", blocking=True))
        if not rewritten:
            diagnostics.append(_diagnostic("style_rewrite_empty", blocking=True))
        if rewritten == context.source_text.strip():
            diagnostics.append(_diagnostic("style_rewrite_no_op", blocking=True))

        protected = self._protected_values(document, context.source_text, rewritten)
        missing = [item for item in protected if not item.preserved]
        if missing:
            diagnostics.append(_diagnostic(
                "style_rewrite_protected_value_missing",
                blocking=True,
                kinds=sorted({item.kind for item in missing}),
                count=len(missing),
            ))

        patch = None
        if not any(item.blocking for item in diagnostics):
            try:
                patch = self._build_patch(document, context.target, rewritten)
            except (ProjectPatchError, StyleRewriteValidationError, ValueError):
                diagnostics.append(_diagnostic("style_rewrite_patch_invalid", blocking=True))
        status = "blocked" if any(item.blocking for item in diagnostics) else "valid"
        return StyleRecommendationV1(
            id=recommendation_id,
            source_text=context.source_text,
            rewritten_text=response.rewritten_text,
            explanation=response.explanation,
            applied_traits=response.applied_traits,
            factual_risks=response.factual_risks,
            protected_value_results=protected,
            provider_disclosure=disclosure,
            patch=patch,
            diff=self._diff(context.source_text, response.rewritten_text),
            validation_status=status,
            validation_diagnostics=tuple(diagnostics),
        )

    def _build_patch(
        self,
        document: ProjectDocument,
        target: StyleRewriteTargetV1,
        rewritten: str,
    ):
        payload = document.model_dump(mode="python", exclude={"checksum"})
        if isinstance(target, DialogueFieldTargetV1):
            self._rewrite_dialogue(payload, target, rewritten)
            expected_collection = "dialogues"
        elif isinstance(target, QuestFieldTargetV1):
            self._rewrite_quest(payload, target, rewritten)
            expected_collection = "quests"
        else:
            node = next((item for item in payload["nodes"] if item["id"] == target.node_id), None)
            if node is None:
                raise StyleRewriteValidationError("target missing")
            node["summary"] = rewritten
            node["body"] = rewritten
            expected_collection = "nodes"
        candidate = create_project_document(**payload)
        patch = derive_project_patch(document, candidate)
        if len(patch.operations) != 1:
            raise StyleRewriteValidationError("style patch must contain one operation")
        operation = patch.operations[0]
        if (
            not isinstance(operation, PutProjectRecordOperation)
            or operation.collection != expected_collection
            or operation.record_id != target.node_id
        ):
            raise StyleRewriteValidationError("style patch changed an unrelated record")
        applied = apply_project_patch(document, patch)
        if applied != candidate:
            raise StyleRewriteValidationError("style patch replay differs from candidate")
        return patch

    @staticmethod
    def _current_text(document: ProjectDocument, target: StyleRewriteTargetV1) -> str:
        """Re-read the addressed field so internal context cannot outlive its target."""

        if isinstance(target, QuestFieldTargetV1):
            owned = next((item for item in document.quests if item.node_id == target.node_id), None)
            if owned is None:
                return ""
            if target.field_kind == "objective":
                return owned.document.objective
            stage = next((item for item in owned.document.stages if item.id == target.stage_id), None)
            return stage.description if stage is not None else ""
        if not isinstance(target, DialogueFieldTargetV1):
            node = next((item for item in document.nodes if item.id == target.node_id), None)
            if node is None:
                return ""
            summary, body = node.summary.strip(), node.body.strip()
            if summary and body and summary != body:
                return ""
            return summary or body
        owned = next((item for item in document.dialogues if item.node_id == target.node_id), None)
        if owned is None:
            return ""
        element = next((item for item in owned.document.elements if item.id == target.element_id), None)
        if element is None:
            return ""
        if target.field_kind == "line_text" and hasattr(element, "speaker_node_id"):
            return element.text
        if target.field_kind == "choice_prompt" and hasattr(element, "options"):
            return element.prompt
        if target.field_kind == "option_text" and hasattr(element, "options"):
            option = next((item for item in element.options if item.id == target.option_id), None)
            return option.text if option is not None else ""
        return ""

    @staticmethod
    def _rewrite_dialogue(
        payload: dict,
        target: DialogueFieldTargetV1,
        rewritten: str,
    ) -> None:
        owned = next((item for item in payload["dialogues"] if item["node_id"] == target.node_id), None)
        if owned is None:
            raise StyleRewriteValidationError("dialogue missing")
        element = next(
            (item for item in owned["document"]["elements"] if item["id"] == target.element_id),
            None,
        )
        if element is None:
            raise StyleRewriteValidationError("dialogue element missing")
        if target.field_kind == "line_text" and element["kind"] == "line":
            element["text"] = rewritten
        elif target.field_kind == "choice_prompt" and element["kind"] == "choice":
            element["prompt"] = rewritten
        elif target.field_kind == "option_text" and element["kind"] == "choice":
            option = next(
                (item for item in element["options"] if item["id"] == target.option_id),
                None,
            )
            if option is None:
                raise StyleRewriteValidationError("dialogue option missing")
            option["text"] = rewritten
        else:
            raise StyleRewriteValidationError("dialogue target kind mismatch")

    @staticmethod
    def _rewrite_quest(payload: dict, target: QuestFieldTargetV1, rewritten: str) -> None:
        """Replace only the addressed Quest prose field."""

        owned = next((item for item in payload["quests"] if item["node_id"] == target.node_id), None)
        if owned is None:
            raise StyleRewriteValidationError("quest missing")
        if target.field_kind == "objective":
            owned["document"]["objective"] = rewritten
            return
        stage = next((item for item in owned["document"]["stages"] if item["id"] == target.stage_id), None)
        if stage is None:
            raise StyleRewriteValidationError("quest stage missing")
        stage["description"] = rewritten

    @staticmethod
    def _protected_values(
        document: ProjectDocument,
        source: str,
        rewritten: str,
    ) -> tuple[StyleProtectedValueResultV1, ...]:
        values: list[tuple[int, str, str]] = []
        for node in document.nodes:
            match = _name_pattern(node.title).search(source)
            if match is not None:
                values.append((match.start(), "name", node.title))
        for kind, pattern in (
            ("state_reference", _STATE_REFERENCE),
            ("quantity", _QUANTITY),
        ):
            values.extend((match.start(), kind, match.group(0)) for match in pattern.finditer(source))
        values.extend(
            (match.start(1), "quoted_term", match.group(1))
            for match in _QUOTED_TERM.finditer(source)
        )
        ordered = _ordered_unique(values)
        rewritten_states = {match.group(0) for match in _STATE_REFERENCE.finditer(rewritten)}
        rewritten_quantities = {match.group(0) for match in _QUANTITY.finditer(rewritten)}
        rewritten_quotes = {match.group(1) for match in _QUOTED_TERM.finditer(rewritten)}
        return tuple(
            StyleProtectedValueResultV1(
                kind=kind,
                value=value,
                preserved={
                    "name": _name_pattern(value).search(rewritten) is not None,
                    "state_reference": value in rewritten_states,
                    "quantity": value in rewritten_quantities,
                    "quoted_term": value in rewritten_quotes,
                }[kind],
            )
            for _, kind, value in ordered
        )

    @staticmethod
    def _diff(source: str, rewritten: str) -> tuple[StyleTextDiffSegmentV1, ...]:
        before, after = _TOKENS.findall(source), _TOKENS.findall(rewritten)
        matcher = SequenceMatcher(a=before, b=after, autojunk=False)
        segments: list[StyleTextDiffSegmentV1] = []
        for opcode, left_start, left_end, right_start, right_end in matcher.get_opcodes():
            if opcode in {"equal", "delete", "replace"} and left_start != left_end:
                segments.append(StyleTextDiffSegmentV1(
                    kind="equal" if opcode == "equal" else "delete",
                    text="".join(before[left_start:left_end]),
                ))
            if opcode in {"insert", "replace"} and right_start != right_end:
                segments.append(StyleTextDiffSegmentV1(
                    kind="insert", text="".join(after[right_start:right_end])
                ))
        return tuple(segments)


def _ordered_unique(values: Iterable[tuple[int, str, str]]) -> tuple[tuple[int, str, str], ...]:
    """Keep source order while collapsing identical kind/value evidence."""

    seen: set[tuple[str, str]] = set()
    result: list[tuple[int, str, str]] = []
    for item in sorted(values, key=lambda value: (value[0], value[1], value[2])):
        key = (item[1], item[2])
        if key not in seen:
            seen.add(key)
            result.append(item)
    return tuple(result)


def _name_pattern(value: str) -> re.Pattern[str]:
    """Match a complete authored display name without accepting word prefixes."""

    return re.compile(rf"(?<!\w){re.escape(value)}(?!\w)", re.IGNORECASE)


def _diagnostic(code: str, *, blocking: bool, **parameters: object) -> StyleRewriteValidationDiagnosticV1:
    return StyleRewriteValidationDiagnosticV1(
        code=code,
        message_key=f"style.validation.{code}",
        blocking=blocking,
        parameters=parameters,
    )
