// Static checks of the service install scripts: they cannot run on Windows, the container run (scripts/test-systemd.sh)
// covers their behaviour. These keep the contract of the spec («Служба на Linux», «Хабом управляет служба») from drifting.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join, resolve } from "path";
import { must } from "./helpers.ts";

const SCRIPTS = resolve(import.meta.dir, "..", "..", "scripts");
const MARKER = "service-managed";

const read = (name: string) => readFileSync(join(SCRIPTS, name), "utf8").replaceAll("\r\n", "\n");
const lineWith = (text: string, needle: string) => text.split("\n").find(line => line.includes(needle)) ?? "";

describe("install-hub-service.sh", () => {
  const install = read("install-hub-service.sh");

  test("a fast failure at start does not leave the service failed for good", () => {
    expect(install).toContain("RestartSec=2");
    expect(install).toContain("StartLimitIntervalSec=0");
    // Newer systemd reads the start limit from [Unit] only.
    expect(install.indexOf("StartLimitIntervalSec=0")).toBeLessThan(install.indexOf("'[Service]'"));
  });

  test("the unit PATH is static and holds the user's tool directories", () => {
    const line = lineWith(install, "PATH=");
    expect(install).toContain("unit_path=");
    expect(lineWith(install, "unit_path=")).toContain(".local/bin");
    expect(lineWith(install, "unit_path=")).toContain(".bun/bin");
    // The PATH of the installing shell is not copied into the unit.
    expect(lineWith(install, "unit_path=")).not.toContain("$PATH");
    expect(line).not.toContain(":$PATH");
  });

  test("it waits for the user bus after enabling linger, before the first systemctl call", () => {
    const linger = install.indexOf("enable-linger");
    const wait = install.indexOf("show-environment");
    const first = install.indexOf("systemctl --user daemon-reload");
    expect(linger).toBeGreaterThan(-1);
    expect(wait).toBeGreaterThan(linger);
    expect(first).toBeGreaterThan(wait);
  });

  test("it marks the hub as service-managed before the service starts, so no window starts a second hub", () => {
    const marker = install.indexOf(`/${MARKER}"`);
    expect(marker).toBeGreaterThan(-1);
    expect(install.indexOf("enable --now")).toBeGreaterThan(marker);
  });

  test("a service that fails to start leaves no marker behind", () => {
    expect(lineWith(install, "enable --now")).toContain("||");
    expect(install).toContain('rm -f -- "$state_dir/service-managed"');
  });
});

describe("run-hub-service.sh", () => {
  const run = read("run-hub-service.sh");

  test("the commit of the code is fixed before bun starts", () => {
    const commit = run.indexOf("TELEGRAM_HUB_COMMIT");
    expect(commit).toBeGreaterThan(-1);
    expect(run).toContain("rev-parse HEAD");
    expect(commit).toBeLessThan(run.indexOf("bun install"));
    expect(commit).toBeLessThan(run.indexOf("exec bun"));
    expect(run).toContain("export TELEGRAM_HUB_COMMIT");
  });
});

describe("uninstall-hub-service.sh", () => {
  const uninstall = read("uninstall-hub-service.sh");

  test("it removes the marker and also works when the service is already gone", () => {
    expect(uninstall).toContain(MARKER);
    expect(lineWith(uninstall, "disable --now")).toContain("|| ");
    expect(lineWith(uninstall, "daemon-reload")).toContain("|| ");
  });
});

describe("Windows task scripts", () => {
  test("the install script creates the marker, the uninstall script removes it", () => {
    expect(read("install-hub-task.ps1")).toContain(MARKER);
    expect(read("uninstall-hub-task.ps1")).toContain(MARKER);
  });

  test("the install script creates the marker before it starts the task, so no window starts a second hub", () => {
    const install = read("install-hub-task.ps1");
    const marker = install.indexOf(`'${MARKER}'`);
    expect(marker).toBeGreaterThan(-1);
    expect(install.indexOf("Start-ScheduledTask")).toBeGreaterThan(marker);
  });

  test("the uninstall script removes the marker also when the task is already gone", () => {
    const uninstall = read("uninstall-hub-task.ps1");
    expect(uninstall.indexOf(MARKER)).toBeLessThan(uninstall.indexOf("Get-ScheduledTask"));
  });
});

describe("shell syntax", () => {
  for (const name of ["install-hub-service.sh", "run-hub-service.sh", "uninstall-hub-service.sh", "test-systemd.sh"]) {
    test(`${name} parses`, () => {
      const result = Bun.spawnSync([must(Bun.which("bash")), "-n", join(SCRIPTS, name)]);
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    });
  }
});
