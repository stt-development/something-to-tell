import type { ProjectDocument } from "@something-to-tell/contracts/project-document";
import type { DialogueDocument } from "../dialogue/contracts";
import type { QuestDocument } from "../quest/contracts";

/** Frontend projection of the runtime-owned complete durable document. */
export type RuntimeProjectDocument = ProjectDocument<DialogueDocument, QuestDocument>;
