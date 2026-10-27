// Checks one commit on its own, apart from the working tree:
//   bun scripts/test-commit.ts <commit>
// It checks the commit out into a temporary worktree named like the repo (the
// tests take the project name from the folder), installs the plugin's
// dependencies there from the lockfile, runs the type check and the full test
// suite, then removes the worktree. The test output stays in the repo's .tmp/.
// It never links node_modules from the main tree: removing a worktree follows
// such a link and empties the real folder.
import { lstatSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";

const REPO = resolve(import.meta.dir, "..");
const FAIL_LINE = /^\(fail\)/;
const TOTAL_LINE = /^\s*\d+ (pass|fail)$/;

async function run(cmd: string[], cwd: string, logPath?: string): Promise<number> {
  if (!logPath) return Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exited;
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await Bun.write(logPath, out + err);
  return proc.exited;
}

const commit = process.argv[2];
if (!commit) {
  console.error("usage: bun scripts/test-commit.ts <commit>");
  process.exit(2);
}
const sha = (await new Response(Bun.spawn(["git", "rev-parse", "--short", commit], { cwd: REPO }).stdout).text()).trim();
if (!sha) {
  console.error(`unknown commit: ${commit}`);
  process.exit(2);
}

const base = mkdtempSync(join(tmpdir(), "test-commit-"));
const tree = join(base, basename(REPO));
const log = join(REPO, ".tmp", `test-commit-${sha}.txt`);
let code = 1;
try {
  if ((await run(["git", "worktree", "add", "--detach", tree, sha], REPO)) !== 0) throw new Error("git worktree add failed");
  const plugin = join(tree, "plugin");
  if ((await run(["bun", "install", "--frozen-lockfile"], plugin)) !== 0) throw new Error("bun install failed");
  if ((await run(["bunx", "tsc", "--noEmit", "-p", "."], plugin)) !== 0) throw new Error("type check failed");
  console.log("type check: ok");
  code = await run(["bun", "test"], plugin, log);
  const lines = (await Bun.file(log).text()).split("\n").map(line => line.trimEnd());
  for (const line of lines) if (FAIL_LINE.test(line) || TOTAL_LINE.test(line)) console.log(line);
  console.log(`full output: ${log}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
} finally {
  // A link here would make the removal empty the main tree's folder.
  const modules = join(tree, "plugin", "node_modules");
  let linked = false;
  try {
    linked = lstatSync(modules).isSymbolicLink();
  } catch {
    // No node_modules: nothing to guard.
  }
  if (linked) console.error(`left ${base} in place: ${modules} is a link`);
  else {
    await run(["git", "worktree", "remove", "--force", tree], REPO);
    rmSync(base, { recursive: true, force: true });
  }
}
process.exit(code);
