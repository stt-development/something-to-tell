"""Owned whole/scoped export attribution; no normal-runtime instrumentation.

Reuse the pinned benchmark's import/migration/cleanup, but export the fresh source
without preceding edits/history/Save. This series is not a P9-001 speedup sample.
Stage times are inclusive; allocation peaks cover the complete guarded operation.
"""

import argparse
from hashlib import sha256
import json
from pathlib import Path
import shutil
from tempfile import mkdtemp
from unittest.mock import patch

from services.runtime.scripts import benchmark_storage as benchmark
from services.runtime.scripts.profile_storage_session import SessionProfile
from services.runtime.scripts.storage_scale_metrics import OperationMetrics
from services.runtime.stt_runtime.engine_tags.projection import EngineTagProjectionService
from services.runtime.stt_runtime.export.projection import ExportProjectionService
from services.runtime.stt_runtime.export.serialization import JsonExportAdapter
from services.runtime.stt_runtime.export.writer import AtomicExportWriter
from services.runtime.stt_runtime.project_document import service as document_module
from services.runtime.stt_runtime.project_session import remote_reads
from services.runtime.stt_runtime.schemas.export import ExportOptionsV1


class ExportProfile(SessionProfile):
    """Transient fixed-label spans; never retain SQL, paths or author content."""

    TARGETS = SessionProfile.TARGETS + (
        (document_module, "create_project_document", "document_assembly"),
        (remote_reads, "capture", "guarded_capture"),
        (ExportProjectionService, "build", "projection"),
        (ExportProjectionService, "_selected_scope", "selected_closure"),
        (EngineTagProjectionService, "project", "tag_projection"),
        (JsonExportAdapter, "serialize", "serialization"),
        (AtomicExportWriter, "install", "installation"),
    )


def measure_exports(registry, project_path, artifact_path, report, *, full_history=False):
    """Measure only guarded reads; inspect complete source before and after."""
    opened = registry.open(project_path)
    session_id = opened.session.session_id
    before = registry.inspect(session_id)
    flow_id = opened.document.story_flows[0].id
    report["measurement_kind"] = "fresh_source_export_allocation_sql_inclusive_stages"
    report["probe_sha256"] = sha256(Path(__file__).read_bytes()).hexdigest()

    for scope in ("whole_project", "story_flows"):
        def export():
            with registry.readonly_document_guard(session_id) as (document, _):
                options = ExportOptionsV1(
                    format="json", scope=scope, engine_tag_target="generic",
                    story_flow_ids=[flow_id] if scope == "story_flows" else [],
                )
                build = ExportProjectionService().build(document, options)
                if any(item.severity == "error" for item in build.projection.diagnostics):
                    raise ValueError("scale_export_diagnostic_error")
                payload = JsonExportAdapter().serialize(build.projection)
                artifact = AtomicExportWriter().install(
                    payload=payload, destination_directory=artifact_path,
                    filename=f"{scope}.json", format="json",
                    source_checksum=document.checksum, overwrite=False,
                )
                return dict(bytes=artifact.bytes_written, checksum=artifact.artifact_checksum,
                            records=build.inventory.record_count, nodes=build.inventory.node_count,
                            source_checksum=document.checksum)

        collector, profile = OperationMetrics(), ExportProfile()
        status = "failed"
        try:
            with profile:
                artifact, metrics = collector.measure("export_" + scope, export)
            status = "ok"
        finally:
            report["operations"].append({
                **getattr(collector, "last", {"operation": "export_" + scope}),
                "status": status, "attribution": profile.summary(),
            })
        report["operations"][-1]["artifact"] = artifact
    report["integrity"] = {
        "export_read_only": registry.inspect(session_id) == before,
        "complete_source_checksum": all(
            row["artifact"]["source_checksum"] == before.document.checksum
            for row in report["operations"]
        ),
    }
    assert all(report["integrity"].values())
    registry.close(session_id)


def run_export_case(size, mode, folder, database_url=None):
    """Original setup/finally owns all sessions, never a manual project folder."""
    with patch.object(benchmark, "measure_operations", measure_exports):
        return benchmark.run_case(size, mode, folder, database_url)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--size", type=int, choices=(1000,), default=1000)
    parser.add_argument("--modes", nargs="+", choices=("local_sqlite", "postgresql"),
                        default=["local_sqlite", "postgresql"])
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    reports = []
    for mode in args.modes:
        report = dict(mode=mode, status="failed", database_cleanup="not_acquired")
        root = Path(mkdtemp(prefix="stt-export-profile-")).resolve()
        try:
            # Resolve macOS /var without weakening the writer's symlink policy.
            folder = root / "case"
            if mode == "postgresql":
                with benchmark.disposable_database() as url:
                    report = run_export_case(args.size, mode, folder, url)
                report["database_cleanup"] = "released"
            else:
                report = run_export_case(args.size, mode, folder)
                report["database_cleanup"] = "not_applicable"
        except Exception as error:
            # No raw driver prose, credentials or resource paths in artifacts.
            report.update(status="failed", error_type=type(error).__name__)
        finally:
            # Never remove a folder whose public session release failed.
            report["local_cleanup"] = "retained" if list(root.rglob("project.lock.json")) else "released"
            if report["local_cleanup"] == "released":
                shutil.rmtree(root)
        reports.append(report)
    args.report.write_text(json.dumps({"report_version": 1, "cases": reports}, indent=2) + "\n")
    print(json.dumps([dict(mode=row["mode"], status=row["status"]) for row in reports]))
    return 0 if all(row["status"] == "ok" and row["local_cleanup"] == "released"
                    for row in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
