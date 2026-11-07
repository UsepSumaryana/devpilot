import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'devpilot-panel',
  component: 'Pane',
  requestId: 'devpilot',
  props: { title: 'Services', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const SUMMARY = {
  version: '0.1.0',
  pid: 1,
  startedAt: 0,
  incidents: [],
  workspaces: [
    {
      id: 'demo-abc123',
      name: 'demo',
      envProfile: null,
      mode: 'default',
      modes: ['default', 'build'],
      tasks: ['install'],
      serviceTasks: ['install'],
      runningTasks: [],
      services: [
        { key: 'demo-abc123/api', name: 'api', status: 'running', cwd: 'D:\\work\\demo\\backend', run: 'node dist/main.js', runs: ['yarn start:dev', 'node dist/main.js'], startedAt: 1000, mode: 'build', modes: ['default', 'build'], tasks: ['install'], port: 4510, url: 'http://localhost:4510', health: { state: 'ok', latencyMs: 2 }, cpu: 0.5, mem: 64 * 1048576, restarts: 0, openIncidents: 0 },
        { key: 'demo-abc123/worker', name: 'worker', status: 'crashed', health: { state: 'none' }, restarts: 2, exitCode: 1, lastError: 'Error: boom', openIncidents: 1 },
        { key: 'demo-abc123/web', name: 'web', status: 'stopped', cwd: 'D:/work/demo/web', run: 'npm run dev', runs: ['npm run dev'], queued: true, dependsOn: ['api'], health: { state: 'none' }, restarts: 0, openIncidents: 0 },
      ],
    },
  ],
}

const posts: string[] = []
/** Incidents the daemon reports from the next poll on (the first poll only seeds what is already there). */
const liveIncidents: any[] = []
const placed: string[] = []
const submitted: string[] = []
const registeredTools: string[] = []

const store: Record<string, unknown> = {}
const opens: string[] = []

function engine(on: any, { daemonUp, project = true, pref }: { daemonUp: boolean; project?: boolean; pref?: boolean }) {
  for (const k of Object.keys(store)) delete store[k]
  if (pref !== undefined) store.paneOpen = pref
  opens.length = 0
  liveIncidents.length = 0
  placed.length = 0
  submitted.length = 0
  registeredTools.length = 0
  on('tool.register', (_: any, e: any) => {
    registeredTools.push(e.name)
    return { value: { tool: `mcp__devpilot-panel__${e.name}` } }
  })
  on('agent.list', () => ({ value: [{ id: 'diag-1', type: 'devpilot:diagnoser', description: 'why api is down', status: 'running' }] }))
  // The engine's own verdict beneath the plugin: DevPilot tools would be asked, the rest allowed.
  on('tool.check', (_: any, e: any) => ({ decision: String(e.tool).startsWith('mcp__devpilot-panel__') ? 'ask' : 'allow' }))
  on('ui.place', (_: any, e: any) => {
    placed.push(e.id)
    return { value: { isPlaced: true, requestId: `row-${e.id}` } }
  })
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }))
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('command.register', () => ({ value: {} }))
  on('ui.open', (_: any, e: any) => {
    opens.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: opens.map((id) => ({ id, title: 'Services', isShown: true, isFocused: false })) }))
  on('ui.close', (_: any, e: any) => {
    opens.splice(opens.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  // What the engine itself draws where the plugin hands the site on.
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('store.get', (_: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: any, e: any) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'D:/work/demo' }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // The tool itself, beneath the plugin: it ran.
  on('tool.call', () => ({ result: {} }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : undefined }))
  on('fs.read', (_: any, e: any) => {
    const path = String(e.path).replace(/\\/g, '/')
    if (path === 'D:/work/demo/devpilot.yaml') {
      if (project) return { value: 'services: {}' }
      throw new Error('ENOENT')
    }
    if (!daemonUp) throw new Error('ENOENT')
    if (path.endsWith('daemon.json')) return { value: JSON.stringify({ port: 47800, token: 't' }) }
    throw new Error('ENOENT')
  })
  on('http.fetch', (_: any, e: any) => {
    const url = String(e.url)
    if (e.init?.method === 'POST' || e.method === 'POST') posts.push(url.replace(/^https?:\/\/[^/]+/, ''))
    const body = url.includes('/api/resolve')
      ? { workspace: 'demo-abc123', key: url.includes('ref=web') ? 'demo-abc123/web' : 'demo-abc123/api' }
      : /\/api\/workspaces\/[^/]+\/metrics/.test(url)
        ? { range: '15m', step: 10000, points: [{ t: 1, cpu: 4, mem: 300 * 1048576 }, { t: 2, cpu: 9.5, mem: 320 * 1048576 }, { t: 3, cpu: 12.5, mem: 350 * 1048576 }] }
        : url.includes('/logs')
          ? { lines: [{ seq: 1, t: 1, stream: 'out', text: 'listening on 4510' }, { seq: 2, t: 2, stream: 'err', text: 'warn: slow query' }], lastSeq: 2 }
          : /\/api\/workspaces\/[^/]+\/tasks$/.test(url)
            ? { id: 't1', status: 'ok', exitCode: 0, logKey: 'demo-abc123/api', task: 'install' }
          : url.includes('/api/incidents?')
            ? liveIncidents
          : url.endsWith('/api/workspaces')
            ? [{ id: 'demo-abc123', name: 'demo' }, { id: 'other-1', name: 'other' }]
          : url.endsWith('/diagnose')
            ? {
                verdict: 'Dependency infra is stopped',
                findings: [{ level: 'info', title: 'Service is stopped', suggestion: 'devpilot start party' }, { level: 'warning', title: 'Dependency infra is stopped', suggestion: 'devpilot diagnose infra' }],
                lastIncident: { id: 'i1', title: 'crashed', context: Array.from({ length: 40 }, (_, n) => `ctx ${n}`) },
                errorBlock: Array.from({ length: 40 }, (_, n) => `err ${n}`),
                recentLogs: Array.from({ length: 40 }, (_, n) => `log ${n}`),
              }
          : url.endsWith('/api/ports')
            ? [{ port: 4510, pid: 42, name: 'node.exe', cmd: 'node dist/main.js', service: 'demo-abc123/api' }]
          : /\/(start|restart|stop)$/.test(url)
            ? { ok: true, key: 'demo-abc123/api', status: 'running' }
            : { ...SUMMARY, incidents: [...SUMMARY.incidents, ...liveIncidents] }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } }
  })
}

test('a refused command name does not stop the pane from opening', async ($, on) => {
  let opened = false
  const registered: string[] = []
  on('command.register', (_: any, e: any) => {
    if (e.name === 'services') throw new Error('a built-in name is refused')
    registered.push(e.name)
    return { value: {} }
  })
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true } }
  })
  on('fs.read', (_: any, e: any) => {
    if (String(e.path).replace(/\\/g, '/') === 'D:/work/demo/devpilot.yaml') return { value: 'services: {}' }
    throw new Error('ENOENT')
  })
  on('store.get', () => ({ value: true }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'D:/work/demo' }))
  on('clock.every', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  expect(opened).toBe(true)
  expect(registered).toContain('devpilot-panel')
  expect(registered).toContain('dp-services')
})

test('daemon down: the pane offers to start it', async ($, on) => {
  engine(on, { daemonUp: false })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'start-daemon' })).toBeTruthy()
  await ui.unmount()
})

test('daemon up: rows for each service, with the right actions', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^api$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'stop-demo-abc123/api' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'restart-demo-abc123/worker' })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'logs-demo-abc123/worker' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /worker has crashed|worker is crash-looping/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'ask-demo-abc123/worker' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Error: boom/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Exited with code 1 after 2 restarts/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^queued$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Button', key: 'dequeue-demo-abc123/web' })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /1 of 3 up/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^build$/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('actions ask first: Cancel sends nothing, Confirm sends the request', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  posts.length = 0

  await ui.press({ key: 'stop-demo-abc123/api' })
  expect(await ui.find({ type: 'Text', text: /^Stop api\?$/ })).toBeTruthy()
  expect(posts.filter((p) => p.includes('/stop'))).toHaveLength(0)

  await ui.press({ key: 'confirm-cancel' })
  expect(await ui.find({ type: 'Text', text: /^Stop api\?$/ })).toBeFalsy()
  expect(posts.filter((p) => p.includes('/stop'))).toHaveLength(0)

  await ui.press({ key: 'stop-demo-abc123/api' })
  await ui.press({ key: 'confirm-ok' })
  expect(posts.filter((p) => p.includes('/api/services/demo-abc123/api/stop'))).toHaveLength(1)
  await ui.unmount()
})

const BAND = { plugin: 'devpilot-panel', component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('a new session does not open the pane unless it was left open', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  expect(opens).toHaveLength(0)
})

test('the pane reopens when it was left open, in a DevPilot project only', async ($, on) => {
  engine(on, { daemonUp: true, pref: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  expect(opens).toEqual(['devpilot'])
})

test('outside a DevPilot project: no pane and no band, whatever was remembered', async ($, on) => {
  engine(on, { daemonUp: true, pref: true, project: false })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  expect(opens).toHaveLength(0)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', key: 'show-pane' })).toBeFalsy()
  await ui.unmount()
})

test('while hidden, the band opens the pane; closing it is remembered', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Button', key: 'show-pane' })).toBeTruthy()
  await band.press({ key: 'show-pane' })
  expect(opens).toEqual(['devpilot'])
  expect(store.paneOpen).toBe(true)
  expect(await band.find({ type: 'Button', key: 'show-pane' })).toBeFalsy()
  await band.unmount()

  // Hiding it (here through the plugin's own toggle) is remembered for the next sessions.
  await $.command.run({ command: 'services', args: '' })
  expect(opens).toHaveLength(0)
  expect(store.paneOpen).toBe(false)
})

test('/services toggles the pane', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const first = await $.command.run({ command: 'services', args: '' })
  expect(opens).toEqual(['devpilot'])
  expect(String((first as any).text)).toMatch(/opened/)
  const second = await $.command.run({ command: 'services', args: '' })
  expect(opens).toHaveLength(0)
  expect(String((second as any).text)).toMatch(/hidden/)
})


const BAND_ON = (surface: 'desktop' | 'terminal') => ({ plugin: 'devpilot-panel', component: 'AbovePrompt', props: { hasSurvey: false }, surface }) as const

test('Claude starting a running managed service by hand is refused, with the DevPilot command', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'cd backend && yarn start:dev' })
  expect(String(r.deny ?? r.text)).toMatch(/already runs "api"/)
  expect(String(r.deny ?? r.text)).toMatch(/mcp__devpilot-panel__restart \(service "demo-abc123\/api"\)/)
  // Same script through another package manager, from the project root with --prefix.
  const r2: any = await $.tool.call({ tool: 'Bash', command: 'npm --prefix backend run start:dev' })
  expect(String(r2.deny ?? r2.text)).toMatch(/already runs "api"/)
})

test('a stopped managed service: refused, pointing at devpilot start', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'cd /d/work/demo/web; yarn dev' })
  expect(String(r.deny ?? r.text)).toMatch(/mcp__devpilot-panel__start tool \(service "demo-abc123\/web"/)
})

test('other commands, and the same script in another folder, run as usual', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  for (const command of ['cd backend && yarn build', 'cd backend && yarn test', 'yarn start:dev', 'cd other && npm run dev', 'git status']) {
    const r: any = await $.tool.call({ tool: 'Bash', command })
    expect(r.deny ?? (r.isError ? r.text : undefined)).toBeUndefined()
  }
})

test('the daemon down: the guard stands aside', async ($, on) => {
  engine(on, { daemonUp: false })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'cd backend && yarn start:dev' })
  expect(r.deny ?? (r.isError ? r.text : undefined)).toBeUndefined()
})

test('an edit to a running service without a watcher offers a restart, asked first', async ($, on) => {
  engine(on, { daemonUp: true, pref: true }) // pane open: the band shows only the change
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const quiet = await $.ui.mount(BAND_ON(surface))
    expect(await quiet.find({ type: 'Button', key: 'restart-changed' })).toBeFalsy()
    await quiet.unmount()
  }
  await $.tool.call({ tool: 'Edit', file_path: 'D:\\work\\demo\\backend\\src\\app.service.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: 'D:/work/demo/backend/README.md', old_string: 'a', new_string: 'b' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const band = await $.ui.mount(BAND_ON(surface))
    expect(await band.find({ type: 'Text', text: /api: code changed since it started/ })).toBeTruthy()
    expect(await band.find({ type: 'Text', text: /^app\.service\.ts$/ })).toBeTruthy()
    await band.unmount()
  }
  const band = await $.ui.mount(BAND_ON('desktop'))
  posts.length = 0
  await band.press({ key: 'restart-changed' })
  expect(posts).toHaveLength(0) // asked first
  expect(await band.find({ type: 'Text', text: /Restart api\?/ })).toBeTruthy()
  await band.press({ key: 'restart-changed-ok' })
  expect(posts).toEqual(['/api/services/demo-abc123/api/restart'])
  expect(await band.find({ type: 'Button', key: 'restart-changed' })).toBeFalsy()
  await band.unmount()
})

test('edits outside a running service, or to a stopped one, change nothing; Dismiss clears', async ($, on) => {
  engine(on, { daemonUp: true, pref: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Write', file_path: 'D:/work/demo/web/src/main.ts', content: 'x' })
  await $.tool.call({ tool: 'Edit', file_path: 'D:/work/demo/docs/x.ts', old_string: 'a', new_string: 'b' })
  const band = await $.ui.mount(BAND_ON('desktop'))
  expect(await band.find({ type: 'Button', key: 'restart-changed' })).toBeFalsy()
  await band.unmount()
  await $.tool.call({ tool: 'Write', file_path: 'D:/work/demo/backend/src/a.ts', content: 'x' })
  const again = await $.ui.mount(BAND_ON('desktop'))
  await again.press({ key: 'dismiss-changed' })
  expect(await again.find({ type: 'Button', key: 'restart-changed' })).toBeFalsy()
  await again.unmount()
})

const CRASH = {
  id: 'inc_42',
  at: 5000,
  key: 'demo-abc123/worker',
  workspace: 'demo-abc123',
  service: 'worker',
  kind: 'crash',
  severity: 'error',
  title: 'crashed (exit code 1)',
  exitCode: 1,
  restart: 2,
  context: ['starting worker', '', 'TypeError: Cannot read properties of undefined', '    at main (worker.js:3:9)'],
  count: 1,
}
const CARD = (surface: 'desktop' | 'terminal') => ({ plugin: 'devpilot-panel', component: 'Placed', props: { id: 'inc-inc_42', plugin: 'devpilot-panel' }, surface }) as const

test('a new crash is placed as a card in the transcript; Diagnose asks Claude, Restart asks first', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  liveIncidents.push(CRASH)
  await $.command.run({ command: 'services', args: '' }) // opening the pane polls again
  expect(placed).toEqual(['inc-inc_42'])

  for (const surface of ['desktop', 'terminal'] as const) {
    const card = await $.ui.mount(CARD(surface))
    expect(await card.find({ type: 'Text', text: /worker: crashed \(exit code 1\)/ })).toBeTruthy()
    expect(await card.find({ type: 'Text', text: /exit code 1 · restart 2/ })).toBeTruthy()
    expect(await card.find({ type: 'Text', text: /TypeError: Cannot read properties/ })).toBeTruthy()
    expect(await card.find({ type: 'Button', key: 'card-logs-inc-inc_42' })).toBeTruthy()
    await card.unmount()
  }

  const card = await $.ui.mount(CARD('desktop'))
  await card.press({ key: 'card-diagnose-inc-inc_42' })
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toMatch(/devpilot:diagnoser agent/)
  expect(submitted[0]).toMatch(/mcp__devpilot-panel__diagnose/)
  expect(submitted[0]).toMatch(/don't change anything yet/)

  posts.length = 0
  await card.press({ key: 'card-restart-inc-inc_42' })
  expect(posts).toHaveLength(0)
  expect(await card.find({ type: 'Text', text: /Restart worker\?/ })).toBeTruthy()
  await card.press({ key: 'card-restart-ok-inc-inc_42' })
  expect(posts).toEqual(['/api/services/demo-abc123/worker/restart'])
  await card.unmount()
})

test('incidents already open when the session starts get no card; warnings stay toasts', async ($, on) => {
  engine(on, { daemonUp: true })
  liveIncidents.push(CRASH) // there before the first poll
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  liveIncidents.push({ ...CRASH, id: 'inc_43', severity: 'warning', kind: 'unhealthy', title: 'health check failing' })
  await $.command.run({ command: 'services', args: '' })
  expect(placed).toHaveLength(0)
})

const typed = (text: string) => ({ text, cursor: text.length, token: text.split(' ').pop()!, start: text.lastIndexOf(' ') + 1 })

test('typing a service-name prefix offers this project\u2019s services', async ($, on) => {
  engine(on, { daemonUp: true })
  on('prompt.autocomplete', () => ({ suggestions: [] }))
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'services', args: '' }) // a poll has finished, as long before anyone types
  const r: any = await $.prompt.autocomplete(typed('kenapa wo'))
  expect(r.suggestions).toEqual([{ text: 'worker', label: 'worker', description: 'DevPilot · demo · crashed' }])
  const api: any = await $.prompt.autocomplete(typed('restart #ap'))
  expect(api.suggestions[0]).toMatchObject({ text: 'api', description: 'DevPilot · demo · running · :4510' })
  // Too short, already complete, or no match: nothing added.
  for (const t of ['w', 'cek worker', 'zzz', 'a.b?c']) expect(((await $.prompt.autocomplete(typed(t))) as any).suggestions).toHaveLength(0)
})

const said = (r: any) => String(r.deny ?? (r.isError ? r.text : ''))

test('DevPilot tools: registered at start, reads answered from the daemon without a prompt', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  expect(registeredTools).toEqual(['status', 'logs', 'incidents', 'diagnose', 'metrics', 'env', 'ports', 'tasks', 'detect', 'open_dashboard', 'up', 'down', 'start', 'restart', 'stop', 'run_task', 'set_mode', 'set_env', 'clear_incidents', 'kill_port', 'register', 'unregister', 'daemon'])

  const st: any = await $.tool.call({ tool: 'mcp__devpilot-panel__status' } as any)
  expect(typeof st.result).toBe('string') // the model reads text
  expect(JSON.parse(st.result).workspaces[0].services.map((r: any) => r.name)).toEqual(['api', 'worker', 'web'])
  const logs: any = await $.tool.call({ tool: 'mcp__devpilot-panel__logs', service: 'api', tail: 20 } as any)
  expect(JSON.parse(logs.result).lines).toEqual(['listening on 4510', 'ERR warn: slow query'])

  posts.length = 0
  const started: any = await $.tool.call({ tool: 'mcp__devpilot-panel__restart', service: 'web' } as any)
  expect(JSON.parse(started.result).ok).toBe(true)
  expect(posts).toEqual(['/api/services/demo-abc123/web/restart'])

  expect((await $.tool.check({ tool: 'mcp__devpilot-panel__logs', input: { service: 'api' } } as any)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'mcp__devpilot-panel__start', input: { service: 'api' } } as any)).decision).toBe('ask')
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } } as any)).decision).toBe('allow')
})

test('DevPilot tools with the daemon down and nothing installed: a clear error', async ($, on) => {
  engine(on, { daemonUp: false })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  expect(said(await $.tool.call({ tool: 'mcp__devpilot-panel__status' } as any))).toMatch(/DevPilot is not set up on this machine/)
})

test('the diagnoser agent stays read-only', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'services', args: '' })
  const asAgent = (command: string) => $.tool.call({ tool: 'Bash', command, agentId: 'diag-1' } as any)
  for (const command of ['git log -5 --oneline -- src', 'cd backend && grep -rn timeout src 2>/dev/null']) {
    expect(said(await asAgent(command))).toBe('')
  }
  expect(said(await asAgent('devpilot restart api --wait --json'))).toMatch(/read-only/)
  expect(said(await asAgent('devpilot incidents clear'))).toMatch(/read-only/)
  expect(said(await asAgent('devpilot env api --reveal'))).toMatch(/read-only/)
  expect(said(await asAgent('cat backend/.env'))).toMatch(/\.env file/)
  expect(said(await asAgent('echo fix > src/a.ts'))).toMatch(/writes to a file/)
  expect(said(await asAgent('yarn install'))).toMatch(/read-only/)
  expect(said(await $.tool.call({ tool: 'mcp__devpilot-panel__restart', service: 'api', agentId: 'diag-1' } as any))).toMatch(/read-only/)
  // The main loop is not the agent: the same command passes the read-only check.
  expect(said(await $.tool.call({ tool: 'Bash', command: 'yarn install' }))).toBe('')
})

test('the pane charts the workspace CPU and memory of the last 15 minutes', async ($, on) => {
  engine(on, { daemonUp: true, pref: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'services', args: '' }) // hidden
  await $.command.run({ command: 'services', args: '' }) // shown again: polls with the pane open
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /RESOURCES · 15 MIN/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^12\.5%$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^350 MB$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Top: api 1% · 64 MB/ })).toBeTruthy()
    // A chart where the surface draws Svg, block characters where it does not.
    const svgs = await ui.findAll({ type: 'Svg' })
    const chart = svgs.some((x) => x.props.alt === 'CPU 12.5%') || !!(await ui.find({ type: 'Text', text: /^[▁▂▃▄▅▆▇█]{3}$/ }))
    expect(chart).toBe(true)
    await ui.unmount()
  }
})

test('the devpilot CLI through Bash is refused, naming the tool to use', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const cases: [string, string][] = [
    ['devpilot logs api -n 50 --json', 'logs'],
    ['cd backend && devpilot task run install api', 'run_task'],
    ['devpilot task --json', 'tasks'],
    ['devpilot status --json', 'status'],
    ['devpilot mode use build --restart', 'set_mode'],
    ['devpilot incidents clear', 'clear_incidents'],
    ['npx devpilot up --wait', 'up'],
    ['devpilot.cmd ports kill 3000 --force', 'kill_port'],
  ]
  for (const [command, tool] of cases) expect(said(await $.tool.call({ tool: 'Bash', command }))).toMatch(new RegExp(`use mcp__devpilot-panel__${tool} for`))
  for (const command of ['devpilot help config', 'devpilot import-jsrunner', 'echo devpilot status']) expect(said(await $.tool.call({ tool: 'Bash', command }))).toBe('')
})

test('DevPilot tools: up, run_task (waits in the daemon) and kill_port (only the agreed pid)', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  posts.length = 0
  await $.tool.call({ tool: 'mcp__devpilot-panel__up', profile: 'backend' } as any)
  expect(posts).toEqual(['/api/workspaces/demo-abc123/up'])

  const task: any = await $.tool.call({ tool: 'mcp__devpilot-panel__run_task', task: 'install', service: 'api' } as any)
  expect(JSON.parse(task.result)).toMatchObject({ status: 'ok', exitCode: 0, output: ['listening on 4510', 'warn: slow query'] })

  expect(said(await $.tool.call({ tool: 'mcp__devpilot-panel__kill_port', port: 4510, pid: 41 } as any))).toMatch(/held by pid 42 \(node\.exe/)
  expect(said(await $.tool.call({ tool: 'mcp__devpilot-panel__kill_port', port: 9999, pid: 1 } as any))).toMatch(/Nothing listens on port 9999/)
  posts.length = 0
  await $.tool.call({ tool: 'mcp__devpilot-panel__kill_port', port: 4510, pid: 42 } as any)
  expect(posts).toEqual(['/api/ports/4510/kill'])
})

test('tool answers stay small, and daemon suggestions name tools, not the CLI', async ($, on) => {
  engine(on, { daemonUp: true })
  liveIncidents.push({ ...CRASH, context: Array.from({ length: 40 }, (_, n) => `line ${n}`) })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  const st = JSON.parse(((await $.tool.call({ tool: 'mcp__devpilot-panel__status' } as any)) as any).result)
  expect(st.incidents[0].context).toBeUndefined()
  expect(st.workspaces[0].services[0]).toMatchObject({ name: 'api', health: 'ok', memMb: 64 })
  const inc = JSON.parse(((await $.tool.call({ tool: 'mcp__devpilot-panel__incidents', service: 'worker' } as any)) as any).result)
  expect(inc[0].context).toHaveLength(15)
  const dg = JSON.parse(((await $.tool.call({ tool: 'mcp__devpilot-panel__diagnose', service: 'api' } as any)) as any).result)
  expect(dg.findings.map((f: any) => f.suggestion)).toEqual(['mcp__devpilot-panel__start (party)', 'mcp__devpilot-panel__diagnose (infra)'])
  expect(dg.errorBlock).toHaveLength(30)
  expect(dg.recentLogs).toHaveLength(15)
  expect(dg.lastIncident.context).toBeUndefined()
})

test('workspace tools take a workspace by name or id from any folder', async ($, on) => {
  engine(on, { daemonUp: true })
  await $.session.start({ cwd: 'D:/work/demo', surface: 'desktop', isInteractive: true })
  posts.length = 0
  await $.tool.call({ tool: 'mcp__devpilot-panel__down', workspace: 'other' } as any)
  expect(posts).toEqual(['/api/workspaces/other-1/down'])
  posts.length = 0
  await $.tool.call({ tool: 'mcp__devpilot-panel__up', workspace: 'demo-abc123', services: ['api'] } as any)
  expect(posts).toEqual(['/api/workspaces/demo-abc123/up'])
  expect(said(await $.tool.call({ tool: 'mcp__devpilot-panel__tasks', workspace: 'nope' } as any))).toMatch(/No workspace "nope"\. Registered: demo \(demo-abc123\), other \(other-1\)/)
})
