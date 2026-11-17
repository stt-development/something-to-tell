"""Keep public deselection limited to the reviewed private-document assertions."""

import ast
from pathlib import Path
import subprocess

import pytest

from services.runtime.scripts import benchmark_storage


def test_only_reviewed_document_assertions_have_the_private_marker():
    """A new broad marker must fail review instead of silently dropping product tests."""
    directory = Path(__file__).parent
    expected = {
        "test_storage_core_evidence.py": {
            "test_core_review_preserves_original_budgets_and_explicit_size_scope",
            "test_current_complete_workload_does_not_erase_original_save_failure",
            "test_canon_control_separates_operation_reads_from_background_lease_writes",
        },
        "test_storage_admission_evidence.py": {"test_public_admission_archives_preserve_failures_complete_work_and_owned_cleanup"},
        "test_export_profile.py": {"test_frozen_export_pair_preserves_scope_probe_and_read_only_evidence"},
        "test_session_profile.py": {"test_session_evidence_preserves_failed_before_and_verified_capture_reduction"},
        "test_migration_batch_profile.py": {"test_node_batch_evidence_keeps_rejection_and_three_owned_successes_distinct"},
        "test_storage_scale.py": {"test_frozen_observations_match_pinned_inputs_and_explicit_coverage"},
        "test_storage_restore.py": {"test_native_drill_archive_is_complete_redacted_and_not_desktop_evidence"},
        "test_migration_profile.py": {
            "test_frozen_migration_evidence_keeps_controls_and_timeouts_distinct",
            "test_batch_migration_evidence_verifies_complete_work_without_hiding_prior_failure",
        },
        "test_remote_storage_schemas.py": {"test_private_protocol_error_table_matches_wire_codes"},
    }
    actual = {}
    marker = "pytest.mark.internal_documentation"
    for path in directory.glob("test_*.py"):
        tree = ast.parse(path.read_text())
        module_marked = any(
            isinstance(node, ast.Assign)
            and any(isinstance(target, ast.Name) and target.id == "pytestmark" for target in node.targets)
            and ast.unparse(node.value) == marker
            for node in tree.body
        )
        marked = {
            node.name for node in tree.body
            if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")
            and (module_marked or any(ast.unparse(decorator) == marker for decorator in node.decorator_list))
        }
        if marked:
            actual[path.name] = marked
        # Reject alternative/broader marker syntax rather than overlooking it.
        count = sum(isinstance(node, ast.Attribute) and ast.unparse(node) == marker for node in ast.walk(tree))
        assert count == (1 if module_marked else len(marked)), path.name
        if module_marked:
            assert not any(isinstance(node, ast.ClassDef) for node in tree.body), path.name
    assert actual == expected


@pytest.mark.parametrize("reference", ["HEAD", "HEAD:services/runtime/stt_runtime"])
def test_report_metadata_is_honest_before_and_after_the_first_commit(tmp_path, monkeypatch, reference):
    """Exercise real Git instead of relying on this checkout's existing history."""
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    monkeypatch.setattr(benchmark_storage, "ROOT", tmp_path)
    assert benchmark_storage._git_revision(reference) is None
    directory = tmp_path / "services/runtime/stt_runtime"
    directory.mkdir(parents=True)
    (directory / "module.py").write_text("# Fixture source\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run([
        "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
        "-c", "commit.gpgsign=false", "commit", "-m", "fixture",
    ], cwd=tmp_path, check=True, capture_output=True)
    expected = subprocess.check_output(["git", "rev-parse", reference], cwd=tmp_path, text=True).strip()
    assert benchmark_storage._git_revision(reference) == expected


def test_report_metadata_allows_a_source_archive_without_git(monkeypatch):
    def missing_git(*args, **kwargs):
        raise FileNotFoundError("git")
    monkeypatch.setattr(benchmark_storage.subprocess, "run", missing_git)
    assert benchmark_storage._git_revision("HEAD") is None
