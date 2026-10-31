import { describe, expect, test } from "bun:test";
import { freshEnv, mergeEnv, parseRegQuery } from "../src/hub/exec-env.ts";

const sz = (value: string) => ({ type: "REG_SZ" as const, value });
const expand = (value: string) => ({ type: "REG_EXPAND_SZ" as const, value });

describe("mergeEnv", () => {
  test("takes from the hub only the system variables a new window gets", () => {
    const env = mergeEnv(
      {
        CLAUDE_CONFIG_DIR: "c",
        TELEGRAM_HUB_PORT: "1",
        TMPDIR: "C:\\proj\\.tmp",
        FOO: "bar",
        USERPROFILE: "C:\\Users\\me",
        SYSTEMROOT: "C:\\Windows",
        "ProgramFiles(x86)": "C:\\Program Files (x86)",
        PROCESSOR_ARCHITECTURE: "AMD64",
        ComSpec: "C:\\Windows\\system32\\cmd.exe",
        PATH: "old",
      },
      {},
      {},
      {},
    );
    expect(env).toEqual({
      USERPROFILE: "C:\\Users\\me",
      SYSTEMROOT: "C:\\Windows",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      PROCESSOR_ARCHITECTURE: "AMD64",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
    });
  });

  test("Volatile Environment comes after machine and before user", () => {
    const env = mergeEnv(
      {},
      { LOGONSERVER: sz("\\\\OLD"), APPDATA: sz("machine") },
      { TEMP: expand("%APPDATA%\\..\\Local\\Temp") },
      { LOGONSERVER: sz("\\\\DC"), APPDATA: sz("C:\\Users\\me\\AppData\\Roaming") },
    );
    expect(env.LOGONSERVER).toBe("\\\\DC");
    expect(env.TEMP).toBe("C:\\Users\\me\\AppData\\Roaming\\..\\Local\\Temp");
  });

  test("registry wins, user over machine, case-insensitively", () => {
    const env = mergeEnv(
      { Temp: "X", USERPROFILE: "C:\\Users\\me" },
      { TEMP: expand("%SystemRoot%\\TEMP") },
      { TEMP: expand("%userprofile%\\AppData\\Local\\Temp") },
      {},
    );
    expect(env.TEMP).toBe("C:\\Users\\me\\AppData\\Local\\Temp");
    expect(Object.keys(env).filter(k => k.toLowerCase() === "temp")).toEqual(["TEMP"]);
  });

  test("an unknown variable stays as is", () => {
    expect(mergeEnv({}, { X: expand("%NOPE%\\a") }, {}, {}).X).toBe("%NOPE%\\a");
  });

  test("Path joins machine and user", () => {
    const env = mergeEnv({ PATH: "old" }, { Path: sz("C:\\Windows") }, { Path: expand("%USERPROFILE%\\bin") }, {});
    expect(env.Path).toBe("C:\\Windows;%USERPROFILE%\\bin");
    expect(Object.keys(env).filter(k => k.toLowerCase() === "path")).toEqual(["Path"]);
    const home = mergeEnv({ USERPROFILE: "C:\\Users\\me" }, { Path: sz("C:\\Windows") }, { Path: expand("%USERPROFILE%\\bin") }, {});
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
  test.skipIf(process.platform !== "win32")("freshEnv on this machine has a Path and nothing else of the hub's", () => {
    process.env.TG_EXEC_TEST_LEAK = "1";
    let env: Record<string, string>;
    try {
      env = freshEnv();
    } finally {
      delete process.env.TG_EXEC_TEST_LEAK;
    }
    const names = Object.keys(env);
    expect(env.TG_EXEC_TEST_LEAK).toBeUndefined();
    expect(names.find(k => k.toLowerCase() === "path")).toBeDefined();
    expect(names.filter(k => /^(CLAUDE|TELEGRAM_HUB_|ANTHROPIC_)/i.test(k))).toEqual([]);
    expect(env.SystemRoot ?? env.SYSTEMROOT).toBeDefined();
  });
});
