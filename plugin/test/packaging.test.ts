import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, resolve } from 'path'
import { Hub } from '../src/hub/hub.ts'
import { HOOK_NOTE_TOOL } from '../src/plugin/plugin.ts'
import { PROTOCOL_VERSION } from '../src/shared/protocol.ts'
import { freePort, memLogger, tempDir, waitFor, wsClient } from './helpers.ts'

const PLUGIN = resolve(import.meta.dir, '..')
const REPO = resolve(PLUGIN, '..')
const HOOK = join(PLUGIN, 'src', 'hook', 'session-start.ts')

// Async on purpose: an in-process hub must keep serving while the hook runs.
async function runHook(port: number, input: object, socket = 'pipe-H') {
  const started = Date.now()
  const proc = Bun.spawn([process.execPath, HOOK], {
    stdin: new Blob([JSON.stringify(input)]),
    stdout: 'pipe',
    env: { ...process.env, TG_HUB_PORT: String(port), CLAUDE_CODE_MESSAGING_SOCKET: socket },
  })
  const stdout = await new Response(proc.stdout).text()
  const status = await proc.exited
  return { status, stdout, ms: Date.now() - started }
}

describe('SessionStart hook', () => {
  let hub: Hub | undefined
  const clients: { close(): void }[] = []
  afterEach(async () => {
    for (const c of clients.splice(0)) c.close()
    await hub?.stop()
  })

  test('tells the hub which session the window now runs', async () => {
    const port = await freePort()
    const dir = tempDir()
    hub = new Hub({ port, sessionsFile: join(dir, 's.json'), outboxFile: join(dir, 'o.json'), filesDir: join(dir, 'files'), inboxDir: dir, api: undefined, config: () => ({ allowFrom: [] }), idleMs: 60_000, log: memLogger(), onExit() {} })
    hub.start()
    const c = await wsClient(port, { type: 'hello', v: PROTOCOL_VERSION, windowKey: 'pipe-H', sessionId: 'old', cwd: 'C:\\p' })
    clients.push(c)
    const r = await runHook(port, { session_id: 'new', transcript_path: 'C:\\t\\new.jsonl', cwd: 'C:\\p', hook_event_name: 'SessionStart', source: 'clear' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    const sw = await c.next(m => m.type === 'switchSession')
    expect(sw).toMatchObject({ sessionId: 'new', transcriptPath: 'C:\\t\\new.jsonl' })
  })

  test('exits quietly and quickly when no hub is running', async () => {
    const port = await freePort()
    const r = await runHook(port, { session_id: 's', transcript_path: 't', cwd: 'c' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.ms).toBeLessThan(3000)
  })

  test('survives garbage input', async () => {
    const port = await freePort()
    const r = spawnSync(process.execPath, [HOOK], { input: 'not json', env: { ...process.env, TG_HUB_PORT: String(port) }, encoding: 'utf8' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('plugin packaging', () => {
  const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'))

  test('marketplace lists the plugin directory', () => {
    const m = json(join(REPO, '.claude-plugin', 'marketplace.json'))
    expect(m.name).toBe('tg-hub-local')
    const entry = m.plugins.find((p: any) => p.name === 'tg-hub')
    expect(existsSync(join(REPO, entry.source, '.claude-plugin', 'plugin.json'))).toBe(true)
  })

  test('plugin manifest, MCP server and hook point at real files', () => {
    expect(json(join(PLUGIN, '.claude-plugin', 'plugin.json')).name).toBe('tg-hub')
    const mcp = json(join(PLUGIN, '.mcp.json'))
    expect(mcp.mcpServers['tg-hub'].command).toBe('bun')
    const pkg = json(join(PLUGIN, 'package.json'))
    expect(pkg.scripts.start).toContain('src/plugin/main.ts')
    expect(existsSync(join(PLUGIN, 'src', 'plugin', 'main.ts'))).toBe(true)
    const hooks = json(join(PLUGIN, 'hooks', 'hooks.json'))
    const cmd: string = hooks.hooks.SessionStart[0].hooks[0].command
    expect(cmd).toContain('src/hook/session-start.ts')
    expect(existsSync(HOOK)).toBe(true)
    // The function hooks module that runs commands from the topic.
    expect(hooks.modules).toEqual(['../src/mod/register.ts'])
    expect(existsSync(join(PLUGIN, 'hooks', hooks.modules[0]))).toBe(true)
  })

  // The note that the mode went off reaches the agent through our own server.
  test('the PostToolBatch hook calls the note tool of the plugin server, main agent only', () => {
    const hooks = json(join(PLUGIN, 'hooks', 'hooks.json'))
    const pluginName = json(join(PLUGIN, '.claude-plugin', 'plugin.json')).name
    const serverKey = Object.keys(json(join(PLUGIN, '.mcp.json')).mcpServers)[0]
    expect(hooks.hooks.PostToolBatch[0].hooks[0]).toMatchObject({
      type: 'mcp_tool',
      server: `plugin:${pluginName}:${serverKey}`,
      tool: HOOK_NOTE_TOOL,
      input: { agent_id: '${agent_id}' },
    })
    expect(hooks.hooks.UserPromptSubmit).toBeUndefined()
  })
})

const ps = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
const hasPowerShell = ps.status === 0

describe.skipIf(!hasPowerShell)('PowerShell wrappers', () => {
  const script = join(REPO, 'scripts', 'tg-hub-profile.ps1')
  function args(fn: string, list: string[]): string {
    const quoted = list.map(a => `'${a.replace(/'/g, "''")}'`).join(',')
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `$global:TgHubClaudeExe='x'; $global:TgHubCswapExe='y'; . '${script}'; (${fn} @(${quoted})) -join '|'`],
      { encoding: 'utf8' },
    )
    if (r.status !== 0) throw new Error(r.stderr)
    return r.stdout.trim()
  }
  const CH = '--dangerously-load-development-channels|plugin:tg-hub@tg-hub-local'

  test('claude gets the channel flag for interactive sessions', () => {
    expect(args('Get-TgHubClaudeArgs', [])).toBe(CH)
    expect(args('Get-TgHubClaudeArgs', ['--resume', 'abc'])).toBe(`${CH}|--resume|abc`)
  })

  test('claude subcommands and print mode are left alone', () => {
    expect(args('Get-TgHubClaudeArgs', ['mcp', 'list'])).toBe('mcp|list')
    expect(args('Get-TgHubClaudeArgs', ['-p', 'hi'])).toBe('-p|hi')
    expect(args('Get-TgHubClaudeArgs', ['--version'])).toBe('--version')
  })

  test('cswap run gets the flag after --', () => {
    expect(args('Get-TgHubCswapArgs', ['run', '2'])).toBe(`run|2|--|${CH}`)
    expect(args('Get-TgHubCswapArgs', ['run', '2', '--', '--resume'])).toBe(`run|2|--|${CH}|--resume`)
  })

  test('other cswap commands pass through', () => {
    expect(args('Get-TgHubCswapArgs', ['list'])).toBe('list')
    expect(args('Get-TgHubCswapArgs', ['run', '2', '--', '-p', 'x'])).toBe('run|2|--|-p|x')
  })
})
