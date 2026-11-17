from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from ..project_document.patch import (
    ProjectPatchError,
    apply_project_patch,
    derive_project_patch,
)
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.project_history import (
    PROJECT_HISTORY_CAPACITY,
    ProjectHistoryCommandRef,
    ProjectHistorySummary,
)
from ..schemas.project_patch import ProjectPatch


class ProjectHistoryError(ValueError):
    """Stable localization-ready authoring-history failure."""

    def __init__(self, code: str, **parameters: Any) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


@dataclass(frozen=True, slots=True)
class _HistoryEntry:
    command: ProjectHistoryCommandRef
    forward_patch: ProjectPatch
    inverse_patch: ProjectPatch
    created_at: datetime


CommitDocument = Callable[[ProjectDocument], ProjectDocument]


class ProjectHistoryCoordinator:
    """Own one bounded reversible command sequence for an active project session."""

    def __init__(self) -> None:
        self._history_revision = 0
        self._undo: list[_HistoryEntry] = []
        self._redo: list[_HistoryEntry] = []

    def summary(self) -> ProjectHistorySummary:
        return ProjectHistorySummary(
            history_revision=self._history_revision,
            undo_depth=len(self._undo),
            redo_depth=len(self._redo),
            next_undo=self._undo[-1].command if self._undo else None,
            next_redo=self._redo[-1].command if self._redo else None,
        )

    def clear(self) -> ProjectHistorySummary:
        """Cross a successful lifecycle barrier without accepting stale clients."""

        if self._undo or self._redo:
            self._undo.clear()
            self._redo.clear()
            self._history_revision += 1
        return self.summary()

    def rebased_for_save(
        self,
        source: ProjectDocument,
        saved: ProjectDocument,
    ) -> "ProjectHistoryCoordinator":
        """Retain commands while moving their checksum chain to a new save manifest."""

        if source.manifest.project_id != saved.manifest.project_id:
            raise ProjectHistoryError("history_record_invalid")
        try:
            pairs = self._reconstruct_entry_documents(source)
            rebased = ProjectHistoryCoordinator()
            rebased._history_revision = self._history_revision
            rebased._undo = [
                self._rebased_entry(entry, pairs[id(entry)], saved)
                for entry in self._undo
            ]
            rebased._redo = [
                self._rebased_entry(entry, pairs[id(entry)], saved)
                for entry in self._redo
            ]
            return rebased
        except (ProjectPatchError, ValueError) as error:
            raise ProjectHistoryError("history_record_invalid") from error

    def record(
        self,
        source: ProjectDocument,
        target: ProjectDocument,
        *,
        expected_history_revision: int,
        command_id: str,
        command_kind: str,
        label_key: str,
        label_parameters: dict[str, Any] | None = None,
        created_at: datetime | None = None,
    ) -> ProjectHistorySummary:
        """Append one committed command and invalidate its abandoned redo branch."""

        self._require_revision(expected_history_revision)
        if any(
            entry.command.command_id == command_id
            for entry in (*self._undo, *self._redo)
        ):
            raise ProjectHistoryError(
                "history_command_duplicate",
                command_id=command_id,
            )
        try:
            forward = derive_project_patch(source, target)
            if not forward.operations:
                return self.summary()
            inverse = derive_project_patch(target, source)
        except (ProjectPatchError, ValueError) as error:
            raise ProjectHistoryError("history_record_invalid") from error

        command = ProjectHistoryCommandRef(
            command_id=command_id,
            command_kind=command_kind,
            label_key=label_key,
            label_parameters=deepcopy(label_parameters or {}),
        )
        self._undo.append(
            _HistoryEntry(
                command=command,
                forward_patch=forward,
                inverse_patch=inverse,
                created_at=created_at or datetime.now(UTC),
            )
        )
        self._redo.clear()
        if len(self._undo) > PROJECT_HISTORY_CAPACITY:
            self._undo.pop(0)
        self._history_revision += 1
        return self.summary()

    def undo(
        self,
        document: ProjectDocument,
        *,
        expected_history_revision: int,
        commit: CommitDocument,
    ) -> tuple[ProjectDocument, ProjectHistorySummary]:
        return self._apply("undo", document, expected_history_revision, commit)

    def redo(
        self,
        document: ProjectDocument,
        *,
        expected_history_revision: int,
        commit: CommitDocument,
    ) -> tuple[ProjectDocument, ProjectHistorySummary]:
        return self._apply("redo", document, expected_history_revision, commit)

    def _apply(
        self,
        direction: Literal["undo", "redo"],
        document: ProjectDocument,
        expected_history_revision: int,
        commit: CommitDocument,
    ) -> tuple[ProjectDocument, ProjectHistorySummary]:
        self._require_revision(expected_history_revision)
        source_stack = self._undo if direction == "undo" else self._redo
        destination_stack = self._redo if direction == "undo" else self._undo
        if not source_stack:
            raise ProjectHistoryError(f"history_{direction}_empty")
        entry = source_stack[-1]
        patch = entry.inverse_patch if direction == "undo" else entry.forward_patch
        try:
            candidate = apply_project_patch(document, patch)
        except ProjectPatchError as error:
            raise ProjectHistoryError(
                "history_document_stale",
                command_id=entry.command.command_id,
            ) from error
        try:
            committed = commit(candidate)
        except Exception as error:
            raise ProjectHistoryError(
                "history_apply_failed",
                command_id=entry.command.command_id,
            ) from error
        if committed.checksum != candidate.checksum:
            raise ProjectHistoryError(
                "history_apply_failed",
                command_id=entry.command.command_id,
            )

        source_stack.pop()
        destination_stack.append(entry)
        self._history_revision += 1
        return committed, self.summary()

    def _require_revision(self, expected: int) -> None:
        if expected != self._history_revision:
            raise ProjectHistoryError(
                "history_revision_stale",
                expected_history_revision=expected,
                history_revision=self._history_revision,
            )

    def _reconstruct_entry_documents(
        self,
        current: ProjectDocument,
    ) -> dict[int, tuple[ProjectDocument, ProjectDocument]]:
        """Recover private command endpoints from the currently selected stack point."""

        pairs: dict[int, tuple[ProjectDocument, ProjectDocument]] = {}
        cursor = current
        for entry in reversed(self._undo):
            previous = apply_project_patch(cursor, entry.inverse_patch)
            pairs[id(entry)] = (previous, cursor)
            cursor = previous
        cursor = current
        for entry in reversed(self._redo):
            following = apply_project_patch(cursor, entry.forward_patch)
            pairs[id(entry)] = (cursor, following)
            cursor = following
        return pairs

    @staticmethod
    def _rebased_entry(
        entry: _HistoryEntry,
        pair: tuple[ProjectDocument, ProjectDocument],
        saved: ProjectDocument,
    ) -> _HistoryEntry:
        source, target = pair
        rebased_source = _with_save_manifest(source, saved)
        rebased_target = _with_save_manifest(target, saved)
        return _HistoryEntry(
            command=entry.command,
            forward_patch=derive_project_patch(rebased_source, rebased_target),
            inverse_patch=derive_project_patch(rebased_target, rebased_source),
            created_at=entry.created_at,
        )


def _with_save_manifest(
    document: ProjectDocument,
    saved: ProjectDocument,
) -> ProjectDocument:
    """Apply checkpoint-owned manifest fields without changing authored settings."""

    manifest = document.manifest.model_copy(
        update={
            "saved_revision": saved.manifest.saved_revision,
            "updated_at": saved.manifest.updated_at,
        }
    )
    payload = document.model_dump(mode="python", exclude={"checksum", "manifest"})
    return create_project_document(manifest=manifest, **payload)
