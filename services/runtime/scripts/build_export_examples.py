"""Build reviewed P8-010 fixtures, never user projects or runtime export folders.

Run with --check in tests/CI to detect drift without writing. This development
fixture tool is not a user-facing export CLI or a second serialization authority.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path

from services.runtime.stt_runtime.engine_tags.aliases import initial_target_aliases
from services.runtime.stt_runtime.export.executable_projection import ExecutableProjectionService
from services.runtime.stt_runtime.export.ink import InkExportService
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.export.serialization import ExportSerializationService
from services.runtime.stt_runtime.export.yarn_spinner import YarnSpinnerExportService
from services.runtime.stt_runtime.project_fixture import load_project_fixture
from services.runtime.stt_runtime.schemas.engine_tags import EngineTagTargetAliasV1
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1
from services.runtime.stt_runtime.schemas.project_document import create_project_document
from services.runtime.stt_runtime.schemas.project_fixture import ProjectFixtureEnvelope

ROOT = Path(__file__).resolve().parents[3]
PROJECTS = ROOT / "fixtures/projects"
EXAMPLES = ROOT / "fixtures/export_examples"
READY_NAME = "project-aurora-export.v1.json"
EXCLUDED = {"fixture_version", "slug", "playback_effects", "expected_validation"}


def ready_aurora() -> ProjectFixtureEnvelope:
    """Derive an independent example with explicit, reviewed authoring changes."""
    payload = load_project_fixture(PROJECTS / "project-aurora.v1.json").model_dump(mode="json")

    def rebind(value):
        if isinstance(value, dict):
            return {key: "project-aurora-export" if key == "project_id" else rebind(item)
                    for key, item in value.items()}
        if isinstance(value, list):
            return [rebind(item) for item in value]
        return value

    payload = rebind(payload)
    payload["slug"] = "project-aurora-export"
    payload["manifest"]["name"] = "Project Aurora Export"
    payload["manifest"]["description"] = "Reviewed export example; original Canon diagnostic fixture is unchanged."
    aliases = [EngineTagTargetAliasV1.model_validate(alias)
               for definition in payload["engine_tag_definitions"] for alias in definition["aliases"]]
    for definition in payload["engine_tag_definitions"]:
        present = {alias["target"] for alias in definition["aliases"]}
        for alias in initial_target_aliases(definition["normalized_key"], aliases):
            if alias.target not in present:
                definition["aliases"].append(alias.model_dump(mode="json"))
                aliases.append(alias)
    # Proof is available after Ilya's authored Dialogue outcome gives Mara the Ledger.
    for quest in payload["quests"]:
        for stage in quest["document"]["stages"]:
            for branch in stage["branches"]:
                if branch["condition"] in {"ledger_acquired", "ledger_verified"}:
                    branch["condition"] = 'items.node-sealed-ledger.holder.node_id == "node-hero"'
    # Whole-project export exposes the standalone blockade as another root. Give
    # it explicit custody/status rather than relying on an absent caller's state.
    state = deepcopy(next(item for item in payload["flow_initial_states"] if item["flow_id"] == "flow-smuggler-route"))
    state.update(id="state-blockade-ledger", flow_id="flow-z-blockade-outcome")
    payload["flow_initial_states"].append(state)
    payload["flow_initial_states"].sort(key=lambda item: item["id"])
    payload["expected_validation"]["flow_initial_state_count"] = len(payload["flow_initial_states"])
    return ProjectFixtureEnvelope.model_validate(payload)


def document_for(fixture: ProjectFixtureEnvelope):
    """Use the same validated portable document boundary as fixture import."""
    return create_project_document(**fixture.model_dump(mode="python", exclude=EXCLUDED))


def render_example(document, options: ExportOptionsV1) -> bytes:
    """Delegate all semantics and serialization to production pure services."""
    build = ExportProjectionService().build(document, options)
    diagnostics = build.projection.diagnostics
    if options.format in {"ink", "yarn_spinner"}:
        adapter = InkExportService(compiler_policy="disabled") if options.format == "ink" else YarnSpinnerExportService(compiler_policy="disabled")
        source = adapter.build(ExecutableProjectionService().build(build.projection))
        diagnostics, result = source.diagnostics, source.payload
    else:
        result = ExportSerializationService().serialize(options.format, build.projection)
    errors = [item.code for item in diagnostics if item.severity == "error"]
    if errors or result is None:
        raise ValueError(f"Reviewed example is blocked: {errors}")
    return result


def example_files() -> dict[Path, bytes]:
    """Return fixture bytes without touching runtime projects or storage."""
    ready = ready_aurora()
    files = {PROJECTS / READY_NAME: (json.dumps(ready.model_dump(mode="json"), ensure_ascii=True, indent=2, sort_keys=True) + "\n").encode()}
    document = document_for(ready)
    for scope, label in [("whole_project", "whole"), ("story_flows", "main")]:
        for format, extension in [("json", "json"), ("yaml", "yaml"), ("ink", "ink"), ("yarn_spinner", "yarn")]:
            options = ExportOptionsV1(format=format, scope=scope,
                                      story_flow_ids=["flow-main-story"] if scope == "story_flows" else [],
                                      engine_tag_target=format if format in {"ink", "yarn_spinner"} else "generic")
            files[EXAMPLES / f"aurora-{label}.golden.{extension}"] = render_example(document, options)
    citadel = document_for(load_project_fixture(PROJECTS / "citadel-branch.v1.json"))
    for format in ["json", "yaml"]:
        files[EXAMPLES / f"citadel-whole.golden.{format}"] = render_example(citadel, ExportOptionsV1(
            format=format, scope="whole_project", engine_tag_target="generic",
        ))
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Compare only; never write fixtures")
    args = parser.parse_args()
    mismatches = []
    for path, payload in example_files().items():
        if args.check:
            if not path.exists() or path.read_bytes() != payload:
                mismatches.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(payload)
    if mismatches:
        print("Export fixture drift:\n" + "\n".join(mismatches))
        return 1
    print("Reviewed export examples match." if args.check else "Reviewed export examples written.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
