"""Busy-volume retries are bounded and never weaken the normal detach gate."""
import os
from pathlib import Path
import subprocess

import pytest

ROOT = Path(__file__).parents[3]


@pytest.mark.parametrize("failures,status,expected_calls,expected_status", [
    (0, 16, 1, 0), (2, 16, 3, 0), (9, 16, 5, 16), (1, 5, 1, 5),
])
def test_detach_retries_only_busy_and_preserves_final_status(tmp_path, failures, status, expected_calls, expected_status):
    # Fake native commands: exercise the actual shell helper without mounting disks.
    hdiutil = tmp_path / "hdiutil"
    hdiutil.write_text('''#!/bin/bash
printf '%s\\n' "$@" >> "$CALLS"
count=0
if [ -f "$COUNT" ]; then read -r count < "$COUNT"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$COUNT"
if [ "$count" -le "$FAILURES" ]; then exit "$FAIL_STATUS"; fi
''')
    sleep = tmp_path / "sleep"
    sleep.write_text('#!/bin/bash\nprintf "%s\\n" "$1" >> "$SLEEPS"\n')
    hdiutil.chmod(0o755)
    sleep.chmod(0o755)
    env = {**os.environ, "PATH": str(tmp_path), "CALLS": str(tmp_path / "calls"),
           "COUNT": str(tmp_path / "count"), "SLEEPS": str(tmp_path / "sleeps"),
           "FAILURES": str(failures), "FAIL_STATUS": str(status)}
    mount = str(tmp_path / "mount with spaces")
    result = subprocess.run(["/bin/bash", str(ROOT / "tools/detach-macos-image.sh"), mount],
                            env=env, capture_output=True, text=True, timeout=5)
    assert result.returncode == expected_status
    assert (tmp_path / "calls").read_text().splitlines() == ["detach", mount] * expected_calls
    waits = tmp_path / "sleeps"
    assert (waits.read_text().splitlines() if waits.exists() else []) == [str(i) for i in range(1, expected_calls)]


def test_detach_requires_one_nonempty_mountpoint():
    for args in ([], [""], ["one", "two"]):
        result = subprocess.run(["/bin/bash", str(ROOT / "tools/detach-macos-image.sh"), *args],
                                capture_output=True, timeout=5)
        assert result.returncode == 2
