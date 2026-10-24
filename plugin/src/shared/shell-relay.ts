// Runs the shell command in argv[2] with a hidden console and waits for it.
// spawnShellDetached starts this detached on Windows, see there why.
import { spawn } from "child_process";

const cmd = process.argv[2];
if (cmd !== undefined) {
  // windowsHide with no inherited stdio is CREATE_NO_WINDOW: a console with no
  // window, which every program the shell starts shares.
  const child = spawn(cmd, { shell: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
}
