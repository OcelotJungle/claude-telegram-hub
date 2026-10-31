import { posix, win32 } from "path";

const WINDOWS_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

export type Platform = {
  windows: boolean;
  bash: string;
  bashName: string;
  sound: boolean;
  cswapName: string;
  shellNames: { powershell: string; cmd: string; bash: string };
  samePath(left: string, right: string): boolean;
  pathBase(path: string): string;
  join(...parts: string[]): string;
};

// The only OS selection point. Callers may inject either value in tests.
export function platformFor(os: string): Platform {
  const windows = os === "win32";
  const paths = windows ? win32 : posix;
  const normalize = (path: string) => {
    const resolved = paths.resolve(path);
    return windows ? resolved.toLowerCase() : resolved;
  };
  const bashName = windows ? "Git Bash" : "bash";
  return {
    windows,
    bash: windows ? WINDOWS_BASH : "bash",
    bashName,
    sound: windows,
    cswapName: windows ? "cswap.exe" : "cswap",
    shellNames: { powershell: "PowerShell", cmd: "cmd", bash: bashName },
    samePath: (left, right) => normalize(left) === normalize(right),
    pathBase: path => paths.basename(path),
    join: (...parts) => paths.join(...parts),
  };
}

export const PLATFORM = platformFor(process.platform);
