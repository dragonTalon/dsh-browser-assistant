/**
 * Background service worker: owns the bridge connection, the gateway RPC
 * client, controlled-tab tool dispatch, and the panel port service.
 *
 * MVP scope: a single controlled tab (bound to the active tab on first use),
 * reads auto-allowed (`sharePageContent: 'auto'`), state-changing actions
 * fail closed behind a user approval in the side panel.
 *
 * Panel port protocol (chrome.runtime.connect, name "dsh-panel"):
 *   panel → bg: { type: 'rpc', id, method, payload }
 *   panel → bg: { type: 'respond', id, rpcId, result }
 *   panel → bg: { type: 'settings', settings }
 *   panel → bg: { type: 'bridge.test', id, host, token }
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'status', state, caps? }
 *   bg → panel: { type: 'bridge.test.result', id, result }
 *   bg → panel: { type: 'settings.applied', ok, error, pendingUrl, settings }
 *   bg → panel: { type: 'event', frame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *
 * @module
 */

import {
  BRIDGE_CONFIG_PATH,
  buildPageContext,
  DEFAULT_SNAPSHOT_MAX_CHARS,
  isRespondResult,
  normalizeBridgeToken,
  parseBridgeFrame,
  resolveBridgeHost,
  type BridgeCaps,
  type BridgeHostResolution,
  type RespondResult,
  type ToolError,
} from '@dsh-browser/protocol'
import type { ServerFrame } from '@dsh-browser/protocol'
import { BridgeClient, HELLO_ACK_TIMEOUT_MS, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { dispatchOpenTab, dispatchToolCall, type ToolAnswer, type ToolCall } from './tools.ts'
import { requestRegionSelection, type RegionCaptureResult } from './region.ts'
import { isApprovalDecision, type ApprovalAuthorization, type ApprovalPrompt, type ApprovalRequest } from '../security/approval.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  /** dsh address as the user typed it; empty means "discover a local dsh". */
  host: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
}

const SETTINGS_DEFAULTS: Settings = {
  host: '',
  token: '',
  sharePageContent: 'auto',
}

/** Auto-discovery candidate ports (dsh web defaults and common fallbacks). */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'
/** A settings object as an earlier release persisted it. */
type LegacySettings = Partial<Settings> & { bridgeUrl?: unknown }

let settings: Settings = { ...SETTINGS_DEFAULTS }
let caps: BridgeCaps | null = null
let bridge: BridgeClient | null = null
let rpc: ReturnType<typeof createRpc> | null = null
const panelPorts = new Set<chrome.runtime.Port>()
const BRIDGE_KEEPALIVE_ALARM = 'bridge-keepalive'
let bridgeStartRevision = 0
const approvals = new ApprovalCoordinator({
  deliver: (request) => {
    let delivered = false
    for (const port of panelPorts) {
      try { port.postMessage({ type: 'approval.request', request }); delivered = true } catch { /* closed */ }
    }
    return delivered
  },
  notify: () => {},
  clearNotification: () => {},
  resolved: (id) => {
    for (const port of panelPorts) {
      try { port.postMessage({ type: 'approval.resolved', id }) } catch { /* closed */ }
    }
  },
})

/** The single controlled tab; bound to the active tab on first use. */
let controlledTabId: number | null = null

/** 用户当前停留的活动标签页（URL + 标题），随切换/更新实时追踪。 */
let activePage: { url: string; title: string } | null = null

async function refreshActivePage(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab?.url !== undefined && /^https?:\/\//i.test(tab.url)) {
      activePage = { url: tab.url, title: tab.title ?? '' }
      broadcastStatus()
    }
  } catch { /* no active tab */ }
}

chrome.tabs.onActivated.addListener(() => { void refreshActivePage() })
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (tab.active === true && (changeInfo.url !== undefined || changeInfo.status === 'complete')) {
    void refreshActivePage()
  }
})
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void refreshActivePage()
})

/** In-memory log ring buffer, replayed to each newly opened panel. */
interface LogEntry { time: number; level: 'info' | 'warn' | 'error'; msg: string }
const LOG_MAX = 500
const logBuffer: LogEntry[] = []

function emitLog(level: LogEntry['level'], msg: string): void {
  const entry: LogEntry = { time: Date.now(), level, msg }
  logBuffer.push(entry)
  if (logBuffer.length > LOG_MAX) logBuffer.shift()
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'log', entry }) } catch { /* closed */ }
  }
}

function broadcastLogSnapshot(): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'log.snapshot', entries: logBuffer.slice() }) } catch { /* closed */ }
  }
}

async function discoverBridge(shouldContinue: () => boolean = () => true): Promise<string | undefined> {
  for (const port of DISCOVERY_PORTS) {
    if (!shouldContinue()) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`, {
        signal: AbortSignal.timeout(1_500),
      })
      if (!shouldContinue()) return undefined
      if (!response.ok) continue
      const body = await response.json() as { wsUrl?: unknown }
      if (typeof body.wsUrl === 'string' && body.wsUrl.startsWith('ws://')) return body.wsUrl
    } catch { /* no dsh on this port */ }
  }
  return undefined
}

function probeBridge(url: string): Promise<boolean> {
  return Promise.resolve(true)
}

const STORAGE_KEY = 'dshSettings'

/**
 * Read persisted settings, migrating the pre-`host` schema. An earlier release
 * stored an already-resolved `bridgeUrl`; only loopback addresses were
 * reachable back then, so those map onto "discover a local dsh" and any other
 * value is carried over as a user-typed host.
 * @returns the settings to use for this session.
 */
async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const raw = (stored[STORAGE_KEY] ?? {}) as LegacySettings
  const host = typeof raw.host === 'string'
    ? raw.host
    : typeof raw.bridgeUrl === 'string' && raw.bridgeUrl !== '' && raw.bridgeUrl !== LEGACY_LOCAL_URL
      ? raw.bridgeUrl
      : ''
  return {
    host,
    token: typeof raw.token === 'string' ? raw.token : SETTINGS_DEFAULTS.token,
    sharePageContent: raw.sharePageContent ?? SETTINGS_DEFAULTS.sharePageContent,
  }
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...next }
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

const settingsReady = loadSettings().then((loaded) => { settings = loaded })

/**
 * Resolve the endpoint to connect to for the current settings. A configured
 * host always wins: silently falling back to a local dsh would make a wrong
 * remote address look like a working one.
 * @param shouldContinue - abort guard shared with the discovery probe.
 * @returns the endpoint url, or undefined when nothing is configured/found.
 */
async function resolveBridgeUrl(shouldContinue: () => boolean): Promise<string | undefined> {
  if (settings.host.trim() === '') {
    return discoverBridge(shouldContinue) ?? undefined
  }
  const resolved: BridgeHostResolution = resolveBridgeHost(settings.host)
  if (!resolved.ok) {
    emitLog('error', `桥地址无效：${resolved.message}`)
    return undefined
  }
  return resolved.url
}

function armBridgeKeepalive(): void {
  // Chrome alarms 周期最小值是 0.5 分钟（30 秒）；面板侧另有 20s 心跳来
  // 保持 SW 存活。
  void chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

function disarmBridgeKeepalive(): void {
  void chrome.alarms.clear(BRIDGE_KEEPALIVE_ALARM).catch(() => {})
}

function broadcastStatus(): void {
  const payload = {
    type: 'status',
    state: bridge?.state ?? ('stopped' as BridgeState),
    caps,
    url: bridge?.url ?? '',
    attempt: bridge?.attemptCount ?? 0,
    activePage,
    // The dialog must show what is actually in effect (host after auto-discovery
    // too), so the effective values ride along with every status broadcast.
    settings: effectiveSettings(),
  }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* closed */ }
  }
}

/**
 * Settings as the panel should render them: the persisted host/token plus the
 * address the bridge actually resolved (empty while nothing is resolved yet).
 * The panel lives in the same extension origin as this worker, so the token
 * already crosses this boundary — it is never sent to a page.
 * @returns the panel-facing settings snapshot.
 */
function effectiveSettings(): Record<string, unknown> {
  const resolved = resolveBridgeHost(settings.host)
  return {
    host: settings.host,
    token: settings.token,
    effectiveUrl: resolved.ok ? resolved.url : '',
    loopback: resolved.ok ? resolved.loopback : false,
    plaintext: resolved.ok ? resolved.plaintext : false,
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* closed */ }
  }
}

/**
 * Start (or restart) the bridge with current settings.
 * @returns whether a connectable address was found, plus why not when it was not.
 */
async function startBridge(): Promise<BridgeStartOutcome> {
  const revision = ++bridgeStartRevision
  if (panelPorts.size === 0) return { ok: false, url: '', error: '面板已关闭，未建立连接' }
  const url = await resolveBridgeUrl(() => revision === bridgeStartRevision && panelPorts.size > 0)
  if (revision !== bridgeStartRevision || panelPorts.size === 0) {
    return { ok: false, url: '', error: '已有更新的连接请求，本次保存被取代' }
  }
  if (url === undefined || url === '') {
    const configured = settings.host.trim() !== ''
    let error: string
    if (configured) {
      const resolved = resolveBridgeHost(settings.host)
      error = resolved.ok
        ? `地址不可达：无法连接到 ${settings.host}（网络不可达、端口未开放或被防火墙拦截）`
        : resolved.message
      emitLog('error', `桥地址无法使用：${settings.host}`)
    } else {
      error = '未发现本机 dsh（探测 3080/3081/3090/14389/43189 均无响应）'
      emitLog('warn', error)
    }
    bridge?.stop(); bridge = null; rpc = null; broadcastStatus()
    return { ok: false, url: '', error }
  }
  emitLog('info', `正在连接桥 ${url}`)
  if (bridge === null) {
    const client = new BridgeClient({
      onStateChange: (state) => {
        if (state !== 'connected') { /* clear pending tool state */ }
        const attempt = client.attemptCount
        if (state === 'connected') emitLog('info', '已连接 dsh')
        else if (state === 'connecting') emitLog('info', '连接中…')
        else if (state === 'reconnecting') emitLog('warn', `连接断开，重连中（第 ${attempt} 次）`)
        else if (state === 'stopped') emitLog('info', '已停止（面板关闭或手动停止）')
        broadcastStatus()
        if (state === 'stopped' && panelPorts.size === 0) disarmBridgeKeepalive()
      },
      onFrame: (frame) => {
        if (frame.t === 'event') broadcastEvent(frame)
        else if (frame.t === 'tool.call') routeToolCall(frame)
        else if (frame.t === 'tool.cancel') { /* minimal: no-op */ }
        // rpc.result is settled by the rpc facade.
      },
      onHelloOk: (negotiated) => {
        caps = negotiated
        emitLog('info', `握手成功，快照预算 ${negotiated.snapshotMaxChars} 字符 / ${negotiated.maxInteractiveItems} 项`)
        broadcastStatus()
      },
    }, probeBridge, () => panelPorts.size > 0)
    bridge = client
    rpc = createRpc(client)
  }
  bridge.start(url, normalizeBridgeToken(settings.token))
  // Reaching here only means the socket is opening: the connect outcome arrives
  // as a later `status` broadcast (connecting → connected | reconnecting), which
  // is why the panel waits for it before claiming the configuration works.
  return { ok: true, url }
}

/** Result of one {@link startBridge} attempt, reported back to the config dialog. */
export type BridgeStartOutcome =
  | { ok: true; url: string }
  | { ok: false; url: string; error: string }

/**
 * Which stage of a one-shot verification failed. Reported separately because
 * each has a different fix: a malformed address, a server that is down or
 * misrouted, and a wrong token must never collapse into one "failed" message.
 */
export type BridgeTestFailurePhase = 'invalid-address' | 'unusable-url' | 'unreachable' | 'token-rejected' | 'handshake-timeout'

/** Outcome of one connection test. */
export type BridgeTestResult =
  | { ok: true; url: string; caps: BridgeCaps }
  | { ok: false; phase: BridgeTestFailurePhase; message: string }

/**
 * Verify a host/token pair the user just typed, WITHOUT touching the live
 * connection. The bridge owns a single active slot and evicts the previous
 * socket with close code 4000, which the client treats as a permanent
 * handoff — reusing {@link BridgeClient} here would kill a working session.
 * @param id - panel correlation id, echoed back in the result message.
 * @param host - raw host input.
 * @param token - raw token input.
 */
async function testBridge(id: string, host: string, token: string): Promise<void> {
  const result = await probeBridgeEndpoint(host, token)
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'bridge.test.result', id, result }) } catch { /* closed */ }
  }
}

/**
 * One-shot handshake against a candidate endpoint: connect, send `hello`, wait
 * for `hello.ok`. The full handshake is the point — a transport-level probe
 * would report a wrong token as success and send the user into an endless
 * reconnect loop while believing the configuration works.
 * @param host - raw host input.
 * @param token - raw token input.
 * @returns the negotiated capabilities, or the stage that failed.
 */
function probeBridgeEndpoint(host: string, token: string): Promise<BridgeTestResult> {
  const resolved: BridgeHostResolution = resolveBridgeHost(host)
  if (!resolved.ok) return Promise.resolve({ ok: false, phase: 'invalid-address', message: resolved.message })
  if (resolved.url === '') {
    return Promise.resolve({ ok: false, phase: 'unusable-url', message: '请先填写 dsh 地址；留空只会连接本机 dsh' })
  }
  const url = resolved.url
  const bearer = normalizeBridgeToken(token)
  return new Promise<BridgeTestResult>((resolve) => {
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error: unknown) {
      resolve({ ok: false, phase: 'unusable-url', message: `地址无法建立连接：${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let settled = false
    // Declared before `finish` so the settle path never reads it in its TDZ.
    const timer = setTimeout(() => {
      finish({ ok: false, phase: 'handshake-timeout', message: `已连上 ${url}，但 ${HELLO_ACK_TIMEOUT_MS / 1000} 秒内没有收到 dsh 的握手应答` })
    }, HELLO_ACK_TIMEOUT_MS)
    const finish = (result: BridgeTestResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
      resolve(result)
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        t: 'hello',
        token: bearer,
        caps: { textOnly: true, snapshotMaxChars: DEFAULT_SNAPSHOT_MAX_CHARS, maxInteractiveItems: 60 },
      }))
    })
    socket.addEventListener('message', (event) => {
      const frame = parseBridgeFrame(String(event.data))
      if (frame === undefined) return
      if (frame.t === 'hello.ok') {
        finish({ ok: true, url, caps: frame.caps })
        return
      }
      if (frame.t === 'error') finish({ ok: false, phase: 'handshake-timeout', message: `dsh 拒绝了握手：${frame.message}` })
    })
    socket.addEventListener('error', () => {
      // Transport-level failure. An authenticated rejection (4002) arrives as a
      // clean close instead — verified against the real bridge: empty and wrong
      // tokens both produce `close(4002, "bad token")` with no error event.
      finish({ ok: false, phase: 'unreachable', message: `无法连接到 ${url}（网络不可达、端口未开放或被防火墙拦截）` })
    })
    socket.addEventListener('close', (event) => {
      // The bridge closes with 4002 when the bearer token does not match.
      if (event.code === 4002) {
        finish({ ok: false, phase: 'token-rejected', message: `${url} 可达，但 token 被拒绝（dsh 侧提示：${event.reason === '' ? 'bad token' : event.reason}）` })
        return
      }
      finish({ ok: false, phase: 'unreachable', message: `连接 ${url} 被关闭（code ${event.code}${event.reason === '' ? '' : `: ${event.reason}`}）` })
    })
  })
}

async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error('dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

/** Resolve the controlled tab, binding to the active tab on first use. */
async function resolveControlledTab(): Promise<{ tab: chrome.tabs.Tab } | { error: ToolError }> {
  if (controlledTabId === null) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      if (tab?.id === undefined) return { error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
      controlledTabId = tab.id
      return { tab }
    } catch {
      return { error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
    }
  }
  try {
    const tab = await chrome.tabs.get(controlledTabId)
    if (tab.id === undefined) return { error: { code: 'no-active-tab', message: 'No active tab is available for browser operations.' } }
    return { tab }
  } catch {
    controlledTabId = null
    return { error: { code: 'content-unavailable', message: 'The controlled tab was closed. Retry to bind the current page.' } }
  }
}

async function authorizeToolCall(prompt: ApprovalPrompt, signal: AbortSignal, windowId: number, sessionId?: string): Promise<ApprovalAuthorization> {
  if (signal.aborted) return 'cancelled'
  const result: ApprovalRequestResult = await approvals.request(prompt, signal, windowId, sessionId)
  if (signal.aborted) return 'cancelled'
  if (result.status !== 'decision') return result.status
  const { decision } = result
  if (decision === 'always-allow-reads' && prompt.kind === 'read') {
    await persistSettings({ sharePageContent: 'auto' })
    return 'approved'
  }
  return decision === 'allow-once' ? 'approved' : 'denied'
}

/** Route one tool.call frame to the controlled tab. */
function routeToolCall(call: ToolCall): void {
  if (bridge === null) return
  emitLog('info', `收到工具调用 ${call.name}${call.sessionId ? ` (session ${call.sessionId.slice(0, 8)}…)` : ''}`)
  const controller = new AbortController()
  const expiryTimer = call.expiresAt === undefined
    ? undefined
    : setTimeout(() => { controller.abort() }, Math.max(0, call.expiresAt - Date.now()))
  const budget = caps === null ? undefined : { maxItems: caps.maxInteractiveItems, maxChars: caps.snapshotMaxChars }

  void (call.name === 'browser_open_tab'
    ? resolveOpenTabWindow().then((windowId) => dispatchOpenTab(
        call, windowId, settings.sharePageContent, budget,
        (prompt) => authorizeToolCall(prompt, controller.signal, windowId, call.sessionId),
        controller.signal,
        (tab) => { if (tab.id !== undefined) { controlledTabId = tab.id; return true } return false },
        () => controlledTabId !== null && controlledTabId !== undefined,
      ))
    : resolveControlledTab().then((target): Promise<ToolAnswer> => 'error' in target
      ? Promise.resolve({ ok: false, error: target.error })
      : dispatchToolCall(
          call, settings.sharePageContent, budget,
          (prompt) => authorizeToolCall(prompt, controller.signal, target.tab.windowId, call.sessionId),
          controller.signal,
          target.tab,
          () => controlledTabId === target.tab.id,
        ))
  ).then(
    (answer) => {
      if (controller.signal.aborted && !(call.name === 'browser_open_tab' && answer.ok)) {
        emitLog('warn', `工具 ${call.name} 已取消`)
        bridge?.send({ t: 'tool.result', id: call.id, ok: false, error: { code: 'action-failed', message: 'Tool call was cancelled' } })
        return
      }
      if (answer.ok) {
        emitLog('info', `工具 ${call.name} 执行成功`)
        bridge?.send({ t: 'tool.result', id: call.id, ok: true, result: answer.result })
      } else {
        emitLog('error', `工具 ${call.name} 失败: ${answer.error?.message ?? 'unknown'}`)
        bridge?.send({ t: 'tool.result', id: call.id, ok: false, error: answer.error! })
      }
    },
    (error: unknown) => {
      emitLog('error', `工具 ${call.name} 异常: ${error instanceof Error ? error.message : String(error)}`)
      bridge?.send({ t: 'tool.result', id: call.id, ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } })
    },
  ).finally(() => {
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
  })
}

async function resolveOpenTabWindow(): Promise<number> {
  if (controlledTabId !== null) {
    try {
      const tab = await chrome.tabs.get(controlledTabId)
      return tab.windowId
    } catch { /* fall through */ }
  }
  try {
    const focused = await chrome.windows.getLastFocused()
    if (focused.id !== undefined) return focused.id
  } catch { /* no focused window */ }
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return fallback?.windowId ?? chrome.windows.WINDOW_ID_NONE
}

// ---- Panel ports ----

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'dsh-panel') return
  const wasIdle = panelPorts.size === 0
  panelPorts.add(port)
  if (wasIdle) armBridgeKeepalive()
  void settingsReady.then(() => {
    if (!panelPorts.has(port)) return
    if (bridge === null || bridge.state === 'stopped') return startBridge()
  })
  emitLog('info', '侧边栏已打开')
  broadcastStatus()
  broadcastLogSnapshot()

  port.onMessage.addListener((message: unknown) => {
    if (typeof message !== 'object' || message === null) return
    const msg = message as { type?: string }
    switch (msg.type) {
      case 'rpc': {
        const rpcMsg = message as { id: string; method: string; payload?: unknown }
        emitLog('info', `面板 RPC: ${rpcMsg.method}`)
        // 发消息时，把「用户当前停留的页面」注入进 prompt 上下文，让 dsh 有页面感知。
        if (rpcMsg.method === 'session.prompt' && activePage !== null) {
          const payload = (typeof rpcMsg.payload === 'object' && rpcMsg.payload !== null ? rpcMsg.payload : {}) as { content?: unknown[] }
          if (Array.isArray(payload.content)) {
            const pageCtx = buildPageContext(activePage.title, activePage.url)
            payload.content = [{ type: 'text', text: pageCtx }, ...payload.content]
          }
        }
        void gatewayRpc(rpcMsg.method, rpcMsg.payload).then(
          (result) => { try { port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: true, result }) } catch { /* closed */ } },
          (error: unknown) => {
            emitLog('error', `RPC ${rpcMsg.method} 失败: ${error instanceof Error ? error.message : String(error)}`)
            try {
              port.postMessage({ type: 'rpc.result', id: rpcMsg.id, ok: false, error: { code: 'bridge-unavailable', message: error instanceof Error ? error.message : String(error) } })
            } catch { /* closed */ }
          },
        )
        break
      }
      case 'respond': {
        const response = message as { id?: unknown; rpcId?: unknown; result?: unknown }
        if (typeof response.id !== 'string' || typeof response.rpcId !== 'string' || !isRespondResult(response.result)) break
        bridge?.send({ t: 'respond', id: response.id, rpcId: response.rpcId, result: response.result as RespondResult })
        break
      }
      case 'settings': {
        const settingsMsg = message as { settings?: Partial<Settings> }
        const patch = settingsMsg.settings ?? {}
        void settingsReady.then(async () => {
          // The panel sends the host/token exactly as typed; normalize here so
          // storage holds the value the handshake will actually use.
          await persistSettings({
            ...patch,
            ...(patch.host === undefined ? {} : { host: patch.host.trim() }),
            ...(patch.token === undefined ? {} : { token: normalizeBridgeToken(patch.token) }),
          })
          const outcome: BridgeStartOutcome = panelPorts.size > 0
            ? await startBridge()
            : { ok: false, url: '', error: '面板已关闭，未建立连接' }
          try {
            port.postMessage({
              type: 'settings.applied',
              ok: outcome.ok,
              error: outcome.ok ? '' : outcome.error,
              // A successful start means the socket is only now opening; the
              // panel waits for the following status broadcast to learn whether
              // it actually connected, so it can report the real outcome.
              pendingUrl: outcome.ok ? outcome.url : '',
              settings: effectiveSettings(),
            })
          } catch { /* closed */ }
        })
        break
      }
      case 'bridge.test': {
        const testMsg = message as { id?: unknown; host?: unknown; token?: unknown }
        if (typeof testMsg.id !== 'string' || typeof testMsg.host !== 'string') break
        const token = typeof testMsg.token === 'string' ? testMsg.token : ''
        emitLog('info', `面板测试桥连接：${testMsg.host === '' ? '(未填写地址)' : testMsg.host}`)
        void testBridge(testMsg.id, testMsg.host, token)
        break
      }
      case 'approval.response': {
        const approval = message as { id?: unknown; decision?: unknown }
        if (typeof approval.id !== 'string' || !isApprovalDecision(approval.decision)) break
        approvals.respond(approval.id, approval.decision)
        break
      }
      case 'request-status':
        broadcastStatus()
        broadcastLogSnapshot()
        break
      case 'region.start': {
        void (async () => {
          const deliver = (result: RegionCaptureResult): void => {
            try { port.postMessage({ type: 'region.result', result }) } catch { /* closed */ }
          }
          try {
            // 框选目标是用户正在查看的活动标签页（拖拽发生在那里，captureVisibleTab 也只截活动标签页），
            // 而不是模型工具的受控 tab affinity——这是用户本人发起的显式操作。
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => [])
            if (tab?.id === undefined || !/^https?:\/\//i.test(tab.url ?? '')) {
              deliver({ ok: false, error: '当前标签页不支持框选（需为标准 http/https 页面）。' })
              return
            }
            deliver(await requestRegionSelection(tab.id, tab.windowId))
          } catch (error: unknown) {
            deliver({ ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
        break
      }
    }
  })

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port)
    if (panelPorts.size === 0) disarmBridgeKeepalive()
  })
})

// ---- MV3 keepalive + alarms ----

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRIDGE_KEEPALIVE_ALARM && panelPorts.size > 0) {
    if (bridge === null || bridge.state === 'stopped') void startBridge()
  }
})

// Content script readiness announcement (no selection watch in MVP).
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return
  if ((message as { type?: unknown }).type === 'DSH_CONTENT_READY') {
    sendResponse({})
  }
})

// 点击工具栏图标时自动打开侧边栏（Chrome 116+）。没有这个设置时，点击
// 扩展图标不会弹出任何界面。
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
