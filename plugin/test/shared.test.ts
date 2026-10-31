import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { chunk } from "../src/shared/chunk.ts";
import { chimeCommand, defaultTurnEndChime, playChime, spawnShellDetached } from "../src/shared/chime.ts";
import { idleMs, loadConfig, loadToken, paths } from "../src/shared/config.ts";
import { tempDir, waitFor } from "./helpers.ts";
import { platformFor } from "../src/shared/platform.ts";

const CHIME_WAIT_MS = 10_000;

// Writes to argv[2] whether this process has a console window: none, hidden or visible.
const CONSOLE_PROBE = [
  `import { dlopen, FFIType } from "bun:ffi";`,
  `import { writeFileSync } from "fs";`,
  `const k32 = dlopen("kernel32.dll", { GetConsoleWindow: { args: [], returns: FFIType.ptr } });`,
  `const u32 = dlopen("user32.dll", { IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool } });`,
  `const hwnd = k32.symbols.GetConsoleWindow();`,
  `writeFileSync(process.argv[2] ?? "", hwnd === null ? "none" : u32.symbols.IsWindowVisible(hwnd) ? "visible" : "hidden");`,
  ``,
].join("\n");

describe("chunk", () => {
  const plain = (text: string) => ({ text, entities: [] });
  const texts = (text: string, limit?: number) => chunk(plain(text), limit).map(p => p.text);

  test("short text is one piece", () => {
    expect(chunk(plain("hello"))).toEqual([plain("hello")]);
  });

  test("empty text gives no pieces", () => {
    expect(chunk(plain(""))).toEqual([]);
  });

  test("long text is split into pieces within the limit", () => {
    const text = "abcdefghij".repeat(1000);
    const pieces = texts(text, 4096);
    expect(pieces.length).toBe(3);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(4096);
    expect(pieces.join("")).toBe(text);
  });

  test("prefers a paragraph boundary past half the limit", () => {
    const a = "a".repeat(70);
    const b = "b".repeat(50);
    expect(texts(`${a}\n\n${b}`, 100)).toEqual([a, b]);
  });

  test("falls back to a line break, then a space", () => {
    expect(texts(`${"a".repeat(70)}\n${"b".repeat(50)}`, 100)).toEqual(["a".repeat(70), "b".repeat(50)]);
    expect(texts(`${"a".repeat(70)} ${"b".repeat(50)}`, 100)).toEqual(["a".repeat(70), "b".repeat(50)]);
  });

  test("never yields whitespace-only pieces", () => {
    expect(texts(`${"a".repeat(60)}\n\n\n\n${"b".repeat(60)}`, 100)).toEqual(["a".repeat(60), "b".repeat(60)]);
  });

  test("never cuts a surrogate pair", () => {
    const pieces = texts("a" + "😀".repeat(60), 100);
    expect(pieces.join("")).toBe("a" + "😀".repeat(60));
    for (const p of pieces) expect(p).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });

  test("entities move with their piece; one on the boundary is split", () => {
    const a = "a".repeat(70);
    const b = "b".repeat(50);
    const text = `${a}\n\n${b}`;
    const pieces = chunk(
      {
        text,
        entities: [
          { type: "bold", offset: 0, length: 5 },
          { type: "pre", offset: 60, length: 20, language: "ts" },
          { type: "italic", offset: 75, length: 3 },
        ],
      },
      100,
    );
    expect(pieces).toEqual([
      { text: a, entities: [{ type: "bold", offset: 0, length: 5 }, { type: "pre", offset: 60, length: 10, language: "ts" }] },
      // The cut drops "\n\n"; the pre entity keeps its two b's, the italic its three.
      { text: b, entities: [{ type: "pre", offset: 0, length: 8, language: "ts" }, { type: "italic", offset: 3, length: 3 }] },
    ]);
  });
});

describe("config", () => {
  let dir: string;
  const saved = { ...process.env };

  beforeEach(() => {
    dir = tempDir();
    process.env.TELEGRAM_HUB_STATE_DIR = dir;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  test("paths live in the state dir", () => {
    const p = paths();
    expect(p.stateDir).toBe(dir);
    expect(p.configFile).toBe(join(dir, "config.json"));
    expect(p.sessionsFile).toBe(join(dir, "sessions.json"));
    expect(p.inboxDir).toBe(join(dir, "inbox"));
  });

  test("token is read from .env, CRLF tolerated", () => {
    writeFileSync(join(dir, ".env"), "OTHER=1\r\nTELEGRAM_BOT_TOKEN=123:abc\r\n");
    expect(loadToken()).toBe("123:abc");
  });

  // Windows PowerShell 5.1 `>` / Out-File writes UTF-16LE with a BOM; Notepad may add a UTF-8 BOM.
  const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  const utf16be = (s: string) => Buffer.from(utf16le(s).swap16());
  const utf8bom = (s: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, "utf8")]);

  test("token is read from .env saved as UTF-16 or with a BOM", () => {
    for (const enc of [utf16le, utf16be, utf8bom]) {
      writeFileSync(join(dir, ".env"), enc("TELEGRAM_BOT_TOKEN=123:abc\r\n"));
      expect(loadToken()).toBe("123:abc");
    }
  });

  test("config.json saved as UTF-16 or with a BOM is read", () => {
    for (const enc of [utf16le, utf8bom]) {
      writeFileSync(join(dir, "config.json"), enc('{ "groupId": "-1001", "allowFrom": ["1"] }'));
      expect(loadConfig()).toEqual({ groupId: "-1001", allowFrom: ["1"], turnEndChime: defaultTurnEndChime() });
    }
  });

  test("real env token wins over .env", () => {
    writeFileSync(join(dir, ".env"), "TELEGRAM_BOT_TOKEN=123:abc\n");
    process.env.TELEGRAM_BOT_TOKEN = "999:zzz";
    expect(loadToken()).toBe("999:zzz");
  });

  test("missing token is undefined", () => {
    expect(loadToken()).toBeUndefined();
  });

  test("config coerces numeric ids to strings", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ groupId: -1001234, allowFrom: [123456789] }));
    expect(loadConfig()).toEqual({ groupId: "-1001234", allowFrom: ["123456789"], turnEndChime: defaultTurnEndChime() });
  });

  test("TELEGRAM_HUB_IDLE_MS=0 means never, nonsense means the default", () => {
    process.env.TELEGRAM_HUB_IDLE_MS = "0";
    expect(idleMs()).toBe(0);
    process.env.TELEGRAM_HUB_IDLE_MS = "1500";
    expect(idleMs()).toBe(1500);
    process.env.TELEGRAM_HUB_IDLE_MS = "soon";
    expect(idleMs()).toBe(300_000);
    delete process.env.TELEGRAM_HUB_IDLE_MS;
    expect(idleMs()).toBe(300_000);
  });

  test("a launch section is read, with a default timeout", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], launch: { command: ["cswap.exe", "run", "{account}"] } }));
    expect(loadConfig().launch).toEqual({ command: ["cswap.exe", "run", "{account}"], timeoutSec: 90 });
  });

  test("exec.bash is read", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], exec: { bash: "D:\\Git\\bin\\bash.exe" } }));
    expect(loadConfig().exec).toEqual({ bash: "D:\\Git\\bin\\bash.exe" });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], exec: { bash: 5 } }));
    expect(loadConfig().exec).toBeUndefined();
  });

  test("the exec folder and runs file are in the state dir", () => {
    expect(paths().execDir).toBe(join(dir, "exec"));
    expect(paths().execsFile).toBe(join(dir, "execs.json"));
  });

  test("a broken launch section is reported, not used", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], launch: { command: "cswap.exe run 1" } }));
    const cfg = loadConfig();
    expect(cfg.launch).toBeUndefined();
    expect(cfg.launchError).toContain("command");
  });

  test("missing or corrupt config gives empty allowFrom", () => {
    expect(loadConfig()).toEqual({ allowFrom: [], turnEndChime: defaultTurnEndChime() });
    writeFileSync(join(dir, "config.json"), "{not json");
    expect(loadConfig()).toEqual({ allowFrom: [], turnEndChime: defaultTurnEndChime() });
  });

  test("turnEndChime: default when missing, a string as given (also empty), default plus an error otherwise", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [] }));
    expect(loadConfig().turnEndChime).toBe(defaultTurnEndChime());
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], turnEndChime: "beep {kind}" }));
    expect(loadConfig().turnEndChime).toBe("beep {kind}");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], turnEndChime: "" }));
    expect(loadConfig().turnEndChime).toBe("");
    expect(loadConfig().turnEndChimeError).toBeUndefined();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], turnEndChime: 5 }));
    const cfg = loadConfig();
    expect(cfg.turnEndChime).toBe(defaultTurnEndChime());
    expect(cfg.turnEndChimeError).toContain("turnEndChime");
  });
});

describe("chime", () => {
  test("the default runs chime.ps1 of the chime skill with {kind}", () => {
    const cmd = defaultTurnEndChime(platformFor("win32"));
    expect(cmd).toContain("/.claude/skills/chime/chime.ps1");
    expect(cmd).toContain("-Kind {kind}");
    expect(cmd).not.toContain("\\");
  });

  test("{kind} is replaced everywhere; an empty template gives no command", () => {
    expect(chimeCommand("a {kind} b {kind}", "ask")).toBe("a ask b ask");
    expect(chimeCommand("", "ask")).toBeUndefined();
    expect(chimeCommand("  ", "done")).toBeUndefined();
  });

  test("playChime hands the command to the runner, not at all for an empty template, and swallows its errors", () => {
    const ran: string[] = [];
    playChime("beep {kind}", "done", cmd => ran.push(cmd), platformFor("win32"));
    expect(ran).toEqual(["beep done"]);
    playChime("", "done", cmd => ran.push(cmd), platformFor("win32"));
    expect(ran).toEqual(["beep done"]);
    expect(() => playChime("beep", "ask", () => { throw new Error("no shell"); }, platformFor("win32"))).not.toThrow();
  });

  // A program the shell starts must not get a visible console: Windows
  // Terminal, the default terminal, would open it as a window.
  test.skipIf(process.platform !== "win32")("spawnShellDetached starts the command without a visible console window", async () => {
    const dir = tempDir();
    try {
      const out = join(dir, "console.txt");
      const probe = join(dir, "probe.ts");
      writeFileSync(probe, CONSOLE_PROBE);
      spawnShellDetached(`"${process.execPath}" "${probe}" "${out}"`);
      await waitFor(() => existsSync(out) && readFileSync(out, "utf8") !== "", CHIME_WAIT_MS, "probe");
      expect(readFileSync(out, "utf8")).not.toBe("visible");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
