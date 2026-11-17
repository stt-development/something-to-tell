import {
  PROJECT_SESSION_VERSION,
  type ProjectSessionResponse
} from "@something-to-tell/contracts/project-session";
import { describe, expect, it } from "vitest";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";
import type { RuntimeProjectDocument } from "./projectDocumentContract";

describe("shared project session contract", () => {
  it("binds runtime session ownership to one complete project document", () => {
    const response = {
      session: {
        session_version: PROJECT_SESSION_VERSION,
        session_id: "session",
        project_id: "project",
        project_path: "/workspace/Project.narrative",
        storage_mode: "local_sqlite",
        loaded_revision: 0,
        saved_revision: 0,
        save_status: "clean",
        lifecycle: "open",
        opened_at: "2026-07-28T12:00:00+00:00",
        last_saved_at: "2026-07-28T12:00:00+00:00",
        save_error: null
      },
      document: {} as RuntimeProjectDocument
    } satisfies ProjectSessionResponse<DialogueDocument, QuestDocument>;

    expect(response.session.session_version).toBe(1);
    expect(response.session.lifecycle).toBe("open");
  });
});
