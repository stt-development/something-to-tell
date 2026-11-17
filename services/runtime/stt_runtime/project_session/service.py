from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from contextlib import contextmanager
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import sqlite3
from threading import Lock, RLock
from typing import Any, Callable, Iterable, Iterator
from uuid import uuid4

from alembic import command  # Re-exported for lifecycle migration fault injection.
from pydantic import ValidationError
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from ..canon.projection import CanonFactProjector
from ..canon.reconciliation import (
    CanonIssueReconciler,
    CanonIssueReconciliationResult,
)
from ..domain.entities import (
    ImpactResolutionDecisionEntity,
    SuggestionEntity,
)
from ..project_document.patch import ProjectPatchError, apply_project_patch
from ..project_history.service import ProjectHistoryCoordinator, ProjectHistoryError
from ..project_document.service import ProjectDocumentError, ProjectDocumentService
from ..project_format.manifest import (
    PROJECT_FORMAT_VERSION,
    PROJECT_SETTINGS_VERSION,
    ProjectManifestError,
    ProjectManifestV2,
    ProjectSettings,
    migrate_project_manifest_v1,
    parse_project_manifest,
)
from ..project_format.service import (
    PROJECT_CONFIG_FILE,
    PROJECT_DATABASE_FILE,
    PROJECT_DIRECTORIES,
    PROJECT_SUFFIX,
    ProjectFormatError,
    create_project_folder,
    read_project_config_payload,
    write_project_manifest,
)
from ..repositories.sqlite import SqlAlchemyUnitOfWork
from .scoped_uow import project_unit_of_work
from ..schemas.agent_memory import (
    AgentMemoryEntryV1,
    AgentMemoryMutationCommandV1,
    AgentMemoryMutationResponseV1,
)
from ..schemas.engine_tags import EngineTagMutationCommandV1, EngineTagMutationResponseV1
from ..schemas.project_document import ProjectDocument, create_project_document
from ..schemas.canon_check import (
    CanonCheckInput,
    CanonIssueCandidate,
    CanonOwnerRef,
    parse_canon_issue_metadata,
)
from ..schemas.impact_analysis import ImpactAnalysisInput, ImpactAnalysisRequest
from ..schemas.impact_resolution import ImpactResolutionDecision
from ..schemas.project_session import (
    ProjectSessionResponse,
    ProjectSessionSaveAsResponse,
    ProjectSessionState,
)
from ..schemas.project_history import (
    ProjectHistoryMutationResponse,
    ProjectHistorySummary,
)
from ..schemas.project_patch import ProjectPatch
from ..schemas.storage import StorageMigrationResponse
from ..storage_profiles import StorageProfileError, StorageProfileRegistry
from ..style_system.service import StylePersistenceService
from .checkpoints import (
    PROJECT_DOCUMENT_CHECKPOINT_FILE,
    RECOVERY_MARKER_FILENAME,
    checkpoint_path,
    load_checkpoint_document,
    prune_checkpoints,
    read_checkpoint_manifest,
    read_document_checkpoint,
    recovery_marker_path,
    restore_local_checkpoint,
    stage_checkpoint,
)
from .database import (
    create_session_factory,
    ensure_project_root,
    open_database,
    upgrade_database,
    validate_postgresql_engine,
)
from .documents import (
    document_record_count,
    document_with_manifest,
    document_with_project_identity,
)
from .errors import ProjectSessionError
from .history_integration import (
    capture_history_persistence,
    reconcile_history_document,
    restore_history_persistence,
)
from .save_as import (
    install_save_as_copy,
    validate_portable_assets,
    validate_save_as_destination,
)
from .storage_migration import admit_migration_target, prepare_migration_target
from .remote_ownership import close_remote, ownership_guard, provision_target, lease_for
from .remote_commands import remote_method, remote_uow
from .remote_context import current_transaction
from .write_guard import SessionWriteGuard
from .agent_memory_commands import apply_agent_memory_command
from .engine_tag_commands import apply_engine_tag_command

LOCK_VERSION = 1
LOCK_FILENAME = "project.lock.json"
MAX_IMPACT_RESOLUTION_DECISIONS = 500


@dataclass(slots=True)
class _ActiveSession:
    state: ProjectSessionState
    path: Path
    manifest: ProjectManifestV2
    engine: Engine
    session_factory: sessionmaker[Session]
    saved_checksum: str | None = None
    # FastAPI dependency threads can differ; use a non-thread-affine guard.
    write_guard: SessionWriteGuard = field(default_factory=SessionWriteGuard)
    history: ProjectHistoryCoordinator = field(default_factory=ProjectHistoryCoordinator)
    remote_state: str = "ready"
    remote_head: Any = None
    lifecycle_identity: object = field(default_factory=object, repr=False)


class ProjectSessionRegistry:
    """Owns all writable project engines and lock files for one runtime process."""

    # These collaborators are intentionally stateless. Session ownership,
    # revision checks, and write guards remain in this registry.
    _document_with_manifest = staticmethod(document_with_manifest)
    _document_with_project_identity = staticmethod(document_with_project_identity)
    _document_record_count = staticmethod(document_record_count)
    _checkpoint_path = staticmethod(checkpoint_path)
    _recovery_marker_path = staticmethod(recovery_marker_path)
    _read_document_checkpoint = staticmethod(read_document_checkpoint)
    _load_checkpoint_document = staticmethod(load_checkpoint_document)
    _read_manifest = staticmethod(read_checkpoint_manifest)
    _restore_local_checkpoint = staticmethod(restore_local_checkpoint)
    _prune_checkpoints = staticmethod(prune_checkpoints)
    _upgrade_database = staticmethod(upgrade_database)
    _open_database = staticmethod(open_database)
    _validate_postgresql_engine = staticmethod(validate_postgresql_engine)
    _session_factory = staticmethod(create_session_factory)
    _ensure_project_root = staticmethod(ensure_project_root)

    def __init__(
        self,
        storage_profiles: StorageProfileRegistry | None = None,
        on_authoring_committed: Callable[[str], None] | None = None,
        on_session_closed: Callable[[str, str], None] | None = None,
    ) -> None:
        self._runtime_instance_id = str(uuid4())
        self._storage_profiles = storage_profiles or StorageProfileRegistry()
        self._on_authoring_committed = on_authoring_committed
        self._on_session_closed = on_session_closed
        self._sessions: dict[str, _ActiveSession] = {}
        self._remote_reconnects: dict[str, Any] = {}
        self._remote_reconnect_guard = RLock()
        self._paths: dict[Path, str] = {}
        self._guard = RLock()

    def create(
        self,
        path: Path,
        name: str,
        description: str = "",
        settings: ProjectSettings | None = None,
    ) -> ProjectSessionResponse:
        project_path = path.expanduser().resolve()
        with self._guard:
            self._require_path_available(project_path)
            try:
                create_project_folder(
                    project_path,
                    name,
                    description=description,
                    settings=settings,
                )
            except ProjectFormatError as error:
                raise self._format_error(error) from error
            return self._open_locked(
                project_path,
                recover_stale_lock=False,
                newly_created=True,
            )

    def open(
        self,
        path: Path,
        *,
        recover_stale_lock: bool = False,
        recovery_mode: str = "cancel",
        expected_lock_session_id: str | None = None,
        remote_profile_id: str | None = None,
        initialize_remote_storage: bool = False,
    ) -> ProjectSessionResponse:
        project_path = path.expanduser().resolve()
        with self._guard:
            self._require_path_available(project_path)
            return self._open_locked(
                project_path,
                recover_stale_lock=recover_stale_lock,
                newly_created=False,
                recovery_mode=recovery_mode,
                expected_lock_session_id=expected_lock_session_id,
                remote_profile_id=remote_profile_id,
                initialize_remote_storage=initialize_remote_storage,
            )

    def inspect(self, session_id: str) -> ProjectSessionResponse:
        with self._guard:
            active = self._require_session(session_id)
            document = self._load_document(active)
            return ProjectSessionResponse(session=active.state, document=document)

    def inspect_history(self, session_id: str) -> ProjectHistorySummary:
        """Return bounded process-local history without exposing reversible patches."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            return active.history.summary()

    def session_id_for_project(self, project_id: str) -> str:
        """Resolve one open project without exposing registry internals to APIs."""

        with self._guard:
            active = next(
                (
                    item
                    for item in self._sessions.values()
                    if item.state.project_id == project_id
                ),
                None,
            )
            if active is None:
                raise ProjectSessionError(
                    "canon_project_not_open",
                    project_id=project_id,
                )
            return active.state.session_id

    def capture_canon_input(
        self,
        session_id: str,
        *,
        rule_pack_version: int = 1,
    ) -> CanonCheckInput:
        """Capture the current authoritative working document for analysis."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            current = self._load_document(active)
            remote_head = active.remote_head
            if current.manifest.project_id != active.state.project_id:
                raise ProjectSessionError("canon_revision_stale")
        # Projection is pure and may run after releasing the session write lock.
        captured = CanonFactProjector().project(
            current,
            rule_pack_version=rule_pack_version,
        )
        return captured.model_copy(update={"remote_storage": remote_head})

    def capture_impact_input(
        self,
        session_id: str,
        request: ImpactAnalysisRequest,
    ) -> ImpactAnalysisInput:
        """Capture one working checksum without saving or entering repositories."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            document = self._load_document(active)
            history_revision = active.history.summary().history_revision
            self._require_impact_checkpoint(
                active,
                document,
                history_revision,
                request.observed_saved_revision,
                request.expected_history_revision,
                request.source_checksum,
            )
            return ImpactAnalysisInput(
                project_id=active.state.project_id,
                saved_revision=active.state.saved_revision,
                history_revision=history_revision,
                source_checksum=document.checksum,
                document=document,
                request=request,
                remote_storage=active.remote_head,
            )

    @contextmanager
    def impact_publication_guard(
        self,
        session_id: str,
        captured: ImpactAnalysisInput,
    ) -> Iterator[None]:
        """Serialize final validation and publication against lifecycle barriers."""

        with self._guard:
            active = self._require_session(session_id)
            with active.write_guard:
                document = self._load_document(active)
                if captured.remote_storage is not None and active.remote_head != captured.remote_storage:
                    raise ProjectSessionError("impact_run_stale")
                history_revision = active.history.summary().history_revision
                if active.state.project_id != captured.project_id:
                    raise ProjectSessionError(
                        "impact_run_stale",
                        expected_project_id=captured.project_id,
                        project_id=active.state.project_id,
                    )
                self._require_impact_checkpoint(
                    active,
                    document,
                    history_revision,
                    captured.saved_revision,
                    captured.history_revision,
                    captured.source_checksum,
                )
                yield

    @staticmethod
    def _require_impact_checkpoint(
        active: _ActiveSession,
        document: ProjectDocument,
        history_revision: int,
        expected_saved_revision: int,
        expected_history_revision: int,
        expected_checksum: str,
    ) -> None:
        if (
            active.state.saved_revision != expected_saved_revision
            or history_revision != expected_history_revision
            or document.checksum != expected_checksum
        ):
            raise ProjectSessionError(
                "impact_run_stale",
                expected_saved_revision=expected_saved_revision,
                saved_revision=active.state.saved_revision,
                expected_history_revision=expected_history_revision,
                history_revision=history_revision,
                expected_checksum=expected_checksum,
                document_checksum=document.checksum,
            )

    def reconcile_canon_issues(
        self,
        session_id: str,
        check_input: CanonCheckInput,
        candidates: Iterable[CanonIssueCandidate],
        *,
        checked_rule_ids: Iterable[str],
        disabled_rule_ids: Iterable[str] = (),
        observed_at: datetime,
        expected_history_revision: int | None = None,
        require_current_checkpoint: bool = False,
        scope: Iterable[CanonOwnerRef] = (),
    ) -> CanonIssueReconciliationResult:
        """Persist one complete result as a single reversible authoring command."""

        result: CanonIssueReconciliationResult | None = None
        with self.authoring_unit_of_work(
            session_id,
            command_kind="reconcile_canon_issues",
            label_key="history.command.reconcileCanonIssues",
            expected_history_revision=expected_history_revision,
            required_canon_input=check_input if require_current_checkpoint else None,
        ) as uow:
            result = CanonIssueReconciler().reconcile(
                uow,
                check_input,
                candidates,
                checked_rule_ids=checked_rule_ids,
                disabled_rule_ids=disabled_rule_ids,
                observed_at=observed_at,
                scope=scope,
            )
        assert result is not None
        return result

    def record_authoring_command(
        self,
        session_id: str,
        *,
        source: ProjectDocument,
        target: ProjectDocument,
        expected_history_revision: int,
        command_id: str,
        command_kind: str,
        label_key: str,
        label_parameters: dict[str, Any] | None = None,
    ) -> ProjectHistorySummary:
        """Record a committed mutation after verifying its authoritative target."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            current = self._load_document(active)
            if current.checksum != target.checksum:
                raise ProjectHistoryError(
                    "history_document_stale",
                    expected_checksum=target.checksum,
                    document_checksum=current.checksum,
                )
            summary = active.history.record(
                source,
                target,
                expected_history_revision=expected_history_revision,
                command_id=command_id,
                command_kind=command_kind,
                label_key=label_key,
                label_parameters=label_parameters,
            )
            self._notify_authoring_committed(active)
            return summary

    @remote_method
    def review_canon_fix(
        self,
        session_id: str,
        *,
        patch: ProjectPatch | None,
        audit: SuggestionEntity,
        expected_history_revision: int,
        approved: bool,
    ) -> ProjectHistoryMutationResponse:
        """Apply or reject one Canon proposal as a reversible authoring command."""

        with self._guard:
            active = self._require_session(session_id)
        try:
            with self.authoring_unit_of_work(
                session_id,
                command_kind="approve_canon_fix" if approved else "reject_canon_fix",
                label_key=(
                    "history.command.approveCanonFix"
                    if approved
                    else "history.command.rejectCanonFix"
                ),
                expected_history_revision=expected_history_revision,
            ) as uow:
                current = ProjectDocumentService().load(uow, active.manifest)
                if approved:
                    if patch is None:
                        raise ProjectSessionError("canon_suggestion_invalid")
                    candidate = apply_project_patch(current, patch)
                    ProjectDocumentService().reconcile(uow, candidate)
                    issue_id = audit.metadata.get("issue_id")
                    issue = uow.issues.get(issue_id) if isinstance(issue_id, str) else None
                    if issue is None:
                        raise ProjectSessionError("canon_issue_not_found", issue_id=issue_id)
                    metadata = parse_canon_issue_metadata(issue.metadata)
                    if metadata is None:
                        raise ProjectSessionError("canon_issue_metadata_invalid")
                    resolved_at = datetime.now(UTC)
                    uow.issues.update(replace(
                        issue,
                        status="resolved",
                        metadata=metadata.model_copy(update={
                            "resolved_at": resolved_at,
                            "resolution_reason": "suggestion_approved",
                        }).model_dump(mode="json"),
                        updated_at=resolved_at,
                    ))
                uow.suggestions.add(audit)
                uow.commit()
        except ProjectPatchError as error:
            raise ProjectSessionError(
                "canon_suggestion_stale",
                expected_checksum=patch.source_checksum if patch else None,
            ) from error
        return ProjectHistoryMutationResponse(
            project=self.inspect(session_id),
            history=self.inspect_history(session_id),
        )

    def list_impact_resolution_decisions(
        self,
        session_id: str,
    ) -> tuple[ImpactResolutionDecision, ...]:
        """Read ordered non-secret review memory without touching authoring state."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard, project_unit_of_work(active.session_factory, active.manifest) as uow:
            entities = sorted(
                uow.impact_resolution_decisions.list(project_id=active.state.project_id),
                key=lambda item: (item.decided_at, item.id),
            )
            return tuple(self._impact_decision_schema(item) for item in entities)

    @remote_method
    def approve_style_rewrite(
        self,
        session_id: str,
        *,
        patch: ProjectPatch,
        expected_history_revision: int,
        recommendation_id: str,
    ) -> ProjectHistoryMutationResponse:
        """Apply one runtime-validated text-only patch as a reversible command."""

        with self._guard:
            active = self._require_session(session_id)
        try:
            with self.authoring_unit_of_work(
                session_id,
                command_kind="approve_style_rewrite",
                label_key="history.command.approveStyleRewrite",
                expected_history_revision=expected_history_revision,
                label_parameters={"recommendation_id": recommendation_id},
            ) as uow:
                current = ProjectDocumentService().load(uow, active.manifest)
                if current.checksum != patch.source_checksum:
                    raise ProjectSessionError(
                        "style_rewrite_run_stale",
                        expected_checksum=patch.source_checksum,
                        document_checksum=current.checksum,
                    )
                candidate = apply_project_patch(current, patch)
                ProjectDocumentService().reconcile(uow, candidate)
                uow.commit()
        except ProjectPatchError as error:
            raise ProjectSessionError("style_rewrite_patch_invalid") from error
        return ProjectHistoryMutationResponse(
            project=self.inspect(session_id),
            history=self.inspect_history(session_id),
        )

    @remote_method
    def delete_style_profile(
        self,
        session_id: str,
        *,
        profile_id: str,
        replacement_profile_id: str | None,
        impact_reviewed: bool,
        expected_history_revision: int | None = None,
    ) -> ProjectHistoryMutationResponse:
        """Replace every manifest/Scene reference and delete in one history command."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            source = self._load_document(active)
            history_revision = active.history.summary().history_revision
            expected_revision = history_revision if expected_history_revision is None else expected_history_revision
            if expected_revision != history_revision:
                raise ProjectHistoryError(
                    "history_revision_stale",
                    expected_history_revision=expected_revision,
                    history_revision=history_revision,
                )
            candidate = StylePersistenceService().prepare_profile_deletion(
                source,
                profile_id=profile_id,
                replacement_profile_id=replacement_profile_id,
                impact_reviewed=impact_reviewed,
                now=datetime.now(UTC),
            )
            target = self._commit_history_document(active, candidate)
            history = active.history.record(
                source,
                target,
                expected_history_revision=expected_revision,
                command_id=str(uuid4()),
                command_kind="delete_style_profile",
                label_key="history.command.deleteStyleProfile",
            )
            self._notify_authoring_committed(active)
            return ProjectHistoryMutationResponse(
                project=ProjectSessionResponse(session=active.state, document=target),
                history=history,
            )

    @remote_method
    def accept_agent_memory_candidate(
        self,
        session_id: str,
        *,
        entry: AgentMemoryEntryV1,
        source_checksum: str,
        expected_history_revision: int,
    ) -> ProjectHistoryMutationResponse:
        """Persist one reviewed candidate as one reversible authoring command."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            source = self._load_document(active)
            history_revision = active.history.summary().history_revision
            if (
                source.checksum != source_checksum
                or history_revision != expected_history_revision
            ):
                raise ProjectSessionError(
                    "agent_memory_candidate_stale",
                    source_checksum=source.checksum,
                    history_revision=history_revision,
                )
            if entry.project_id != source.manifest.project_id:
                raise ProjectSessionError("agent_memory_candidate_stale")
            memories = list(source.agent_memories)
            if entry.supersedes_id is not None:
                index = next(
                    (
                        offset
                        for offset, memory in enumerate(memories)
                        if memory.id == entry.supersedes_id
                    ),
                    None,
                )
                if index is None:
                    raise ProjectSessionError("agent_memory_supersedes_missing")
                superseded = memories[index]
                if (
                    superseded.status != "active"
                    or superseded.agent_id != entry.agent_id
                    or superseded.content_locale != entry.content_locale
                    or superseded.scope != entry.scope
                ):
                    raise ProjectSessionError("agent_memory_supersedes_invalid")
                memories[index] = superseded.model_copy(
                    update={"status": "archived", "updated_at": entry.created_at}
                )
            memories.append(entry)
            # ProjectDocument canonicalization requires deterministic collection
            # order even when a reviewed candidate joins a populated catalog.
            memories.sort(key=lambda memory: memory.id)
            payload = source.model_dump(mode="python", exclude={"checksum"})
            target = create_project_document(**{**payload, "agent_memories": memories})
            committed = self._commit_history_document(active, target)
            history = active.history.record(
                source,
                committed,
                expected_history_revision=expected_history_revision,
                command_id=f"accept-agent-memory-{entry.id}",
                command_kind="accept_agent_memory_candidate",
                label_key="history.command.acceptAgentMemory",
            )
            self._notify_authoring_committed(active)
            return ProjectHistoryMutationResponse(
                project=ProjectSessionResponse(session=active.state, document=committed),
                history=history,
            )

    @remote_method
    def apply_agent_memory_command(
        self,
        session_id: str,
        command: AgentMemoryMutationCommandV1,
    ) -> AgentMemoryMutationResponseV1:
        """Delegate manual memory mutation to the bounded session collaborator."""

        return apply_agent_memory_command(self, session_id, command)

    @remote_method
    def apply_engine_tag_command(
        self,
        session_id: str,
        command: EngineTagMutationCommandV1,
    ) -> EngineTagMutationResponseV1:
        """Delegate registry writes to the shared project-session history owner."""

        return apply_engine_tag_command(self, session_id, command)

    @remote_method
    def review_impact_resolution(
        self,
        session_id: str,
        *,
        patch: ProjectPatch | None,
        decision: ImpactResolutionDecision,
        expected_history_revision: int,
    ) -> tuple[ImpactResolutionDecision, ProjectSessionResponse, ProjectHistorySummary]:
        """Persist one review and atomically apply an approved exact patch."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            before = self._load_document(active)
            history = active.history.summary()
            if history.history_revision != expected_history_revision:
                raise ProjectHistoryError(
                    "history_revision_stale",
                    expected_history_revision=expected_history_revision,
                    history_revision=history.history_revision,
                )
            if decision.source_checksum != before.checksum:
                raise ProjectSessionError(
                    "impact_resolution_patch_stale",
                    expected_checksum=decision.source_checksum,
                    document_checksum=before.checksum,
                )
            if decision.decision == "approved" and patch is None:
                raise ProjectSessionError("impact_resolution_patch_invalid")
            try:
                candidate = apply_project_patch(before, patch) if patch is not None else before
            except ProjectPatchError as error:
                raise ProjectSessionError("impact_resolution_patch_stale") from error

            entity = self._impact_decision_entity(active.state.project_id, decision)
            previous: ImpactResolutionDecisionEntity | None = None
            pruned: list[ImpactResolutionDecisionEntity] = []
            config_path = active.path / PROJECT_CONFIG_FILE
            marker_path = self._recovery_marker_path(active.path)
            persistence = capture_history_persistence(
                active.state,
                active.manifest,
                config_path,
                marker_path,
            )
            committed = False
            try:
                with project_unit_of_work(active.session_factory, active.manifest) as uow:
                    previous = uow.impact_resolution_decisions.get(entity.id)
                    if patch is not None:
                        ProjectDocumentService().reconcile(uow, candidate, commit=False)
                    if previous is None:
                        uow.impact_resolution_decisions.add(entity)
                    else:
                        uow.impact_resolution_decisions.update(entity)
                    records = sorted(
                        uow.impact_resolution_decisions.list(project_id=active.state.project_id),
                        key=lambda item: (item.decided_at, item.id),
                    )
                    for obsolete in records[:-MAX_IMPACT_RESOLUTION_DECISIONS]:
                        if obsolete.id != entity.id:
                            pruned.append(obsolete)
                            uow.impact_resolution_decisions.delete(obsolete.id)
                    uow.commit()
                committed = True
                after = self._load_document(active)
                if patch is not None:
                    self._mark_dirty(active)
                    active.history.record(
                        before,
                        after,
                        expected_history_revision=expected_history_revision,
                        command_id=f"impact-resolution-{entity.id}",
                        command_kind="approve_impact_resolution",
                        label_key="history.command.approveImpactResolution",
                    )
                    self._notify_authoring_committed(active)
                return decision, ProjectSessionResponse(session=active.state, document=after), active.history.summary()
            except Exception:
                if committed:
                    with project_unit_of_work(active.session_factory, active.manifest) as rollback_uow:
                        if patch is not None:
                            ProjectDocumentService().reconcile(rollback_uow, before, commit=False)
                        rollback_uow.impact_resolution_decisions.delete(entity.id)
                        if previous is not None:
                            rollback_uow.impact_resolution_decisions.add(previous)
                        for restored in pruned:
                            rollback_uow.impact_resolution_decisions.add(restored)
                        rollback_uow.commit()
                active.state = previous_state
                if marker_backup is None:
                    marker_path.unlink(missing_ok=True)
                else:
                    marker_path.write_bytes(marker_backup)
                raise

    @remote_method
    def undo_history(
        self,
        session_id: str,
        *,
        expected_history_revision: int,
    ) -> ProjectHistoryMutationResponse:
        return self._apply_history(session_id, "undo", expected_history_revision)

    @remote_method
    def redo_history(
        self,
        session_id: str,
        *,
        expected_history_revision: int,
    ) -> ProjectHistoryMutationResponse:
        return self._apply_history(session_id, "redo", expected_history_revision)

    def _apply_history(
        self,
        session_id: str,
        direction: str,
        expected_history_revision: int,
    ) -> ProjectHistoryMutationResponse:
        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            current = self._load_document(active)
            operation = active.history.undo if direction == "undo" else active.history.redo
            document, history = operation(
                current,
                expected_history_revision=expected_history_revision,
                commit=lambda candidate: self._commit_history_document(
                    active,
                    candidate,
                    current=current,
                ),
            )
            self._notify_authoring_committed(active)
            return ProjectHistoryMutationResponse(
                project=ProjectSessionResponse(session=active.state, document=document),
                history=history,
            )

    def _commit_history_document(
        self,
        active: _ActiveSession,
        candidate: ProjectDocument,
        *,
        current: ProjectDocument | None = None,
    ) -> ProjectDocument:
        """Reconcile data and manifest while retaining stack state on any failure."""

        if active.state.storage_mode == "postgresql":
            with project_unit_of_work(active.session_factory, active.manifest) as uow:
                result = reconcile_history_document(uow, candidate, current=current)
            active.manifest = candidate.manifest
            return result
        config_path = active.path / PROJECT_CONFIG_FILE
        marker_path = self._recovery_marker_path(active.path)
        persistence = capture_history_persistence(
            active.state,
            active.manifest,
            config_path,
            marker_path,
        )
        try:
            self._mark_dirty(active)
            if candidate.manifest != active.manifest:
                write_project_manifest(config_path, candidate.manifest)
            with project_unit_of_work(active.session_factory, active.manifest) as uow:
                reconciled = reconcile_history_document(uow, candidate, current=current)
            active.manifest = candidate.manifest
            self._sync_history_save_status(active, reconciled)
            return reconciled
        except Exception:
            active.state = persistence.state
            active.manifest = persistence.manifest
            restore_history_persistence(persistence, config_path, marker_path)
            raise

    def project_path(self, session_id: str) -> Path:
        with self._guard:
            return self._require_session(session_id).path

    def export_capture_token(self, session_id: str):
        """Called inside the existing document guard, never another full capture."""
        value = self._require_session(session_id).remote_head
        return ((value.storage_generation, value.authoring_revision, value.document_checksum)
                if value is not None else None)

    @contextmanager
    def readonly_document_guard(self, session_id: str, *, expected_remote=None) -> Iterator[tuple[ProjectDocument, Path]]:
        """Hold authoring publication while a read-only consumer verifies and publishes."""
        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            if active.state.storage_mode == "postgresql":
                from .remote_reads import document_guard
                with document_guard(active, expected_remote) as captured:
                    yield captured
                return
            yield self._load_document(active), active.path

    @remote_method
    def update_settings(
        self,
        session_id: str,
        *,
        name: str,
        description: str,
        settings: ProjectSettings,
        expected_history_revision: int | None = None,
    ) -> ProjectSessionResponse:
        """Publish checkpoint-backed settings as one reversible authoring command."""

        with self._guard:
            active = self._require_session(session_id)
        if active.state.storage_mode == "postgresql":
            from .remote_lifecycle import update_settings
            return update_settings(self, active, name=name, description=description, settings=settings,
                                   expected_history_revision=expected_history_revision)
        with active.write_guard, ownership_guard(active.session_factory):
            if settings.storage != active.manifest.settings.storage:
                raise ProjectSessionError(
                    "project_storage_migration_required",
                    current_mode=active.manifest.settings.storage.mode,
                    requested_mode=settings.storage.mode,
                )
            history_revision = active.history.summary().history_revision
            expected_revision = (
                history_revision
                if expected_history_revision is None
                else expected_history_revision
            )
            if expected_revision != history_revision:
                raise ProjectHistoryError(
                    "history_revision_stale",
                    expected_history_revision=expected_revision,
                    history_revision=history_revision,
                )
            source = self._load_document(active)
            if (
                name == active.manifest.name
                and description == active.manifest.description
                and settings == active.manifest.settings
            ):
                return ProjectSessionResponse(session=active.state, document=source)

            # Re-validate the complete manifest because Pydantic model_copy
            # intentionally does not validate update values.
            manifest = ProjectManifestV2.model_validate(
                {
                    **active.manifest.model_dump(),
                    "name": name,
                    "description": description,
                    "settings": settings,
                    "updated_at": datetime.now(UTC),
                }
            )
            target = self._document_with_manifest(source, manifest)
            config_path = active.path / PROJECT_CONFIG_FILE
            checkpoint_path = self._checkpoint_path(
                active.path,
                active.state.saved_revision,
            )
            checkpoint_config = checkpoint_path / PROJECT_CONFIG_FILE
            config_backup = config_path.read_bytes()
            checkpoint_backup = (
                checkpoint_config.read_bytes() if checkpoint_config.is_file() else None
            )
            previous_manifest = active.manifest
            previous_state = active.state
            previous_saved_checksum = active.saved_checksum
            try:
                write_project_manifest(config_path, manifest)
                if checkpoint_backup is not None:
                    write_project_manifest(checkpoint_config, manifest)
                    active.saved_checksum = self._load_checkpoint_document(
                        checkpoint_path,
                        manifest,
                    ).checksum
                active.manifest = manifest
                self._sync_history_save_status(active, target)
                active.history.record(
                    source,
                    target,
                    expected_history_revision=expected_revision,
                    command_id=str(uuid4()),
                    command_kind="update_project_settings",
                    label_key="history.command.updateProjectSettings",
                )
            except Exception as error:
                config_path.write_bytes(config_backup)
                if checkpoint_backup is not None:
                    checkpoint_config.write_bytes(checkpoint_backup)
                active.manifest = previous_manifest
                active.state = previous_state
                active.saved_checksum = previous_saved_checksum
                if isinstance(error, ProjectHistoryError):
                    raise
                raise ProjectSessionError("project_settings_save_failed") from error

            self._notify_authoring_committed(active)
            return ProjectSessionResponse(session=active.state, document=target)

    @remote_uow
    @contextmanager
    def unit_of_work(
        self,
        session_id: str,
        *,
        mark_dirty: bool = False,
    ) -> Iterator[SqlAlchemyUnitOfWork]:
        """Open a repository boundary against one runtime-owned project database."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            with project_unit_of_work(active.session_factory, active.manifest) as uow:
                yield uow
            if mark_dirty:
                self._mark_dirty(active)

    @remote_uow
    @contextmanager
    def authoring_unit_of_work(
        self,
        session_id: str,
        *,
        command_kind: str,
        label_key: str,
        expected_history_revision: int | None = None,
        label_parameters: dict[str, Any] | None = None,
        required_canon_input: CanonCheckInput | None = None,
    ) -> Iterator[SqlAlchemyUnitOfWork]:
        """Commit one core mutation and its history entry under the same session lock."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            before = self._load_document(active)
            if required_canon_input is not None:
                if required_canon_input.remote_storage is not None and active.remote_head != required_canon_input.remote_storage:
                    raise ProjectSessionError("canon_run_stale")
                if (
                    active.state.project_id != required_canon_input.project_id
                    or active.state.saved_revision != required_canon_input.saved_revision
                    or before.checksum != required_canon_input.source_checksum
                ):
                    raise ProjectSessionError(
                        "canon_run_stale",
                        expected_revision=required_canon_input.saved_revision,
                        current_revision=active.state.saved_revision,
                        expected_checksum=required_canon_input.source_checksum,
                        current_checksum=before.checksum,
                    )
            history_revision = active.history.summary().history_revision
            expected_revision = (
                history_revision
                if expected_history_revision is None
                else expected_history_revision
            )
            if expected_revision != history_revision:
                raise ProjectHistoryError(
                    "history_revision_stale",
                    expected_history_revision=expected_revision,
                    history_revision=history_revision,
                )
            config_path = active.path / PROJECT_CONFIG_FILE
            marker_path = self._recovery_marker_path(active.path)
            persistence = capture_history_persistence(
                active.state,
                active.manifest,
                config_path,
                marker_path,
            )
            mutation_completed = False
            try:
                with project_unit_of_work(active.session_factory, active.manifest) as uow:
                    yield uow
                mutation_completed = True
                after = self._load_document(active)
                if after.checksum == before.checksum:
                    return
                self._mark_dirty(active)
                active.history.record(
                    before,
                    after,
                    expected_history_revision=expected_revision,
                    command_id=str(uuid4()),
                    command_kind=command_kind,
                    label_key=label_key,
                    label_parameters=label_parameters,
                )
                self._notify_authoring_committed(active)
            except Exception as error:
                try:
                    try:
                        current = self._load_document(active)
                    except ProjectSessionError:
                        current = None
                    if current is None or current.checksum != before.checksum:
                        with project_unit_of_work(active.session_factory, active.manifest) as rollback_uow:
                            ProjectDocumentService().reconcile(rollback_uow, before)
                finally:
                    active.state = persistence.state
                    active.manifest = persistence.manifest
                    restore_history_persistence(
                        persistence,
                        config_path,
                        marker_path,
                    )
                if not mutation_completed:
                    raise
                if isinstance(error, (ProjectHistoryError, ProjectSessionError)):
                    raise
                raise ProjectHistoryError("history_record_invalid") from error

    def mark_dirty(self, session_id: str) -> None:
        """Record a successful authoring mutation without advancing save revision."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard:
            self._mark_dirty(active)
            self._notify_authoring_committed(active)

    @remote_method
    def save(
        self,
        session_id: str,
        *,
        expected_revision: int,
        reason: str,
    ) -> ProjectSessionResponse:
        """Create one revision checkpoint and atomically publish its manifest."""

        with self._guard:
            active = self._require_session(session_id)
            if active.state.storage_mode == "postgresql":
                from .remote_lifecycle import save_working
                return save_working(self, active, expected_revision)
            if active.state.save_status == "saving":
                raise ProjectSessionError("project_save_in_progress")
            if expected_revision != active.state.saved_revision:
                raise ProjectSessionError(
                    "project_save_revision_stale",
                    expected_revision=expected_revision,
                    saved_revision=active.state.saved_revision,
                )
            active.state = active.state.model_copy(
                update={"save_status": "saving", "save_error": None}
            )

        with active.write_guard:
            try:
                with ownership_guard(active.session_factory):
                    return self._save_owned(active, reason)
            except Exception:
                active.state = active.state.model_copy(
                    update={"save_status": "error", "save_error": "project_save_failed"}
                )
                raise

    def _save_owned(self, active, reason):
        staged_checkpoint = None
        try:
            source_document = self._load_document(active)
            now = datetime.now(UTC)
            next_revision = active.state.saved_revision + 1
            manifest = active.manifest.model_copy(
                update={"saved_revision": next_revision, "updated_at": now}
            )
            saved_document = self._document_with_manifest(source_document, manifest)
            rebased_history = active.history.rebased_for_save(
                source_document,
                saved_document,
            )
            staged_checkpoint = self._stage_checkpoint(active, manifest)
            checkpoint = self._checkpoint_path(active.path, next_revision)
            if checkpoint.exists():
                shutil.rmtree(checkpoint)
            staged_checkpoint.replace(checkpoint)
            staged_checkpoint = None
            write_project_manifest(active.path / PROJECT_CONFIG_FILE, manifest)
            active.manifest = manifest
            active.saved_checksum = saved_document.checksum
            active.history = rebased_history
            active.state = active.state.model_copy(
                update={
                    "loaded_revision": next_revision,
                    "saved_revision": next_revision,
                    "save_status": "clean",
                    "last_saved_at": now,
                    "save_error": None,
                }
            )
            self._recovery_marker_path(active.path).unlink(missing_ok=True)
            self._prune_checkpoints(active.path)
            # Saving rebases the document checksum and history baseline, so
            # every snapshot-bound process result must be reviewed afresh.
            self._notify_authoring_committed(active)
            return ProjectSessionResponse(session=active.state, document=saved_document)
        except Exception as error:
            if staged_checkpoint is not None:
                shutil.rmtree(staged_checkpoint, ignore_errors=True)
            active.state = active.state.model_copy(
                update={"save_status": "error", "save_error": "project_save_failed"}
            )
            if isinstance(error, ProjectSessionError):
                raise
            raise ProjectSessionError(
                "project_save_failed",
                reason=reason,
            ) from error

    def save_as(
        self,
        session_id: str,
        *,
        destination: Path,
        expected_revision: int,
        identity: str,
        replace_existing: bool,
    ) -> ProjectSessionSaveAsResponse:
        """Install a checkpoint-consistent, secret-free portable project copy."""

        with self._guard:
            active = self._require_session(session_id)
            if expected_revision != active.state.saved_revision:
                raise ProjectSessionError(
                    "project_save_revision_stale",
                    expected_revision=expected_revision,
                    saved_revision=active.state.saved_revision,
                )
            requires_save = active.state.save_status != "clean"
        if requires_save:
            self.save(
                session_id,
                expected_revision=expected_revision,
                reason="manual",
            )

        project_path = destination.expanduser().resolve()
        with self._guard:
            active = self._require_session(session_id)
            validate_save_as_destination(active.path, project_path)
            if project_path in self._paths:
                raise ProjectSessionError(
                    "project_already_open",
                    session_id=self._paths[project_path],
                )
        with active.write_guard, ownership_guard(active.session_factory):
            if active.state.save_status != "clean":
                raise ProjectSessionError(
                    "project_unsaved_changes",
                    save_status=active.state.save_status,
                )
            if project_path.exists() and not replace_existing:
                raise ProjectSessionError(
                    "project_save_as_destination_exists",
                    path=str(project_path),
                )
            validate_portable_assets(active.path, active.manifest.asset_paths)
            source_document = self._load_document(active)
            destination_project_id = (
                active.manifest.project_id
                if identity == "preserve"
                else str(uuid4())
            )
            if identity not in {"preserve", "regenerate"}:
                raise ProjectSessionError("project_save_as_identity_invalid")
            portable_settings = ProjectSettings.model_validate(
                {
                    **active.manifest.settings.model_dump(),
                    "storage": {
                        "mode": "local_sqlite",
                        "connection_profile_id": None,
                    },
                }
            )
            portable_manifest = ProjectManifestV2.model_validate(
                {
                    **active.manifest.model_dump(),
                    "project_id": destination_project_id,
                    "settings": portable_settings,
                    "updated_at": datetime.now(UTC),
                }
            )
            portable_document = self._document_with_project_identity(
                source_document,
                portable_manifest,
                active.manifest.project_id,
            )
            result = install_save_as_copy(
                active.path,
                active.state,
                project_path,
                portable_manifest,
                portable_document,
                replace_existing=replace_existing,
            )
            active.history.clear()
            # A clean Save As still clears history and crosses a project-copy
            # boundary. Dirty sessions were already invalidated by save().
            if not requires_save:
                self._notify_authoring_committed(active)
            return result

    @remote_method
    def discard(self, session_id: str) -> ProjectSessionResponse:
        """Restore the last successful checkpoint while retaining session ownership."""

        with self._guard:
            active = self._require_session(session_id)
        if active.state.storage_mode == "postgresql":
            from .remote_lifecycle import discard_working
            return discard_working(self, active)
        with active.write_guard:
            checkpoint = self._checkpoint_path(active.path, active.state.saved_revision)
            if not checkpoint.is_dir():
                raise ProjectSessionError(
                    "project_checkpoint_missing",
                    saved_revision=active.state.saved_revision,
                )
            manifest = self._read_manifest(checkpoint / PROJECT_CONFIG_FILE)
            if active.manifest.settings.storage.mode == "local_sqlite":
                active.engine.dispose()
                self._restore_local_checkpoint(active.path, checkpoint)
                # A checkpoint may predate runtime schema migrations. Upgrade
                # the restored copy before any repository reads reopen it.
                self._upgrade_database(
                    active.path / PROJECT_DATABASE_FILE,
                    project_path=active.path,
                    backup_existing=False,
                )
                engine = self._open_database(active.path / PROJECT_DATABASE_FILE)
                active.engine = engine
                active.session_factory = self._session_factory(engine)
            else:
                document = self._read_document_checkpoint(checkpoint)
                with project_unit_of_work(active.session_factory, active.manifest) as uow:
                    ProjectDocumentService().reconcile(uow, document)
                write_project_manifest(active.path / PROJECT_CONFIG_FILE, manifest)
            active.manifest = manifest
            active.state = active.state.model_copy(
                update={
                    "loaded_revision": manifest.saved_revision,
                    "saved_revision": manifest.saved_revision,
                    "save_status": "clean",
                    "last_saved_at": manifest.updated_at,
                    "save_error": None,
                }
            )
            self._recovery_marker_path(active.path).unlink(missing_ok=True)
            document = self._load_document(active)
            active.saved_checksum = document.checksum
            active.history.clear()
            self._notify_authoring_committed(active)
            return ProjectSessionResponse(session=active.state, document=document)

    @remote_method
    def migrate_storage(
        self,
        session_id: str,
        *,
        expected_revision: int,
        target_mode: str,
        target_profile_id: str | None,
    ) -> StorageMigrationResponse:
        """Copy, verify, and only then switch one session's storage authority."""

        with self._guard:
            active = self._require_session(session_id)
        with active.write_guard, ownership_guard(active.session_factory, retire_on_success=True):
            if active.state.save_status != "clean":
                raise ProjectSessionError(
                    "project_unsaved_changes",
                    save_status=active.state.save_status,
                )
            if expected_revision != active.state.saved_revision:
                raise ProjectSessionError(
                    "project_save_revision_stale",
                    expected_revision=expected_revision,
                    saved_revision=active.state.saved_revision,
                )
            current_storage = active.manifest.settings.storage
            if (
                target_mode == current_storage.mode
                and target_profile_id == current_storage.connection_profile_id
            ):
                raise ProjectSessionError("storage_migration_same_target")
            if target_mode == "local_sqlite" and target_profile_id is not None:
                raise ProjectSessionError("storage_migration_target_invalid")
            if target_mode == "postgresql" and not target_profile_id:
                raise ProjectSessionError("storage_migration_target_invalid")

            source_document = self._load_document(active)
            with project_unit_of_work(active.session_factory, active.manifest) as decision_uow:
                source_decisions = tuple(
                    self._impact_decision_schema(item)
                    for item in sorted(
                        decision_uow.impact_resolution_decisions.list(
                            project_id=active.state.project_id
                        ),
                        key=lambda item: (item.decided_at, item.id),
                    )
                )
            target_settings = ProjectSettings.model_validate(
                {
                    **active.manifest.settings.model_dump(),
                    "storage": {
                        "mode": target_mode,
                        "connection_profile_id": target_profile_id,
                    },
                }
            )
            target_manifest = ProjectManifestV2.model_validate(
                {
                    **active.manifest.model_dump(),
                    "settings": target_settings,
                    "updated_at": datetime.now(UTC),
                }
            )
            target_document = self._document_with_manifest(
                source_document,
                target_manifest,
            )
            source_factory = active.session_factory
            target_engine: Engine | None = None
            target_lease = None
            staged_checkpoint: Path | None = None
            checkpoint_backup: Path | None = None
            checkpoint = self._checkpoint_path(
                active.path,
                active.state.saved_revision,
            )
            config_path = active.path / PROJECT_CONFIG_FILE
            original_config = config_path.read_bytes()
            try:
                target_engine = prepare_migration_target(
                    active.path,
                    target_manifest,
                    self._storage_profiles,
                )
                target_factory = self._session_factory(target_engine)
                with project_unit_of_work(target_factory, target_manifest) as uow:
                    if target_mode == "postgresql":
                        target_lease = provision_target(uow, target_factory, target_document, active.path)
                    admit_migration_target(uow, target_document, active.path,
                        shared=target_mode == "postgresql", decisions=source_decisions,
                        newly_provisioned=target_lease is not None and target_lease.provisioned_project)
                    copied = ProjectDocumentService().reconcile(
                        uow, target_document, commit=False
                    )
                    for existing in uow.impact_resolution_decisions.list(
                        project_id=target_manifest.project_id
                    ):
                        uow.impact_resolution_decisions.delete(existing.id)
                    for decision in source_decisions:
                        uow.impact_resolution_decisions.add(
                            self._impact_decision_entity(target_manifest.project_id, decision)
                        )
                    uow.commit()
                if target_lease is not None:
                    target_lease.start()
                if copied.checksum != target_document.checksum:
                    raise ProjectSessionError("storage_migration_checksum_mismatch")
                record_count = self._document_record_count(copied)
                if record_count != self._document_record_count(target_document):
                    raise ProjectSessionError("storage_migration_count_mismatch")

                target_active = _ActiveSession(
                    state=active.state.model_copy(
                        update={"storage_mode": target_mode}
                    ),
                    path=active.path,
                    manifest=target_manifest,
                    engine=target_engine,
                    session_factory=target_factory,
                )
                staged_checkpoint = self._stage_checkpoint(
                    target_active,
                    target_manifest,
                )
                if checkpoint.exists():
                    checkpoint_backup = checkpoint.with_name(
                        f".{checkpoint.name}.migration-{uuid4().hex}.bak"
                    )
                    checkpoint.replace(checkpoint_backup)
                staged_checkpoint.replace(checkpoint)
                staged_checkpoint = None
                if current_transaction(active.session_factory) is None:
                    write_project_manifest(config_path, target_manifest)

                active.engine = target_engine
                active.session_factory = target_factory
                active.manifest = target_manifest
                active.state = active.state.model_copy(
                    update={"storage_mode": target_mode}
                )
                if target_mode == "local_sqlite":
                    active.state = ProjectSessionState.model_validate(active.state.model_dump(
                        exclude={"session_version", "remote_storage", "remote_state"}))
                active.saved_checksum = copied.checksum
                if target_mode == "postgresql" and current_transaction(target_factory) is None and current_transaction(source_factory) is None:
                    from .remote_files import publish_local
                    publish_local(active, profile_id=target_profile_id)
                active.history.clear()
                target_engine = None
                if checkpoint_backup is not None:
                    shutil.rmtree(checkpoint_backup, ignore_errors=True)
                # Storage replacement preserves authored records but replaces
                # their authoritative repository and history baseline.
                self._notify_authoring_committed(active)
                return StorageMigrationResponse(
                    source_mode=current_storage.mode,
                    target_mode=target_mode,
                    verified_checksum=copied.checksum,
                    record_count=record_count,
                    project=ProjectSessionResponse(
                        session=active.state,
                        document=copied,
                    ),
                )
            except (ProjectSessionError, StorageProfileError):
                config_path.write_bytes(original_config)
                if checkpoint_backup is not None and checkpoint_backup.exists():
                    shutil.rmtree(checkpoint, ignore_errors=True)
                    checkpoint_backup.replace(checkpoint)
                raise
            except Exception as error:
                config_path.write_bytes(original_config)
                if checkpoint_backup is not None and checkpoint_backup.exists():
                    shutil.rmtree(checkpoint, ignore_errors=True)
                    checkpoint_backup.replace(checkpoint)
                raise ProjectSessionError("storage_migration_failed") from error
            finally:
                if target_engine is not None:
                    if target_lease is not None:
                        close_remote(target_factory)
                    target_engine.dispose()
                if staged_checkpoint is not None:
                    shutil.rmtree(staged_checkpoint, ignore_errors=True)

    def close(self, session_id: str) -> ProjectSessionResponse:
        from .closing import close_project
        return close_project(self, session_id)

    def exit(self, session_id: str, *, expected_revision: int) -> ProjectSessionState:
        """Preserve a confirmed page exit before releasing its runtime lock."""

        with self._guard:
            active = self._require_session(session_id)
            blocked = active.state.storage_mode == "postgresql" and active.remote_state != "ready"
        if blocked:
            return self.close(session_id).session
        with self._guard:
            active = self._require_session(session_id)
            if active.state.save_status == "saving":
                raise ProjectSessionError("project_save_in_progress")
            if expected_revision != active.state.saved_revision:
                raise ProjectSessionError(
                    "project_save_revision_stale",
                    expected_revision=expected_revision,
                    saved_revision=active.state.saved_revision,
                )
            requires_save = active.state.save_status != "clean"

        # Save and close retain their normal guards and error semantics. A
        # concurrent mutation between them makes Close fail instead of losing it.
        if requires_save:
            self.save(
                session_id,
                expected_revision=expected_revision,
                reason="close",
            )
        return self.close(session_id).session

    def close_all(self) -> None:
        from .closing import close_project
        with self._guard:
            session_ids = list(self._sessions)
        for session_id in session_ids:
            try:
                close_project(self, session_id, shutdown=True)
            except ProjectSessionError as error:
                if error.code != "project_session_not_found":
                    raise

    def _open_locked(self, *args, **kwargs):
        from .opening import open_locked

        return open_locked(self, *args, active_session_type=_ActiveSession, **kwargs)

    def _prepare_recovery(self, project_path: Path, recovery_mode: str) -> str:
        marker_path = self._recovery_marker_path(project_path)
        if not marker_path.is_file():
            return "none"
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            base_revision = marker["base_revision"]
            if isinstance(base_revision, bool) or not isinstance(base_revision, int):
                raise ValueError
        except (OSError, json.JSONDecodeError, KeyError, ValueError, TypeError) as error:
            raise ProjectSessionError("project_recovery_invalid") from error
        if recovery_mode == "cancel":
            raise ProjectSessionError(
                "project_recovery_required",
                saved_revision=base_revision,
            )
        if recovery_mode == "last_saved":
            checkpoint = self._checkpoint_path(project_path, base_revision)
            if not checkpoint.is_dir():
                raise ProjectSessionError(
                    "project_checkpoint_missing",
                    saved_revision=base_revision,
                )
            if (checkpoint / PROJECT_DATABASE_FILE).is_file():
                self._restore_local_checkpoint(project_path, checkpoint)
                action = "none"
            elif (checkpoint / PROJECT_DOCUMENT_CHECKPOINT_FILE).is_file():
                write_project_manifest(
                    project_path / PROJECT_CONFIG_FILE,
                    self._read_manifest(checkpoint / PROJECT_CONFIG_FILE),
                )
                action = "last_saved_external"
            else:
                raise ProjectSessionError("project_checkpoint_invalid")
            marker_path.unlink(missing_ok=True)
            return action
        if recovery_mode == "recover":
            return "recover"
        raise ProjectSessionError("project_recovery_mode_invalid")

    def _load_document(self, active: _ActiveSession) -> ProjectDocument:
        if active.state.storage_mode == "postgresql":
            from .remote_store import capture
            from .remote_files import sync_active
            document, row = capture(active.session_factory, active.manifest.project_id, manifest=active.manifest)
            if current_transaction(active.session_factory) is None:
                sync_active(active, document, row)
            return document
        try:
            with project_unit_of_work(active.session_factory, active.manifest) as uow:
                return ProjectDocumentService().load(uow, active.manifest)
        except (ProjectDocumentError, ValidationError) as error:
            raise ProjectSessionError(
                "project_document_invalid",
                project_id=active.manifest.project_id,
            ) from error

    def _mark_dirty(self, active: _ActiveSession) -> None:
        active.state = active.state.model_copy(
            update={"save_status": "dirty", "save_error": None}
        )
        if active.state.storage_mode == "postgresql":
            return
        marker = self._recovery_marker_path(active.path)
        temporary = marker.with_suffix(".tmp")
        temporary.write_text(
            json.dumps(
                {
                    "recovery_version": 1,
                    "session_id": active.state.session_id,
                    "base_revision": active.state.saved_revision,
                    "marked_at": datetime.now(UTC).isoformat(),
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        temporary.replace(marker)

    @staticmethod
    def _impact_decision_entity(
        project_id: str,
        decision: ImpactResolutionDecision,
    ) -> ImpactResolutionDecisionEntity:
        identity = sha256(
            f"{project_id}:{decision.source_checksum}:{decision.proposal_semantic_fingerprint}".encode("utf-8")
        ).hexdigest()
        return ImpactResolutionDecisionEntity(
            id=f"impact-decision-{identity[:24]}",
            project_id=project_id,
            finding_fingerprints=list(decision.finding_fingerprints),
            proposal_semantic_fingerprint=decision.proposal_semantic_fingerprint,
            source_checksum=decision.source_checksum,
            decision=decision.decision,
            decided_at=decision.decided_at,
            decision_version=decision.decision_version,
            created_at=decision.decided_at,
            updated_at=decision.decided_at,
        )

    @staticmethod
    def _impact_decision_schema(
        entity: ImpactResolutionDecisionEntity,
    ) -> ImpactResolutionDecision:
        return ImpactResolutionDecision(
            decision_version=entity.decision_version,
            finding_fingerprints=entity.finding_fingerprints,
            proposal_semantic_fingerprint=entity.proposal_semantic_fingerprint,
            source_checksum=entity.source_checksum,
            decision=entity.decision,
            decided_at=entity.decided_at,
        )

    def _sync_history_save_status(
        self,
        active: _ActiveSession,
        document: ProjectDocument,
    ) -> None:
        """Derive clean/dirty state from the successful checkpoint checksum."""

        if active.saved_checksum is not None and document.checksum == active.saved_checksum:
            active.state = active.state.model_copy(
                update={"save_status": "clean", "save_error": None}
            )
            self._recovery_marker_path(active.path).unlink(missing_ok=True)
            return
        active.state = active.state.model_copy(
            update={"save_status": "dirty", "save_error": None}
        )

    def _notify_authoring_committed(self, active: _ActiveSession) -> None:
        """Invalidate process-local readers only after an authoring commit succeeds."""

        from .remote_context import request_intent, transaction
        intent = request_intent.get()
        if (intent.transaction if intent is not None else transaction.get()) is not None:
            return
        if self._on_authoring_committed is not None:
            self._on_authoring_committed(active.manifest.project_id)

    def _stage_checkpoint(
        self,
        active: _ActiveSession,
        manifest: ProjectManifestV2,
    ) -> Path:
        return stage_checkpoint(active.path, active.session_factory, manifest)

    def _ensure_checkpoint(self, active: _ActiveSession) -> None:
        checkpoint = checkpoint_path(active.path, active.manifest.saved_revision)
        if checkpoint.is_dir():
            return
        staged = stage_checkpoint(active.path, active.session_factory, active.manifest)
        staged.replace(checkpoint)
        prune_checkpoints(active.path)

    def _prepare_manifest(
        self,
        raw: dict[str, object],
        database_path: Path,
    ) -> tuple[ProjectManifestV2, bool]:
        version = raw.get("format_version")
        if isinstance(version, bool) or not isinstance(version, int):
            raise ProjectSessionError("project_format_version_invalid")
        try:
            if version == PROJECT_FORMAT_VERSION:
                manifest = parse_project_manifest(raw)
                return (
                    manifest,
                    raw.get("settings_version", 1) != PROJECT_SETTINGS_VERSION,
                )
            if version == 1:
                project_id = self._legacy_project_id(database_path) or str(uuid4())
                return (
                    migrate_project_manifest_v1(
                        raw,
                        project_id=project_id,
                        migration_time=datetime.now(UTC),
                    ),
                    True,
                )
            if version > PROJECT_FORMAT_VERSION:
                raise ProjectSessionError(
                    "project_format_future",
                    format_version=version,
                    supported_version=PROJECT_FORMAT_VERSION,
                )
            raise ProjectSessionError(
                "project_format_unsupported",
                format_version=version,
            )
        except (ProjectManifestError, ValidationError) as error:
            raise ProjectSessionError("project_manifest_invalid") from error

    @staticmethod
    def _read_raw_manifest(config_path: Path) -> dict[str, object]:
        try:
            return read_project_config_payload(config_path)
        except ProjectFormatError as error:
            raise ProjectSessionRegistry._format_error(error) from error

    @staticmethod
    def _legacy_project_id(database_path: Path) -> str | None:
        try:
            with sqlite3.connect(database_path) as connection:
                has_projects = connection.execute(
                    "select 1 from sqlite_master where type='table' and name='projects'"
                ).fetchone()
                if has_projects is None:
                    return None
                project_ids = [
                    str(row[0])
                    for row in connection.execute("select id from projects limit 2").fetchall()
                ]
        except sqlite3.DatabaseError as error:
            raise ProjectSessionError("project_database_invalid") from error
        if len(project_ids) > 1:
            raise ProjectSessionError("project_database_multiple_roots")
        return project_ids[0] if project_ids else None

    def _acquire_lock(
        self,
        project_path: Path,
        project_id: str,
        session_id: str,
        *,
        recover_stale_lock: bool,
        expected_lock_session_id: str | None = None,
    ) -> None:
        lock_path = self._lock_path(project_path)
        payload = {
            "lock_version": LOCK_VERSION,
            "session_id": session_id,
            "project_id": project_id,
            "runtime_instance_id": self._runtime_instance_id,
            "pid": os.getpid(),
            "opened_at": datetime.now(UTC).isoformat(),
        }
        for _ in range(2):
            try:
                with lock_path.open("x", encoding="utf-8") as lock_file:
                    json.dump(payload, lock_file, indent=2, sort_keys=True)
                    lock_file.write("\n")
                return
            except FileExistsError:
                existing = self._read_lock(lock_path)
                pid = existing.get("pid")
                if isinstance(pid, bool) or not isinstance(pid, int):
                    raise ProjectSessionError("project_lock_invalid")
                same_orphaned_session = (
                    pid == os.getpid()
                    and expected_lock_session_id is not None
                    and existing.get("session_id") == expected_lock_session_id
                )
                if self._process_alive(pid) and not (
                    recover_stale_lock and same_orphaned_session
                ):
                    raise ProjectSessionError(
                        "project_locked",
                        owner_pid=pid,
                        owner_session_id=str(existing.get("session_id", "")),
                    )
                if not recover_stale_lock:
                    raise ProjectSessionError(
                        "project_lock_stale",
                        owner_pid=pid,
                    )
                try:
                    lock_path.unlink()
                except OSError as error:
                    raise ProjectSessionError("project_lock_recovery_failed") from error
        raise ProjectSessionError("project_lock_race")

    @staticmethod
    def _read_lock(lock_path: Path) -> dict[str, object]:
        try:
            payload = json.loads(lock_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ProjectSessionError("project_lock_invalid") from error
        if not isinstance(payload, dict):
            raise ProjectSessionError("project_lock_invalid")
        return payload

    @staticmethod
    def _process_alive(pid: int) -> bool:
        if pid <= 0:
            return False
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _release_lock(self, project_path: Path, session_id: str) -> None:
        lock_path = self._lock_path(project_path)
        if not lock_path.exists():
            return
        try:
            payload = self._read_lock(lock_path)
            if payload.get("session_id") == session_id:
                lock_path.unlink()
        except ProjectSessionError:
            # Never remove a lock whose ownership cannot be proven.
            return

    @staticmethod
    def _lock_path(project_path: Path) -> Path:
        return project_path / "cache" / LOCK_FILENAME

    @staticmethod
    def _require_structure(project_path: Path) -> None:
        if project_path.suffix != PROJECT_SUFFIX:
            raise ProjectSessionError(
                "project_suffix_invalid",
                required_suffix=PROJECT_SUFFIX,
            )
        if not project_path.is_dir():
            raise ProjectSessionError("project_folder_not_found")
        missing: list[str] = []
        for filename in (PROJECT_DATABASE_FILE, PROJECT_CONFIG_FILE):
            if not (project_path / filename).is_file():
                missing.append(filename)
        for directory in PROJECT_DIRECTORIES:
            if not (project_path / directory).is_dir():
                missing.append(f"{directory}/")
        if missing:
            raise ProjectSessionError("project_structure_incomplete", missing=missing)

    def _require_path_available(self, project_path: Path) -> None:
        if project_path in self._paths:
            raise ProjectSessionError(
                "project_already_open",
                session_id=self._paths[project_path],
            )

    def _require_session(self, session_id: str) -> _ActiveSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise ProjectSessionError(
                "project_session_not_found",
                session_id=session_id,
            )
        return session

    @staticmethod
    def _backup_project_for_migration(project_path: Path, project_id: str) -> Path:
        backup_path = (
            project_path
            / "snapshots"
            / f"format-v1-backup-{project_id}-{uuid4().hex[:8]}"
        )
        backup_path.mkdir(parents=False, exist_ok=False)
        shutil.copy2(project_path / PROJECT_CONFIG_FILE, backup_path / PROJECT_CONFIG_FILE)
        shutil.copy2(project_path / PROJECT_DATABASE_FILE, backup_path / PROJECT_DATABASE_FILE)
        return backup_path

    @staticmethod
    def _restore_migration_backup(project_path: Path, backup_path: Path) -> None:
        shutil.copy2(backup_path / PROJECT_CONFIG_FILE, project_path / PROJECT_CONFIG_FILE)
        shutil.copy2(backup_path / PROJECT_DATABASE_FILE, project_path / PROJECT_DATABASE_FILE)

    @staticmethod
    def _format_error(error: ProjectFormatError) -> ProjectSessionError:
        return ProjectSessionError(
            "project_format_invalid",
            missing=error.missing,
        )
