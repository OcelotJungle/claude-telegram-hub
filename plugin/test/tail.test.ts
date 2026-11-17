import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { readSessionTitle, readSessionTitles, TITLE_BLOCK_BYTES, TranscriptTailer } from "../src/transcript/tail.ts";
import { sanitizeCwd, sessionTranscriptPath, transcriptPathFor } from "../src/transcript/locate.ts";
import { tempDir } from "./helpers.ts";
import { manualClock } from "./manual-clock.ts";

const TAIL_INTERVAL_MS = 20;

const line = (o: object) => JSON.stringify(o) + "\n";

describe("TranscriptTailer", () => {
  const tailers: TranscriptTailer[] = [];
  afterEach(() => {
    for (const t of tailers.splice(0)) t.stop();
  });

  function make(path: string) {
    const recs: unknown[] = [];
    let idles = 0;
    const t = new TranscriptTailer({ path, onRecord: r => recs.push(r), onIdle: () => idles++ });
    tailers.push(t);
    return { t, recs, idles: () => idles };
  }

  test("existing content is not replayed, appended lines are delivered in order", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, line({ n: 0 }));
    const { t, recs } = make(path);
    t.start();
    t.pollNow();
    expect(recs).toEqual([]);
    appendFileSync(path, line({ n: 1 }) + line({ n: 2 }));
    t.pollNow();
    expect(recs).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("a partial last line is delivered only once completed", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, "");
    const { t, recs } = make(path);
    t.start();
    const full = line({ msg: "hello" });
    appendFileSync(path, full.slice(0, 7));
    t.pollNow();
    expect(recs).toEqual([]);
    appendFileSync(path, full.slice(7));
    t.pollNow();
    expect(recs).toEqual([{ msg: "hello" }]);
  });

  test("a multi-byte character split across reads survives", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, "");
    const { t, recs } = make(path);
    t.start();
    const bytes = Buffer.from(line({ text: "\u041f\u0440\u0438\u0432\u0435\u0442" }), "utf8");
    const cut = bytes.indexOf(Buffer.from("\u0440", "utf8")) + 1; // middle of a 2-byte char
    appendFileSync(path, bytes.subarray(0, cut));
    t.pollNow();
    appendFileSync(path, bytes.subarray(cut));
    t.pollNow();
    expect(recs).toEqual([{ text: "\u041f\u0440\u0438\u0432\u0435\u0442" }]);
  });

  test("fromStart reads an existing file from its start, open() polls only on demand", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, line({ n: 0 }));
    const recs: unknown[] = [];
    const t = new TranscriptTailer({ path, fromStart: true, onRecord: r => recs.push(r) });
    t.open();
    expect(recs).toEqual([]);
    t.pollNow();
    expect(recs).toEqual([{ n: 0 }]);
  });

  test("a file that appears later is read from its start", () => {
    const path = join(tempDir(), "s.jsonl");
    const { t, recs } = make(path);
    t.start();
    t.pollNow();
    writeFileSync(path, line({ n: 1 }) + line({ n: 2 }));
    t.pollNow();
    expect(recs).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("an invalid line is skipped and the following ones delivered", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, "");
    const { t, recs } = make(path);
    t.start();
    appendFileSync(path, "{broken\n" + line({ n: 1 }));
    t.pollNow();
    expect(recs).toEqual([{ n: 1 }]);
  });

  test("a shrunk file is re-read from the start", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, line({ n: 0 }) + line({ n: 0 }));
    const { t, recs } = make(path);
    t.start();
    writeFileSync(path, line({ n: 9 }));
    t.pollNow();
    expect(recs).toEqual([{ n: 9 }]);
  });

  test("onIdle fires on a poll that brought nothing new", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, "");
    const { t, idles } = make(path);
    t.start();
    appendFileSync(path, line({ n: 1 }));
    t.pollNow();
    expect(idles()).toBe(0);
    t.pollNow();
    expect(idles()).toBe(1);
  });

  test("polls on its own timer", async () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, "");
    const recs: unknown[] = [];
    const clock = manualClock();
    const t = new TranscriptTailer({ path, onRecord: r => recs.push(r), intervalMs: TAIL_INTERVAL_MS, timers: clock });
    tailers.push(t);
    t.start();
    appendFileSync(path, line({ n: 1 }));
    expect(recs).toEqual([]);
    await clock.advance(TAIL_INTERVAL_MS);
    expect(recs).toEqual([{ n: 1 }]);
  });
});

describe("readSessionTitle", () => {
  test("custom beats agent beats ai, last record of each wins", () => {
    const path = join(tempDir(), "s.jsonl");
    writeFileSync(path, line({ type: "ai-title", aiTitle: "ai1" }) + line({ type: "ai-title", aiTitle: "ai2" }));
    expect(readSessionTitle(path)).toBe("ai2");
    appendFileSync(path, line({ type: "agent-name", agentName: "ag1" }) + line({ type: "ai-title", aiTitle: "ai3" }));
    expect(readSessionTitle(path)).toBe("ag1");
    appendFileSync(path, line({ type: "custom-title", customTitle: "c1" }));
    expect(readSessionTitle(path)).toBe("c1");
  });

  test("a title written across the reading blocks of a large transcript is read whole", () => {
    const path = join(tempDir(), "big.jsonl");
    // Filler past the 4 MiB block, ending so that the title record starts just before the boundary; the title is
    // Cyrillic, so a cut at the boundary would split a multibyte character.
    const filler = line({ type: "user", pad: "x".repeat(TITLE_BLOCK_BYTES - 40) });
    const title = "\u0421\u043e\u0446\u043d\u043e\u0432\u043e\u0441\u0442\u0438".repeat(4);
    writeFileSync(path, filler + line({ type: "custom-title", customTitle: title }) + filler + line({ type: "ai-title", aiTitle: "tail" }));
    expect(readSessionTitles(path)).toEqual({ custom: title, ai: "tail" });
  });

  test("missing file or no titles gives undefined", () => {
    const dir = tempDir();
    expect(readSessionTitle(join(dir, "none.jsonl"))).toBeUndefined();
    writeFileSync(join(dir, "x.jsonl"), line({ type: "user" }));
    expect(readSessionTitle(join(dir, "x.jsonl"))).toBeUndefined();
  });
});

describe("locate", () => {
  test("sanitizeCwd replaces every non-alphanumeric char", () => {
    expect(sanitizeCwd("C:\\code\\project")).toBe("C--code-project");
  });

  test("uses the sanitized path when it exists", () => {
    const cfg = tempDir();
    const dir = join(cfg, "projects", "C--a-b");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sid.jsonl"), "");
    expect(transcriptPathFor("sid", "C:\\a\\b", cfg)).toBe(join(dir, "sid.jsonl"));
  });

  test("falls back to searching all project dirs", () => {
    const cfg = tempDir();
    const dir = join(cfg, "projects", "other-dir");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sid.jsonl"), "");
    expect(transcriptPathFor("sid", "C:\\a\\b", cfg)).toBe(join(dir, "sid.jsonl"));
  });

  test("a named transcript that does not exist gives way to the session's existing one", () => {
    const cfg = tempDir();
    const dir = join(cfg, "projects", "C--a");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sid.jsonl"), "");
    const named = join(cfg, "projects", "C--a-sub", "sid.jsonl");
    expect(sessionTranscriptPath("sid", named, cfg)).toBe(join(dir, "sid.jsonl"));
  });

  test("a named transcript that exists, or a session with none yet, keeps the named path", () => {
    const cfg = tempDir();
    const named = join(cfg, "projects", "C--a-sub", "sid.jsonl");
    expect(sessionTranscriptPath("sid", named, cfg)).toBe(named);
    mkdirSync(join(cfg, "projects", "C--a"), { recursive: true });
    writeFileSync(join(cfg, "projects", "C--a", "sid.jsonl"), "");
    mkdirSync(join(cfg, "projects", "C--a-sub"), { recursive: true });
    writeFileSync(named, "");
    expect(sessionTranscriptPath("sid", named, cfg)).toBe(named);
  });

  test("returns the sanitized path when nothing exists yet", () => {
    const cfg = tempDir();
    expect(transcriptPathFor("sid", "C:\\a\\b", cfg)).toBe(join(cfg, "projects", "C--a-b", "sid.jsonl"));
  });
});
