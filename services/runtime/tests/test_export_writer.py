"""Hostile-path and atomicity tests for the constrained export writer."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path

import pytest

from services.runtime.stt_runtime.export.errors import ExportOperationError
from services.runtime.stt_runtime.export.writer import AtomicExportWriter


def _install(
    directory: Path,
    *,
    payload: bytes = b'{"ok": true}\n',
    overwrite: bool = False,
):
    return AtomicExportWriter().install(
        payload=payload,
        destination_directory=directory,
        filename="story.json",
        format="json",
        source_checksum="a" * 64,
        overwrite=overwrite,
    )


def _temporary_files(directory: Path) -> list[Path]:
    return list(directory.glob(".story.json.*.tmp"))


def test_writer_installs_verified_bytes_and_requires_explicit_overwrite(tmp_path: Path) -> None:
    first = _install(tmp_path)
    destination = tmp_path / "story.json"

    assert destination.read_bytes() == b'{"ok": true}\n'
    assert first.installed_path == str(destination)
    assert first.bytes_written == len(destination.read_bytes())
    assert _temporary_files(tmp_path) == []

    with pytest.raises(ExportOperationError) as conflict:
        _install(tmp_path, payload=b"replacement\n")
    assert conflict.value.code == "export_destination_conflict"
    assert destination.read_bytes() == b'{"ok": true}\n'

    replaced = _install(tmp_path, payload=b"replacement\n", overwrite=True)
    assert destination.read_bytes() == b"replacement\n"
    assert replaced.bytes_written == len(b"replacement\n")


def test_writer_rejects_relative_symlink_and_special_destinations(tmp_path: Path) -> None:
    with pytest.raises(ExportOperationError, match="export_path_invalid"):
        _install(Path("relative"))

    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    with pytest.raises(ExportOperationError, match="export_path_invalid"):
        _install(linked)

    destination = real / "story.json"
    destination.symlink_to(tmp_path / "outside.json")
    with pytest.raises(ExportOperationError, match="export_path_invalid"):
        _install(real, overwrite=True)

    destination.unlink()
    if hasattr(os, "mkfifo"):
        os.mkfifo(destination)
        with pytest.raises(ExportOperationError, match="export_path_invalid"):
            _install(real, overwrite=True)


def test_failed_stage_and_replace_leave_no_partial_or_destroyed_artifact(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "story.json"
    destination.write_bytes(b"original\n")

    def fail_replace(_: object, __: object) -> None:
        raise OSError("injected replace failure")

    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(ExportOperationError, match="export_write_failed"):
        _install(tmp_path, payload=b"replacement\n", overwrite=True)

    assert destination.read_bytes() == b"original\n"
    assert _temporary_files(tmp_path) == []


def test_permission_failure_is_actionable_and_cleans_stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_open = os.open

    def deny_stage(path: object, flags: int, mode: int = 0o777) -> int:
        if str(path).endswith(".tmp"):
            raise PermissionError("injected permission failure")
        return original_open(path, flags, mode)

    monkeypatch.setattr(os, "open", deny_stage)
    with pytest.raises(ExportOperationError, match="export_permission_denied"):
        _install(tmp_path)
    assert not (tmp_path / "story.json").exists()
    assert _temporary_files(tmp_path) == []


def test_concurrent_no_overwrite_install_has_one_winner_and_no_partial_files(
    tmp_path: Path,
) -> None:
    def attempt(payload: bytes):
        try:
            return _install(tmp_path, payload=payload)
        except ExportOperationError as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, (b"first\n", b"second\n")))

    successes = [item for item in results if not isinstance(item, ExportOperationError)]
    failures = [item for item in results if isinstance(item, ExportOperationError)]
    assert len(successes) == len(failures) == 1
    assert failures[0].code == "export_destination_conflict"
    assert (tmp_path / "story.json").read_bytes() in {b"first\n", b"second\n"}
    assert _temporary_files(tmp_path) == []
