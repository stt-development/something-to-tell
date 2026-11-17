"""Process-local export plan lifecycle and checksum-bound write orchestration."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
import re
from threading import RLock
from typing import ContextManager, Literal, Protocol
import unicodedata

from ..schemas.export import (
    ExportOptionsV1,
    ExportPlanRequestV1,
    ExportPlanV1,
    ExportPreviewV1,
    ExportWriteRequestV1,
    ExportWriteResultV1,
)
from ..schemas.project_document import ProjectDocument
from .errors import ExportOperationError
from .executable_projection import ExecutableProjectionService
from .ink import InkExportService
from .projection import ExportProjectionService
from .serialization import ExportSerializationError, ExportSerializationService
from .writer import AtomicExportWriter
from .yarn_spinner import YarnSpinnerExportService


class ProjectSessionExportAuthority(Protocol):
    """Read-only session surface required by the export lifecycle."""

    def readonly_document_guard(
        self,
        session_id: str,
        *, expected_remote=None,
    ) -> ContextManager[tuple[ProjectDocument, Path]]:
        """Hold authoring publication around final source validation."""


@dataclass(slots=True)
class _ExportPlanRecord:
    plan: ExportPlanV1
    payload: bytes
    state: Literal["ready", "writing", "written", "stale"] = "ready"
    remote_token: tuple[str, str, str] | None = None


class ExportCoordinator:
    """Build transient previews and install only matching serialized plans."""

    def __init__(
        self,
        sessions: ProjectSessionExportAuthority,
        *,
        projection: ExportProjectionService | None = None,
        executable_projection: ExecutableProjectionService | None = None,
        serialization: ExportSerializationService | None = None,
        yarn_spinner: YarnSpinnerExportService | None = None,
        ink: InkExportService | None = None,
        writer: AtomicExportWriter | None = None,
    ) -> None:
        self._sessions = sessions
        self._projection = projection or ExportProjectionService()
        self._executable_projection = executable_projection or ExecutableProjectionService()
        self._serialization = serialization or ExportSerializationService()
        self._yarn_spinner = yarn_spinner or YarnSpinnerExportService()
        self._ink = ink or InkExportService()
        self._writer = writer or AtomicExportWriter()
        self._plans: dict[str, _ExportPlanRecord] = {}
        self._lock = RLock()

    def plan(self, session_id: str, request: ExportPlanRequestV1) -> ExportPlanV1:
        """Capture, project, serialize, and retain one transient write plan."""

        with self._sessions.readonly_document_guard(session_id) as (document, _):
            build = self._projection.build(document, request.options)
            # Production authority supplies the capture token while the SHARE
            # guard is held. Test/local authorities need no remote capability.
            getter = getattr(self._sessions, "export_capture_token", None)
            token = getter(session_id) if getter is not None else None
        if request.options.format in {"yarn_spinner", "ink"}:
            adapter = self._ink if request.options.format == "ink" else self._yarn_spinner
            rendered = adapter.build(
                self._executable_projection.build(build.projection)
            )
            payload = rendered.payload or b""
            diagnostics = list(rendered.diagnostics)
            media_type = adapter.media_type
        else:
            try:
                payload = self._serialization.serialize(
                    request.options.format,
                    build.projection,
                )
            except ExportSerializationError as error:
                raise ExportOperationError(error.code) from error
            diagnostics = build.projection.diagnostics
            media_type = (
                "application/json"
                if request.options.format == "json"
                else "application/yaml"
            )
        source = build.projection.manifest.source
        filename = self._suggested_filename(source.project_name, request.options)
        fingerprint = self._fingerprint(
            request.options,
            source.source_checksum,
            filename,
            payload,
        )
        preview_text = self._preview_text(payload, request.options.preview_max_bytes)
        plan = ExportPlanV1(
            options=request.options,
            source=source,
            inventory=build.inventory,
            diagnostics=diagnostics,
            preview=ExportPreviewV1(
                media_type=media_type,
                text=preview_text,
                preview_bytes=len(preview_text.encode("utf-8")),
                total_bytes=len(payload),
                truncated=len(preview_text.encode("utf-8")) < len(payload),
            ),
            suggested_filename=filename,
            plan_fingerprint=fingerprint,
            can_write=not any(item.severity == "error" for item in diagnostics),
        )
        with self._lock:
            existing = self._plans.get(session_id)
            if existing is not None and existing.state == "writing":
                raise ExportOperationError("export_plan_stale")
            self._plans[session_id] = _ExportPlanRecord(plan=plan, payload=payload, remote_token=token)
        return plan

    def write(
        self,
        session_id: str,
        request: ExportWriteRequestV1,
    ) -> ExportWriteResultV1:
        """Install one exact plan after current-source and concurrency checks."""

        with self._lock:
            record = self._plans.get(session_id)
            if (
                record is None
                or record.plan.plan_fingerprint != request.expected_plan_fingerprint
                or record.plan.options != request.options
                or record.state != "ready"
            ):
                raise ExportOperationError("export_plan_stale")
            if not record.plan.can_write:
                raise ExportOperationError("export_contract_invalid")
            record.state = "writing"

        try:
            expected = record.plan.source.source_checksum
            guard_options = {"expected_remote": record.remote_token} if record.remote_token is not None else {}
            with self._sessions.readonly_document_guard(session_id, **guard_options) as (
                document,
                project_path,
            ):
                if (
                    request.expected_source_checksum != expected
                    or document.checksum != expected
                ):
                    raise ExportOperationError(
                        "export_source_stale",
                        expected_checksum=expected,
                        current_checksum=document.checksum,
                    )
                directory = (
                    Path(request.destination_directory)
                    if request.destination_directory is not None
                    else project_path / "exports"
                )
                artifact = self._writer.install(
                    payload=record.payload,
                    destination_directory=directory,
                    filename=record.plan.suggested_filename,
                    format=request.options.format,
                    source_checksum=expected,
                    overwrite=request.overwrite,
                )
        except Exception as error:
            with self._lock:
                record.state = (
                    "stale"
                    if isinstance(error, ExportOperationError)
                    and error.code in {"export_source_stale", "export_plan_stale"}
                    else "ready"
                )
            raise
        with self._lock:
            record.state = "written"
        return ExportWriteResultV1(artifact=artifact)

    def clear_session(self, session_id: str, _: str | None = None) -> None:
        with self._lock:
            self._plans.pop(session_id, None)

    def clear_all(self) -> None:
        with self._lock:
            self._plans.clear()

    @staticmethod
    def _preview_text(payload: bytes, limit: int) -> str:
        prefix = payload[:limit]
        while prefix:
            try:
                return prefix.decode("utf-8")
            except UnicodeDecodeError as error:
                prefix = prefix[:error.start]
        return ""

    @staticmethod
    def _suggested_filename(project_name: str, options: ExportOptionsV1) -> str:
        normalized = unicodedata.normalize("NFKD", project_name).encode("ascii", "ignore").decode()
        slug = re.sub(r"[^A-Za-z0-9._-]+", "-", normalized).strip(".-_").lower()
        extension = {
            "json": ".json",
            "yaml": ".yaml",
            "yarn_spinner": ".yarn",
            "ink": ".ink",
        }[options.format]
        maximum = 160 - len(extension)
        return f"{(slug[:maximum].rstrip('.-_') or 'narrative-export')}{extension}"

    @staticmethod
    def _fingerprint(
        options: ExportOptionsV1,
        source_checksum: str,
        filename: str,
        payload: bytes,
    ) -> str:
        identity = json.dumps(
            {
                "artifact_checksum": sha256(payload).hexdigest(),
                "filename": filename,
                "options": options.model_dump(mode="json"),
                "source_checksum": source_checksum,
            },
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return sha256(identity).hexdigest()
