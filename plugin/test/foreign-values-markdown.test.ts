import { describe, expect, test } from "bun:test";
import { infoText } from "../src/hub/info-text.ts";
import { featureText, statusText } from "../src/hub/rig.ts";
import { autocompactOutcome, compactOutcome, failureOutcome, renameOutcome, stopOutcome } from "../src/hub/session-outcome.ts";
import { catalogOf } from "../src/shared/i18n/index.ts";
import { toTelegram } from "../src/shared/markdown.ts";
import { blockError, fullInfo, INFO_NOW } from "./info-fixtures.ts";

const en = catalogOf("en");
const ru = catalogOf("ru");
// Values from outside the catalog that Markdown would eat or turn into entities.
const PATH = "C:\\projects\\_tmp\\a*b*c";
const COMMAND = "rig session <subcommand> [x]";
const MATH = "2*3*4";
const TICK = "a`b";
const FOREIGN = [PATH, COMMAND, MATH, TICK];

const shown = (md: string): string => toTelegram(md).text;
const entityTypes = (md: string): string[] => toTelegram(md).entities.map(e => e.type);

describe("foreign values in builders' Markdown", () => {
  test("/info shows rig's block errors verbatim, with bold headers rendered", () => {
    for (const v of FOREIGN) {
      const text = infoText(
        fullInfo({ claude: blockError("x", v), codex: blockError("x", v), volunteers: blockError("x", v), context: blockError("x", v) }),
        INFO_NOW,
        en,
      );
      const out = shown(text);
      expect(out.split(v).length - 1, out).toBe(4);
      expect(out).not.toContain("**");
      expect(entityTypes(text).every(t => t === "bold")).toBe(true);
    }
  });

  test("/info shows provider names and unknown limit kinds verbatim", () => {
    for (const v of FOREIGN) {
      const info = fullInfo();
      const volunteers = info.volunteers;
      if (!volunteers || "error" in volunteers) throw new Error("fixture");
      const text = infoText(
        { ...info, claude: { ...info.claude, limits: [{ kind: v, percentUsed: 1, resetsAt: null }] }, volunteers: { ...volunteers, providers: { [v]: { used: 1, cap: 2 } } } },
        INFO_NOW,
        ru,
      );
      const out = shown(text);
      expect(out).toContain(`${v}: 1/2`);
      expect(out).toContain(v);
      expect(out).not.toContain("**");
    }
  });

  test("session outcomes show rig's reasons, names and texts verbatim", () => {
    for (const v of FOREIGN) {
      for (const outcome of [
        compactOutcome({ session: "s", skip: v }, en),
        stopOutcome({ session: "s", stopped: true, compacted: { error: v } }, en),
        renameOutcome({ session: "s", name: v }, en),
        autocompactOutcome({ session: "s", window: "auto", text: v }, en),
        failureOutcome({ kind: "failure", message: v }, en),
        failureOutcome({ kind: "rig", code: "session-no-module", message: v }, en),
        stopOutcome({ session: "s", stopped: true, compacted: { skip: v } }, en),
      ]) {
        expect(shown(outcome.text)).toContain(v);
      }
    }
  });

  test("feature and status text show rig's strings verbatim", () => {
    for (const v of FOREIGN) {
      const feature = { name: v, description: v, enabled: true, platformAllowed: true };
      expect(shown(featureText([feature], en))).toBe(`✅ ${v}: ${v}`);
      const status = {
        schemaVersion: 1 as const,
        mode: "server" as const,
        versions: { rig: v, hub: v },
        releases: { rig: v, hub: null },
        features: [feature],
        lastUpdate: { time: v, type: v, text: v },
        pendingHubRestart: v,
        errors: [{ time: v, type: v, text: v }],
      };
      const out = shown(statusText(status, en));
      expect(out.split(v).length - 1).toBeGreaterThanOrEqual(10);
      expect(out).toContain(`${v} ${v}: ${v}`);
    }
  });
});
