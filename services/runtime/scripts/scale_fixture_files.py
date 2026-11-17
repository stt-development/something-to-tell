"""Pinned P9-001 source projects; ordinary tests/runs never regenerate workloads.

The gzip files contain portable ProjectFixture JSON, never SQLite databases,
credentials or project lock files. Only an explicit --write regenerates them.
"""

import argparse
import gzip
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path

from services.runtime.scripts.scale_fixture import SOURCE, document_for, generate_scale_fixture
from services.runtime.stt_runtime.project_fixture import write_project_fixture
from services.runtime.stt_runtime.schemas.project_fixture import ProjectFixtureEnvelope

SIZES = (1000, 10000)
DIRECTORY = Path(__file__).resolve().parents[3] / "fixtures/benchmarks"


def _filename(size):
    if type(size) is not int or size not in SIZES:
        raise ValueError("scale_frozen_size_unsupported")
    return f"storage-scale-{size}.v1.json.gz"


def _manifest():
    value = json.loads((DIRECTORY / "manifest.v1.json").read_text())
    if value.get("fixture_set_version") != 1:
        raise ValueError("scale_fixture_version_unsupported")
    return value


def seed_sha256(size):
    _filename(size)
    return _manifest()["seed_sha256"]


def load_scale_fixture(size) -> ProjectFixtureEnvelope:
    """Verify stored bytes and canonical content, without invoking the generator."""
    filename = _filename(size)
    expected = _manifest()["projects"][str(size)]
    packed = (DIRECTORY / filename).read_bytes()
    if sha256(packed).hexdigest() != expected["gzip_sha256"]:
        raise ValueError("scale_fixture_integrity_error")
    raw = gzip.decompress(packed)
    if sha256(raw).hexdigest() != expected["json_sha256"]:
        raise ValueError("scale_fixture_integrity_error")
    fixture = ProjectFixtureEnvelope.model_validate_json(raw)
    document = document_for(fixture)
    if (len(document.nodes) != size or document.checksum != expected["document_checksum"]
            or fixture.expected_validation.model_dump() != expected["counts"]):
        raise ValueError("scale_fixture_integrity_error")
    return fixture


def freeze(*, check=False):
    """Maintenance-only regeneration; gzip metadata is stable across invocations."""
    manifest = {"fixture_set_version": 1, "seed_sha256": sha256(SOURCE.read_bytes()).hexdigest(), "projects": {}}
    packed_files = {}
    for size in SIZES:
        fixture = generate_scale_fixture(size)
        raw = (json.dumps(fixture.model_dump(mode="json"), sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True, allow_nan=False) + "\n").encode()
        buffer = BytesIO()
        with gzip.GzipFile(filename="", fileobj=buffer, mode="wb", mtime=0, compresslevel=9) as stream:
            stream.write(raw)
        packed = buffer.getvalue()
        manifest["projects"][str(size)] = {
            "file": _filename(size), "node_count": size,
            "json_sha256": sha256(raw).hexdigest(), "gzip_sha256": sha256(packed).hexdigest(),
            "document_checksum": document_for(fixture).checksum,
            "counts": fixture.expected_validation.model_dump(),
        }
        packed_files[_filename(size)] = packed
        if check and load_scale_fixture(size) != fixture:
            raise ValueError("scale_fixture_generation_drift")
    if check:
        if _manifest()["seed_sha256"] != manifest["seed_sha256"]:
            raise ValueError("scale_fixture_generation_drift")
        return
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    for name, packed in packed_files.items():
        (DIRECTORY / name).write_bytes(packed)
    (DIRECTORY / "manifest.v1.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--write", action="store_true")
    action.add_argument("--check", action="store_true")
    action.add_argument("--extract", type=int, choices=SIZES)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.extract is not None:
        if args.output is None:
            parser.error("--extract requires --output")
        write_project_fixture(args.output, load_scale_fixture(args.extract))
    else:
        freeze(check=args.check)


if __name__ == "__main__":
    main()
