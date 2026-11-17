"""Constrained sibling-stage writer for validated export artifacts."""

from __future__ import annotations

from hashlib import sha256
import os
from pathlib import Path
import stat
from uuid import uuid4

from ..schemas.export import (
    EXPORT_MAX_OUTPUT_BYTES,
    ExportArtifactV1,
    ExportFormat,
)
from .errors import ExportOperationError
from .installation_guard import check_installation


class AtomicExportWriter:
    """Install one named artifact without exposing arbitrary file operations."""

    def install(
        self,
        *,
        payload: bytes,
        destination_directory: Path,
        filename: str,
        format: ExportFormat,
        source_checksum: str,
        overwrite: bool,
    ) -> ExportArtifactV1:
        if len(payload) > EXPORT_MAX_OUTPUT_BYTES:
            raise ExportOperationError("export_limit_exceeded")
        if Path(filename).name != filename or filename in {".", ".."}:
            raise ExportOperationError("export_path_invalid")

        directory = self._validated_directory(destination_directory)
        destination = directory / filename
        self._validate_destination(destination, overwrite=overwrite)
        stage = directory / f".{filename}.{uuid4().hex}.tmp"
        expected_checksum = sha256(payload).hexdigest()
        staged = False
        try:
            self._write_stage(stage, payload, expected_checksum)
            staged = True
            # Source authority rechecks its bounded lock immediately before rename.
            check_installation()
            if overwrite:
                os.replace(stage, destination)
            else:
                # A hard link installs without replacing a file created after
                # validation; stage and destination share the verified inode.
                os.link(stage, destination, follow_symlinks=False)
                try:
                    stage.unlink()
                except OSError:
                    # The destination must not survive a failed installation.
                    destination.unlink(missing_ok=True)
                    raise
            staged = False
            self._sync_directory(directory)
        except FileExistsError as error:
            raise ExportOperationError(
                "export_destination_conflict", filename=filename
            ) from error
        except PermissionError as error:
            raise ExportOperationError("export_permission_denied") from error
        except ExportOperationError:
            raise
        except OSError as error:
            raise ExportOperationError("export_write_failed") from error
        finally:
            if staged:
                try:
                    stage.unlink(missing_ok=True)
                except OSError:
                    pass

        return ExportArtifactV1(
            format=format,
            filename=filename,
            installed_path=str(destination),
            artifact_checksum=expected_checksum,
            source_checksum=source_checksum,
            bytes_written=len(payload),
        )

    @staticmethod
    def _validated_directory(value: Path) -> Path:
        expanded = value.expanduser()
        if not expanded.is_absolute():
            raise ExportOperationError("export_path_invalid")
        absolute = expanded.absolute()
        current = Path(absolute.anchor)
        try:
            for component in absolute.parts[1:]:
                current /= component
                metadata = current.lstat()
                if stat.S_ISLNK(metadata.st_mode):
                    raise ExportOperationError("export_path_invalid")
            if not stat.S_ISDIR(absolute.stat().st_mode):
                raise ExportOperationError("export_path_invalid")
            return absolute.resolve(strict=True)
        except (FileNotFoundError, NotADirectoryError) as error:
            raise ExportOperationError("export_path_invalid") from error
        except PermissionError as error:
            raise ExportOperationError("export_permission_denied") from error

    @staticmethod
    def _validate_destination(destination: Path, *, overwrite: bool) -> None:
        try:
            metadata = destination.lstat()
        except FileNotFoundError:
            return
        except PermissionError as error:
            raise ExportOperationError("export_permission_denied") from error
        if not stat.S_ISREG(metadata.st_mode):
            raise ExportOperationError("export_path_invalid")
        if not overwrite:
            raise ExportOperationError(
                "export_destination_conflict", filename=destination.name
            )

    @staticmethod
    def _write_stage(stage: Path, payload: bytes, expected_checksum: str) -> None:
        flags = os.O_CREAT | os.O_EXCL | os.O_RDWR
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor: int | None = None
        created = False
        try:
            descriptor = os.open(stage, flags, 0o600)
            created = True
            view = memoryview(payload)
            while view:
                written = os.write(descriptor, view)
                if written <= 0:
                    raise OSError("staged export write made no progress")
                view = view[written:]
            os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            digest = sha256()
            while chunk := os.read(descriptor, 65_536):
                digest.update(chunk)
            if digest.hexdigest() != expected_checksum:
                raise ExportOperationError("export_write_failed")
        except Exception:
            if descriptor is not None:
                os.close(descriptor)
                descriptor = None
            if created:
                try:
                    stage.unlink(missing_ok=True)
                except OSError:
                    pass
            raise
        finally:
            if descriptor is not None:
                os.close(descriptor)

    @staticmethod
    def _sync_directory(directory: Path) -> None:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        try:
            descriptor = os.open(directory, flags)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        except OSError:
            # Atomic installation already completed; directory fsync is not
            # supported on every desktop filesystem.
            pass
        finally:
            os.close(descriptor)
