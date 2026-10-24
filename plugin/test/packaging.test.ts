import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { z } from "zod";
import { QUESTION_DEADLINE_MS } from "../src/hook/question-limits.ts";
import { isAlive } from "../src/hub/exec-runner.ts";
import { Hub } from "../src/hub/hub.ts";
import { HOOK_NOTE_TOOL } from "../src/plugin/plugin.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol.ts";
import { freePort, memLogger, must, tempDir, waitFor, wsClient } from "./helpers.ts";

const PLUGIN = resolve(import.meta.dir, "..");
const REPO = resolve(PLUGIN, "..");
const HOOK = join(PLUGIN, "src", "hook", "session-start.ts");
const STOP_HOOK = join(PLUGIN, "src", "hook", "stop.ts");
const QUESTION_HOOK = join(PLUGIN, "src", "hook", "question.ts");
const SLOW_READER_MS = 500;
const TEST_DEADLINE_MS = 300;
const MS_PER_SECOND = 1000;
// How far under the hooks.json timeout the hook's own deadline may sit.
const DEADLINE_MARGIN_MAX_MS = 5 * 60_000;
const PARENT_GONE_WAIT_MS = 10_000;
const PARENT_GONE_TEST_MS = 30_000;
// Starts the hook with its own stdin, prints its pid and lives on until killed.
// Detached, so the hook outlives it, as it would outlive a dead Claude Code.
const PARENT_SCRIPT = "const c = require(\"child_process\").spawn(process.execPath, [process.env.HOOK_PATH], { stdio: [\"inherit\", \"ignore\", \"ignore\"], detached: true, windowsHide: true }); console.log(c.pid); await Bun.sleep(1e9);";

// Async on purpose: an in-process hub must keep serving while the hook runs.
async function runHook(port: number, input: object, socket = "pipe-H") {
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    env: { ...process.env, TG_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: socket },
  });
  const stdout = await new Response(proc.stdout).text();
  const status = await proc.exited;
  return { status, stdout, ms: Date.now() - started };
}

describe("SessionStart hook", () => {
  let hub: Hub | undefined;
  const clients: { close(): void }[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await hub?.stop();
  });

  test("tells the hub which session the window now runs", async () => {
    const port = await freePort();
    const dir = tempDir();
    hub = new Hub({ port, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    const c = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-H", sessionId: "old", cwd: "C:\\p" });
    clients.push(c);
    const r = await runHook(port, { session_id: "new", transcript_path: "C:\\t\\new.jsonl", cwd: "C:\\p", hook_event_name: "SessionStart", source: "clear" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const sw = await c.next("switchSession");
    expect(sw).toMatchObject({ sessionId: "new", transcriptPath: "C:\\t\\new.jsonl" });
  });

  test("exits quietly and quickly when no hub is running", async () => {
    const port = await freePort();
    const r = await runHook(port, { session_id: "s", transcript_path: "t", cwd: "c" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.ms).toBeLessThan(3000);
  });

  test("survives garbage input", async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [HOOK], { input: "not json", env: { ...process.env, TG_HUB_PORT: String(port) }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("Stop hook", () => {
  let hub: Hub | undefined;
  const clients: { close(): void }[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close();
    await hub?.stop();
  });

  // The state dir holds a config whose chime command adds its kind as a line to a file.
  function chimeSetup() {
    const dir = tempDir();
    const marker = join(dir, "chimed.txt");
    const script = join(dir, "chime.ts");
    writeFileSync(script, `import { appendFileSync } from "fs";\nappendFileSync(${JSON.stringify(marker)}, (process.argv[2] ?? "") + "\\n");\n`);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ allowFrom: [], turnEndChime: `"${process.execPath}" "${script}" {kind}` }));
    const chimes = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(l => l !== "") : []);
    return { dir, chimes };
  }

  async function runStop(port: number, input: object, stateDir: string, socket = "pipe-S") {
    const proc = Bun.spawn([process.execPath, STOP_HOOK], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      env: { ...process.env, TG_HUB_PORT: String(port), TG_HUB_STATE_DIR: stateDir, CLAUDE_CODE_MESSAGING_SOCKET: socket },
    });
    const stdout = await new Response(proc.stdout).text();
    return { status: await proc.exited, stdout };
  }

  test("tells the window how the turn ended, without a sound of its own", async () => {
    const port = await freePort();
    const { dir, chimes } = chimeSetup();
    hub = new Hub({ port, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    const c = await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-S", sessionId: "s", cwd: "C:\\p" });
    clients.push(c);
    const r = await runStop(port, { session_id: "s", hook_event_name: "Stop", last_assistant_message: "Готово. Дальше?", background_tasks: [{ id: "t" }] }, dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(await c.next("turnEnd")).toEqual({ type: "turnEnd", final: true, kind: "ask" });
    // A hook with no hub to tell chimes; by then a chime of the first would be heard too.
    expect((await runStop(await freePort(), { session_id: "s", last_assistant_message: "Готово." }, dir)).status).toBe(0);
    await waitFor(() => chimes().length > 0, 5000, "chime");
    expect(chimes()).toEqual(["done"]);
  });

  test("with no hub a final turn plays the chime itself, an intermediate one does not", async () => {
    const port = await freePort();
    const { dir, chimes } = chimeSetup();
    const quiet = await runStop(port, { session_id: "s", last_assistant_message: "Жду.", background_tasks: [{ id: "t" }] }, dir);
    expect(quiet.status).toBe(0);
    const loud = await runStop(port, { session_id: "s", last_assistant_message: "Готово." }, dir);
    expect(loud.status).toBe(0);
    expect(loud.stdout).toBe("");
    await waitFor(() => chimes().length > 0, 5000, "chime");
    expect(chimes()).toEqual(["done"]);
  });

  test("survives garbage input", async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [STOP_HOOK], { input: "not json", env: { ...process.env, TG_HUB_PORT: String(port) }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("AskUserQuestion hook", () => {
  const QUESTIONS = [{ question: "Какой цвет?", header: "Цвет", options: [{ label: "Синий", description: "" }, { label: "Красный", description: "" }], multiSelect: false }];
  const INPUT = { session_id: "s", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } };
  let server: { stop(force?: boolean): void } | undefined;
  let hub: Hub | undefined;
  const clients: { close(): void }[] = [];
  afterEach(async () => {
    server?.stop(true);
    server = undefined;
    for (const c of clients.splice(0)) c.close();
    await hub?.stop();
    hub = undefined;
  });

  async function runQuestion(port: number, input: object) {
    const proc = Bun.spawn([process.execPath, QUESTION_HOOK], {
      stdin: new Blob([JSON.stringify(input)]),
      stdout: "pipe",
      env: { ...process.env, TG_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: "pipe-Q" },
    });
    const stdout = await new Response(proc.stdout).text();
    return { status: await proc.exited, stdout };
  }

  // A stand-in hub that answers /question with the given decision and keeps the bodies it got.
  async function fakeHub(decision: object) {
    const port = await freePort();
    const bodies: unknown[] = [];
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname !== "/question") return new Response("no", { status: 404 });
        bodies.push(await req.json());
        return Response.json(decision);
      },
    });
    return { port, bodies };
  }

  // A stand-in hub that holds /question until the hook drops it.
  async function holdingHub() {
    const port = await freePort();
    const seen = { got: 0, aborted: 0 };
    server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch(req, srv) {
        srv.timeout(req, 0);
        seen.got++;
        return new Promise<Response>(resolve => {
          req.signal.addEventListener("abort", () => {
            seen.aborted++;
            resolve(new Response("gone"));
          });
        });
      },
    });
    return { port, seen };
  }

  test("the hook stops waiting at its own deadline", async () => {
    const { port, seen } = await holdingHub();
    const proc = Bun.spawn([process.execPath, QUESTION_HOOK], {
      stdin: new Blob([JSON.stringify(INPUT)]),
      stdout: "pipe",
      env: { ...process.env, TG_HUB_PORT: String(port), TG_HUB_QUESTION_DEADLINE_MS: String(TEST_DEADLINE_MS) },
      windowsHide: true,
    });
    const stdout = await new Response(proc.stdout).text();
    expect({ status: await proc.exited, stdout }).toEqual({ status: 0, stdout: "" });
    await waitFor(() => seen.aborted === 1);
  });

  test("the hook stops waiting when its parent is gone", async () => {
    const { port, seen } = await holdingHub();
    // A parent that starts the hook and then lives on until killed.
    const parent = Bun.spawn([process.execPath, "-e", PARENT_SCRIPT], {
      stdin: new Blob([JSON.stringify(INPUT)]),
      stdout: "pipe",
      env: { ...process.env, TG_HUB_PORT: String(port), HOOK_PATH: QUESTION_HOOK },
      windowsHide: true,
    });
    const reader = parent.stdout.getReader();
    const first = await reader.read();
    const hookPid = Number(new TextDecoder().decode(first.value).trim());
    try {
      await waitFor(() => seen.got === 1);
      parent.kill();
      await parent.exited;
      await waitFor(() => seen.aborted === 1, PARENT_GONE_WAIT_MS);
      await waitFor(() => !isAlive(hookPid), PARENT_GONE_WAIT_MS);
    } finally {
      if (isAlive(hookPid)) process.kill(hookPid);
    }
  }, PARENT_GONE_TEST_MS);

  test("the hook's deadline is a little under its timeout in hooks.json", () => {
    const hooks = z
      .object({ hooks: z.object({ PreToolUse: z.array(z.object({ matcher: z.string(), hooks: z.array(z.object({ timeout: z.number() })) })) }) })
      .parse(JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")));
    const timeoutMs = must(hooks.hooks.PreToolUse.find(h => h.matcher === "AskUserQuestion")?.hooks[0]).timeout * MS_PER_SECOND;
    expect(QUESTION_DEADLINE_MS).toBeLessThan(timeoutMs);
    expect(QUESTION_DEADLINE_MS).toBeGreaterThan(timeoutMs - DEADLINE_MARGIN_MAX_MS);
  });

  test("an answer from the topic allows the tool with the questions and the answers", async () => {
    const { port, bodies } = await fakeHub({ decision: "allow", answers: { "Какой цвет?": "Синий" } });
    const r = await runQuestion(port, INPUT);
    expect(r.status).toBe(0);
    expect(bodies).toEqual([{ messagingSocket: "pipe-Q", session_id: "s", tool_input: { questions: QUESTIONS } }]);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Answered in Telegram",
        updatedInput: { questions: QUESTIONS, answers: { "Какой цвет?": "Синий" } },
      },
    });
  });

  test("the allowed input keeps every field of the original tool input", async () => {
    const { port, bodies } = await fakeHub({ decision: "allow", answers: { "Какой цвет?": "Синий" } });
    const toolInput = { questions: QUESTIONS, metadata: { source: "x" } };
    const r = await runQuestion(port, { ...INPUT, tool_input: toolInput });
    expect(bodies).toEqual([{ messagingSocket: "pipe-Q", session_id: "s", tool_input: toolInput }]);
    expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput).toEqual({ ...toolInput, answers: { "Какой цвет?": "Синий" } });
  });

  test("a large answer reaches stdout whole before the hook exits", async () => {
    const big = "ж".repeat(2_000_000);
    const { port } = await fakeHub({ decision: "allow", answers: { "Какой цвет?": big } });
    const proc = Bun.spawn([process.execPath, QUESTION_HOOK], {
      stdin: new Blob([JSON.stringify(INPUT)]),
      stdout: "pipe",
      env: { ...process.env, TG_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: "pipe-Q" },
    });
    // A slow reader: the pipe fills up before anything is read.
    await Bun.sleep(SLOW_READER_MS);
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    expect(JSON.parse(stdout).hookSpecificOutput.updatedInput.answers["Какой цвет?"]).toBe(big);
  });

  test("a cancel in the topic denies the tool with the hub's reason", async () => {
    const { port } = await fakeHub({ decision: "deny", reason: "cancelled" });
    const r = await runQuestion(port, INPUT);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "cancelled" } });
  });

  test("none, a broken answer or no hub leave the dialog to the terminal", async () => {
    for (const decision of [{ decision: "none" }, { decision: "allow" }]) {
      const { port } = await fakeHub(decision);
      const r = await runQuestion(port, INPUT);
      expect(r).toEqual({ status: 0, stdout: "" });
      server?.stop(true);
    }
    expect(await runQuestion(await freePort(), INPUT)).toEqual({ status: 0, stdout: "" });
  });

  test("the real hub decides nothing for a session with the mode off", async () => {
    const port = await freePort();
    const dir = tempDir();
    hub = new Hub({ port, sessionsFile: join(dir, "s.json"), outboxFile: join(dir, "o.json"), filesDir: join(dir, "files"), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [], turnEndChime: "" }), idleMs: 60_000, log: memLogger(), onExit() {} });
    hub.start();
    clients.push(await wsClient(port, { type: "hello", v: PROTOCOL_VERSION, windowKey: "pipe-Q", sessionId: "s", cwd: "C:\\p" }));
    expect(await runQuestion(port, INPUT)).toEqual({ status: 0, stdout: "" });
  });

  test("survives garbage input", async () => {
    const port = await freePort();
    const r = spawnSync(process.execPath, [QUESTION_HOOK], { input: "not json", env: { ...process.env, TG_HUB_PORT: String(port) }, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("plugin packaging", () => {
  // The parts of the manifests the tests read.
  const marketplace = z.object({ name: z.string(), plugins: z.array(z.object({ name: z.string(), source: z.string() })) });
  const manifest = z.object({ name: z.string() });
  const mcpConfig = z.object({ mcpServers: z.record(z.string(), z.object({ command: z.string() })) });
  const pkgJson = z.object({ scripts: z.record(z.string(), z.string()) });
  const hooksJson = z.object({
    hooks: z.record(z.string(), z.array(z.object({ matcher: z.string().optional(), hooks: z.array(z.looseObject({ command: z.string().optional() })) }))),
    modules: z.array(z.string()),
  });
  const json = <T>(p: string, schema: z.ZodType<T>) => schema.parse(JSON.parse(readFileSync(p, "utf8")));

  test("marketplace lists the plugin directory", () => {
    const m = json(join(REPO, ".claude-plugin", "marketplace.json"), marketplace);
    expect(m.name).toBe("tg-hub-local");
    const entry = must(m.plugins.find(p => p.name === "tg-hub"), "tg-hub entry");
    expect(existsSync(join(REPO, entry.source, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  test("plugin manifest, MCP server and hook point at real files", () => {
    expect(json(join(PLUGIN, ".claude-plugin", "plugin.json"), manifest).name).toBe("tg-hub");
    const mcp = json(join(PLUGIN, ".mcp.json"), mcpConfig);
    expect(mcp.mcpServers["tg-hub"].command).toBe("bun");
    const pkg = json(join(PLUGIN, "package.json"), pkgJson);
    expect(pkg.scripts.start).toContain("src/plugin/main.ts");
    expect(existsSync(join(PLUGIN, "src", "plugin", "main.ts"))).toBe(true);
    const hooks = json(join(PLUGIN, "hooks", "hooks.json"), hooksJson);
    const cmd = hooks.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain("src/hook/session-start.ts");
    expect(existsSync(HOOK)).toBe(true);
    expect(hooks.hooks.Stop[0].hooks[0].command).toContain("src/hook/stop.ts");
    expect(existsSync(STOP_HOOK)).toBe(true);
    // The questions hook waits as long as a poll may stay open: 24 hours.
    const question = hooks.hooks.PreToolUse[0];
    expect(question.matcher).toBe("AskUserQuestion");
    expect(question.hooks[0]).toMatchObject({ type: "command", timeout: 86400, statusMessage: "Жду ответа в Телеграме" });
    expect(question.hooks[0].command).toContain("src/hook/question.ts");
    expect(existsSync(QUESTION_HOOK)).toBe(true);
    // The function hooks module that runs commands from the topic.
    expect(hooks.modules).toEqual(["../src/mod/register.ts"]);
    expect(existsSync(join(PLUGIN, "hooks", hooks.modules[0]))).toBe(true);
  });

  // The note that the mode went off reaches the agent through our own server.
  test("the PostToolBatch hook calls the note tool of the plugin server, main agent only", () => {
    const hooks = json(join(PLUGIN, "hooks", "hooks.json"), hooksJson);
    const pluginName = json(join(PLUGIN, ".claude-plugin", "plugin.json"), manifest).name;
    const serverKey = Object.keys(json(join(PLUGIN, ".mcp.json"), mcpConfig).mcpServers)[0];
    expect(hooks.hooks.PostToolBatch[0].hooks[0]).toMatchObject({
      type: "mcp_tool",
      server: `plugin:${pluginName}:${serverKey}`,
      tool: HOOK_NOTE_TOOL,
      input: { agent_id: "${agent_id}" },
    });
    expect(hooks.hooks.UserPromptSubmit).toBeUndefined();
  });
});

const ps = spawnSync("powershell", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
const hasPowerShell = ps.status === 0;

describe.skipIf(!hasPowerShell)("PowerShell wrappers", () => {
  const script = join(REPO, "scripts", "tg-hub-profile.ps1");
  function args(fn: string, list: string[]): string {
    const quoted = list.map(a => `'${a.replace(/'/g, "''")}'`).join(",");
    const r = spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `$global:TgHubClaudeExe='x'; $global:TgHubCswapExe='y'; . '${script}'; (${fn} @(${quoted})) -join '|'`],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  }
  const CH = "--dangerously-load-development-channels|plugin:tg-hub@tg-hub-local";

  test("claude gets the channel flag for interactive sessions", () => {
    expect(args("Get-TgHubClaudeArgs", [])).toBe(CH);
    expect(args("Get-TgHubClaudeArgs", ["--resume", "abc"])).toBe(`${CH}|--resume|abc`);
  });

  test("claude subcommands and print mode are left alone", () => {
    expect(args("Get-TgHubClaudeArgs", ["mcp", "list"])).toBe("mcp|list");
    expect(args("Get-TgHubClaudeArgs", ["-p", "hi"])).toBe("-p|hi");
    expect(args("Get-TgHubClaudeArgs", ["--version"])).toBe("--version");
  });

  test("cswap run gets the flag after --", () => {
    expect(args("Get-TgHubCswapArgs", ["run", "2"])).toBe(`run|2|--|${CH}`);
    expect(args("Get-TgHubCswapArgs", ["run", "2", "--", "--resume"])).toBe(`run|2|--|${CH}|--resume`);
  });

  test("other cswap commands pass through", () => {
    expect(args("Get-TgHubCswapArgs", ["list"])).toBe("list");
    expect(args("Get-TgHubCswapArgs", ["run", "2", "--", "-p", "x"])).toBe("run|2|--|-p|x");
  });
});
