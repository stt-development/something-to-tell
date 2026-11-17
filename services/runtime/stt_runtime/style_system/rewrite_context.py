"""Deterministic minimum-context assembly for one Style Rewriter request."""

from __future__ import annotations

from hashlib import sha256

from ..agent_memory.context import resolve_agent_memory_provider_data
from ..agent_memory.resolver import AgentMemoryResolutionError
from ..schemas.dialogue import DialogueChoiceElement, DialogueLineElement
from ..schemas.agent_memory import (
    ApprovedAgentMemoryV1,
    DialogueFieldMemoryScopeV1,
    NodeMemoryScopeV1,
    ProjectMemoryScopeV1,
    SceneMemoryScopeV1,
)
from ..schemas.project_document import ProjectDocument
from ..schemas.style_rewrite import (
    STYLE_REWRITE_MAX_SOURCE_CHARACTERS,
    DialogueFieldTargetV1,
    QuestFieldTargetV1,
    StyleRewriteAdjacentLineV1,
    StyleRewriteContextPackageV1,
    StyleRewriteRequestV1,
)
from .resolver import EffectiveStyleResolver, StyleResolutionError, StyleResolutionSnapshot


class StyleRewriteContextError(ValueError):
    """Stable, redacted failure raised before provider-visible data is assembled."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class StyleRewriteContextBuilder:
    """Resolve an exact target while excluding unrelated authored project data."""

    def build(
        self,
        document: ProjectDocument,
        history_revision: int,
        request: StyleRewriteRequestV1,
    ) -> StyleRewriteContextPackageV1:
        if document.checksum != request.observed_source_checksum:
            raise StyleRewriteContextError("style_rewrite_run_stale")
        node = next((item for item in document.nodes if item.id == request.target.node_id), None)
        if node is None:
            raise StyleRewriteContextError(
                "style_rewrite_target_not_found", target_id=request.target.node_id
            )
        try:
            resolution = EffectiveStyleResolver().resolve(
                StyleResolutionSnapshot.from_document(document),
                target_node_id=node.id,
                context=request.style_context,
            )
        except StyleResolutionError as error:
            raise StyleRewriteContextError(error.code, **error.parameters) from error
        if resolution.status != "resolved" or resolution.style_profile_id is None:
            raise StyleRewriteContextError(f"style_rewrite_{resolution.status}")
        profile = next(
            (item for item in document.style_profiles if item.id == resolution.style_profile_id),
            None,
        )
        if profile is None:
            raise StyleRewriteContextError("style_rewrite_unavailable")

        source, speaker, participants, adjacent, omitted = self._target_context(
            document, request.target
        )
        if not source.strip():
            raise StyleRewriteContextError("style_rewrite_target_empty")
        if len(source) > STYLE_REWRITE_MAX_SOURCE_CHARACTERS:
            raise StyleRewriteContextError(
                "style_rewrite_limit_invalid", field="source_text"
            )
        traits = (
            *profile.traits.tone,
            *profile.traits.rhythm,
            *profile.traits.pacing,
            *profile.traits.vocabulary,
            *((profile.traits.dramatic_intensity,) if profile.traits.dramatic_intensity else ()),
        )
        scene_title = resolution.scene_context.scene_title if resolution.scene_context else None
        approved_memory = self._approved_memory(
            document,
            history_revision=history_revision,
            request=request,
            target_node_type=node.type,
            scene_node_id=(
                resolution.scene_context.scene_node_id
                if resolution.scene_context is not None
                else None
            ),
        )
        return StyleRewriteContextPackageV1(
            project_id=document.manifest.project_id,
            content_locale=document.manifest.settings.content_locale,
            target=request.target,
            source_text=source,
            source_text_checksum=sha256(source.encode("utf-8")).hexdigest(),
            document_checksum=document.checksum,
            history_revision=history_revision,
            target_title=node.title,
            scene_title=scene_title,
            speaker_name=speaker,
            participant_names=participants,
            adjacent_lines=adjacent,
            style_profile_id=profile.id,
            style_profile_name=profile.name,
            style_guidance=profile.guidance,
            style_traits=traits,
            positive_examples=profile.positive_examples,
            approved_memory=approved_memory,
            additional_instructions=request.additional_instructions.strip(),
            omitted_adjacent_line_count=omitted,
        )

    @staticmethod
    def _approved_memory(
        document: ProjectDocument,
        *,
        history_revision: int,
        request: StyleRewriteRequestV1,
        target_node_type: str,
        scene_node_id: str | None,
    ) -> ApprovedAgentMemoryV1:
        """Resolve reviewed Style guidance against the exact provider snapshot."""

        if isinstance(request.target, DialogueFieldTargetV1):
            target_scope = DialogueFieldMemoryScopeV1(
                node_id=request.target.node_id,
                field_kind=request.target.field_kind,
                element_id=request.target.element_id,
                option_id=request.target.option_id,
            )
        elif target_node_type == "Scene":
            target_scope = SceneMemoryScopeV1(scene_node_id=request.target.node_id)
        else:
            target_scope = NodeMemoryScopeV1(node_id=request.target.node_id)
        context_scope = (
            SceneMemoryScopeV1(scene_node_id=scene_node_id)
            if scene_node_id is not None
            else ProjectMemoryScopeV1()
        )
        try:
            return resolve_agent_memory_provider_data(
                document,
                history_revision=history_revision,
                agent_id="style_rewriter",
                scope=target_scope,
                context_scope=context_scope,
            ).approved_memory
        except AgentMemoryResolutionError as error:
            raise StyleRewriteContextError(error.code, **error.parameters) from error
        except ValueError as error:
            raise StyleRewriteContextError("agent_memory_resolution_blocked") from error

    @staticmethod
    def _target_context(
        document: ProjectDocument,
        target: object,
    ) -> tuple[str, str | None, tuple[str, ...], tuple[StyleRewriteAdjacentLineV1, ...], int]:
        if isinstance(target, QuestFieldTargetV1):
            owned = next((item for item in document.quests if item.node_id == target.node_id), None)
            if owned is None:
                raise StyleRewriteContextError("style_rewrite_target_not_found", target_id=target.node_id)
            if target.field_kind == "objective":
                return owned.document.objective, None, (), (), 0
            stage = next((item for item in owned.document.stages if item.id == target.stage_id), None)
            if stage is None:
                raise StyleRewriteContextError("style_rewrite_target_not_found", target_id=target.stage_id or "")
            return stage.description, None, (), (), 0

        if not isinstance(target, DialogueFieldTargetV1):
            node = next(item for item in document.nodes if item.id == target.node_id)
            summary, body = node.summary.strip(), node.body.strip()
            if summary and body and summary != body:
                raise StyleRewriteContextError("style_node_text_conflict", target_id=node.id)
            return summary or body, None, (), (), 0

        owned = next((item for item in document.dialogues if item.node_id == target.node_id), None)
        if owned is None:
            raise StyleRewriteContextError(
                "style_rewrite_target_not_found", target_id=target.node_id
            )
        names = {node.id: node.title for node in document.nodes}
        participants = tuple(names[item] for item in owned.document.participants if item in names)
        element = next(
            (item for item in owned.document.elements if item.id == target.element_id), None
        )
        if element is None:
            raise StyleRewriteContextError(
                "style_rewrite_target_not_found", target_id=target.element_id
            )
        speaker: str | None = None
        if target.field_kind == "line_text" and isinstance(element, DialogueLineElement):
            source = element.text
            speaker = names.get(element.speaker_node_id)
        elif target.field_kind == "choice_prompt" and isinstance(element, DialogueChoiceElement):
            source = element.prompt
        elif target.field_kind == "option_text" and isinstance(element, DialogueChoiceElement):
            option = next((item for item in element.options if item.id == target.option_id), None)
            if option is None:
                raise StyleRewriteContextError(
                    "style_rewrite_target_not_found", target_id=target.option_id or ""
                )
            source = option.text
        else:
            raise StyleRewriteContextError("style_rewrite_target_kind_invalid")

        index = owned.document.elements.index(element)
        neighbors = [
            item for position, item in enumerate(owned.document.elements)
            if position != index and abs(position - index) <= 4
        ]
        adjacent = tuple(
            StyleRewriteAdjacentLineV1(
                element_id=item.id,
                kind=item.kind,
                speaker_name=(names.get(item.speaker_node_id) if isinstance(item, DialogueLineElement) else None),
                text=(item.text if isinstance(item, DialogueLineElement) else item.prompt)[:1_000],
            )
            for item in neighbors
        )
        return source, speaker, participants, adjacent, max(0, len(owned.document.elements) - 1 - len(adjacent))
