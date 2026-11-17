"""A missing notice bundle must block binary uploads, not just release promotion."""
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).parents[3]


@pytest.mark.parametrize("platform", ["windows", "macos", "linux"])
def test_native_candidates_require_and_copy_notices_before_binary_upload(platform):
    workflow = yaml.load((ROOT / f".github/workflows/{platform}-candidate.yml").read_text(), Loader=yaml.BaseLoader)
    steps = workflow["jobs"][f"{platform}-candidate"]["steps"]
    first_upload = next(index for index, step in enumerate(steps) if step.get("uses") == "actions/upload-artifact@v4")
    before = "\n".join(step.get("run", "") for step in steps[:first_upload])
    if platform == "windows":
        assert "Test-Path THIRD_PARTY_NOTICES.md" in before
        assert "Get-Item THIRD_PARTY_NOTICES.md).Length -eq 0" in before
        assert "throw 'Reviewed THIRD_PARTY_NOTICES.md is required" in before
        assert "Copy-Item THIRD_PARTY_NOTICES.md $destination" in before
    else:
        assert "test -s THIRD_PARTY_NOTICES.md" in before
        assert 'cp THIRD_PARTY_NOTICES.md "$destination/"' in before
        assert "LICENSE THIRD_PARTY_NOTICES.md runtime-manifest.json" in before
    assert steps[first_upload]["with"]["if-no-files-found"] == "error"
