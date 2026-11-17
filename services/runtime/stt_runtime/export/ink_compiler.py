"""Pinned official inklecate process boundary; compiler JSON stays temporary."""

from dataclasses import dataclass
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from typing import Literal, Protocol

INK_VERSION = "1.2.1"
InkCompilerPolicy = Literal["disabled", "optional", "required"]
# Official v1.2.1 release executables. Hash identity avoids relying on a CLI
# version flag: inklecate does not provide one.
INKLECATE_DIGESTS = {
    "df0f53f321203bb5f7ccfe7debb3f0f9abb3f328a56363bef4dde605baf17e5e",
    "fbd469d57a4476cba9ec7549b04b23b4d01b4ff9307916f83cb4e2540bb60444",
}


@dataclass(frozen=True, slots=True)
class InkCompilerValidation:
    status: Literal["disabled", "unavailable", "valid", "invalid", "version_mismatch"]
    detail: str = ""


class InkCompiler(Protocol):
    """Compile complete source through an independently substitutable tool."""

    def validate(self, source: bytes) -> InkCompilerValidation: ...


class OfficialInkCompiler:
    """Validate using the exact official release, without installing its JSON."""

    def __init__(self, executable: str | None = None) -> None:
        self._configured = executable

    def validate(self, source: bytes) -> InkCompilerValidation:
        executable = self._configured or shutil.which("inklecate")
        if executable is None:
            return InkCompilerValidation("unavailable", "inklecate was not found")
        try:
            if sha256(Path(executable).read_bytes()).hexdigest() not in INKLECATE_DIGESTS:
                return InkCompilerValidation("version_mismatch", "expected official inklecate 1.2.1")
            with tempfile.TemporaryDirectory(prefix="stt-ink-") as directory:
                root = Path(directory)
                input_file = root / "narrative.ink"
                output_file = root / "compiled.json"
                input_file.write_bytes(source)
                result = subprocess.run(
                    [executable, "-o", str(output_file), str(input_file)],
                    capture_output=True, text=True, timeout=30, check=False,
                )
                detail = (result.stdout + "\n" + result.stderr).replace(str(root), "<temporary>")
                # Some compiler releases print errors while still returning zero.
                valid = result.returncode == 0 and output_file.is_file()
                if valid:
                    compiled = json.loads(output_file.read_text(encoding="utf-8-sig"))
                    valid = isinstance(compiled, dict) and "inkVersion" in compiled
                return InkCompilerValidation("valid" if valid else "invalid", detail.strip()[:2000])
        except (OSError, subprocess.SubprocessError) as error:
            return InkCompilerValidation("unavailable", str(error)[:500])
        except (ValueError, UnicodeError):
            return InkCompilerValidation("invalid", "compiler produced an invalid artifact")
