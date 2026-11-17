"""Functional CI keeps real prerequisites, product gates and visible skips."""
import importlib.util
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import subprocess

import pytest
import yaml
from services.runtime.tests import test_postgresql_restore_drill as restore

ROOT = Path(__file__).parents[3]
WORKFLOWS = ROOT / ".github/workflows"
spec = importlib.util.spec_from_file_location("ci_report", ROOT / "tools/check-ci-test-report.py")
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


def workflow(name):
    # GitHub's YAML treats `on` as a key; BaseLoader avoids YAML1.1 boolean `on`.
    return yaml.load((WORKFLOWS / name).read_text(), Loader=yaml.BaseLoader)


def test_only_functional_workflow_automatically_runs_product_checks():
    automatic = []
    for path in WORKFLOWS.glob("*.yml"):
        triggers = workflow(path.name)["on"]
        if "pull_request" in triggers or "push" in triggers:
            automatic.append(path.name)
    assert automatic == ["functional-tests.yml"]
    current = workflow(automatic[0])
    assert set(current["on"]) == {"pull_request", "push", "workflow_dispatch"}
    assert current["name"] == "Functional verification"
    assert current["on"]["push"]["branches"] == ["main"]
    assert current["permissions"] == {"contents": "read"}
    assert current["jobs"]["ink"]["uses"] == "./.github/workflows/ink-export.yml"
    assert current["jobs"]["yarn"]["uses"] == "./.github/workflows/yarn-export.yml"


@pytest.mark.parametrize("event,branch,expected", [
    ("push", "fix/ci-runner-context", False),
    ("push", "feature/story-tools", False),
    ("pull_request", "fix/ci-runner-context", True),
    ("pull_request", "feature/story-tools", True),
    ("push", "main", True),
    ("workflow_dispatch", "fix/ci-runner-context", True),
])
def test_pr_commits_do_not_schedule_a_second_branch_push_run(event, branch, expected):
    # Branch pushes with an open PR emit both events; only PR may schedule tests.
    triggers = workflow("functional-tests.yml")["on"]
    selected = event in triggers
    if event == "push" and selected:
        selected = any(fnmatchcase(branch, pattern) for pattern in triggers[event]["branches"])
    assert selected is expected


def test_public_product_and_browser_checks_keep_real_postgresql_and_no_stress_runner():
    jobs = workflow("functional-tests.yml")["jobs"]
    job = jobs["foundation"]
    assert job["runs-on"] == "ubuntu-24.04"
    assert job["services"]["postgres"]["image"] == "postgres:17-alpine"
    assert "STT_TEST_POSTGRES_URL" in job["env"]
    assert job["env"]["STT_TEST_POSTGRES_TLS"] == "1"
    assert job["env"]["STT_TEST_POSTGRES_NATIVE_DOCKER"] == "1"
    verify = next(step for step in job["steps"] if step.get("run") == "pnpm verify:public")
    assert verify["env"]["STT_TEST_POSTGRES_CONTAINER"] == "${{ job.services.postgres.id }}"
    assert "--junitxml=" in verify["env"]["PYTEST_ADDOPTS"]
    commands = "\n".join(step.get("run", "") for step in job["steps"])
    for gate in ["pnpm verify:public", "--frozen-lockfile", "uv sync --all-extras --locked", "check-ci-test-report.py"]:
        assert gate in commands
    assert "perf:baseline" not in commands and "performance/run" not in commands and "benchmark_storage" not in commands
    assert "continue-on-error" not in str(job)
    native = jobs["desktop-unit"]
    assert native["runs-on"] == "macos-15"
    assert any("cargo test --locked" in step.get("run", "") for step in native["steps"])


def test_browser_job_discovers_every_spec_independently_and_rejects_skipped_coverage():
    job = workflow("functional-tests.yml")["jobs"]["browser"]
    assert job["runs-on"] == "ubuntu-24.04" and "needs" not in job
    scripts = json.loads((ROOT / "apps/web/package.json").read_text())["scripts"]
    # Directory discovery includes new functional specs without maintaining a second list.
    assert scripts["test:e2e"] == "playwright test e2e --workers=1"
    commands = "\n".join(step.get("run", "") for step in job["steps"])
    assert "playwright install --with-deps chromium" in commands
    assert "pnpm web:test:e2e --reporter=line,junit" in commands
    assert "trap 'kill" in commands
    assert 'check-ci-test-report.py "$RUNNER_TEMP/playwright.xml" --no-skips' in commands
    execute = next(step for step in job["steps"] if "pnpm web:test:e2e" in step.get("run", ""))
    assert execute["env"]["PLAYWRIGHT_JUNIT_OUTPUT_FILE"] == "${{ runner.temp }}/playwright.xml"
    assert "continue-on-error" not in str(job)
    for path in (ROOT / "apps/web/e2e").glob("*.spec.ts"):
        assert "/private/tmp/" not in path.read_text(), f"Nonportable browser output: {path.name}"


def test_functional_native_job_exercises_explicit_frozen_handshake_without_binary_uploads():
    job = workflow("functional-tests.yml")["jobs"]["desktop-unit"]
    commands = "\n".join(step.get("run", "") for step in job["steps"])
    assert "uv sync --all-extras --group build --locked" in commands
    assert "python -m services.runtime.scripts.build_desktop_runtime" in commands
    assert '.candidate,"stt-runtime")' in commands
    assert 'env PATH=/nonexistent "$executable" --self-check' in commands
    assert "test_desktop_runtime.py services/runtime/tests/test_desktop_lifecycle.py" in commands
    assert 'check-ci-test-report.py "$RUNNER_TEMP/frozen.xml" --no-skips' in commands
    assert "runtime_supervisor::tests::real_frozen_child_handshake -- --ignored --exact" in commands
    configure = next(step for step in job["steps"] if step.get("name") == "Configure disposable runtime paths")
    for name in ["STT_RUNTIME_STORAGE_PROFILES_FILE", "STT_RUNTIME_STORAGE_MASTER_KEY_FILE", "STT_RUNTIME_CANON_PROVIDER_PROFILES_FILE"]:
        assert configure["env"][name].startswith("${{ runner.temp }}/")
    # Diagnostics are retained; compiler output is never a distributable PR artifact.
    for current in workflow("functional-tests.yml")["jobs"].values():
        for step in current.get("steps", []):
            if step.get("uses") == "actions/upload-artifact@v4":
                assert all("dist/" not in line and "target/" not in line
                           for line in step["with"]["path"].splitlines())


def test_runner_context_is_not_evaluated_before_steps_are_dispatched():
    # GitHub rejects these contexts in workflow/job env before creating any jobs.
    for path in WORKFLOWS.glob("*.yml"):
        current = workflow(path.name)
        envs = [current.get("env", {})]
        envs.extend(job.get("env", {}) for job in current["jobs"].values())
        for env in envs:
            assert "runner." not in json.dumps(env), path.name


@pytest.mark.parametrize("filename,job_id", [
    ("functional-tests.yml", "desktop-unit"),
    ("macos-candidate.yml", "macos-candidate"),
    ("linux-candidate.yml", "linux-candidate"),
])
def test_disposable_paths_are_exported_for_later_steps(filename, job_id, tmp_path):
    job = workflow(filename)["jobs"][job_id]
    step = next(step for step in job["steps"] if step.get("name") == "Configure disposable runtime paths")
    owned = {key: value.replace("${{ runner.temp }}", str(tmp_path / "owned space"))
             for key, value in step["env"].items()}
    output = tmp_path / "github-env"
    subprocess.run(["bash", "-e", "-c", step["run"]],
                   env={**os.environ, **owned, "GITHUB_ENV": str(output)}, check=True)
    assert dict(line.split("=", 1) for line in output.read_text().splitlines()) == owned


@pytest.mark.parametrize("name,pin", [("ink-export.yml", "v1.2.1"), ("yarn-export.yml", "--version 3.0.2")])
def test_compiler_jobs_are_reusable_pinned_and_reject_skips(name, pin):
    current = workflow(name)
    assert set(current["on"]) == {"workflow_call"}
    assert current["permissions"] == {"contents": "read"}
    job = current["jobs"]["official-compiler"]
    assert job["runs-on"] == "ubuntu-24.04"
    commands = "\n".join(step.get("run", "") for step in job["steps"])
    assert pin in commands and "--junitxml=" in commands and "--no-skips" in commands
    assert "test_export_official_examples.py" in commands
    assert ("test_export_ink.py" if name == "ink-export.yml" else "test_export_yarn_spinner.py") in commands
    assert "continue-on-error" not in str(job)
    if name == "ink-export.yml":
        assert "1997ff5bca618c90003ecd5fecb286e7468abb955005a2a185042949642f8fb5" in commands
        assert "sha256sum --check" in commands


@pytest.mark.parametrize("element,accepted", [("", True), ("<failure/>", False), ("<error/>", False), ("<skipped message='compiler absent'/>", False)])
def test_compiler_report_requires_actual_non_skipped_passing_cases(tmp_path, element, accepted):
    path = tmp_path / "results.xml"
    path.write_text(f"<testsuites><testsuite><testcase classname='export' name='compile'>{element}<system-out>PRIVATE OUTPUT</system-out></testcase></testsuite></testsuites>")
    summary, result = report.inspect_report(path, no_skips=True)
    assert result is accepted
    assert summary["tests"] == 1 and "PRIVATE OUTPUT" not in str(summary)


def test_general_report_discloses_skips_and_cli_rejects_missing_empty_or_malformed_report(tmp_path, capsys):
    path = tmp_path / "results.xml"
    path.write_text("<testsuite><testcase name='compiler'><skipped message='missing prerequisite'/></testcase></testsuite>")
    assert report.main([str(path)]) == 0
    assert "missing prerequisite" in capsys.readouterr().out
    assert report.main([str(path), "--no-skips"]) == 1
    for value in ["<testsuites/>", "<invalid/>", "not xml"]:
        path.write_text(value)
        assert report.main([str(path)]) == 1
    assert report.main([str(tmp_path / "missing.xml")]) == 1


@pytest.mark.parametrize("container", [None, "a" * 64])
def test_restore_tools_target_only_explicit_ci_container_or_existing_compose_service(monkeypatch, container):
    if container:
        monkeypatch.setenv("STT_TEST_POSTGRES_CONTAINER", container)
    else:
        monkeypatch.delenv("STT_TEST_POSTGRES_CONTAINER", raising=False)
    calls = []
    monkeypatch.setattr(restore.subprocess, "run", lambda args, **kwargs: calls.append((args, kwargs)))
    restore._native("pg_restore", "--version", payload=b"owned input")
    command, options = calls[0]
    assert command == (["docker", "exec", "-i", container, "pg_restore", "--version"] if container
                       else ["docker-compose", "exec", "-T", "postgres", "pg_restore", "--version"])
    assert options["input"] == b"owned input" and "shell" not in options


def test_restore_tool_rejects_non_container_identifiers_before_process_creation(monkeypatch):
    monkeypatch.setenv("STT_TEST_POSTGRES_CONTAINER", "postgres; external-command")
    monkeypatch.setattr(restore.subprocess, "run", lambda *args, **kwargs: pytest.fail("unexpected process"))
    with pytest.raises(ValueError, match="Invalid disposable"):
        restore._native("pg_dump", "--version")
