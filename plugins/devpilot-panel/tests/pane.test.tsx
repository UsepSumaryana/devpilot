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
        { key: 'demo-abc123/api', name: 'api', status: 'running', mode: 'build', modes: ['default', 'build'], tasks: ['install'], port: 4510, url: 'http://localhost:4510', health: { state: 'ok', latencyMs: 2 }, cpu: 0.5, mem: 64 * 1048576, restarts: 0, openIncidents: 0 },
        { key: 'demo-abc123/worker', name: 'worker', status: 'crashed', health: { state: 'none' }, restarts: 2, exitCode: 1, lastError: 'Error: boom', openIncidents: 1 },
        { key: 'demo-abc123/web', name: 'web', status: 'stopped', queued: true, dependsOn: ['api'], health: { state: 'none' }, restarts: 0, openIncidents: 0 },
      ],
    },
  ],
}

const posts: string[] = []

const store: Record<string, unknown> = {}
const opens: string[] = []

function engine(on: any, { daemonUp, project = true, pref }: { daemonUp: boolean; project?: boolean; pref?: boolean }) {
  for (const k of Object.keys(store)) delete store[k]
  if (pref !== undefined) store.paneOpen = pref
  opens.length = 0
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
    const body = url.includes('/api/resolve') ? { workspace: 'demo-abc123' } : SUMMARY
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

