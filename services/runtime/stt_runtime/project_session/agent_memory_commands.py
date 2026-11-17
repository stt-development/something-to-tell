"""Agent Memory commands composed into the project-session write authority."""

from typing import Any, Protocol

from ..agent_memory.service import AgentMemoryService
from ..project_history.service import ProjectHistoryError
from ..schemas.agent_memory import (
    AgentMemoryMutationCommandV1,
    AgentMemoryMutationResponseV1,
)


class AgentMemorySessionAuthority(Protocol):
    """Minimal registry surface required by manual memory orchestration."""

    _guard: Any

    def _require_session(self, session_id: str) -> Any: ...
    def _load_document(self, active: Any) -> Any: ...
    def _commit_history_document(self, active: Any, document: Any) -> Any: ...
    def _notify_authoring_committed(self, active: Any) -> None: ...


def apply_agent_memory_command(
    authority: AgentMemorySessionAuthority,
    session_id: str,
    command: AgentMemoryMutationCommandV1,
) -> AgentMemoryMutationResponseV1:
    """Commit one manual memory mutation through the bounded history owner."""

    with authority._guard:
        active = authority._require_session(session_id)
    with active.write_guard:
        source = authority._load_document(active)
        history_revision = active.history.summary().history_revision
        if history_revision != command.expected_history_revision:
            raise ProjectHistoryError(
                "history_revision_stale",
                expected_history_revision=command.expected_history_revision,
                history_revision=history_revision,
            )
        target, entry = AgentMemoryService().apply(source, command)
        committed = authority._commit_history_document(active, target)
        history = active.history.record(
            source,
            committed,
            expected_history_revision=command.expected_history_revision,
            command_id=command.command_id,
            command_kind=f"agent_memory_{command.action}",
            label_key="history.command.agentMemory",
            label_parameters={"action": command.action},
        )
        authority._notify_authoring_committed(active)
        return AgentMemoryMutationResponseV1(
            entry=entry,
            source_checksum=committed.checksum,
            history_revision=history.history_revision,
        )
