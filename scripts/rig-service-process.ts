// Container-only fake rig and long-lived shell children for the systemd smoke test.
import { existsSync, writeFileSync } from "fs";
import { join } from "path";

const mode = process.argv[2];
if (!existsSync("/.dockerenv") || !process.env.RIG_SMOKE_DIR) process.exit(1);
if (mode === "rig") {
  const root = process.env.RIG_SMOKE_DIR;
  if (!root) process.exit(1);
  const args = process.argv.slice(3);
  if (args.join(" ") === "feature --json") {
    console.log(JSON.stringify([{ name: "telegram", description: "Telegram", enabled: true, platformAllowed: true }]));
  } else if (args.join(" ") === "status --json") {
    // The contract's `pendingHubRestart` is the saved state value: a string when a restart is expected, null otherwise.
    console.log(JSON.stringify({ schemaVersion: 1, mode: "dev", versions: { rig: "1.0.0", hub: "fixture" },
      features: [{ name: "telegram", description: "Telegram", enabled: true, platformAllowed: true }],
      lastUpdate: null, pendingHubRestart: "2026-01-01T00:00:00.000Z", errors: [] }));
  } else if (args.join(" ") === "feature telegram disable") {
    console.log("Disabling the fixture service");
    writeFileSync(join(root, "rig-started.json"), JSON.stringify({ pid: process.pid }));
    const child = Bun.spawn(["systemctl", "--user", "stop", "telegram-hub.service"], { stdout: "inherit", stderr: "inherit" });
    const code = await child.exited;
    if (code !== 0) process.exit(code);
    // This record proves that rig ran after its parent service had stopped.
    writeFileSync(join(root, "rig-finished.json"), JSON.stringify({ pid: process.pid }));
    console.log("Fixture disable finished");
  } else process.exit(1);
} else if (mode === "bash" || mode === "tmux") {
  const root = process.argv[3];
  if (!root) process.exit(1);
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("alive") });
  writeFileSync(join(root, `child-${mode}.json`), JSON.stringify({ pid: process.pid, port: server.port }));
} else process.exit(1);
