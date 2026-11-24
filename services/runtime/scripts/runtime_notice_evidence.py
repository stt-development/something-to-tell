"""Read-only runtime license evidence; never certify or distribute a candidate."""

import argparse
from email import policy
from email.parser import BytesParser
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re

from services.runtime.scripts.build_desktop_runtime import artifact_manifest

MAX_TEXT_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 8 * MAX_TEXT_BYTES
NOTICE_NAME = re.compile(r"^(licen[cs]e|copying|notice|copyright)([._-].*)?$", re.I)


def collect_evidence(candidate: Path, manifest_path: Path) -> dict:
    """Compare the original recipe's full provenance before reading declared text."""
    root = candidate.resolve(strict=True)
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest != artifact_manifest(root):
        raise ValueError("runtime_notice_candidate_mismatch")
    files = manifest["files"]
    total = 0

    def read_text(entry: dict) -> str:
        nonlocal total
        relative = PurePosixPath(entry["path"])
        if relative.is_absolute() or any(part in (".", "..") for part in relative.parts) or "\\" in entry["path"]:
            raise ValueError("runtime_notice_path_invalid")
        path = root / entry["path"]
        if "symlink" in entry or path.is_symlink() or not path.resolve(strict=True).is_relative_to(root):
            raise ValueError("runtime_notice_path_escape")
        if entry["bytes"] > MAX_TEXT_BYTES or total + entry["bytes"] > MAX_TOTAL_BYTES:
            raise ValueError("runtime_notice_text_limit")
        # Recheck the exact bytes consumed, not just the earlier whole-bundle scan.
        with path.open("rb") as stream:
            data = stream.read(MAX_TEXT_BYTES + 1)
        if len(data) != entry["bytes"] or sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("runtime_notice_content_changed")
        text = data.decode("utf-8")
        if any(ord(char) < 32 and char not in "\t\r\n\f" for char in text):
            raise ValueError("runtime_notice_not_text")
        total += len(data)
        return text

    texts = []
    for entry in files:
        if NOTICE_NAME.match(PurePosixPath(entry["path"]).name):
            texts.append({"path": entry["path"], "sha256": entry["sha256"] if "sha256" in entry else None,
                          "text": read_text(entry)})
    distributions = []
    for entry in files:
        path = PurePosixPath(entry["path"])
        if path.name != "METADATA" or not path.parent.name.endswith(".dist-info"):
            continue
        headers = BytesParser(policy=policy.default).parsebytes(read_text(entry).encode("utf-8"))
        if not headers.get("Name") or not headers.get("Version"):
            raise ValueError("runtime_notice_metadata_invalid")
        prefix = path.parent.as_posix() + "/"
        distributions.append({
            "name": str(headers["Name"]), "version": str(headers["Version"]),
            "metadata_path": entry["path"], "metadata_sha256": entry["sha256"],
            "license_expression": str(headers.get("License-Expression", "")),
            "license_declaration": str(headers.get("License", "")),
            "declared_license_files": [str(value) for value in headers.get_all("License-File", [])],
            "bundled_notice_paths": [item["path"] for item in texts if item["path"].startswith(prefix)],
        })
    native = [entry for entry in files if (
        PurePosixPath(entry["path"]).suffix.lower() in {".dll", ".dylib", ".pyd", ".so", ".exe"}
        or ".so." in PurePosixPath(entry["path"]).name
        or PurePosixPath(entry["path"]).name in {"Python", "stt-runtime"}
    )]
    return {
        "schema_version": 1, "scope": "raw_runtime_notice_evidence_only",
        "distribution_approved": False,
        "collector_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "manifest_sha256": sha256(manifest_bytes).hexdigest(),
        "runtime": {key: manifest[key] for key in ("system", "machine", "python", "pyinstaller", "lock_sha256")},
        "distributions": distributions, "notice_texts": texts, "native_files": native,
        "review_gaps": ["native_component_versions_licenses_and_corresponding_source",
                        "python_interpreter_and_pyinstaller_bootloader_notices",
                        "frontend_rust_installer_and_asset_notices",
                        "human_review_and_distribution_approval"],
        "distributions_without_notice_text": [item["metadata_path"] for item in distributions if not item["bundled_notice_paths"]],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("manifest", type=Path)
    args = parser.parse_args()
    print(json.dumps(collect_evidence(args.candidate, args.manifest), ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
