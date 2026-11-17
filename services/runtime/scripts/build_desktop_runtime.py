"""Generate one host-native runtime candidate; never publish or overwrite an artifact."""

from hashlib import sha256
from importlib.metadata import version
import json
from pathlib import Path
import platform
import subprocess
import sys
from tempfile import mkdtemp
import tomllib

from packaging.requirements import Requirement

ROOT = Path(__file__).resolve().parents[3]


def build_arguments(destination: Path, work: Path) -> list[str]:
    """Allowlist runtime code/data; never collect the whole repository or dev extras."""
    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text())
    arguments = [
        sys.executable, "-m", "PyInstaller", "--onedir", "--noupx", "--name", "stt-runtime",
        "--distpath", str(destination), "--workpath", str(work / "work"),
        "--specpath", str(work / "spec"), "--paths", str(ROOT),
        "--collect-submodules", "services.runtime.stt_runtime",
        "--add-data", f"{ROOT / 'services/runtime/alembic.ini'}:services/runtime",
    ]
    # Include only authored migration inputs, not stale caches or bytecode.
    migrations = ROOT / "services/runtime/migrations"
    for path in sorted(migrations.rglob("*")):
        if path.is_file() and path.suffix in (".py", ".mako") and "__pycache__" not in path.parts:
            target = Path("services/runtime/migrations") / path.relative_to(migrations).parent
            arguments.extend(["--add-data", f"{path}:{target.as_posix()}"])
    for dependency in metadata["project"]["dependencies"]:
        arguments.extend(["--recursive-copy-metadata", Requirement(dependency).name])
    for excluded in ("pytest", "httpx", "tkinter", "IPython"):
        # HTTPX is test-only here; agents use the stdlib provider transport.
        arguments.extend(["--exclude-module", excluded])
    arguments.append(str(ROOT / "services/runtime/desktop_entry.py"))
    return arguments


def artifact_manifest(candidate: Path) -> dict:
    """Record actual distributable bytes without machine paths or private Git history."""
    files = []
    for path in sorted(candidate.rglob("*")):
        if path.is_symlink():
            # PyInstaller emits relative native-library aliases on some platforms.
            target = path.resolve()
            if path.readlink().is_absolute() or not target.is_relative_to(candidate.resolve()):
                raise ValueError("runtime_bundle_external_symlink")
            files.append({"path": path.relative_to(candidate).as_posix(),
                          "symlink": path.readlink().as_posix()})
        elif path.is_file():
            files.append({"path": path.relative_to(candidate).as_posix(),
                          "bytes": path.stat().st_size,
                          "sha256": sha256(path.read_bytes()).hexdigest()})
    inputs = {ROOT / "pyproject.toml", ROOT / "uv.lock", Path(__file__),
              ROOT / "services/runtime/desktop_entry.py", ROOT / "services/runtime/alembic.ini"}
    for directory in ("services/runtime/stt_runtime", "services/runtime/migrations"):
        inputs.update((ROOT / directory).rglob("*.py"))
    inputs.update((ROOT / "services/runtime/migrations").rglob("*.mako"))
    sources = [{"path": path.relative_to(ROOT).as_posix(), "sha256": sha256(path.read_bytes()).hexdigest()}
               for path in sorted(inputs)]
    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text())
    dependencies = {Requirement(item).name: version(Requirement(item).name)
                    for item in metadata["project"]["dependencies"]}
    return {"schema_version": 1, "system": platform.system(), "machine": platform.machine(),
            "python": platform.python_version(), "pyinstaller": version("pyinstaller"),
            "lock_sha256": sha256((ROOT / "uv.lock").read_bytes()).hexdigest(),
            "sources": sources, "runtime_dependencies": dependencies, "files": files}


def main() -> None:
    output = ROOT / "dist/desktop-runtime"
    output.mkdir(parents=True, exist_ok=True)
    # Every attempt gets a new owned directory; failed candidates are not overwritten.
    destination = Path(mkdtemp(prefix="candidate-", dir=output))
    work = ROOT / "build/desktop-runtime"
    work.mkdir(parents=True, exist_ok=True)
    workspace = Path(mkdtemp(prefix="build-", dir=work))
    subprocess.run(build_arguments(destination, workspace), cwd=ROOT, check=True)
    candidate = destination / "stt-runtime"
    report = artifact_manifest(candidate)
    (destination / "manifest.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"candidate": str(candidate), "manifest": str(destination / 'manifest.json')}))


if __name__ == "__main__":
    main()
