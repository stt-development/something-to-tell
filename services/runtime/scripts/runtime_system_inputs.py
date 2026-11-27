"""Read OS-owned library metadata, without executing collected libraries."""

import ctypes
from ctypes import wintypes
from hashlib import sha256
import os
from pathlib import Path
import re
import subprocess

MAX_NOTICE_BYTES = 1024 * 1024
DOCUMENTATION_ROOT = Path("/usr/share/doc")


def dpkg_package(path: Path) -> dict | None:
    """Use explicit dpkg fields; account for Debian's merged /usr aliases."""
    queries = [str(path)]
    if str(path).startswith("/usr/lib/"):
        queries.append(str(path)[4:])
    owners = set()
    for query in queries:
        result = subprocess.run(["/usr/bin/dpkg-query", "--search", query], capture_output=True, text=True, timeout=10)
        if result.returncode not in {0, 1}:
            raise ValueError("native_system_package_lookup_failed")
        for line in result.stdout.splitlines():
            owner, separator, actual = line.rpartition(": ")
            if separator and actual == query and re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?", owner):
                owners.add(owner)
    if len(owners) != 1:
        return None
    owner = owners.pop()
    result = subprocess.run(["/usr/bin/dpkg-query", "--show", "--showformat=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\\n", owner],
                            capture_output=True, text=True, timeout=10)
    if result.returncode:
        raise ValueError("native_system_package_metadata_failed")
    fields = result.stdout.rstrip("\r\n").split("\t")
    if len(fields) != 4 or fields[0] != owner or not fields[1]:
        raise ValueError("native_system_package_metadata_invalid")
    package = {"name": owner, "version": fields[1], "source_name": fields[2] or owner.split(":")[0],
               "source_version": fields[3] or fields[1], "evidence": "installed_dpkg_database_not_source_verification"}
    copyright = DOCUMENTATION_ROOT / owner.split(":")[0] / "copyright"
    resolved = copyright.resolve()
    if copyright.is_file() and resolved.is_relative_to(DOCUMENTATION_ROOT.resolve()):
        with copyright.open("rb") as stream:
            data = stream.read(MAX_NOTICE_BYTES + 1)
        if len(data) > MAX_NOTICE_BYTES:
            raise ValueError("native_system_notice_limit")
        text = data.decode("utf-8")
        if any(ord(c) < 32 and c not in "\t\r\n\f" for c in text):
            raise ValueError("native_system_notice_not_text")
        package["copyright_notice"] = {"sha256": sha256(data).hexdigest(), "text": text}
    return package


class FixedVersion(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in (
        "signature", "structure", "file_ms", "file_ls", "product_ms", "product_ls",
        "flags_mask", "flags", "os", "type", "subtype", "date_ms", "date_ls")]


def version_numbers(info: FixedVersion) -> dict:
    if info.signature != 0xFEEF04BD:
        raise ValueError("native_windows_version_signature_invalid")
    def parts(ms, ls):
        return [ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF]
    return {"status": "version_resource", "file_version": parts(info.file_ms, info.file_ls),
            "product_version": parts(info.product_ms, info.product_ls)}


def windows_file_version(path: Path) -> dict:
    """Windows version-resource APIs read resources; they do not load this DLL."""
    library = ctypes.WinDLL("version", use_last_error=True)
    library.GetFileVersionInfoSizeW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.DWORD)]
    library.GetFileVersionInfoSizeW.restype = wintypes.DWORD
    library.GetFileVersionInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID]
    library.GetFileVersionInfoW.restype = wintypes.BOOL
    library.VerQueryValueW.argtypes = [wintypes.LPCVOID, wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.UINT)]
    library.VerQueryValueW.restype = wintypes.BOOL
    ignored = wintypes.DWORD()
    size = library.GetFileVersionInfoSizeW(str(path), ctypes.byref(ignored))
    if not size:
        return {"status": "version_resource_unavailable"}
    if size > MAX_NOTICE_BYTES:
        raise ValueError("native_windows_version_resource_limit")
    data = ctypes.create_string_buffer(size)
    if not library.GetFileVersionInfoW(str(path), 0, size, data):
        raise ValueError("native_windows_version_read_failed")
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    if not library.VerQueryValueW(data, "\\", ctypes.byref(pointer), ctypes.byref(length)) or length.value < ctypes.sizeof(FixedVersion):
        return {"status": "version_resource_unavailable"}
    return version_numbers(ctypes.cast(pointer, ctypes.POINTER(FixedVersion)).contents)


def system_files(sources, system: str):
    """Only explicitly collected DLL/shared libraries under known OS roots qualify."""
    roots = []
    if system == "Linux":
        roots = [(Path("/usr/lib"), "linux_library"), (Path("/lib"), "linux_library")]
    elif system == "Windows":
        if os.environ.get("SystemRoot"):
            roots.append((Path(os.environ["SystemRoot"]) / "System32", "windows_system32"))
            roots.append((Path(os.environ["SystemRoot"]) / "WinSxS", "windows_component_store"))
        if os.environ.get("ProgramFiles(x86)"):
            roots.append((Path(os.environ["ProgramFiles(x86)"]) / "Windows Kits", "windows_sdk_redist"))
        # Hosted Python/SDK inputs also live in the runner's explicit toolcache.
        if os.environ.get("RUNNER_TOOL_CACHE"):
            roots.append((Path(os.environ["RUNNER_TOOL_CACHE"]), "windows_toolcache_runtime"))
    for source in sorted(set(sources)):
        source = source.resolve()
        for root, scope in roots:
            root = root.resolve()
            if not source.is_relative_to(root) or not source.is_file():
                continue
            relative = source.relative_to(root).as_posix()
            if not re.fullmatch(r"[A-Za-z0-9_./+ -]+", relative) or not (source.suffix.lower() == ".dll" or ".so" in source.name):
                continue
            owner = {"kind": "system_library", "scope": scope}
            if system == "Linux":
                owner["package"] = dpkg_package(source)
            else:
                owner["version_resource"] = windows_file_version(source)
            yield root, relative, owner
            break


def source_scope(source: Path | None) -> str | None:
    """Coarse diagnostics for unresolved inputs, never absolute host paths."""
    if source is None:
        return None
    for variable, label in (("SystemRoot", "windows_installation"), ("ProgramFiles", "program_files"),
                            ("ProgramFiles(x86)", "program_files_x86"), ("RUNNER_TOOL_CACHE", "runner_toolcache"),
                            ("LOCALAPPDATA", "local_machine_cache"), ("RUNNER_TEMP", "temporary_build_input"),
                            ("GITHUB_WORKSPACE", "repository_build_input")):
        if os.environ.get(variable) and source.is_relative_to(Path(os.environ[variable]).resolve()):
            return label
    return "other_unattributed_input"
