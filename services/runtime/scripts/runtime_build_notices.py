"""Collect actual interpreter/freezer notice inputs; never approve distribution."""

import argparse
from hashlib import sha256
from importlib import metadata
import json
from pathlib import Path
import sys
import sysconfig

from services.runtime.scripts.runtime_notice_evidence import collect_evidence, NOTICE_NAME

MAX_TEXT_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 8 * MAX_TEXT_BYTES


def notice_inputs():
    prefix = Path(sys.base_prefix).resolve()
    for root in sorted({prefix, Path(sysconfig.get_path("stdlib")).resolve()}):
        if not root.is_relative_to(prefix):
            continue
        for name in ("LICENSE", "LICENSE.txt", "LICENSE.rst", "LICENSE.md"):
            path = root / name
            if path.is_file():
                yield prefix, path.relative_to(prefix).as_posix(), {"kind": "interpreter_installation"}
    distribution = metadata.distribution("pyinstaller")
    root = Path(distribution.locate_file("")).resolve()
    for entry in sorted(distribution.files or []):
        relative = str(entry).replace("\\", "/")
        if NOTICE_NAME.match(Path(relative).name):
            yield root, relative, {"kind": "build_tool", "name": "pyinstaller", "version": distribution.version}


def collect_build_notices(candidate: Path, manifest: Path) -> dict:
    evidence = collect_evidence(candidate, manifest)
    texts, seen, total = [], set(), 0
    for root, relative, owner in notice_inputs():
        name = Path(relative)
        if name.is_absolute() or ".." in name.parts or ":" in relative or "\\" in relative or any(ord(c) < 32 for c in relative):
            raise ValueError("build_notice_path_invalid")
        path = root / relative
        if not path.resolve(strict=True).is_relative_to(root.resolve()) or path.is_symlink():
            raise ValueError("build_notice_path_escape")
        if owner["kind"] == "build_tool" and owner["version"] != evidence["runtime"]["pyinstaller"]:
            raise ValueError("build_notice_tool_version_changed")
        key = (path.resolve(), owner["kind"])
        if key in seen:
            continue
        seen.add(key)
        with path.open("rb") as stream:
            raw = stream.read(MAX_TEXT_BYTES + 1)
        total += len(raw)
        if len(raw) > MAX_TEXT_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError("build_notice_text_limit")
        text = raw.decode("utf-8")
        if any(ord(c) < 32 and c not in "\t\r\n\f" for c in text):
            raise ValueError("build_notice_not_text")
        texts.append({**owner, "relative_path": relative, "sha256": sha256(raw).hexdigest(), "text": text})
    kinds = {item["kind"] for item in texts}
    return {"schema_version": 1, "scope": "interpreter_and_freezer_notice_inputs_only", "distribution_approved": False,
            "collector_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
            "manifest_sha256": evidence["manifest_sha256"], "runtime": evidence["runtime"], "notice_texts": texts,
            "missing_notice_groups": sorted({"interpreter_installation", "build_tool"} - kinds),
            "review_gaps": ["notice_inputs_not_complete_bundled_component_terms",
                            "bootloader_identity_native_versions_corresponding_source_and_installer_review",
                            "human_review_and_distribution_approval"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    print(json.dumps(collect_build_notices(args.candidate, args.manifest), indent=2))


if __name__ == "__main__":
    main()
