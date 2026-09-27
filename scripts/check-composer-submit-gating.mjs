#!/usr/bin/env node
/**
 * Behavioral check for the panel composer's submit gate.
 *
 * The repo has no test suite, so this bundles the REAL `panel/main.ts` (and with
 * it the whole panel composition: conversation, region, session selector, slash
 * catalog) with the same esbuild resolution order as `packages/extension/build.sh`,
 * then drives it headlessly through a stub DOM and a stub panel port. It asserts
 * every decidable scenario in
 * `openspec/changes/panel-composer-submit-gating/specs/panel-composer-submit-gating/`.
 *
 * Two properties make this possible without a browser:
 * - `main.ts` is the composition root, so importing it wires the real feature
 *   modules exactly as the side panel does — including the click/keydown handlers
 *   on the composer, which the stub DOM records and this check fires.
 * - the busy gate lives in module state, so each case imports a FRESH copy of the
 *   bundle (a distinct file per case defeats Node's module cache). Cases therefore
 *   cannot leak a half-finished turn into each other.
 *
 * Usage: pnpm check:composer   (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'composer-submit-gating')

function resolveEsbuild() {
  const candidates = [
    process.env.ESBUILD,
    join(repoRoot, 'packages/extension/node_modules/.bin/esbuild'),
    join(repoRoot, 'packages/bridge-dsh/node_modules/.bin/esbuild'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('error: esbuild not found (run pnpm install, or set ESBUILD)')
    process.exit(1)
  }
  return found
}

/** Bundle one fresh copy of the panel composition root for Node. */
let bundleSeq = 0
function buildPanel() {
  const outfile = join(outDir, `panel-${++bundleSeq}.mjs`)
  const result = spawnSync(resolveEsbuild(), [
    join(repoRoot, 'packages/extension/src/panel/main.ts'),
    '--bundle', '--platform=node', '--format=esm', '--target=node22',
    `--outfile=${outfile}`,
    `--alias:@dsh-browser/protocol=${join(repoRoot, 'packages/protocol/src/index.ts')}`,
    // The real DOMPurify cannot initialize without a browser DOM (see the stub).
    `--alias:dompurify=${join(repoRoot, 'scripts/stubs/dompurify.mjs')}`,
    '--log-level=error',
  ], { cwd: repoRoot, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
  return outfile
}

mkdirSync(outDir, { recursive: true })

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

// ---------------------------------------------------------------------------
// Harness. Everything below the DOM/port stubs is written against the panel's
// real public surface: outbound frames, inbound server frames, and the composer.
// ---------------------------------------------------------------------------

/**
 * Minimal DOM. Only what the panel composition actually touches is implemented;
 * `classList` and `children` are stateful because the gate's rendering and the
 * region attachment both assert on them.
 */
function makeNode(tag = 'div', id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id,
    children: [],
    parent: null,
    dataset: {},
    style: {},
    attributes: {},
    textContent: '',
    innerHTML: '',
    title: '',
    value: '',
    checked: false,
    disabled: false,
    src: '',
    scrollTop: 0,
    scrollHeight: 0,
    _classes: new Set(),
    addEventListener(type, fn) { (el._listeners[type] ??= []).push(fn) },
    _listeners: {},
    appendChild(child) {
      const at = el.children.indexOf(child)
      if (at >= 0) el.children.splice(at, 1)
      child.parent = el
      el.children.push(child)
      return child
    },
    append(child) { el.appendChild(child) },
    insertBefore(child, before) {
      const at = before === null ? -1 : el.children.indexOf(before)
      if (at < 0) return el.appendChild(child)
      child.parent = el
      el.children.splice(at, 0, child)
      return child
    },
    removeChild(child) {
      const at = el.children.indexOf(child)
      if (at >= 0) el.children.splice(at, 1)
      return child
    },
    remove() { if (el.parent !== null) el.parent.removeChild(el) },
    replaceChildren(...nodes) {
      for (const node of el.children) node.parent = null
      el.children = []
      for (const node of nodes) el.appendChild(node)
    },
    contains(child) {
      return el.children.some((c) => c === child || (typeof c.contains === 'function' && c.contains(child)))
    },
    setAttribute(key, val) { el.attributes[key] = val; el[key] = val },
    focus() {},
    scrollIntoView() {},
    querySelector(selector) {
      if (selector.startsWith('.')) {
        return el.children.find((c) => c._classes?.has(selector.slice(1))) ?? null
      }
      if (selector.endsWith(':last-child')) {
        const tag = selector.slice(0, -':last-child'.length).toUpperCase()
        for (let i = el.children.length - 1; i >= 0; i -= 1) {
          if (el.children[i].tagName === tag) return el.children[i]
        }
        return null
      }
      return el.children.find((c) => c.tagName === selector.toUpperCase()) ?? null
    },
  }
  Object.defineProperty(el, 'firstChild', { get: () => el.children[0] ?? null })
  Object.defineProperty(el, 'className', {
    get: () => [...el._classes].join(' '),
    set: (v) => { el._classes = new Set(String(v).split(/\s+/).filter(Boolean)) },
  })
  el.classList = {
    add: (...cs) => { for (const c of cs) el._classes.add(c) },
    remove: (...cs) => { for (const c of cs) el._classes.delete(c) },
    toggle: (c, force) => {
      const on = force === undefined ? !el._classes.has(c) : force
      if (on) el._classes.add(c); else el._classes.delete(c)
      return on
    },
    contains: (c) => el._classes.has(c),
  }
  return el
}

/** A `setInterval` that never keeps the process alive and is clearable. */
function installFakeClock() {
  const timers = new Map()
  let seq = 0
  globalThis.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id }
  globalThis.clearInterval = (id) => { timers.delete(id) }
  return timers
}

/** Fresh stub document; the panel reads `document` at module load, so this must
 * be replaced BEFORE importing a bundle copy. */
function installDocument() {
  const nodes = new Map()
  const doc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode('div', id))
      return nodes.get(id)
    },
    createElement: (tag) => makeNode(tag),
    addEventListener() {},
  }
  globalThis.document = doc
  globalThis.Node = class {}
  globalThis.window = globalThis
  return nodes
}

/** Fresh stub panel port; `sent` collects every outbound frame. */
function installChrome() {
  const ports = []
  globalThis.chrome = {
    runtime: {
      connect: () => {
        const record = { sent: [], inbound: null }
        ports.push(record)
        return {
          onMessage: { addListener: (fn) => { record.inbound = fn } },
          onDisconnect: { addListener() {} },
          postMessage: (message) => { record.sent.push(message) },
        }
      },
    },
    i18n: { getUILanguage: () => 'zh-CN' },
  }
  return ports
}

/** Load one isolated panel instance. Returns its handles and message helpers. */
async function loadPanel() {
  installFakeClock()
  const nodes = installDocument()
  const ports = installChrome()
  await import(pathToFileURL(buildPanel()).href)
  const port = ports[0]
  if (port === undefined || port.inbound === null) {
    console.error('error: the panel did not open a port on load')
    process.exit(1)
  }
  const sendBtn = nodes.get('sendBtn')
  const inputEl = nodes.get('input')
  const attachmentEl = nodes.get('attachment')
  const inbound = (message) => { port.inbound(message) }
  const rpcCalls = (method) => port.sent.filter((m) => m.type === 'rpc' && m.method === method)
  /** Settle the most recent unanswered call of `method` and await two turns. */
  const answer = async (method, result) => {
    const call = rpcCalls(method).at(-1)
    if (call === undefined) throw new Error(`no ${method} call was sent`)
    inbound({ type: 'rpc.result', id: call.id, ok: true, result: { result: { ok: true, value: result } } })
    await settle()
  }
  // The outer `type` is what routes the frame on the panel port; `t: 'event'`
  // alone is not enough (the background sends both).
  const sessionEvent = (sessionId, event) => inbound({
    type: 'event',
    t: 'event',
    frame: { method: 'session/event', payload: { sessionId, event } },
  })
  const bridgeStatus = (state) => inbound(statusFrame(state))
  /** Fire a real click on the composer's send button. */
  const clickSend = () => {
    for (const fn of sendBtn._listeners.click ?? []) fn({})
  }
  /** Fire a real Enter keydown on the composer's input. */
  const pressEnter = () => {
    const listeners = inputEl._listeners.keydown ?? []
    const event = { key: 'Enter', shiftKey: false, defaultPrevented: false, preventDefault() {} }
    // Indexed loop on purpose: `for...of` over this array dispatched nothing,
    // which silently turned an Enter assertion into a no-op.
    for (let i = 0; i < listeners.length; i += 1) listeners[i](event)
  }
  return {
    port, sendBtn, inputEl, attachmentEl, nodes, inbound, rpcCalls, answer,
    sessionEvent, bridgeStatus, clickSend, pressEnter,
    type: (text) => { inputEl.value = text },
  }
}

/** Let queued microtasks (and the awaited RPC chain) run. */
async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}

/**
 * A status frame with the shape the background broadcasts. `connected` is the
 * panel's real steady state: the side panel only exists once the bridge is up,
 * and the slash catalog refuses to load until this has been seen.
 */
function statusFrame(state) {
  return {
    type: 'status',
    state,
    url: 'ws://127.0.0.1:3080/ext/bridge',
    attempt: 0,
    activePage: null,
    settings: { host: '', token: '', sharePageContent: 'auto', loopback: true },
  }
}

const SESSION = 'sess-1'
const CREATE_ANSWER = { sessionId: SESSION }
const COMMANDS_ANSWER = [{ name: 'compact', description: '压缩会话上下文' }]
/**
 * The panel reads commands and skills with `Promise.all`, so BOTH must be
 * answered before the catalog can settle — a skills read left in flight keeps
 * the whole catalog pending forever, exactly as a silent bridge would.
 */
const SKILLS_ANSWER = { skills: [] }

/** Answer both catalog reads (order-independent) if they are outstanding. */
async function answerCatalog(p) {
  if (p.rpcCalls('commands.list').length > 0) await p.answer('commands.list', COMMANDS_ANSWER)
  if (p.rpcCalls('skills.list').length > 0) await p.answer('skills.list', SKILLS_ANSWER)
}

/**
 * Drive a panel to the "bound session, idle" starting point every case needs:
 * the bridge connected, one text submission, its `session.create` answered, the
 * prompt admitted and the catalog read complete, then the turn closed.
 *
 * There is deliberately NO history read on this path: a first send binds the
 * session dsh just created, and only a session PICKED from the list is replayed
 * (see `openSession` in main.ts). The reconnect cases below are what exercise the
 * replay window.
 *
 * @returns the bound session id.
 */
async function bootBoundSession(p) {
  // The panel's steady state: the bridge is connected before the user can type.
  p.bridgeStatus('connected')
  await settle()
  p.type('第一条')
  p.clickSend()
  await settle()
  await p.answer('session.create', CREATE_ANSWER)
  await answerCatalog(p)
  // The prompt was admitted; the turn then completes, which is what returns the
  // panel to the idle state the assertions start from.
  p.sessionEvent(SESSION, { type: 'turn/end', data: { turn: 1 }, seq: 9 })
  await settle()
  return SESSION
}







// ---------------------------------------------------------------------------
// Requirement: 回复中禁止提交
// ---------------------------------------------------------------------------

{
  const p = await loadPanel()
  await bootBoundSession(p)
  check('初始状态：发送按钮可用', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)

  p.sessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 }, seq: 8 })
  check('turn/start → 发送按钮禁用', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  // 多步 turn：文本增量、工具调用、assistant 消息都不得放开闸门。
  p.sessionEvent(SESSION, { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '中间输出' } } })
  p.sessionEvent(SESSION, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '调用工具前' }] } } })
  p.sessionEvent(SESSION, { type: 'assistant/chunk', data: { chunk: { type: 'tool-call-delta', text: '' } } })
  check('多步 turn 中途不放开闸门', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  p.sessionEvent(SESSION, { type: 'turn/end', data: { turn: 1 }, seq: 9 })
  check('turn/end → 发送按钮恢复可用', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)

  // 闸门放开的完整含义不只是「按钮可点」：下一次提交必须真的发出请求。
  // 少了这一条，「守卫把闸门关死」这种反向缺陷会漏网。
  const promptsBefore = p.rpcCalls('session.prompt').length
  p.type('turn 结束后这一条应该发出去')
  p.pressEnter()
  await settle()
  check(
    'turn/end 后下一次提交正常产生 session.prompt',
    p.rpcCalls('session.prompt').length === promptsBefore + 1,
    `prompt 调用数 ${promptsBefore} → ${p.rpcCalls('session.prompt').length}`,
  )
}

// ---------------------------------------------------------------------------
// Requirement: 提交入口的忙态守卫（忙态下两条手势都不提交）
// ---------------------------------------------------------------------------

{
  const p = await loadPanel()
  await bootBoundSession(p)
  const before = p.rpcCalls('session.prompt').length
  p.sessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 }, seq: 8 })

  p.type('回复中再发一条')
  p.clickSend()
  check('忙态点击发送：按钮禁用使其不触发', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  // Enter 是独立手势：按钮禁用不会替它兜底，全靠 send() 的同步守卫。
  p.pressEnter()
  await settle()
  check(
    '忙态按 Enter：不产生第二次 session.prompt',
    p.rpcCalls('session.prompt').length === before,
    `prompt 调用数 ${before} → ${p.rpcCalls('session.prompt').length}`,
  )
  check('被拒绝的草稿不被清空', p.inputEl.value === '回复中再发一条', `value=${JSON.stringify(p.inputEl.value)}`)
}

// ---------------------------------------------------------------------------
// Requirement: 闸门只约束提交（命令路径不被误伤 + 输入框仍可编辑）
// ---------------------------------------------------------------------------

{
  const p = await loadPanel()
  await bootBoundSession(p)
  p.sessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 }, seq: 8 })
  const promptsBefore = p.rpcCalls('session.prompt').length

  p.type('/compact')
  p.clickSend()
  await settle()
  check(
    '忙态下斜杠命令仍可执行',
    p.rpcCalls('commands.execute').length === 1,
    `commands.execute 调用数 ${p.rpcCalls('commands.execute').length}`,
  )
  check(
    '命令路径不产生 session.prompt',
    p.rpcCalls('session.prompt').length === promptsBefore,
    `prompt 调用数 ${promptsBefore} → ${p.rpcCalls('session.prompt').length}`,
  )
  check('禁用期间输入框未被禁用', p.inputEl.disabled === false, `input.disabled=${p.inputEl.disabled}`)
}

// ---------------------------------------------------------------------------
// Requirement: 提交入口的忙态守卫（冷会话创建窗口）
// ---------------------------------------------------------------------------

{
  const p = await loadPanel()
  p.bridgeStatus('connected')
  await settle()
  p.type('冷会话第一条')
  p.clickSend()
  await settle()
  check('冷会话提交产生一次会话创建', p.rpcCalls('session.create').length === 1, `create=${p.rpcCalls('session.create').length}`)

  // 会话创建尚未应答，此间再提交一次：不得再要点一次会话，也不得补发 prompt。
  p.type('窗口内第二条')
  p.clickSend()
  await settle()
  check('创建窗口内不重复创建会话', p.rpcCalls('session.create').length === 1, `create=${p.rpcCalls('session.create').length}`)

  await p.answer('session.create', CREATE_ANSWER)
  await settle()
  check(
    '创建窗口内不产生第二次 session.prompt',
    p.rpcCalls('session.prompt').length === 1,
    `prompt 调用数 ${p.rpcCalls('session.prompt').length}`,
  )
}

// ---------------------------------------------------------------------------
// Requirement: 提交入口的忙态守卫（框选路径）＋ 闸门只约束提交（附件仍可移除）
// ---------------------------------------------------------------------------

{
  const p = await loadPanel()
  await bootBoundSession(p)
  const promptsBefore = p.rpcCalls('session.prompt').length

  p.inbound({
    type: 'region.result',
    result: { ok: true, screenshot: { mediaType: 'image/png', data: 'AAAA' }, elements: [] },
  })
  check('选区截图成为待发送附件', p.attachmentEl._classes.has('show'), `class=${p.attachmentEl.className}`)

  p.sessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 }, seq: 8 })
  p.type('描述这个区域')
  p.clickSend()
  await settle()
  check('忙态下框选提交被拒', p.rpcCalls('session.prompt').length === promptsBefore, `prompt 调用数 ${p.rpcCalls('session.prompt').length}`)
  check('被拒的框选附件保持待发送', p.attachmentEl._classes.has('show'), `class=${p.attachmentEl.className}`)

  // 闸门只约束提交：回复期间附件移除按钮仍然可用。
  for (const fn of p.nodes.get('attachmentRemove')._listeners.click ?? []) fn({})
  check('回复期间附件仍可移除', !p.attachmentEl._classes.has('show'), `class=${p.attachmentEl.className}`)

  // spec 同条还要求框选按钮可用：它是「组装意图」的入口，禁掉会妨碍准备下一条。
  // 断言它仍在向 background 发 region.start，而不是只看按钮没被禁用。
  const regionStartsBefore = p.port.sent.filter((m) => m.type === 'region.start').length
  for (const fn of p.nodes.get('regionBtn')._listeners.click ?? []) fn({})
  check(
    '回复期间框选按钮仍可用',
    p.port.sent.filter((m) => m.type === 'region.start').length === regionStartsBefore + 1,
    `region.start ${regionStartsBefore} → ${p.port.sent.filter((m) => m.type === 'region.start').length}`,
  )

  p.sessionEvent(SESSION, { type: 'turn/end', data: { turn: 1 }, seq: 9 })
  check('turn 结束后闸门放开', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)
}

// ---------------------------------------------------------------------------
// Requirement: 失败与状态复位后恢复可提交
// ---------------------------------------------------------------------------

{
  const p = await loadPanel()
  await bootBoundSession(p)
  // 失败提示的基线：只数新出现的系统行，避免 boot 期间的行造成假阳性。
  const systemRowsBefore = p.nodes.get('log').children.filter((c) => c._classes?.has('system')).length
  p.type('这条会失败')
  p.clickSend()
  await settle()
  check('提交后立即置忙（按钮禁用）', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  const call = p.rpcCalls('session.prompt').at(-1)
  p.inbound({ type: 'rpc.result', id: call.id, ok: false, error: { code: 'bridge-unavailable', message: '连接已断开' } })
  await settle()
  check('prompt RPC 失败后恢复可提交', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)

  // spec 要求「恢复可提交**并给出失败提示**」——只断言按钮恢复会漏掉静默失败。
  const systemRows = p.nodes.get('log').children.filter((c) => c._classes?.has('system'))
  const notice = systemRows.slice(systemRowsBefore).map((c) => c.textContent).join(' | ')
  check(
    'prompt RPC 失败时给出失败提示',
    systemRows.length > systemRowsBefore && /发送失败/.test(notice),
    `新增系统行: ${JSON.stringify(notice)}`,
  )
}

{
  const p = await loadPanel()
  await bootBoundSession(p)
  p.sessionEvent(SESSION, { type: 'turn/start', data: { turn: 1 }, seq: 8 })
  check('切换前处于禁用态', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  const select = p.nodes.get('sessionSelect')
  select.disabled = false
  select.value = '__new__'
  for (const fn of select._listeners.change ?? []) fn({})
  check('切回「新会话」后恢复可提交', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)
}

// ---------------------------------------------------------------------------
// Requirement: 重放进行期间闸门保持关闭 ＋ 重连重放后的闸门状态一致
// ---------------------------------------------------------------------------

/** Disconnect then reconnect so the panel re-opens the session and replays history. */
async function reconnect(p) {
  p.bridgeStatus('stopped')
  await settle()
  p.bridgeStatus('connected')
  await settle()
}

{
  // 历史以 turn/end 收尾：重放结束后闸门放开。
  const p = await loadPanel()
  await bootBoundSession(p)
  // Binding a session issues its own history reads (the tier selector loads per
  // session), so measure the reconnect as a delta rather than a total.
  const historyBefore = p.rpcCalls('session.history').length
  await reconnect(p)
  check(
    '重连后发出历史读取',
    p.rpcCalls('session.history').length === historyBefore + 1,
    `history ${historyBefore} → ${p.rpcCalls('session.history').length}`,
  )
  check('重放进行期间闸门关闭', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  const promptsDuringReplay = p.rpcCalls('session.prompt').length
  p.type('重放中不要发出去')
  p.pressEnter()
  await settle()
  check(
    '重放窗口内按 Enter 不产生 session.prompt',
    p.rpcCalls('session.prompt').length === promptsDuringReplay,
    `prompt 调用数 ${p.rpcCalls('session.prompt').length}`,
  )

  await p.answer('session.history', {
    events: [
      { event: { type: 'turn/start', data: { turn: 1 }, seq: 1 } },
      { event: { type: 'turn/end', data: { turn: 1 }, seq: 2 } },
    ],
    hasMore: false,
  })
  check('历史以 turn/end 收尾 → 重放后可用', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)
}

{
  // 历史以未结束的 turn 收尾：重放结束后闸门保持关闭，直到实时 turn/end。
  const p = await loadPanel()
  await bootBoundSession(p)
  await reconnect(p)
  await p.answer('session.history', {
    events: [{ event: { type: 'turn/start', data: { turn: 1 }, seq: 1 } }],
    hasMore: false,
  })
  check('历史以未结束 turn 收尾 → 重放后仍禁用', p.sendBtn.disabled === true, `disabled=${p.sendBtn.disabled}`)

  p.sessionEvent(SESSION, { type: 'turn/end', data: { turn: 1 }, seq: 9 })
  check('后续实时 turn/end 到达后恢复可用', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)
}

{
  // 历史读取失败：重放提前结束，不得因此永久禁用。
  const p = await loadPanel()
  await bootBoundSession(p)
  await reconnect(p)
  const call = p.rpcCalls('session.history').at(-1)
  p.inbound({ type: 'rpc.result', id: call.id, ok: false, error: { code: 'rpc-timeout', message: '超时' } })
  await settle()
  check('历史读取失败后不永久禁用', p.sendBtn.disabled === false, `disabled=${p.sendBtn.disabled}`)
}

console.log(failures === 0 ? '\nall composer-submit-gating checks passed' : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
