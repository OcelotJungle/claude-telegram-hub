import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { HubClient, spawnHubDetached } from '../src/plugin/hubClient.ts'
import { PROTOCOL_VERSION, type HubToPlugin } from '../src/shared/protocol.ts'
import { FakeTelegram } from './fakeTelegram.ts'
import { freePort, memLogger, tempDir, waitFor } from './helpers.ts'

const HUB_MAIN = resolve(import.meta.dir, '../src/hub/main.ts')
const GROUP = '-1001'

let fake: FakeTelegram
let port: number
let env: Record<string, string>
const clients: HubClient[] = []

async function health(): Promise<{ pid: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    return (await res.json()) as { pid: number }
  } catch {
    return undefined
  }
}

function client(sessionId: string) {
  const messages: HubToPlugin[] = []
  const c = new HubClient({
    port,
    hello: () => ({ type: 'hello', v: PROTOCOL_VERSION, windowKey: `win-${sessionId}`, sessionId, cwd: 'C:\\work\\proj' }),
    spawnHub: () => spawnHubDetached(HUB_MAIN, env),
    onMessage: m => messages.push(m),
    log: memLogger(),
    minDelayMs: 50,
    maxDelayMs: 300,
  })
  clients.push(c)
  return { c, messages }
}

beforeEach(async () => {
  fake = new FakeTelegram()
  port = await freePort()
  const stateDir = tempDir()
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ groupId: GROUP, allowFrom: ['1'] }))
  env = {
    TG_HUB_STATE_DIR: stateDir,
    TG_HUB_PORT: String(port),
    TG_HUB_API_BASE: fake.url,
    TELEGRAM_BOT_TOKEN: fake.token,
    TG_HUB_IDLE_MS: '1500',
    TG_HUB_POLL_TIMEOUT: '1',
  }
})

afterEach(async () => {
  for (const c of clients.splice(0)) c.stop()
  const h = await health()
  if (h) {
    try {
      process.kill(h.pid)
    } catch {}
  }
  fake.stop()
})

describe('hub election', () => {
  test('two plugins starting together share exactly one hub', async () => {
    const a = client('a')
    const b = client('b')
    a.c.start()
    b.c.start()
    await waitFor(() => a.c.connected && b.c.connected, 10_000, 'both connected')
    const first = await health()
    expect(first?.pid).toBeGreaterThan(0)
    await Bun.sleep(2500)
    expect((await health())?.pid).toBe(first!.pid)
    expect(fake.conflicts).toBe(0)
  }, 20_000)

  test('a killed hub is replaced and plugins reconnect', async () => {
    const a = client('a')
    const b = client('b')
    a.c.start()
    b.c.start()
    await waitFor(() => a.c.connected && b.c.connected, 10_000, 'both connected')
    const old = (await health())!.pid
    process.kill(old)
    await waitFor(async () => {
      const h = await health()
      return h && h.pid !== old && a.c.connected && b.c.connected
    }, 10_000, 'new hub')
  }, 20_000)

  test('text queued while the hub is dead arrives once, in order, after reconnect', async () => {
    const a = client('a')
    a.c.start()
    await waitFor(() => a.c.connected, 10_000, 'connected')
    expect(await a.c.request('enable', { title: 'T' })).toMatchObject({ created: true })
    const old = (await health())!.pid
    process.kill(old)
    await waitFor(() => !a.c.connected, 5000, 'disconnect')
    a.c.enqueue('a', 'first', false)
    a.c.enqueue('a', 'second', true)
    await waitFor(() => fake.texts().length >= 2, 10_000, 'messages delivered')
    await Bun.sleep(300)
    expect(fake.texts().map(p => [p.text, p.disable_notification])).toEqual([
      ['first', true],
      ['second', false],
    ])
  }, 20_000)

  // A real hub process killed with text it acked but Telegram never got.
  test('text a killed hub had queued is sent by the next hub', async () => {
    const a = client('a')
    a.c.start()
    await waitFor(() => a.c.connected, 10_000, 'connected')
    await a.c.request('enable', { title: 'T' })
    fake.hangNext('sendRichMessage', 1000)
    a.c.enqueue('a', 'in the queue', true)
    await waitFor(() => a.c.unacked.length === 0, 5000, 'acked')
    const old = (await health())!.pid
    process.kill(old)
    fake.clearHangs()
    const queue = join(env.TG_HUB_STATE_DIR!, 'outbox.json')
    await waitFor(() => JSON.parse(readFileSync(queue, 'utf8')).items.length === 0, 15_000, 'delivered by the next hub')
    expect(fake.texts().filter(p => p.text === 'in the queue').length).toBeGreaterThanOrEqual(2)
    expect((await health())!.pid).not.toBe(old)
  }, 30_000)

  test('the hub exits after the last plugin stops', async () => {
    const a = client('a')
    a.c.start()
    await waitFor(() => a.c.connected, 10_000, 'connected')
    a.c.stop()
    await waitFor(async () => !(await health()), 5000, 'hub exit')
  }, 20_000)

  test('a request while the hub is unreachable rejects after its timeout', async () => {
    const a = client('a')
    // never started: no connection at all
    await expect(a.c.request('disable', {}, 200)).rejects.toThrow(/hub/)
  })
})
