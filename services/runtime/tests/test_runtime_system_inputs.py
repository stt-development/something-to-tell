"""OS source receipts use fixed metadata APIs, not execution of collected code."""
import ctypes
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.runtime.scripts import runtime_system_inputs as systems


@pytest.fixture
def dpkg(tmp_path, monkeypatch):
    docs = tmp_path / "doc"
    docs.mkdir()
    monkeypatch.setattr(systems, "DOCUMENTATION_ROOT", docs)
    calls = []
    def run(command, **kwargs):
        calls.append(command)
        assert command[0] == "/usr/bin/dpkg-query"
        assert kwargs["timeout"] == 10 and kwargs["capture_output"]
        if command[1] == "--search":
            return SimpleNamespace(returncode=0, stdout=f"libfixture:amd64: {command[2]}\n")
        return SimpleNamespace(returncode=0, stdout="libfixture:amd64\t1.2-1\tsource-fixture\t1.2-src\n")
    monkeypatch.setattr(systems.subprocess, "run", run)
    return docs, calls


def test_dpkg_binds_binary_and_source_versions_and_preserves_actual_notice(dpkg):
    docs, calls = dpkg
    notice = docs / "libfixture/copyright"
    notice.parent.mkdir()
    raw = b"Copyright Fixture\r\nLicense: example\r\n"
    notice.write_bytes(raw)
    result = systems.dpkg_package(Path("/usr/lib/libfixture.so"))
    assert result["name"] == "libfixture:amd64" and result["version"] == "1.2-1"
    assert result["source_name"] == "source-fixture" and result["source_version"] == "1.2-src"
    assert result["copyright_notice"]["text"].encode() == raw
    assert calls[1][2] == "/lib/libfixture.so"
    assert "--showformat=" in calls[2][2]


def test_missing_or_ambiguous_dpkg_owner_is_not_guessed(dpkg, monkeypatch):
    for stdout in ("", "first: /usr/lib/libfixture.so\nsecond: /usr/lib/libfixture.so\n"):
        monkeypatch.setattr(systems.subprocess, "run", lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout=stdout))
        assert systems.dpkg_package(Path("/usr/lib/libfixture.so")) is None


def test_dpkg_preserves_empty_source_fields_for_binary_version_fallback(dpkg, monkeypatch):
    def run(command, **_kwargs):
        if command[1] == "--search":
            return SimpleNamespace(returncode=0, stdout=f"libfixture:amd64: {command[2]}\n")
        return SimpleNamespace(returncode=0, stdout="libfixture:amd64\t1.2\t\t\n")
    monkeypatch.setattr(systems.subprocess, "run", run)
    assert systems.dpkg_package(Path("/usr/lib/libfixture.so"))["source_version"] == "1.2"


def test_notice_symlink_outside_documentation_root_is_not_read(dpkg, tmp_path):
    docs, _ = dpkg
    (docs / "libfixture").mkdir()
    (tmp_path / "private").write_bytes(b"must not be exported")
    (docs / "libfixture/copyright").symlink_to(tmp_path / "private")
    assert "copyright_notice" not in systems.dpkg_package(Path("/usr/lib/libfixture.so"))


def test_system_notice_reads_are_bounded(dpkg, monkeypatch):
    docs, _ = dpkg
    notice = docs / "libfixture/copyright"
    notice.parent.mkdir()
    notice.write_bytes(b"over limit")
    monkeypatch.setattr(systems, "MAX_NOTICE_BYTES", 1)
    with pytest.raises(ValueError, match="notice_limit"):
        systems.dpkg_package(Path("/usr/lib/libfixture.so"))


def test_dpkg_errors_are_not_silently_reported_as_known_ownership(dpkg, monkeypatch):
    monkeypatch.setattr(systems.subprocess, "run", lambda *_args, **_kwargs: SimpleNamespace(returncode=2, stdout=""))
    with pytest.raises(ValueError, match="lookup_failed"):
        systems.dpkg_package(Path("/usr/lib/libfixture.so"))


def test_system_lookup_ignores_paths_outside_independent_os_roots(tmp_path, monkeypatch):
    monkeypatch.setattr(systems, "dpkg_package", lambda _: pytest.fail("unexpected OS lookup"))
    assert list(systems.system_files([tmp_path / "private.so"], "Linux")) == []
    assert list(systems.system_files([tmp_path / "private.so"], "Darwin")) == []


def test_windows_metadata_is_scoped_to_selected_system_or_sdk_dlls(tmp_path, monkeypatch):
    root = tmp_path / "Windows"
    dll = root / "System32/api-ms-fixture.dll"
    dll.parent.mkdir(parents=True)
    dll.write_bytes(b"fake versioned DLL")
    monkeypatch.setenv("SystemRoot", str(root))
    monkeypatch.delenv("ProgramFiles(x86)", raising=False)
    monkeypatch.setattr(systems, "windows_file_version", lambda path: {"status": "version_resource", "file_version": [1, 2, 3, 4]})
    records = list(systems.system_files([dll, tmp_path / "private.dll"], "Windows"))
    assert len(records) == 1
    assert records[0][1] == "api-ms-fixture.dll"
    assert records[0][2]["version_resource"]["file_version"] == [1, 2, 3, 4]


def test_windows_component_store_is_a_separate_known_os_scope(tmp_path, monkeypatch):
    root = tmp_path / "Windows"
    dll = root / "WinSxS/component/api-ms-fixture.dll"
    dll.parent.mkdir(parents=True)
    dll.write_bytes(b"DLL fixture")
    monkeypatch.setenv("SystemRoot", str(root))
    monkeypatch.setattr(systems, "windows_file_version", lambda _: {"status": "version_resource_unavailable"})
    records = list(systems.system_files([dll], "Windows"))
    assert records[0][2]["scope"] == "windows_component_store"
    assert systems.source_scope(dll) == "windows_installation"
    assert str(tmp_path) not in str(records[0][2])


def test_unresolved_diagnostics_export_only_fixed_scope_labels(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNNER_TOOL_CACHE", str(tmp_path / "private-tools"))
    assert systems.source_scope(tmp_path / "private-tools/input.dll") == "runner_toolcache"
    assert systems.source_scope(tmp_path / "unknown-input.dll") == "other_unattributed_input"
    assert systems.source_scope(None) is None


def test_windows_toolcache_reads_only_selected_dll_metadata(tmp_path, monkeypatch):
    cache = tmp_path / "tools"
    dll = cache / "Python/3.13.17/x64/runtime/api-ms-fixture.dll"
    dll.parent.mkdir(parents=True)
    dll.write_bytes(b"DLL fixture")
    (cache / "unselected.dll").write_bytes(b"must not scan")
    monkeypatch.setenv("RUNNER_TOOL_CACHE", str(cache))
    calls = []
    def version(path):
        calls.append(path)
        return {"status": "version_resource", "file_version": [10, 0, 1, 0]}
    monkeypatch.setattr(systems, "windows_file_version", version)
    records = list(systems.system_files([dll], "Windows"))
    assert calls == [dll]
    assert records[0][1] == "Python/3.13.17/x64/runtime/api-ms-fixture.dll"
    assert records[0][2]["scope"] == "windows_toolcache_runtime"
    assert str(tmp_path) not in str(records[0][2])
    assert list(systems.system_files([dll], "Darwin")) == []


def test_toolcache_source_cannot_escape_through_traversal_or_symlink(tmp_path, monkeypatch):
    cache = tmp_path / "tools"
    cache.mkdir()
    outside = tmp_path / "outside.dll"
    outside.write_bytes(b"not a toolcache input")
    (cache / "alias.dll").symlink_to(outside)
    monkeypatch.setenv("RUNNER_TOOL_CACHE", str(cache))
    monkeypatch.setattr(systems, "windows_file_version", lambda _: pytest.fail("outside input read"))
    assert list(systems.system_files([cache / "../outside.dll", cache / "alias.dll"], "Windows")) == []


def test_windows_fixed_version_signature_and_numbers():
    info = systems.FixedVersion(signature=0xFEEF04BD, file_ms=(1 << 16) + 2, file_ls=(3 << 16) + 4)
    assert systems.version_numbers(info)["file_version"] == [1, 2, 3, 4]
    with pytest.raises(ValueError, match="signature_invalid"):
        systems.version_numbers(systems.FixedVersion())


def test_windows_api_reads_resource_without_loading_target_dll(tmp_path, monkeypatch):
    info = systems.FixedVersion(signature=0xFEEF04BD, file_ms=1 << 16)
    class Function:
        def __init__(self, callback): self.callback = callback
        def __call__(self, *args): return self.callback(*args)
    def query(_data, key, pointer, length):
        assert key == "\\"
        pointer._obj.value = ctypes.addressof(info)
        length._obj.value = ctypes.sizeof(info)
        return True
    library = SimpleNamespace(GetFileVersionInfoSizeW=Function(lambda *_: ctypes.sizeof(info)),
        GetFileVersionInfoW=Function(lambda *_: True), VerQueryValueW=Function(query))
    def load(name, **_kwargs):
        assert name == "version", "Never load the target library"
        return library
    monkeypatch.setattr(systems.ctypes, "WinDLL", load, raising=False)
    assert systems.windows_file_version(tmp_path / "must-not-load.dll")["file_version"] == [1, 0, 0, 0]
