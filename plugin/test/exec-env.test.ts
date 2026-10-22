import { describe, expect, test } from "bun:test";
import { freshEnv, mergeEnv, parseRegQuery } from "../src/hub/exec-env.ts";

const sz = (value: string) => ({ type: "REG_SZ" as const, value });
const expand = (value: string) => ({ type: "REG_EXPAND_SZ" as const, value });

describe("mergeEnv", () => {
  test("drops Claude Code variables", () => {
    const env = mergeEnv(
      { CLAUDE_CONFIG_DIR: "c", CLAUDECODE: "1", TG_HUB_PORT: "1", anthropic_api_key: "k", USERPROFILE: "C:\\Users\\me" },
      {},
      {},
    );
    expect(env).toEqual({ USERPROFILE: "C:\\Users\\me" });
  });

  test("registry wins, user over machine, case-insensitively", () => {
    const env = mergeEnv(
      { Temp: "X", USERPROFILE: "C:\\Users\\me" },
      { TEMP: expand("%SystemRoot%\\TEMP") },
      { TEMP: expand("%userprofile%\\AppData\\Local\\Temp") },
    );
    expect(env.TEMP).toBe("C:\\Users\\me\\AppData\\Local\\Temp");
    expect(Object.keys(env).filter(k => k.toLowerCase() === "temp")).toEqual(["TEMP"]);
  });

  test("an unknown variable stays as is", () => {
    expect(mergeEnv({}, { X: expand("%NOPE%\\a") }, {}).X).toBe("%NOPE%\\a");
  });

  test("Path joins machine and user", () => {
    const env = mergeEnv({ PATH: "old" }, { Path: sz("C:\\Windows") }, { Path: expand("%HOME%\\bin") });
    expect(env.Path).toBe("C:\\Windows;%HOME%\\bin");
    expect(Object.keys(env).filter(k => k.toLowerCase() === "path")).toEqual(["Path"]);
    const home = mergeEnv({ HOME: "C:\\Users\\me" }, { Path: sz("C:\\Windows") }, { Path: expand("%HOME%\\bin") });
    expect(home.Path).toBe("C:\\Windows;C:\\Users\\me\\bin");
  });
});

describe("parseRegQuery", () => {
  test("parses reg query output", () => {
    const out = [
      "",
      "HKEY_CURRENT_USER\\Environment",
      "    Path    REG_EXPAND_SZ    C:\\Users\\me\\bin;%USERPROFILE%\\x",
      "    OneDrive    REG_SZ    C:\\Users\\me\\One Drive",
      "    Count    REG_DWORD    0x1",
      "",
    ].join("\r\n");
    expect(parseRegQuery(out)).toEqual({
      Path: expand("C:\\Users\\me\\bin;%USERPROFILE%\\x"),
      OneDrive: sz("C:\\Users\\me\\One Drive"),
    });
  });
});

describe("freshEnv", () => {
  test.skipIf(process.platform !== "win32")("freshEnv on this machine has a Path and no CLAUDE variables", () => {
    const env = freshEnv();
    const names = Object.keys(env);
    expect(names.find(k => k.toLowerCase() === "path")).toBeDefined();
    expect(names.filter(k => /^(CLAUDE|TG_HUB_|ANTHROPIC_)/i.test(k))).toEqual([]);
    expect(env.SystemRoot ?? env.SYSTEMROOT).toBeDefined();
  });
});
