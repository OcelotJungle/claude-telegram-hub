// Real Claude Code, isolated HOME, no login and no model request. Results distinguish
// observations from mechanisms unreachable before authentication; never treat those as passes.
import { strict as assert } from "assert";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "fs";
import { connect } from "net";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { randomUUID } from "crypto";
import { sanitizeCwd } from "../plugin/src/transcript/locate.ts";
import { field } from "../plugin/src/shared/guards.ts";

const SCREEN_EXCERPT_LINES = 3;
const REPO = resolve(import.meta.dir, "..");
const AUTH_ENV = /^(?:ANTHROPIC_|CLAUDE_|TG_HUB_|TELEGRAM_BOT_TOKEN$)/;
type Observation = { check: string; result: "pass" | "blocked" | "fail"; detail: string };

if (!existsSync("/.dockerenv") || process.env.TG_HUB_CONTAINER_TEST !== "1") process.exit(1);
const cli = Bun.which("claude");
if (!cli) { console.error("Real Claude Code must be installed in the claude Docker target"); process.exit(1); }
const root = mkdtempSync(join(tmpdir(), "tg-hub-claude-"));
process.once("exit", () => { rmSync(root, { recursive: true, force: true }); });
const home = join(root, "home");
const workspace = join(root, "workspace");
const reports = join(REPO, "docs", "reports");
mkdirSync(home);
mkdirSync(workspace);
mkdirSync(reports, { recursive: true });
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !AUTH_ENV.test(key)) env[key] = value;
env.HOME = home;
env.CLAUDE_CONFIG_DIR = join(home, ".claude");
env.TG_HUB_STATE_DIR = join(root, "state");
env.TG_HUB_CONTAINER_TEST = "1";
// Reserve a private port; the plugin may start its own hub even before login.
const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") });
env.TG_HUB_PORT = String(reservation.port);
reservation.stop(true);
const session = randomUUID();
const socketName = `tg-hub-probe-${session}`;
const terminal = "probe";
const observations: Observation[] = [];
let cleaning = false;

async function command(argv: string[]) {
  const child = Bun.spawn(argv, { env, cwd: workspace, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
async function tmux(args: string[]) {
  const result = await command(["tmux", "-L", socketName, ...args]);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout;
}
async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  await command(["tmux", "-L", socketName, "kill-server"]);
  try {
    const health: unknown = await (await fetch(`http://127.0.0.1:${env.TG_HUB_PORT}/health`)).json();
    const pid = field(health, "pid");
    if (typeof pid === "number") {
      const variables = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (variables.includes(`TG_HUB_STATE_DIR=${env.TG_HUB_STATE_DIR}`)) process.kill(pid, "SIGKILL");
    }
  } catch {}
  rmSync(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => { void cleanup().then(() => process.exit(1)); });

try {
  const version = await command([cli, "--version"]);
  assert.equal(version.code, 0, version.stderr);
  observations.push({ check: "real CLI", result: "pass", detail: version.stdout.trim() });
  const help = await command([cli, "--help"]);
  assert.equal(help.code, 0, help.stderr);
  writeFileSync(join(reports, "claude-help.log"), help.stdout + help.stderr);
  const flags = ["--plugin-dir", join(REPO, "plugin"), "--dangerously-load-development-channels", "plugin:tg-hub@inline", "--session-id", session];
  const parser = await command([cli, ...flags, "--version"]);
  assert.equal(parser.code, 0, parser.stderr);
  observations.push({ check: "development-channel flag", result: "pass", detail: "Real CLI accepts the plugin/channel/session arguments; activation checked below." });
  await tmux(["new-session", "-d", "-s", terminal, "-c", workspace, "--", process.execPath, join(REPO, "scripts", "claude-probe-terminal.ts"), root, cli, ...flags]);
  await tmux(["set-option", "-w", "-t", terminal, "remain-on-exit", "on"]);
  const pane = join(root, "pane.log");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await tmux(["pipe-pane", "-O", "-t", terminal, `cat > ${quote(pane)}`]);
  // Wake on every pane write and re-read the rendered screen: raw output can hold control sequences
  // with word characters before any dialog is drawn, so only the captured screen decides.
  const capture = await new Promise<string>((resolveOutput, rejectOutput) => {
    const watcher = watch(root, () => { void check(); });
    let checking = false;
    let dirty = false;
    async function check() {
      // A wake-up during a capture marks the screen dirty so no write is missed.
      if (checking) { dirty = true; return; }
      checking = true;
      try {
        do {
          dirty = false;
          const screen = await tmux(["capture-pane", "-p", "-t", terminal]);
          if (/\w/.test(screen)) { watcher.close(); resolveOutput(screen); return; }
        } while (dirty);
      } catch (error) { watcher.close(); rejectOutput(error); }
      finally { checking = false; }
    }
    writeFileSync(join(root, "start"), "");
    void check();
  });
  writeFileSync(join(reports, "claude-tmux.log"), capture);
  assert.ok(!/unknown option|unrecognized option/i.test(capture), capture);
  observations.push({ check: "tmux startup", result: "pass", detail: "Real interactive CLI started with separate arguments; terminal capture saved." });
  let messagingSocket: string | undefined;
  const processes = readdirSync("/proc").filter(name => /^\d+$/.test(name));
  for (const pid of processes) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!argv.split("\0").some(argument => argument === "src/plugin/main.ts" || argument.endsWith("/src/plugin/main.ts"))) continue;
      const variables = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (!variables.includes(`CLAUDE_CONFIG_DIR=${env.CLAUDE_CONFIG_DIR}`)) continue;
      messagingSocket = variables.find(value => value.startsWith("CLAUDE_CODE_MESSAGING_SOCKET="))?.slice("CLAUDE_CODE_MESSAGING_SOCKET=".length);
    } catch {}
  }
  const socketPath = messagingSocket;
  const socketLive = socketPath ? await new Promise<boolean>(resolveSocket => {
    const client = connect(socketPath, () => { client.end(); resolveSocket(true); });
    client.on("error", () => resolveSocket(false));
  }) : false;
  observations.push({ check: "CLAUDE_CODE_MESSAGING_SOCKET", result: socketPath ? socketLive ? "pass" : "fail" : "blocked",
    detail: socketPath ? "Connected to the real plugin's inherited Unix socket without sending a prompt or token." : "No plugin messaging socket observed before the initial unauthenticated dialog." });
  if (socketPath && !socketLive) process.exitCode = 1;
  const transcript = join(env.CLAUDE_CONFIG_DIR ?? "", "projects", sanitizeCwd(workspace), `${session}.jsonl`);
  observations.push({ check: "transcript path", result: existsSync(transcript) ? "pass" : "blocked",
    detail: existsSync(transcript) ? "Real CLI created the session file at the expected sanitized cwd path." : "No session transcript observed before authentication; verify in the joint end-to-end run." });
  observations.push({ check: "! interruption", result: "blocked", detail: "Requires an authenticated running turn; no model request or login is attempted." });
  const firstLines = capture.split("\n").map(line => line.trim()).filter(Boolean).slice(0, SCREEN_EXCERPT_LINES).join(" | ");
  observations.push({ check: "channel delivery and confirmation dialog", result: "blocked",
    detail: `First screen (full capture in claude-tmux.log): ${firstLines}. Accepting the channel and exchanging messages require an authenticated session.` });
} catch (error) {
  observations.push({ check: "probe", result: "fail", detail: String(error) });
  process.exitCode = 1;
} finally {
  await cleanup();
  writeFileSync(join(reports, "claude-linux-probe.json"), JSON.stringify(observations, null, 2));
  for (const observation of observations) console.log(`${observation.result}: ${observation.check}: ${observation.detail}`);
}
