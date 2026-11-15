import { describe, expect, test } from "bun:test";
import { infoDataSchema } from "../src/hub/info-schema.ts";
import { bareInfo, blockError, fullInfo } from "./info-fixtures.ts";

describe("rig's InfoData contract, as the hub checks it", () => {
  test("accepts the full answer, the bare one and blocks that failed", () => {
    expect(infoDataSchema.safeParse(fullInfo()).success).toBe(true);
    expect(infoDataSchema.safeParse(bareInfo()).success).toBe(true);
    const failed = fullInfo({ claude: blockError("no-data", "x"), codex: blockError("c", "y"), volunteers: blockError("v", "z"), context: blockError("no-data", "w") });
    expect(infoDataSchema.safeParse(failed).success).toBe(true);
  });

  test("accepts the nullable times rig allows for claude and context", () => {
    const claude = { at: null, sessionId: "s", limits: [] };
    const context = { at: null, tokens: 1, window: null };
    expect(infoDataSchema.safeParse(fullInfo({ claude, context })).success).toBe(true);
  });

  test("rejects a time rig does not allow to be null (codex, volunteers)", () => {
    const full = fullInfo();
    expect(infoDataSchema.safeParse({ ...full, codex: { at: null, limits: [] } }).success).toBe(false);
    const volunteers = full.volunteers;
    expect(infoDataSchema.safeParse({ ...full, volunteers: { ...volunteers, at: null } }).success).toBe(false);
  });

  test("rejects a field rig does not promise, a wrong type and a bad estimated flag", () => {
    const full = fullInfo();
    expect(infoDataSchema.safeParse({ ...full, extra: 1 }).success).toBe(false);
    expect(infoDataSchema.safeParse({ ...full, session: 5 }).success).toBe(false);
    expect(infoDataSchema.safeParse({ ...full, context: { at: null, tokens: 1, window: null, estimated: false } }).success).toBe(false);
    expect(infoDataSchema.safeParse({ ...full, claude: { at: null, sessionId: "s", limits: [{ kind: "x" }] } }).success).toBe(false);
  });
});
