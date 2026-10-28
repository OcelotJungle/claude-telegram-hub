import type { Entity, Formatted } from "../shared/markdown.ts";

const JSON_STRING = /"(?:\\.|[^"\\])*"/y;

type ParsedPreview = {
  description?: string;
  body: string;
};

function removeMember(preview: string, start: number, end: number): string {
  let left = start;
  let right = end;
  while (/\s/.test(preview[left - 1] ?? "") && left > 0) left -= 1;
  while (/\s/.test(preview[right] ?? "") && right < preview.length) right += 1;
  if (preview[left - 1] === ",") {
    const prefix = preview.slice(0, left - 1);
    if (preview[right] === ",") return `${prefix},${preview.slice(right + 1)}`;
    return `${prefix}${preview.slice(right)}`;
  }
  if (preview[right] === ",") return `${preview.slice(0, left)}${preview.slice(right + 1)}`;
  return `${preview.slice(0, left)}${preview.slice(right)}`;
}

function extractDescription(preview: string): ParsedPreview {
  const key = /(^|[,{])\s*"description"\s*:\s*/.exec(preview);
  if (!key) return { body: preview };
  const keyStart = key.index + key[0].lastIndexOf('"description"');
  const valueStart = key.index + key[0].length;
  JSON_STRING.lastIndex = valueStart;
  const value = JSON_STRING.exec(preview);
  if (!value) return { body: preview };
  let description: unknown;
  try {
    description = JSON.parse(value[0]);
  } catch {
    return { body: preview };
  }
  if (typeof description !== "string") return { body: preview };
  return { description, body: removeMember(preview, keyStart, JSON_STRING.lastIndex) };
}

function previewParts(inputPreview: string): ParsedPreview {
  try {
    const value: unknown = JSON.parse(inputPreview);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { body: inputPreview };
    const fields = Object.entries(value);
    const descriptionValue = fields.find(([key]) => key === "description")?.[1];
    const description = typeof descriptionValue === "string" ? descriptionValue : undefined;
    const body = fields.filter(([key]) => key !== "description").map(([key, field]) => `${key}: ${typeof field === "string" ? field : JSON.stringify(field)}`).join("\n");
    return { ...(description === undefined ? {} : { description }), body };
  } catch {
    return extractDescription(inputPreview);
  }
}

export function formatPermission(toolName: string, inputPreview: string | undefined, maxPreviewChars: number): Formatted {
  const head = `🔐 Нужно подтверждение: ${toolName}`;
  if (!inputPreview) return { text: head, entities: [] };
  // Parsed whole, then cut: cutting first would break JSON that parses.
  const parts = previewParts(inputPreview);
  const description = parts.description;
  const body = parts.body.length > maxPreviewChars ? `${parts.body.slice(0, maxPreviewChars)}…` : parts.body;
  const hasBody = body.length > 0 && body !== "{}";
  const lead = description === undefined ? head : `${head}\n${description}`;
  if (!hasBody) return { text: lead, entities: [] };
  const text = `${lead}\n\n${body}`;
  const entity: Entity = { type: "pre", offset: lead.length + 2, length: body.length };
  return { text, entities: [entity] };
}
