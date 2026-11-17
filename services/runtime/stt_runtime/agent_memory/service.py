"""Pure manual Agent Memory authoring and reviewed deletion impact."""

from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
import json
from typing import Callable

from ..schemas.agent_memory import (
    AgentMemoryCatalogV1,
    AgentMemoryDeletionImpactV1,
    AgentMemoryEntryV1,
    AgentMemoryMutationCommandV1,
)
from ..schemas.project_document import ProjectDocument, create_project_document


class AgentMemoryPersistenceError(ValueError):
    """Expose stable authoring failures without returning rejected memory prose."""

    def __init__(self, code: str, **parameters: object) -> None:
        super().__init__(code)
        self.code = code
        self.parameters = parameters


class AgentMemoryService:
    """Apply one validated memory command to an immutable project document."""

    def __init__(
        self,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._clock = clock

    def catalog(self, document: ProjectDocument) -> AgentMemoryCatalogV1:
        """Return only portable records already validated by ProjectDocument."""

        return AgentMemoryCatalogV1(
            project_id=document.manifest.project_id,
            entries=tuple(document.agent_memories),
        )

    def deletion_impact(
        self,
        document: ProjectDocument,
        memory_id: str,
    ) -> AgentMemoryDeletionImpactV1:
        """Describe the exact supersession links that deletion will rebase."""

        memory = self._find(document, memory_id)
        successor_ids = tuple(sorted(
            item.id
            for item in document.agent_memories
            if item.supersedes_id == memory.id
        ))
        payload = {
            "project_id": document.manifest.project_id,
            "memory_id": memory.id,
            "direct_successor_ids": successor_ids,
            "rebase_to_id": memory.supersedes_id,
        }
        fingerprint = sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
        return AgentMemoryDeletionImpactV1(
            **payload,
            impact_fingerprint=fingerprint,
        )

    def apply(
        self,
        document: ProjectDocument,
        command: AgentMemoryMutationCommandV1,
    ) -> tuple[ProjectDocument, AgentMemoryEntryV1 | None]:
        """Return a validated replacement document without owning persistence."""

        if document.checksum != command.expected_source_checksum:
            raise AgentMemoryPersistenceError(
                "agent_memory_resolution_stale",
                source_checksum=document.checksum,
            )
        memories = list(document.agent_memories)
        existing = next(
            (item for item in memories if item.id == command.memory_id),
            None,
        )
        now = self._clock()
        result: AgentMemoryEntryV1 | None
        if command.action == "create":
            if existing is not None or command.entry is None:
                raise AgentMemoryPersistenceError("agent_memory_duplicate")
            result = self._normalize_created(document, command.entry, now)
            memories.append(result)
        else:
            if existing is None:
                raise AgentMemoryPersistenceError(
                    "agent_memory_not_found",
                    memory_id=command.memory_id,
                )
            index = memories.index(existing)
            if command.action == "update":
                assert command.entry is not None
                result = self._normalize_updated(existing, command.entry, now)
                memories[index] = result
            elif command.action in {"archive", "restore"}:
                result = AgentMemoryEntryV1.model_validate({
                    **existing.model_dump(mode="python"),
                    "scope": existing.scope.model_dump(mode="json"),
                    "status": "archived" if command.action == "archive" else "active",
                    "updated_at": now,
                })
                memories[index] = result
            else:
                impact = self.deletion_impact(document, existing.id)
                if command.reviewed_impact_fingerprint != impact.impact_fingerprint:
                    raise AgentMemoryPersistenceError(
                        "agent_memory_delete_impact_stale",
                        memory_id=existing.id,
                    )
                memories = [
                    self._rebase_successor(item, existing, now)
                    if item.supersedes_id == existing.id
                    else item
                    for item in memories
                    if item.id != existing.id
                ]
                result = None
        payload = document.model_dump(mode="python", exclude={"checksum"})
        target = create_project_document(**{**payload, "agent_memories": memories})
        return target, result

    @staticmethod
    def _normalize_created(
        document: ProjectDocument,
        entry: AgentMemoryEntryV1,
        now: datetime,
    ) -> AgentMemoryEntryV1:
        if entry.project_id != document.manifest.project_id or entry.status != "active":
            raise AgentMemoryPersistenceError("agent_memory_invalid")
        return AgentMemoryEntryV1.model_validate({
            **entry.model_dump(mode="python"),
            "scope": entry.scope.model_dump(mode="json"),
            "supersedes_id": None,
            "created_at": now,
            "updated_at": now,
        })

    @staticmethod
    def _normalize_updated(
        existing: AgentMemoryEntryV1,
        entry: AgentMemoryEntryV1,
        now: datetime,
    ) -> AgentMemoryEntryV1:
        if entry.id != existing.id or entry.project_id != existing.project_id:
            raise AgentMemoryPersistenceError("agent_memory_invalid")
        return AgentMemoryEntryV1.model_validate({
            **entry.model_dump(mode="python"),
            "scope": entry.scope.model_dump(mode="json"),
            "status": existing.status,
            "supersedes_id": existing.supersedes_id,
            "created_at": existing.created_at,
            "updated_at": now,
        })

    @staticmethod
    def _rebase_successor(
        successor: AgentMemoryEntryV1,
        deleted: AgentMemoryEntryV1,
        now: datetime,
    ) -> AgentMemoryEntryV1:
        """Keep surviving history connected after a reviewed middle-entry delete."""

        return AgentMemoryEntryV1.model_validate({
            **successor.model_dump(mode="python"),
            "scope": successor.scope.model_dump(mode="json"),
            "supersedes_id": deleted.supersedes_id,
            "updated_at": now,
        })

    @staticmethod
    def _find(document: ProjectDocument, memory_id: str) -> AgentMemoryEntryV1:
        memory = next(
            (item for item in document.agent_memories if item.id == memory_id),
            None,
        )
        if memory is None:
            raise AgentMemoryPersistenceError(
                "agent_memory_not_found",
                memory_id=memory_id,
            )
        return memory
