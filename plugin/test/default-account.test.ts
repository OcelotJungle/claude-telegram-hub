import { describe, expect, test } from "bun:test";
import { isDefaultConfigDir, statusAccount } from "../src/hub/default-account.ts";

describe("default login account", () => {
  test("is read from the first line of cswap status", () => {
    const out = "Status: Account-2 (me@mail.com [me@mail.com's Organization])\n  Total managed accounts: 2\n  ├ 5h:  14%\n";
    expect(statusAccount(out)).toBe("2");
    expect(statusAccount("No accounts managed yet.\n")).toBeUndefined();
  });

  test("the default config dir is matched whatever the case and trailing slash", () => {
    expect(isDefaultConfigDir("C:\\Users\\Me\\.claude\\", "C:\\Users\\me\\.claude")).toBe(true);
    expect(isDefaultConfigDir("C:\\Users\\me\\.claude-swap-backup\\sessions\\2-me_gmail.com", "C:\\Users\\me\\.claude")).toBe(false);
  });
});
