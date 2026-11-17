"""History-owned orchestration for deterministic engine-tag registry commands."""

from typing import Any, Protocol

from ..engine_tags.service import EngineTagRegistryService
from ..project_history.service import ProjectHistoryError
from ..schemas.engine_tags import EngineTagMutationCommandV1, EngineTagMutationResponseV1


class EngineTagSessionAuthority(Protocol):
    """Minimal session surface required by the registry command."""

    _guard: Any

    def _require_session(self, session_id: str) -> Any: ...
    def _load_document(self, active: Any) -> Any: ...
    def _commit_history_document(self, active: Any, document: Any) -> Any: ...
    def _notify_authoring_committed(self, active: Any) -> None: ...


def apply_engine_tag_command(
    authority: EngineTagSessionAuthority,
    session_id: str,
    command: EngineTagMutationCommandV1,
) -> EngineTagMutationResponseV1:
    """Apply exactly one registry mutation and record one undoable history entry."""

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
        target, _impact = EngineTagRegistryService().apply(source, command)
        committed = authority._commit_history_document(active, target)
        history = active.history.record(
            source,
            committed,
            expected_history_revision=command.expected_history_revision,
            command_id=command.command_id,
            command_kind=f"engine_tag_{command.action}",
            label_key="history.command.engineTag",
            label_parameters={"action": command.action},
        )
        authority._notify_authoring_committed(active)
        return EngineTagMutationResponseV1(
            catalog=EngineTagRegistryService().catalog(committed),
            source_checksum=committed.checksum,
            history_revision=history.history_revision,
            impact_fingerprint=_impact,
        )
