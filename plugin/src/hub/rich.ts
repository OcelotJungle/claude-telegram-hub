// A rich formatted message (Bot API 10.1, Message.rich_message) as Markdown
// for the agent. Telegram sends a pasted document this way: a tree of blocks
// (paragraphs, headings, lists, tables, media) instead of text and entities.
// Kinds of block or text this file does not know show what text they carry.
// The tree is read field by field: @gramio/types leaves out forms of rich
// text the Bot API allows.
import { arr, field, isObject, str } from "../shared/guards.ts";

const MAX_HEADING = 6;

// The part of Message.rich_message this file reads.
export type RichMessage = { blocks: unknown };

// Local paths of the photos the hub downloaded, by file_id.
type Paths = ReadonlyMap<string, string>;

// A photo found in `paths` is named by its local path, any other file by its
// file_id, which download_attachment takes.
export function richToMarkdown(m: RichMessage, paths: Paths = new Map()): string {
  return blocks(m.blocks, paths);
}

// The file_id of the largest size of every photo, for the hub to download.
export function richPhotos(m: RichMessage): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!isObject(v)) return;
    if (v.type === "photo") {
      const best = largest(v.photo);
      if (best) found.push(best);
    }
    Object.values(v).forEach(walk);
  };
  walk(m.blocks);
  return found;
}

// The file_id of the last, largest, of a photo's sizes.
function largest(sizes: unknown): string | undefined {
  return str(field(arr(sizes).at(-1), "file_id"));
}

function blocks(list: unknown, paths: Paths): string {
  return arr(list)
    .map(b => block(b, paths))
    .filter(s => s !== "")
    .join("\n\n");
}

function block(b: unknown, paths: Paths): string {
  if (!isObject(b)) return "";
  const t = (key = "text") => text(b[key]);
  const type = str(b.type) ?? "";
  switch (type) {
    case "paragraph":
    case "footer":
      return t();
    case "heading":
      return `${"#".repeat(Math.min(Math.max(Number(b.size) || 1, 1), MAX_HEADING))} ${t()}`;
    case "pre":
      return `\`\`\`${str(b.language) ?? ""}\n${t()}\n\`\`\``;
    case "divider":
      return "---";
    case "mathematical_expression":
      return `$$\n${b.expression}\n$$`;
    case "anchor":
    case "thinking":
      return "";
    case "list":
      return arr(b.items).map(i => listItem(i, paths)).join("\n");
    case "blockquote":
      return quote(blocks(b.blocks, paths), b.credit);
    case "expandable_blockquote":
    case "pullquote":
      return quote(t(), b.credit);
    case "collage":
    case "slideshow":
      return withCaption(blocks(b.blocks, paths), b.caption);
    case "table":
      return table(b.cells);
    case "details":
      return [`**${t("summary")}**`, blocks(b.blocks, paths)].filter(Boolean).join("\n\n");
    case "map":
      return withCaption(`(map: ${field(b.location, "latitude")}, ${field(b.location, "longitude")})`, b.caption);
    case "buttons":
      return arr(b.buttons).map(button).join(" · ");
    case "photo": {
      const id = largest(b.photo);
      const path = id === undefined ? undefined : paths.get(id);
      return withCaption(path ? `(photo: ${path})` : media("photo", undefined, id), b.caption);
    }
    case "video":
    case "animation":
    case "audio":
    case "voice_note":
    case "document": {
      const f = b[type];
      const name = str(field(f, "title")) ?? str(field(f, "file_name"));
      return withCaption(media(type.replace("_", " "), name, str(field(f, "file_id"))), b.caption);
    }
    default:
      return "text" in b ? t() : blocks(b.blocks, paths);
  }
}

// The label comes from Telegram ("1.", "•", "a)"); what follows it is indented
// to line up under the first line.
function listItem(item: unknown, paths: Paths): string {
  if (!isObject(item)) return "";
  const label = str(item.label) || "-";
  const box = item.has_checkbox ? (item.is_checked ? "[x] " : "[ ] ") : "";
  const body = arr(item.blocks)
    .map(b => block(b, paths))
    .filter(s => s !== "")
    .join("\n");
  const pad = " ".repeat(label.length + 1);
  return `${label} ${box}${body.split("\n").join(`\n${pad}`)}`;
}

function media(kind: string, name: string | undefined, fileId: string | undefined): string {
  return `(${kind}${name ? `: ${name}` : ""}${fileId ? `, file_id: ${fileId}` : ""})`;
}

function quote(body: string, credit: unknown): string {
  const lines = body.split("\n");
  const by = text(credit);
  if (by) lines.push(`— ${by}`);
  return lines.map(l => (l ? `> ${l}` : ">")).join("\n");
}

function withCaption(body: string, caption: unknown): string {
  if (!isObject(caption)) return body;
  const parts = [text(caption.text), caption.credit === undefined ? "" : `— ${text(caption.credit)}`].filter(Boolean);
  return parts.length ? `${body} ${parts.join(" ")}` : body;
}

function table(rows: unknown): string {
  const cells = arr(rows).map(r => arr(r).map(c => text(field(c, "text"))));
  if (!cells.length) return "";
  const width = Math.max(...cells.map(r => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => (r[i] ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
  return [line(cells[0] ?? []), `| ${Array(width).fill("---").join(" | ")} |`, ...cells.slice(1).map(line)].join("\n");
}

function button(b: unknown): string {
  const label = text(field(b, "text"));
  const url = str(field(b, "url"));
  return url ? `[${label}](${url})` : label;
}

function text(t: unknown): string {
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map(text).join("");
  if (!isObject(t)) return "";
  const inner = () => text(t.text);
  switch (t.type) {
    case "bold":
      return `**${inner()}**`;
    case "italic":
      return `*${inner()}*`;
    case "strikethrough":
      return `~~${inner()}~~`;
    case "code":
      return `\`${inner()}\``;
    case "url": {
      const label = inner();
      return label === t.url ? label : `[${label}](${t.url})`;
    }
    case "custom_emoji":
      return String(t.alternative_text ?? "");
    case "mathematical_expression":
      return `$${t.expression}$`;
    case "button":
      return button(t.button);
    case "anchor":
      return "";
    default:
      return inner();
  }
}
