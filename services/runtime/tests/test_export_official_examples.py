"""Compile the reviewed artifacts, not only the adapter's older smoke fixture."""

import os
from pathlib import Path
import shutil

import pytest

from services.runtime.stt_runtime.export.ink_compiler import OfficialInkCompiler
from services.runtime.stt_runtime.export.yarn_spinner import OfficialYarnCompiler

EXAMPLES = Path(__file__).parents[3] / "fixtures/export_examples"
INK = os.environ.get("STT_TEST_INKLECATE") or shutil.which("inklecate")
YARN = shutil.which("ysc")


@pytest.mark.skipif(INK is None, reason="official inklecate 1.2.1 is required")
@pytest.mark.parametrize("scope", ["whole", "main"])
def test_official_ink_compiles_reviewed_whole_and_main_artifacts(scope):
    result = OfficialInkCompiler(INK).validate((EXAMPLES / f"aurora-{scope}.golden.ink").read_bytes())
    assert result.status == "valid", result.detail


@pytest.mark.skipif(YARN is None, reason="official YarnSpinner.Console 3.0.2 is required")
@pytest.mark.parametrize("scope", ["whole", "main"])
def test_official_yarn_compiles_reviewed_whole_and_main_artifacts(scope):
    result = OfficialYarnCompiler(YARN).validate((EXAMPLES / f"aurora-{scope}.golden.yarn").read_bytes())
    assert result.status == "valid", result.detail
