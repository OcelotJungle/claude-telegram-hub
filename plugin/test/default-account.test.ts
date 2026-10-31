import { describe, expect, test } from "bun:test";
import { defaultLoginAccount, isDefaultConfigDir, statusAccount } from "../src/hub/default-account.ts";
import { platformFor } from "../src/shared/platform.ts";

describe("default login account", () => {
  test("is read from the first line of cswap status", () => {
    const out = "Status: Account-2 (me@mail.com [me@mail.com's Organization])\n  Total managed accounts: 2\n  ├ 5h:  14%\n";
    expect(statusAccount(out)).toBe("2");
    expect(statusAccount("No accounts managed yet.\n")).toBeUndefined();
  });

  test("the default config dir is matched whatever the case and trailing slash", () => {
    const windows = platformFor("win32");
    expect(isDefaultConfigDir("C:\\Users\\Me\\.claude\\", "C:\\Users\\me\\.claude", windows)).toBe(true);
    expect(isDefaultConfigDir("C:\\Users\\me\\.claude-swap-backup\\sessions\\2-me_gmail.com", "C:\\Users\\me\\.claude", windows)).toBe(false);
  });

  test("Linux config paths are case sensitive and missing cswap does not spawn", async () => {
    const linux = platformFor("linux");
    expect(isDefaultConfigDir("/home/Me/.claude/", "/home/me/.claude", linux)).toBe(false);
    expect(isDefaultConfigDir("/home/me/.claude/", "/home/me/.claude", linux)).toBe(true);
    const lookedUp: string[] = [];
    expect(await defaultLoginAccount(linux, name => { lookedUp.push(name); return null; })).toBeUndefined();
    expect(lookedUp).toEqual(["cswap"]);
  });
});
