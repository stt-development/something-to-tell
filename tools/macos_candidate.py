"""Verify/sign only fresh candidate copies with linked before/after inventories."""
import argparse
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import mkdtemp

ROOT = Path(__file__).resolve().parents[1]

# Thin/fat Mach-O header signatures; runtime inventory is independently hashed.
MACHO_HEADERS = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
                 b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}


def verify_runtime_signatures(runtime: Path):
    root = runtime.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("runtime directory required")
    count = 0
    for path in sorted(root.rglob("*")):
        if not path.resolve(strict=True).is_relative_to(root):
            raise ValueError("runtime path escape")
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            header = stream.read(4)
        if header not in MACHO_HEADERS:
            continue
        subprocess.run(["/usr/bin/codesign", "--verify", "--strict", "--all-architectures", str(path)],
                       check=True, capture_output=True, timeout=30)
        count += 1
    if not count:
        raise ValueError("no runtime Mach-O code found")
    return count


def verify_manifest(runtime: Path, manifest: Path):
    # The existing resource owner validates all bytes, source/lock hashes and
    # platform. Signing does not get a second, weaker implementation of that gate.
    program = "import fs from 'node:fs'; import {verifyCandidate} from './tools/desktop-runtime-resources.mjs'; verifyCandidate(process.argv[1], JSON.parse(fs.readFileSync(process.argv[2])));"
    subprocess.run(["node", "--input-type=module", "-e", program, str(runtime), str(manifest)],
                   cwd=ROOT, check=True, capture_output=True, timeout=30)


def inventory(runtime: Path):
    files = []
    for path in sorted(runtime.rglob("*")):
        name = path.relative_to(runtime).as_posix()
        if path.is_symlink():
            files.append({"path": name, "symlink": str(path.readlink())})
        elif path.is_file():
            data = path.read_bytes()
            files.append({"path": name, "bytes": len(data), "sha256": sha256(data).hexdigest()})
    return files


def signature_envelope(name, frameworks):
    path = Path(name)
    if path.name != "CodeResources" or path.parent.name != "_CodeSignature":
        return False
    owner = path.parent.parent
    return any(owner == frame or (owner.parent.name == "Versions" and owner.parent.parent == frame) for frame in frameworks)


def finalize_candidate(source: Path, manifest: Path, output_parent: Path, *, raw_runtime: Path, raw_manifest: Path):
    source = source.resolve(strict=True)
    manifest = manifest.resolve(strict=True)
    if not source.is_dir() or source.suffix != ".app":
        raise ValueError("source app required")
    staged_bytes = manifest.read_bytes()
    staged = json.loads(staged_bytes)
    raw_runtime = raw_runtime.resolve(strict=True)
    raw_manifest = raw_manifest.resolve(strict=True)
    original_bytes = raw_manifest.read_bytes()
    original = json.loads(original_bytes)
    if staged.get("normalization", {}).get("source_manifest_sha256") != sha256(original_bytes).hexdigest():
        raise ValueError("raw and staged manifest linkage mismatch")
    verify_manifest(source / "Contents/Resources/runtime", manifest)
    verify_manifest(raw_runtime, raw_manifest)
    for path in source.rglob("*"):
        if not path.resolve(strict=True).is_relative_to(source):
            raise ValueError("app path escape")
    output_parent.mkdir(parents=True, exist_ok=True)
    destination = Path(mkdtemp(prefix="macos-candidate-", dir=output_parent)).resolve()
    app = destination / source.name
    # Tauri materializes directory aliases; native framework signing needs the
    # original already-verified framework layout, not duplicated Current folders.
    resources = source / "Contents/Resources"
    shutil.copytree(source, app, symlinks=True,
                    ignore=lambda directory, names: {"runtime"} if Path(directory) == resources else set())
    runtime = app / "Contents/Resources/runtime"
    shutil.copytree(raw_runtime, runtime, symlinks=True)
    verify_manifest(runtime, raw_manifest)  # Reject copy races before signing anything.
    paths = {item["path"]: runtime / item["path"] for item in original["files"]}
    modes = {name: path.lstat().st_mode & 0o777 for name, path in paths.items()}
    code = []
    for name, path in paths.items():
        if path.is_symlink():
            continue
        with path.open("rb") as stream:
            if stream.read(4) in MACHO_HEADERS:
                code.append(name)
    if not code:
        raise ValueError("no runtime Mach-O code found")
    # Only code files are signed, deepest first. Never --deep-sign a bundle or
    # re-sign the input app; rejected output remains separate for diagnosis.
    for name in sorted(code, key=lambda value: (-len(Path(value).parts), value)):
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(paths[name])],
                       check=True, capture_output=True, timeout=30)
    frameworks = sorted((path for path in runtime.rglob("*.framework") if path.is_dir() and not path.is_symlink()),
                        key=lambda path: (-len(path.parts), str(path)))
    for frame in frameworks:
        subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(frame)],
                       check=True, capture_output=True, timeout=30)
    frame_paths = [path.relative_to(runtime) for path in frameworks]
    before = {item["path"]: item for item in original["files"]}
    after = {item["path"]: item for item in inventory(runtime)}
    additions = set(after) - set(before)
    if set(before) - set(after) or any(not signature_envelope(name, frame_paths) for name in additions):
        raise ValueError("signing changed runtime inventory")
    signed = deepcopy(original)
    changed = []
    for item in original["files"]:
        path = paths[item["path"]]
        if (path.lstat().st_mode & 0o777) != modes[item["path"]] or ("symlink" in item) != path.is_symlink():
            raise ValueError("signing changed runtime type or permissions")
        if "symlink" in item:
            if after[item["path"]] != item:
                raise ValueError("signing changed runtime alias")
            continue
        if after[item["path"]]["sha256"] != item["sha256"]:
            if item["path"] not in code and not signature_envelope(item["path"], frame_paths):
                raise ValueError("signing changed non-code resource")
            changed.append(item["path"])
    signed["files"] = [after[name] for name in sorted(after)]
    signed["signing_transform"] = {"version": 1, "kind": "macos_adhoc", "input_manifest_sha256": sha256(original_bytes).hexdigest(),
        "staged_manifest_sha256": sha256(staged_bytes).hexdigest(), "tool_sha256": sha256(Path(__file__).read_bytes()).hexdigest(),
        "code_paths": sorted(code), "changed_paths": sorted(changed), "added_signature_resources": sorted(additions)}
    output_manifest = destination / "runtime-manifest.json"
    output_manifest.write_text(json.dumps(signed, indent=2) + "\n")
    (destination / "input-runtime-manifest.json").write_bytes(original_bytes)
    (destination / "staged-runtime-manifest.json").write_bytes(staged_bytes)
    verify_manifest(runtime, output_manifest)
    count = verify_runtime_signatures(runtime)
    subprocess.run(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", str(app)],
                   check=True, capture_output=True, timeout=30)
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--all-architectures", str(app)],
                   check=True, capture_output=True, timeout=30)
    verify_manifest(runtime, output_manifest)  # Outer sealing must not change code again.
    return {"app": str(app), "manifest": str(output_manifest), "input_manifest": str(destination / "input-runtime-manifest.json"),
            "staged_manifest": str(destination / "staged-runtime-manifest.json"),
            "runtime_macho_files": count, "changed_runtime_files": len(changed)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify")
    verify.add_argument("runtime", type=Path)
    verify.add_argument("--app", type=Path)
    finalize = commands.add_parser("finalize")
    finalize.add_argument("app", type=Path)
    finalize.add_argument("manifest", type=Path)
    finalize.add_argument("--raw-runtime", type=Path, required=True)
    finalize.add_argument("--raw-manifest", type=Path, required=True)
    finalize.add_argument("--output-parent", type=Path, default=ROOT / "build/macos-candidates")
    args = parser.parse_args(argv)
    if sys.platform != "darwin":
        parser.error("macOS host required")
    if args.command == "finalize":
        print(json.dumps(finalize_candidate(args.app, args.manifest, args.output_parent,
                                            raw_runtime=args.raw_runtime, raw_manifest=args.raw_manifest)))
        return 0
    count = verify_runtime_signatures(args.runtime)
    if args.app:
        app = args.app.resolve(strict=True)
        if not app.is_dir() or app.suffix != ".app":
            raise ValueError("app bundle required")
        subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--all-architectures", str(app)],
                       check=True, capture_output=True, timeout=30)
    print(json.dumps({"schema_version": 1, "status": "ok", "runtime_macho_files": count,
                      "outer_app_verified": args.app is not None}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
