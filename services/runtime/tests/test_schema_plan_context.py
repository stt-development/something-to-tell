"""Early plan-context guards reuse B2 cleanup/redaction before privileged SQL."""

import pytest

from services.runtime.tests.test_storage_inspection_api import composition
from services.runtime.stt_runtime.project_format.service import create_project_folder
from services.runtime.stt_runtime.project_session.errors import ProjectSessionError
from services.runtime.stt_runtime.schema_plan_context import capture_schema_plan_context


@pytest.mark.parametrize("major,code", [(16, "remote_server_version_unsupported"), (17, "remote_admin_required")])
def test_context_requires_supported_administrator_before_identity_access(composition, tmp_path, major, code):
    profiles, _, engine, connection = composition
    connection.scalar.side_effect = [major * 10000, False]
    folder = create_project_folder(tmp_path / "Context.narrative")
    with pytest.raises(ProjectSessionError, match=code):
        capture_schema_plan_context(profiles, folder, "audit")
    connection.execute.assert_not_called()
    engine.dispose.assert_called_once()
