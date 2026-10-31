import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { rename } from "fs/promises";
import { join } from "path";
import { cleanTranscript, KEEP_BACKUPS, restoreCleanup } from "../src/hub/skill-cleanup.ts";
import { field } from "../src/shared/guards.ts";
import { tempDir } from "./helpers.ts";

const SID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const NOW = 1_700_000_000_000;
const MTIME_WAIT_MS = 20;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = tempDir("telegramhub-cleanup-");
  dirs.push(d);
  return d;
}

function skills(...names: string[]): { name: string; path: string; content: string }[] {
  return names.map(name => ({ name, path: `C:\\skills\\${name}\\SKILL.md`, content: `# ${name}\n${"x".repeat(name.length * 10)}` }));
}

function invoked(uuid: string, list: unknown, version = "1.0.0"): string {
  return JSON.stringify({ parentUuid: "p", type: "attachment", attachment: { type: "invoked_skills", skills: list }, uuid, version });
}

function attachment(uuid: string, type: string): string {
  return JSON.stringify({ type: "attachment", attachment: { type, content: "invoked_skills is mentioned here" }, uuid, version: "1.0.0" });
}

function user(uuid: string, text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid, version: "1.0.0" });
}

function write(path: string, parts: (string | Buffer)[]): Buffer {
  const buf = Buffer.concat(parts.map(p => (typeof p === "string" ? Buffer.from(p) : p)));
  writeFileSync(path, buf);
  return buf;
}

// The file's lines split on "\n", as bytes.
function lines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let from = 0;
  for (let nl = buf.indexOf(0x0a); nl !== -1; nl = buf.indexOf(0x0a, from)) {
    out.push(buf.subarray(from, nl));
    from = nl + 1;
  }
  if (from < buf.length) out.push(buf.subarray(from));
  return out;
}

function uuidOf(line: Buffer): unknown {
  const rec: unknown = JSON.parse(line.toString("utf8"));
  return typeof rec === "object" && rec !== null && "uuid" in rec ? rec.uuid : undefined;
}

function skillsOf(line: Buffer): unknown {
  const rec: unknown = JSON.parse(line.toString("utf8"));
  if (typeof rec !== "object" || rec === null || !("attachment" in rec)) return undefined;
  const a = rec.attachment;
  return typeof a === "object" && a !== null && "skills" in a ? a.skills : undefined;
}

function backups(d: string, id = SID): string[] {
  return readdirSync(d)
    .filter(n => n.startsWith(`${id}.cleanup-`) && n.endsWith(".jsonl") && !n.includes("tmp"))
    .sort();
}

// Read sizes that split lines, "\r\n" and multibyte characters at every
// place; undefined is the default.
const CHUNKS = [undefined, 1, 7, 64];

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: rename refused`), { code });
}

describe("cleanTranscript", () => {
  for (const chunkBytes of CHUNKS) {
    test(`empties skills in every invoked_skills record and keeps every other byte (chunk ${chunkBytes ?? "default"})`, async () => {
      const d = dir();
      const path = join(d, `${SID}.jsonl`);
      const bad = Buffer.concat([Buffer.from('{"type":"user","uuid":"u3","text":"'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('"}')]);
      const input = write(path, [
        user("u1", "hi"),
        "\r\n",
        invoked("s1", skills("brainstorming", "writing-plans")),
        "\r\n",
        bad,
        "\n",
        attachment("a1", "skill_listing"),
        "\n",
        attachment("a2", "file"),
        "\n",
        user("u2", 'grep for "invoked_skills" please'),
        "\n",
        invoked("s2", skills("writing-plans")),
      ]);
      const res = await cleanTranscript(path, NOW, chunkBytes === undefined ? {} : { chunkBytes });
      expect(res.kind).toBe("cleaned");
      const output = readFileSync(path);
      const before = lines(input);
      const after = lines(output);
      expect(after.length).toBe(before.length);
      for (let i = 0; i < before.length; i++) {
        const b = before[i];
        const a = after[i];
        if (b === undefined || a === undefined) throw new Error("line missing");
        if (i === 1 || i === 6) {
          expect(uuidOf(a)).toEqual(uuidOf(b));
          expect(skillsOf(a)).toEqual([]);
          expect(a.at(-1) === 0x0d).toBe(b.at(-1) === 0x0d);
        } else expect(a.equals(b)).toBe(true);
      }
      // The last line had no newline and still has none.
      expect(output.at(-1)).not.toBe(0x0a);
      expect(existsSync(`${path}.cleanup-tmp`)).toBe(false);
    });
  }

  test("reports the last record's skills with their sizes", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    const last = skills("tdd", "debugging");
    write(path, [invoked("s1", skills("brainstorming")), "\n", user("u1", "x"), "\n", invoked("s2", last, "1.0.0"), "\n"]);
    const res = await cleanTranscript(path, NOW);
    if (res.kind !== "cleaned") throw new Error(`kind ${res.kind}`);
    expect(res.skills).toEqual(last.map(s => ({ name: s.name, chars: s.content.length })));
    expect(res.records).toBe(2);
    expect(res.version).toBe("1.0.0");
    expect(res.backup).toBe(join(d, `${SID}.cleanup-${NOW}.jsonl`));
    const backup = readFileSync(res.backup, "utf8")
      .trim()
      .split("\n")
      .map((l): unknown => JSON.parse(l));
    expect(backup.map(b => [field(b, "line"), field(b, "uuid")])).toEqual([
      [1, "s1"],
      [3, "s2"],
    ]);
  });

  test("nothing to clean leaves the file and writes no backup", async () => {
    const d = dir();
    const empty = join(d, `${SID}.jsonl`);
    const none = join(d, `${OTHER}.jsonl`);
    const a = write(empty, [user("u1", "x"), "\n", invoked("s1", []), "\n"]);
    const b = write(none, [user("u1", "x"), "\n"]);
    const mtimes = [statSync(empty).mtimeMs, statSync(none).mtimeMs];
    await Bun.sleep(MTIME_WAIT_MS);
    expect(await cleanTranscript(empty, NOW)).toEqual({ kind: "nothing", version: "1.0.0" });
    expect((await cleanTranscript(none, NOW)).kind).toBe("nothing");
    expect(readFileSync(empty).equals(a)).toBe(true);
    expect(readFileSync(none).equals(b)).toBe(true);
    expect([statSync(empty).mtimeMs, statSync(none).mtimeMs]).toEqual(mtimes);
    expect(readdirSync(d).sort()).toEqual([`${SID}.jsonl`, `${OTHER}.jsonl`].sort());
  });

  test("unknown format writes nothing", async () => {
    const d = dir();
    for (const odd of [
      JSON.stringify({ type: "attachment", attachment: { type: "invoked_skills", names: ["x"] }, uuid: "s2", version: "2.2.0" }),
      invoked("s2", [{ name: "x", path: "p" }], "2.2.0"),
    ]) {
      const path = join(d, `${SID}.jsonl`);
      const input = write(path, [invoked("s1", skills("tdd")), "\n", odd, "\n", user("u1", "x"), "\n"]);
      expect(await cleanTranscript(path, NOW)).toEqual({ kind: "format", version: "2.2.0" });
      expect(readFileSync(path).equals(input)).toBe(true);
      expect(readdirSync(d)).toEqual([`${SID}.jsonl`]);
    }
  });

  test("restoreCleanup returns the file byte for byte", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    const input = write(path, [user("u1", "é"), "\r\n", invoked("s1", skills("tdd", "ünïcode")), "\r\n", user("u2", "x"), "\n", invoked("s2", skills("tdd"))]);
    const res = await cleanTranscript(path, NOW);
    if (res.kind !== "cleaned") throw new Error(`kind ${res.kind}`);
    await restoreCleanup(path, res.backup);
    expect(readFileSync(path).equals(input)).toBe(true);

    const again = await cleanTranscript(path, NOW + 1);
    if (again.kind !== "cleaned") throw new Error(`kind ${again.kind}`);
    const cleaned = readFileSync(path);
    const wrong = join(d, `${SID}.cleanup-1.jsonl`);
    writeFileSync(wrong, readFileSync(again.backup, "utf8").replace('"uuid":"s2"', '"uuid":"zz"'));
    await expect(restoreCleanup(path, wrong)).rejects.toThrow();
    expect(readFileSync(path).equals(cleaned)).toBe(true);
    expect(existsSync(`${path}.cleanup-tmp`)).toBe(false);
  });

  test("keeps the last 3 backups of this session only", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    const foreign = join(d, `${OTHER}.cleanup-1.jsonl`);
    writeFileSync(foreign, "{}\n");
    for (let i = 0; i < KEEP_BACKUPS + 1; i++) {
      write(path, [invoked(`s${i}`, skills("tdd")), "\n"]);
      expect((await cleanTranscript(path, NOW + i)).kind).toBe("cleaned");
    }
    expect(backups(d)).toEqual([1, 2, 3].map(i => `${SID}.cleanup-${NOW + i}.jsonl`));
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test("a failed rename leaves the file as it was, with no temp file and no backup", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    const input = write(path, [user("u1", "x"), "\n", invoked("s1", skills("tdd")), "\n"]);
    const io = { rename: () => Promise.reject(errno("EIO")) };
    await expect(cleanTranscript(path, NOW, io)).rejects.toThrow("EIO");
    expect(readFileSync(path).equals(input)).toBe(true);
    expect(readdirSync(d)).toEqual([`${SID}.jsonl`]);
  });

  test("a rename Windows refuses twice is tried again", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    write(path, [user("u1", "x"), "\n", invoked("s1", skills("tdd")), "\n"]);
    let tries = 0;
    const io = {
      rename: (from: string, to: string): Promise<void> => (++tries <= 2 ? Promise.reject(errno("EPERM")) : rename(from, to)),
    };
    expect((await cleanTranscript(path, NOW, io)).kind).toBe("cleaned");
    expect(tries).toBe(3);
    const record = lines(readFileSync(path))[1];
    if (record === undefined) throw new Error("line missing");
    expect(skillsOf(record)).toEqual([]);
    expect(readdirSync(d).sort()).toEqual([`${SID}.cleanup-${NOW}.jsonl`, `${SID}.jsonl`].sort());
  });

  test("undecodable bytes in an invoked_skills record are an unknown format", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    const [head, tail] = invoked("s1", [{ name: "tdd", path: "p", content: "@@" }]).split("@@");
    const input = write(path, [user("u1", "x"), "\n", head ?? "", Buffer.from([0xff, 0xfe]), tail ?? "", "\n"]);
    expect(await cleanTranscript(path, NOW)).toEqual({ kind: "format", version: "1.0.0" });
    expect(readFileSync(path).equals(input)).toBe(true);
    expect(readdirSync(d)).toEqual([`${SID}.jsonl`]);
  });

  test("a transcript that grows before the rename is left alone", async () => {
    const d = dir();
    const path = join(d, `${SID}.jsonl`);
    const input = write(path, [user("u1", "x"), "\n", invoked("s1", skills("tdd")), "\n"]);
    const more = user("u2", "a session writes on") + "\n";
    let calls = 0;
    // The first look is pass 1's; before the second, a session appends.
    const io = {
      size: async (p: string): Promise<number> => {
        if (++calls === 2) appendFileSync(p, more);
        return statSync(p).size;
      },
    };
    await expect(cleanTranscript(path, NOW, io)).rejects.toThrow("транскрипт дописывается — сессия уже открыта?");
    expect(readFileSync(path).equals(Buffer.concat([input, Buffer.from(more)]))).toBe(true);
    expect(readdirSync(d)).toEqual([`${SID}.jsonl`]);
  });
});
