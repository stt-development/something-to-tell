import {
  engineTagOwnerKey,
  ENGINE_TAG_MAX_TEXT_LENGTH,
  EngineTagContractError,
  migrateLegacyEngineTagsV5ToV6,
  normalizeEngineTagKey,
  suggestEngineTagKey,
  type EngineTagOwnerV1
} from "@something-to-tell/contracts/engine-tags";
import { describe, expect, it } from "vitest";

const owner: EngineTagOwnerV1 = { kind: "node", project_id: "project", node_id: "node-1" };

describe("stable engine tag contracts", () => {
  it("normalizes only the documented ASCII dotted grammar", () => {
    expect(ENGINE_TAG_MAX_TEXT_LENGTH).toBe(2_000);
    expect(normalizeEngineTagKey(" Story.Main_Quest ")).toBe("story.main_quest");
    expect(() => normalizeEngineTagKey("story/main")).toThrowError(EngineTagContractError);
    expect(() => normalizeEngineTagKey("история.main")).toThrowError(EngineTagContractError);
  });

  it("transliterates labels and resolves collisions deterministically", () => {
    const request = {
      request_version: 1 as const,
      project_id: "project",
      owner,
      label: "Открыть дверь",
      existing_keys: ["node.OtkrytDver", "node.OtkrytDver_2"]
    };
    expect(suggestEngineTagKey(request)).toEqual({
      suggestion_version: 1,
      key: "Node.OtkrytDver_3",
      normalized_key: "node.otkrytdver_3",
      collision_resolved: true
    });
  });

  it("keeps owner identity stable when the runtime serializes optional fields as null", () => {
    const runtimeOwner = { ...owner, edge_id: null, dialogue_node_id: null } as unknown as EngineTagOwnerV1;
    expect(engineTagOwnerKey(runtimeOwner)).toBe(engineTagOwnerKey(owner));
  });

  it("quarantines legacy rows without mutating their nested metadata", () => {
    const rows = [{
      id: "legacy-1", project_id: "project", created_at: "now", updated_at: "now",
      target_type: "node", target_id: "node-1", engine: "unity", key: "tag", value: "x",
      metadata: { nested: { keep: true } }
    }];
    const migrated = migrateLegacyEngineTagsV5ToV6(rows);
    expect(migrated.document_version).toBe(6);
    expect(migrated.legacy_engine_tags).toEqual(rows);
    expect(migrated.legacy_engine_tags).not.toBe(rows);
    expect(migrated.legacy_engine_tags[0]?.metadata).not.toBe(rows[0]?.metadata);
  });
});
