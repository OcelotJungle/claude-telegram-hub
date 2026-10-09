// A rich formatted message (Bot API 10.1, Message.rich_message) as Markdown
// for the agent. Telegram sends a pasted document this way: a tree of blocks
// (paragraphs, headings, lists, tables, media) instead of text and entities.
// Kinds of block or text this file does not know show what text they carry.
import type { TelegramRichMessage } from "@gramio/types";

export type RichMessage = TelegramRichMessage;

// A string, an array of rich texts, or an object with a type.
export type RichText = string | RichText[] | ({ type: string } & Record<string, unknown>);

type RichBlock = { type: string } & Record<string, unknown>;
type ListItem = { label?: string; blocks?: RichBlock[]; has_checkbox?: true; is_checked?: true };
type TableCell = { text?: RichText };

// Local paths of the photos the hub downloaded, by file_id.
type Paths = ReadonlyMap<string, string>;
type Media = { file_id?: string; file_name?: string; title?: string };

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
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "photo" && Array.isArray(o.photo)) {
      const best = (o.photo.at(-1) as Media | undefined)?.file_id;
      if (best) found.push(best);
    }
    Object.values(o).forEach(walk);
  };
  walk(m.blocks);
  return found;
}

function blocks(list: unknown, paths: Paths): string {
  return (Array.isArray(list) ? list : [])
    .map(b => block(b as RichBlock, paths))
    .filter(s => s !== "")
    .join("\n\n");
}

function block(b: RichBlock, paths: Paths): string {
  const t = (key = "text") => text(b[key] as RichText);
  switch (b.type) {
    case "paragraph":
    case "footer":
      return t();
    case "heading":
      return `${"#".repeat(Math.min(Math.max(Number(b.size) || 1, 1), 6))} ${t()}`;
    case "pre":
      return `\`\`\`${typeof b.language === "string" ? b.language : ""}\n${t()}\n\`\`\``;
    case "divider":
      return "---";
    case "mathematical_expression":
      return `$$\n${b.expression}\n$$`;
    case "anchor":
    case "thinking":
      return "";
    case "list":
      return ((b.items as ListItem[]) ?? []).map(i => listItem(i, paths)).join("\n");
    case "blockquote":
      return quote(blocks(b.blocks, paths), b.credit);
    case "expandable_blockquote":
    case "pullquote":
      return quote(t(), b.credit);
    case "collage":
    case "slideshow":
      return withCaption(blocks(b.blocks, paths), b.caption);
    case "table":
      return table(b.cells as TableCell[][]);
    case "details":
      return [`**${t("summary")}**`, blocks(b.blocks, paths)].filter(Boolean).join("\n\n");
    case "map": {
      const l = b.location as { latitude?: number; longitude?: number } | undefined;
      return withCaption(`(map: ${l?.latitude}, ${l?.longitude})`, b.caption);
    }
    case "buttons":
      return ((b.buttons as { text?: RichText; url?: string }[]) ?? []).map(button).join(" · ");
    case "photo": {
      const id = ((b.photo as Media[] | undefined) ?? []).at(-1)?.file_id;
      const path = id === undefined ? undefined : paths.get(id);
      return withCaption(path ? `(photo: ${path})` : media("photo", undefined, id), b.caption);
    }
    case "video":
    case "animation":
    case "audio":
    case "voice_note":
    case "document": {
      const f = b[b.type] as Media | undefined;
      return withCaption(media(b.type.replace("_", " "), f?.title ?? f?.file_name, f?.file_id), b.caption);
    }
    default:
      return "text" in b ? t() : blocks(b.blocks, paths);
  }
}

// The label comes from Telegram ("1.", "•", "a)"); what follows it is indented
// to line up under the first line.
function listItem(item: ListItem, paths: Paths): string {
  const label = item.label || "-";
  const box = item.has_checkbox ? (item.is_checked ? "[x] " : "[ ] ") : "";
  const body = (item.blocks ?? []).map(b => block(b, paths)).filter(s => s !== "").join("\n");
  const pad = " ".repeat(label.length + 1);
  return `${label} ${box}${body.split("\n").join(`\n${pad}`)}`;
}

function media(kind: string, name: string | undefined, fileId: string | undefined): string {
  return `(${kind}${name ? `: ${name}` : ""}${fileId ? `, file_id: ${fileId}` : ""})`;
}

function quote(body: string, credit: unknown): string {
  const lines = body.split("\n");
  const by = credit === undefined ? "" : text(credit as RichText);
  if (by) lines.push(`— ${by}`);
  return lines.map(l => (l ? `> ${l}` : ">")).join("\n");
}

function withCaption(body: string, caption: unknown): string {
  const c = caption as { text?: RichText; credit?: RichText } | undefined;
  if (!c) return body;
  const parts = [text(c.text ?? ""), c.credit === undefined ? "" : `— ${text(c.credit)}`].filter(Boolean);
  return parts.length ? `${body} ${parts.join(" ")}` : body;
}

function table(rows: TableCell[][] | undefined): string {
  if (!rows?.length) return "";
  const width = Math.max(...rows.map(r => r.length));
  const line = (r: TableCell[]) =>
    `| ${Array.from({ length: width }, (_, i) => (r[i]?.text === undefined ? "" : text(r[i]!.text!)).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ")} |`;
  return [line(rows[0]!), `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map(line)].join("\n");
}

function button(b: { text?: RichText; url?: string }): string {
  const label = text(b.text ?? "");
  return b.url ? `[${label}](${b.url})` : label;
}

function text(t: RichText | undefined): string {
  if (t === undefined || t === null) return "";
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.map(text).join("");
  const inner = () => text(t.text as RichText);
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
      return button((t.button as { text?: RichText; url?: string }) ?? {});
    case "anchor":
      return "";
    default:
      return inner();
  }
}
