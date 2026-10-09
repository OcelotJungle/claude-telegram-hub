import type { Logger } from "../shared/log.ts";
import type { VideoMeta } from "../shared/media.ts";

import { rmSync, statSync } from "fs";
import { z } from "zod";

// Bot API thumbnail limits: a JPEG of at most 320 px a side, under 200 kB.
const THUMB_SIDE = 320;
const MAX_THUMB = 200 * 1024;
// ffmpeg's JPEG quality: 2 is the best, 31 the worst.
const THUMB_QUALITY = 4;
// About a second in skips a fade from black; shorter clips take the first frame.
const THUMB_AT_SEC = 1;
const SHORT_CLIP_SEC = 2;
const TOOL_TIMEOUT_MS = 30_000;

// The part of ffprobe's JSON output that dimensions() asks for.
const probeSchema = z.object({
  streams: z
    .array(
      z.object({
        width: z.number().optional(),
        height: z.number().optional(),
        duration: z.string().optional(),
        side_data_list: z.array(z.object({ rotation: z.number().optional() })).optional(),
      }),
    )
    .optional(),
  format: z.object({ duration: z.string().optional() }).optional(),
});

export type VideoTools = { ffprobe: string; ffmpeg: string };

export const DEFAULT_VIDEO_TOOLS: VideoTools = { ffprobe: "ffprobe", ffmpeg: "ffmpeg" };

// Where the thumbnail of a queued copy lives: next to it, so it goes with it.
export function thumbPath(path: string): string {
  return `${path}.thumb.jpg`;
}

// The display size, the duration and a thumbnail of a video, as far as
// ffprobe and ffmpeg can tell; empty when they cannot. Never throws.
export async function probeVideo(path: string, name: string, tools: VideoTools, log: Logger): Promise<VideoMeta> {
  let meta: VideoMeta;
  try {
    meta = await dimensions(path, tools.ffprobe);
  } catch (e) {
    log.warn(`ffprobe failed for ${name} (${e instanceof Error ? e.message : e}); sending the video without metadata`);
    return {};
  }
  const thumb = thumbPath(path);
  try {
    const at = (meta.duration ?? 0) >= SHORT_CLIP_SEC ? THUMB_AT_SEC : 0;
    const scale = `scale=w='min(${THUMB_SIDE},iw)':h='min(${THUMB_SIDE},ih)':force_original_aspect_ratio=decrease`;
    await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", "-ss", String(at), "-i", path, "-frames:v", "1", "-vf", scale, "-q:v", String(THUMB_QUALITY), thumb]);
    const size = statSync(thumb).size;
    if (size === 0 || size >= MAX_THUMB) throw new Error(`thumbnail is ${size} bytes`);
    meta.thumb = thumb;
  } catch (e) {
    rmSync(thumb, { force: true });
    log.warn(`ffmpeg made no thumbnail for ${name} (${e instanceof Error ? e.message : e}); sending the video without one`);
  }
  return meta;
}

async function dimensions(path: string, ffprobe: string): Promise<VideoMeta> {
  const entries = "stream=width,height,duration:stream_side_data=rotation:format=duration";
  const out = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", entries, "-of", "json", path]);
  const json = probeSchema.parse(JSON.parse(out));
  const stream = json.streams?.[0];
  if (!stream?.width || !stream.height) throw new Error("no video stream");
  // Phones store portrait video as landscape plus a rotation.
  const turned = Math.abs(stream.side_data_list?.find(d => d.rotation != null)?.rotation ?? 0) % 180 === 90;
  const seconds = Number(json.format?.duration ?? stream.duration);
  return {
    width: turned ? stream.height : stream.width,
    height: turned ? stream.width : stream.height,
    ...(seconds > 0 ? { duration: Math.max(1, Math.round(seconds)) } : {}),
  };
}

// Runs a tool to completion; its stdout, or an error with its stderr.
async function run(cmd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn([cmd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: TOOL_TIMEOUT_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd} exited with ${proc.signalCode ?? code}${err.trim() ? `: ${err.trim().split("\n")[0]}` : ""}`);
  return out;
}
