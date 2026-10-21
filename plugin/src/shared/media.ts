import { extname } from "path";
import { z } from "zod";

export const BYTES_PER_MB = 1024 * 1024;
// Bot API upload limits.
export const MAX_UPLOAD = 50 * BYTES_PER_MB;
export const MAX_PHOTO = 10 * BYTES_PER_MB;
export const MAX_CAPTION = 1024;
export const MAX_ALBUM = 10;

// Also the Bot API method suffix (sendPhoto…) and the upload field name.
export type FileKind = "photo" | "video" | "audio" | "animation" | "document";

// What Telegram needs to show a video with a preview, its duration and
// streaming; thumb is a JPEG next to the hub's copy. Empty when probing failed.
export type VideoMeta = { width?: number; height?: number; duration?: number; thumb?: string };

// A file queued for the topic: path is the hub's own copy, name the original.
// video: a video's metadata, set once it was probed.
export type OutFile = { path: string; name: string; size: number; kind: FileKind; video?: VideoMeta };

export const outFileSchema: z.ZodType<OutFile> = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number(),
  kind: z.enum(["photo", "video", "audio", "animation", "document"]),
  video: z.object({ width: z.number().optional(), height: z.number().optional(), duration: z.number().optional(), thumb: z.string().optional() }).optional(),
});

const BY_EXT: Record<string, FileKind> = {
  ".jpg": "photo",
  ".jpeg": "photo",
  ".png": "photo",
  ".webp": "photo",
  ".mp4": "video",
  ".mp3": "audio",
  ".m4a": "audio",
  ".gif": "animation",
};

// What Telegram shows natively; anything else is a document.
export function kindOf(name: string, size: number): FileKind {
  const kind = BY_EXT[extname(name).toLowerCase()] ?? "document";
  return kind === "photo" && size > MAX_PHOTO ? "document" : kind;
}

// Kinds that may share a media group. Animations cannot be in one.
function family(kind: FileKind): string | undefined {
  if (kind === "photo" || kind === "video") return "visual";
  return kind === "animation" ? undefined : kind;
}

// Splits files into Telegram sends, keeping their order: consecutive files of
// one family share an album of up to 10. The upload limit holds for a whole
// request (Telegram answers 413), so an album stays within it.
export function albums(files: OutFile[]): OutFile[][] {
  const out: OutFile[][] = [];
  for (const file of files) {
    const last = out.at(-1);
    const fam = family(file.kind);
    const fits = last !== undefined && last.length < MAX_ALBUM && last.reduce((sum, f) => sum + f.size, file.size) <= MAX_UPLOAD;
    if (last && fam && family(last[0].kind) === fam && fits) last.push(file);
    else out.push([file]);
  }
  return out;
}
