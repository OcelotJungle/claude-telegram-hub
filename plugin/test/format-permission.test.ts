import { describe, expect, test } from "bun:test";

import { formatPermission } from "../src/hub/format-permission.ts";

describe("formatPermission", () => {
  test("shows a call description and string arguments without JSON quoting", () => {
    expect(formatPermission("Bash", '{"command":"git push","description":"Push the branch"}', 1500)).toEqual({
      text: "🔐 Нужно подтверждение: Bash\nPush the branch\n\ncommand: git push",
      entities: [{ type: "pre", offset: "🔐 Нужно подтверждение: Bash\nPush the branch\n\n".length, length: "command: git push".length }],
    });
  });

  test("keeps a multi-line command multi-line", () => {
    expect(formatPermission("Bash", JSON.stringify({ command: "git status\ngit push", description: "Push safely" }), 1500).text)
      .toBe("🔐 Нужно подтверждение: Bash\nPush safely\n\ncommand: git status\ngit push");
  });

  test("formats arguments when there is no call description", () => {
    expect(formatPermission("Read", '{"file_path":"src/main.ts"}', 1500).text)
      .toBe("🔐 Нужно подтверждение: Read\n\nfile_path: src/main.ts");
  });

  test("renders non-string values as compact JSON", () => {
    expect(formatPermission("Tool", '{"count":3,"enabled":true,"items":[1,{"ok":false}]}', 1500).text)
      .toBe("🔐 Нужно подтверждение: Tool\n\ncount: 3\nenabled: true\nitems: [1,{\"ok\":false}]");
  });

  test("extracts a complete call description from truncated JSON", () => {
    expect(formatPermission("Bash", '{"command":"git push","description":"Push the branch", "other":', 1500).text)
      .toBe('🔐 Нужно подтверждение: Bash\nPush the branch\n\n{"command":"git push", "other":');
  });

  test("keeps truncated raw preview when no complete description can be read", () => {
    expect(formatPermission("Bash", '{"command":"git push","description":"unfinished', 1500).text)
      .toBe('🔐 Нужно подтверждение: Bash\n\n{"command":"git push","description":"unfinished');
  });

  test("cuts a raw preview at the configured character limit", () => {
    expect(formatPermission("Bash", "123456", 4).text).toBe("🔐 Нужно подтверждение: Bash\n\n1234…");
  });

  test("a long JSON preview is parsed whole and its arguments cut after", () => {
    const preview = JSON.stringify({ command: "x".repeat(20), description: "Long one" });
    expect(formatPermission("Bash", preview, 12).text).toBe("🔐 Нужно подтверждение: Bash\nLong one\n\ncommand: xxx…");
  });

  test("shows only the head for empty or missing preview", () => {
    expect(formatPermission("Bash", undefined, 1500)).toEqual({ text: "🔐 Нужно подтверждение: Bash", entities: [] });
    expect(formatPermission("Bash", "", 1500)).toEqual({ text: "🔐 Нужно подтверждение: Bash", entities: [] });
  });

  test("counts UTF-16 offsets with Cyrillic and emoji in the description", () => {
    const formatted = formatPermission("Bash", '{"command":"echo hi","description":"🚀 Привет"}', 1500);
    expect(formatted.text).toBe("🔐 Нужно подтверждение: Bash\n🚀 Привет\n\ncommand: echo hi");
    expect(formatted.entities[0]).toEqual({ type: "pre", offset: "🔐 Нужно подтверждение: Bash\n🚀 Привет\n\n".length, length: "command: echo hi".length });
  });
});
