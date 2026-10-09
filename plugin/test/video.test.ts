import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { DEFAULT_VIDEO_TOOLS, probeVideo, thumbPath } from "../src/hub/video.ts";
import { hasFfmpeg, makeVideo, memLogger, tempDir } from "./helpers.ts";

// The pixel size of a JPEG, by ffprobe.
function imageSize(path: string): { width: number; height: number } {
  const r = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "json", path]);
  return JSON.parse(r.stdout.toString()).streams[0];
}

describe.skipIf(!hasFfmpeg)("probeVideo", () => {
  test("a landscape clip: its size, duration and a thumbnail of at most 320 px under 200 kB next to it", async () => {
    const path = join(tempDir(), "clip.mp4");
    makeVideo(path, { width: 1280, height: 720, seconds: 3 });
    const log = memLogger();
    const meta = await probeVideo(path, "clip.mp4", DEFAULT_VIDEO_TOOLS, log);
    expect(meta).toEqual({ width: 1280, height: 720, duration: 3, thumb: thumbPath(path) });
    expect(imageSize(meta.thumb!)).toEqual({ width: 320, height: 180 });
    expect(statSync(meta.thumb!).size).toBeLessThan(200 * 1024);
    expect(log.lines).toEqual([]);
  });

  test("a rotated phone clip reports its display size", async () => {
    const path = join(tempDir(), "phone.mp4");
    makeVideo(path, { width: 640, height: 360, seconds: 3, rotation: 90 });
    const meta = await probeVideo(path, "phone.mp4", DEFAULT_VIDEO_TOOLS, memLogger());
    expect(meta).toMatchObject({ width: 360, height: 640, duration: 3 });
    expect(imageSize(meta.thumb!)).toEqual({ width: 180, height: 320 });
  });

  test("a clip shorter than a second takes its first frame and lasts at least a second", async () => {
    const path = join(tempDir(), "blink.mp4");
    makeVideo(path, { width: 200, height: 100, seconds: 0.3 });
    const meta = await probeVideo(path, "blink.mp4", DEFAULT_VIDEO_TOOLS, memLogger());
    expect(meta).toEqual({ width: 200, height: 100, duration: 1, thumb: thumbPath(path) });
    // Small clips are not scaled up.
    expect(imageSize(meta.thumb!)).toEqual({ width: 200, height: 100 });
  });

  test("a file that is not a video gives no metadata and a warning", async () => {
    const dir = tempDir();
    const path = join(dir, "fake.mp4");
    writeFileSync(path, "not a video");
    const log = memLogger();
    expect(await probeVideo(path, "fake.mp4", DEFAULT_VIDEO_TOOLS, log)).toEqual({});
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("fake.mp4"))).toBe(true);
    expect(readdirSync(dir)).toEqual(["fake.mp4"]);
  });

  test("without ffmpeg the size and duration still come, without a thumbnail", async () => {
    const path = join(tempDir(), "clip.mp4");
    makeVideo(path, { seconds: 2 });
    const log = memLogger();
    const meta = await probeVideo(path, "clip.mp4", { ffprobe: "ffprobe", ffmpeg: "no-such-ffmpeg" }, log);
    expect(meta).toEqual({ width: 640, height: 360, duration: 2 });
    expect(existsSync(thumbPath(path))).toBe(false);
    expect(log.lines.some(l => l.startsWith("WARN") && l.includes("thumbnail"))).toBe(true);
  });
});

test("without ffprobe a video gets no metadata and a warning, nothing throws", async () => {
  const path = join(tempDir(), "clip.mp4");
  writeFileSync(path, "whatever");
  const log = memLogger();
  expect(await probeVideo(path, "clip.mp4", { ffprobe: "no-such-ffprobe", ffmpeg: "no-such-ffmpeg" }, log)).toEqual({});
  expect(log.lines.some(l => l.startsWith("WARN") && l.includes("clip.mp4"))).toBe(true);
});
