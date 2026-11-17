"""Build bounded current-project context for one Agent Memory candidate request."""

from __future__ import annotations

from typing import Any

from ..schemas.agent_memory_candidate import (
    AGENT_MEMORY_MAX_TARGET_CHARACTERS,
    AgentMemoryCandidateContextV1,
    AgentMemoryCandidateRequestV1,
)
from ..schemas.dialogue import DialogueChoiceElement, DialogueLineElement
from ..schemas.project_document import ProjectDocument


class AgentMemoryCandidateContextError(ValueError):
    """Stable missing or stale target error without authored text."""

    def __init__(self, code: str, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class AgentMemoryCandidateContextBuilder:
    """Select only the explicitly scoped current target instead of a graph snapshot."""

    def build(
        self,
        document: ProjectDocument,
        request: AgentMemoryCandidateRequestV1,
    ) -> AgentMemoryCandidateContextV1:
        scope = request.scope
        target_kind = scope.kind
        target_title = document.manifest.name
        target_text = document.manifest.description
        if scope.kind in {"scene", "node", "dialogue_field"}:
            node_id = (
                scope.scene_node_id if scope.kind == "scene" else scope.node_id
            )
            node = next((item for item in document.nodes if item.id == node_id), None)
            if node is None:
                raise AgentMemoryCandidateContextError(
                    "agent_memory_resolution_target_missing", target_id=node_id
                )
            if scope.kind == "scene" and node.type != "Scene":
                raise AgentMemoryCandidateContextError(
                    "agent_memory_resolution_target_missing", target_id=node_id
                )
            target_kind = node.type if scope.kind != "dialogue_field" else scope.field_kind
            target_title = node.title
            target_text = f"{node.summary}\n{node.body}".strip()
            if scope.kind == "dialogue_field":
                target_text = self._dialogue_text(document, scope)
        elif scope.kind == "story_flow":
            flow = next(
                (item for item in document.story_flows if item.id == scope.flow_id),
                None,
            )
            if flow is None:
                raise AgentMemoryCandidateContextError(
                    "agent_memory_resolution_target_missing", target_id=scope.flow_id
                )
            target_title = flow.name
            target_text = flow.description

        included = target_text[:AGENT_MEMORY_MAX_TARGET_CHARACTERS]
        return AgentMemoryCandidateContextV1(
            project_name=document.manifest.name,
            target_kind=target_kind,
            target_title=target_title,
            target_text=included,
            omitted_target_characters=len(target_text) - len(included),
            guidance_request=request.guidance_request,
            content_locale=request.content_locale,
            scope=scope.model_dump(mode="json"),
        )

    @staticmethod
    def _dialogue_text(document: ProjectDocument, scope: Any) -> str:
        """Resolve one stable Dialogue field without sending adjacent branches."""

        owned = next(
            (item for item in document.dialogues if item.node_id == scope.node_id),
            None,
        )
        if owned is None:
            raise AgentMemoryCandidateContextError(
                "agent_memory_resolution_target_missing", target_id=scope.node_id
            )
        element = next(
            (item for item in owned.document.elements if item.id == scope.element_id),
            None,
        )
        if scope.field_kind == "line_text" and isinstance(element, DialogueLineElement):
            return element.text
        if scope.field_kind == "choice_prompt" and isinstance(
            element, DialogueChoiceElement
        ):
            return element.prompt
        if scope.field_kind == "option_text" and isinstance(
            element, DialogueChoiceElement
        ):
            option = next(
                (item for item in element.options if item.id == scope.option_id),
                None,
            )
            if option is not None:
                return option.text
        raise AgentMemoryCandidateContextError(
            "agent_memory_resolution_target_missing",
            target_id=f"{scope.node_id}:{scope.element_id}",
        )
