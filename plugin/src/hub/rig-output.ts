// What a rig card shows. The runner keeps rig's two streams apart, each as whole lines: the progress
// (stderr) in the run's log, the result or the error (stdout) in its result file. The words are made
// here, when the card is drawn, from the catalog current at that moment: all progress first, the result
// last. A line that is not a JSON object (a traceback, cmd.exe text) is text and is shown as it is.
import type { Messages } from "../shared/i18n/index.ts";

import { field, isObject, str } from "../shared/guards.ts";
import { isBlockError } from "../shared/info-data.ts";

function parseObject(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// undefined: a progress line with no usable code, which shows nothing.
function progressText(progress: Record<string, unknown>, m: Messages): string | undefined {
  const code = str(progress["code"]);
  if (code === undefined || code === "") return undefined;
  const data = progress["data"];
  const line = str(field(data, "line"));
  const name = str(field(data, "name"));
  const command = str(field(data, "command"));
  if (code === "update-step-output" && line !== undefined) return line;
  if (code === "program-install" && name !== undefined && command !== undefined) return m.rigProgressProgramInstall({ name, command });
  if (code === "lock-waiting") return m.rigProgressLockWaiting;
  if (code === "service-stopping") return m.rigProgressServiceStopping;
  // A progress code this hub has no words for, or a known one without its data.
  return m.rigProgressUnknown({ code });
}

function resultText(value: Record<string, unknown>, m: Messages): string | undefined {
  const feature = str(value["feature"]);
  if (feature !== undefined && typeof value["enabled"] === "boolean") {
    return value["enabled"] ? m.rigFeatureEnabled({ name: feature }) : m.rigFeatureDisabled({ name: feature });
  }
  const mode = str(value["mode"]);
  const outcome = str(value["outcome"]);
  if (mode !== undefined && outcome !== undefined) {
    const pending = mode === "pending";
    if (outcome === "complete") return m.rigUpdateComplete({ pending });
    if (outcome === "checked") return m.rigUpdateChecked({ pending });
    if (outcome === "deferred") return m.rigUpdateDeferred({ pending });
  }
  const language = str(value["language"]);
  if (language !== undefined) {
    const changed = value["changed"];
    if (changed === true) return m.rigLanguageChanged({ language });
    if (changed === false) return m.rigLanguageUnchanged({ language });
    return m.rigLanguageIs({ language });
  }
  return undefined;
}

// An answer this hub has no words for: its plain fields, so that no JSON reaches the user.
function fieldsText(value: Record<string, unknown>): string {
  return Object.entries(value)
    .flatMap(([key, item]) => (typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? [`${key}: ${item}`] : []))
    .join(", ");
}

// The lines of a text made from rig's JSON; none for an empty text. A message that holds the output of a
// failed child (rig update, rig check) has many lines, and the card keeps the last ones.
function textLines(text: string | undefined): string[] {
  if (text === undefined) return [];
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

// One stored line as the lines it shows: none, one, or many.
export function renderRigLine(line: string, m: Messages): string[] {
  const value = parseObject(line);
  if (!value) return [line];
  const progress = value["progress"];
  if (isObject(progress)) return textLines(progressText(progress, m));
  if (isBlockError(value)) return textLines(value.error.message);
  return textLines(resultText(value, m) ?? fieldsText(value));
}

export function renderRigLines(lines: string[], m: Messages): string[] {
  return lines.flatMap(line => renderRigLine(line, m));
}

// A run as the card, the sent file and the reports show it: every progress line, then the result.
export function renderRigRun(progress: string[], result: string[], m: Messages): string[] {
  return [...renderRigLines(progress, m), ...renderRigLines(result, m)];
}

// The lines of a text that are not JSON objects, as text; for a failure that has no error object to show.
export function plainLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter(line => line !== "" && parseObject(line) === undefined)
    .join("\n");
}
