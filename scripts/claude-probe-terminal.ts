// Start the real interactive CLI only after the probe attaches tmux's output pipe.
import { existsSync, watch, writeFileSync } from "fs";
import { join } from "path";

const root = process.argv[2];
const cli = process.argv[3];
if (!root || !cli || !existsSync("/.dockerenv") || process.env.TELEGRAM_HUB_CONTAINER_TEST !== "1") process.exit(1);
const gate = join(root, "start");
await new Promise<void>(resolveGate => {
  const watcher = watch(root, check);
  function check() { if (existsSync(gate)) { watcher.close(); resolveGate(); } }
  check();
});
const child = Bun.spawn([cli, ...process.argv.slice(4)], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
writeFileSync(join(root, "claude-process.json"), JSON.stringify({ pid: child.pid }));
const code = await child.exited;
writeFileSync(join(root, "claude-exit.json"), JSON.stringify({ code }));
process.exit(code);
