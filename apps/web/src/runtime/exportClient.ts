/** Read-only planning and explicit artifact installation client. */
import type {
  ExportPlanRequestV1,
  ExportPlanV1,
  ExportWriteRequestV1,
  ExportWriteResultV1
} from "@something-to-tell/contracts/export";
import type { RuntimeExportPersistence } from "./apiTypes";
import type { RuntimeTransport } from "./transport";

export function createExportRuntimeClient(transport: RuntimeTransport): RuntimeExportPersistence {
  return {
    async createExportPlan(sessionId: string, command: ExportPlanRequestV1): Promise<ExportPlanV1> {
      return transport.sendJson<ExportPlanV1>(
        "POST",
        `/exports/${encodeURIComponent(sessionId)}/plans`,
        command
      );
    },
    async writeExportArtifact(
      sessionId: string,
      command: ExportWriteRequestV1
    ): Promise<ExportWriteResultV1> {
      return transport.sendJson<ExportWriteResultV1>(
        "POST",
        `/exports/${encodeURIComponent(sessionId)}/writes`,
        command
      );
    }
  };
}
