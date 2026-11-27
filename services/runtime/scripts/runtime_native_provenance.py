"""Match verified native bytes to build inputs, without claiming license approval."""

import argparse
from hashlib import sha256
from importlib import metadata
import json
from pathlib import Path, PurePosixPath
import re
import sys
import sysconfig

from packaging.utils import canonicalize_name

from services.runtime.scripts.runtime_notice_evidence import collect_evidence
from services.runtime.scripts.runtime_collection_record import bootloader_record, collection_records

MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_SOURCE_BYTES = 1024 * 1024 * 1024


def native_name(name: str) -> bool:
    return Path(name).suffix.lower() in {".dll", ".dylib", ".pyd", ".so", ".exe"} or ".so." in name or name == "Python"


def input_files():
    """Read installed file inventories, never import or execute package code."""
    for distribution in metadata.distributions():
        name, version = distribution.metadata.get("Name", ""), distribution.version
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", name) or not version:
            continue
        root = Path(distribution.locate_file("")).resolve()
        for item in distribution.files or []:
            relative = str(item).replace("\\", "/")
            # RECORD also lists entry-point launchers outside site-packages on
            # Windows. They are not native package inputs within this owner root.
            if PurePosixPath(relative).is_absolute() or ".." in PurePosixPath(relative).parts:
                continue
            bootloader = relative.startswith("PyInstaller/bootloader/") and PurePosixPath(relative).name in {"run", "run.exe"}
            if native_name(PurePosixPath(relative).name) or bootloader:
                yield root, relative, {"kind": "installed_distribution", "name": name, "version": version}
    # Only known interpreter directories, not a recursive scan of the host disk.
    prefix = Path(sys.base_prefix).resolve()
    roots = {prefix, prefix / "lib", prefix / "DLLs", Path(sysconfig.get_path("stdlib")) / "lib-dynload"}
    for root in sorted(roots):
        root = root.resolve()
        if root.is_dir() and root.is_relative_to(prefix):
            for item in sorted(root.iterdir()):
                if native_name(item.name):
                    yield prefix, item.relative_to(prefix).as_posix(), {"kind": "interpreter_installation"}


def file_digest(path: Path, size: int) -> str:
    if size > MAX_FILE_BYTES:
        raise ValueError("native_provenance_file_limit")
    result, consumed = sha256(), 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            consumed += len(chunk)
            if consumed > size:
                raise ValueError("native_provenance_input_changed")
            result.update(chunk)
    if consumed != size:
        raise ValueError("native_provenance_input_changed")
    return result.hexdigest()


def collect_provenance(candidate: Path, manifest: Path, collection_toc: Path | None = None) -> dict:
    evidence = collect_evidence(candidate, manifest)
    files = [item for item in evidence["native_files"] if "symlink" not in item]
    links, collection = {}, None
    bootloader_output = None
    if collection_toc is not None:
        # Read the original manifest's full path inventory; the preceding evidence
        # gate has already compared its bytes with the actual raw candidate.
        all_paths = {item["path"] for item in json.loads(manifest.read_bytes())["files"]}
        links, collection = collection_records(collection_toc, {item["path"] for item in files}, all_paths)
        bootloader = bootloader_record(collection_toc, links)
        if bootloader is not None:
            output, source, receipt = bootloader
            bootloader_output = output
            links[output] = source
            collection["executable_record_sha256"] = receipt
            collection["generated_executable"] = output
            collection["executable_relationship"] = "bootloader_contribution_not_full_executable_source"
    requested = set(links.values())
    sizes = {item["bytes"] for item in files}
    matches: dict[tuple[int, str], list[dict]] = {}
    hashed: dict[Path, str] = {}
    source_inputs: dict[Path, dict] = {}
    total = 0
    for root, relative, owner in input_files():
        name = PurePosixPath(relative)
        if name.is_absolute() or ".." in name.parts or ":" in relative or any(ord(c) < 32 for c in relative):
            raise ValueError("native_provenance_source_path_invalid")
        path = (root / relative).resolve(strict=True)
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise ValueError("native_provenance_source_escape")
        size = path.stat().st_size
        if size not in sizes and path not in requested:
            continue
        if path not in hashed:
            total += size
            if total > MAX_SOURCE_BYTES:
                raise ValueError("native_provenance_total_limit")
            hashed[path] = file_digest(path, size)
        origin = {**owner, "relative_path": relative}
        origins = matches.setdefault((size, hashed[path]), [])
        if origin not in origins:
            origins.append(origin)
        source_inputs[path] = {"bytes": size, "sha256": hashed[path], "origins": origins}
    records = []
    for item in files:
        # Recheck consumed candidate bytes after the original full-manifest gate.
        if file_digest(candidate / item["path"], item["bytes"]) != item["sha256"]:
            raise ValueError("native_provenance_candidate_changed")
        origins = sorted(matches.get((item["bytes"], item["sha256"]), []), key=lambda item: json.dumps(item, sort_keys=True))
        source = source_inputs.get(links.get(item["path"]))
        if item["path"] == bootloader_output and source is not None:
            if not any(origin["kind"] == "installed_distribution"
                       and canonicalize_name(origin.get("name", "")) == "pyinstaller"
                       and origin.get("version") == evidence["runtime"]["pyinstaller"]
                       and origin["relative_path"].startswith("PyInstaller/bootloader/")
                       and PurePosixPath(origin["relative_path"]).name in {"run", "run.exe"}
                       for origin in source["origins"]):
                raise ValueError("native_executable_bootloader_owner_invalid")
        records.append({**item, "origins": origins, "collection_input": source,
                        "status": "exact_build_input_match" if origins else "unmatched_or_transformed"})
    return {"schema_version": 1, "scope": "native_build_input_attribution_only", "distribution_approved": False,
            "collector_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
            "manifest_sha256": evidence["manifest_sha256"], "runtime": evidence["runtime"], "files": records,
            "collection_record": collection,
            "review_gaps": ["origin_match_is_not_embedded_component_version_or_source_proof",
                            "unmatched_transformed_and_system_library_provenance",
                            "static_components_interpreter_bootloader_installer_and_notice_review",
                            "human_review_and_distribution_approval"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--collection-toc", type=Path)
    args = parser.parse_args()
    print(json.dumps(collect_provenance(args.candidate, args.manifest, args.collection_toc), indent=2))


if __name__ == "__main__":
    main()
