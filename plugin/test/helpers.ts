import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'net'

export function tempDir(prefix = 'tghub-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export async function waitFor<T>(
  pred: () => T | undefined | false | null | Promise<T | undefined | false | null>,
  timeoutMs = 3000,
  label = 'condition',
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await pred()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(20)
  }
}

export function memLogger() {
  const lines: string[] = []
  return {
    lines,
    info: (m: string) => void lines.push(`INFO ${m}`),
    warn: (m: string) => void lines.push(`WARN ${m}`),
    error: (m: string) => void lines.push(`ERROR ${m}`),
  }
}

// A raw WebSocket "plugin" for hub tests.
export async function wsClient(port: number, hello?: object) {
  const messages: any[] = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)))
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('ws connect failed'))
  })
  const client = {
    ws,
    messages,
    send: (o: object) => ws.send(JSON.stringify(o)),
    next: (pred: (m: any) => boolean, timeoutMs = 3000) => waitFor(() => messages.find(pred), timeoutMs, 'hub message'),
    close: () => ws.close(),
  }
  if (hello) client.send(hello)
  return client
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

export const hasFfmpeg = !!Bun.which('ffmpeg') && !!Bun.which('ffprobe')

// A real H.264 clip made by ffmpeg, like the screen recordings the hub sends.
export function makeVideo(path: string, o: { width?: number; height?: number; seconds?: number; rotation?: number } = {}): void {
  const size = `${o.width ?? 640}x${o.height ?? 360}`
  const args = ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=25:duration=${o.seconds ?? 3}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
  const plain = o.rotation ? `${path}.plain.mp4` : path
  const run = (a: string[]) => {
    const r = Bun.spawnSync(['ffmpeg', ...a], { stderr: 'pipe' })
    if (r.exitCode !== 0) throw new Error(`ffmpeg failed: ${r.stderr.toString()}`)
  }
  run([...args, plain])
  if (o.rotation) {
    run(['-v', 'error', '-nostdin', '-y', '-display_rotation', String(o.rotation), '-i', plain, '-c', 'copy', path])
    rmSync(plain)
  }
}
