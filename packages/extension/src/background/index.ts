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
 *   panel → bg: { type: 'approval.response', id, decision }
 *   panel → bg: { type: 'request-status' }
 *   bg → panel: { type: 'rpc.result', id, ok, result? | error? }
 *   bg → panel: { type: 'respond.result', id, ok, result? | error? }
 *   bg → panel: { type: 'status', state, caps? }
 *   bg → panel: { type: 'event', frame }
 *   bg → panel: { type: 'approval.request', request }
 *   bg → panel: { type: 'approval.resolved', id }
 *
 * @module
 */

import { BRIDGE_CONFIG_PATH, BRIDGE_PATH, isRespondResult, type BridgeCaps, type RespondResult } from '@dsh-browser/protocol'
import type { ServerFrame } from '@dsh-browser/protocol'
import { BridgeClient, type BridgeState } from './bridge.ts'
import { createRpc } from './rpc.ts'
import { dispatchOpenTab, dispatchToolCall, type ToolAnswer, type ToolCall } from './tools.ts'
import { isApprovalDecision, type ApprovalAuthorization, type ApprovalPrompt, type ApprovalRequest } from '../security/approval.ts'
import { ApprovalCoordinator, type ApprovalRequestResult } from './approval-coordinator.ts'

/** User settings persisted in chrome.storage.local. */
export interface Settings {
  bridgeUrl: string
  token: string
  sharePageContent: 'ask' | 'auto' | 'off'
}

const SETTINGS_DEFAULTS: Settings = {
  bridgeUrl: '',
  token: '',
  sharePageContent: 'auto',
}

/** Auto-discovery candidate ports (dsh web defaults and common fallbacks). */
const DISCOVERY_PORTS = [3080, 3081, 3090, 14389, 43189]
const LEGACY_LOCAL_URL = 'ws://127.0.0.1:3080'

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

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const loaded = { ...SETTINGS_DEFAULTS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) }
  if (loaded.bridgeUrl === LEGACY_LOCAL_URL) loaded.bridgeUrl = ''
  return loaded
}

async function persistSettings(next: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...next }
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

const settingsReady = loadSettings().then((loaded) => { settings = loaded })

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
  }
  for (const port of panelPorts) {
    try { port.postMessage(payload) } catch { /* closed */ }
  }
}

function broadcastEvent(frame: ServerFrame): void {
  for (const port of panelPorts) {
    try { port.postMessage({ type: 'event', frame }) } catch { /* closed */ }
  }
}

/** Start (or restart) the bridge with current settings. */
async function startBridge(): Promise<void> {
  const revision = ++bridgeStartRevision
  if (panelPorts.size === 0) return
  let url = settings.bridgeUrl
  if (url === '') {
    url = await discoverBridge(() => revision === bridgeStartRevision && panelPorts.size > 0) ?? ''
  }
  if (revision !== bridgeStartRevision || panelPorts.size === 0) return
  if (url === '') {
    emitLog('warn', '未发现本机 dsh（探测 3080/3081/3090/14389/43189 均无响应）')
    bridge?.stop(); bridge = null; rpc = null; broadcastStatus()
    return
  }
  try {
    const parsed = new URL(url)
    if (parsed.pathname === '' || parsed.pathname === '/') parsed.pathname = BRIDGE_PATH
    url = parsed.toString()
  } catch { /* let the WebSocket constructor surface the error */ }
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
  bridge.start(url, settings.token)
}

async function gatewayRpc(method: string, payload: unknown): Promise<unknown> {
  if (rpc === null || bridge === null || !bridge.connected) {
    throw new Error('dsh is not connected (check the bridge address and token in Settings)')
  }
  return rpc.request(method, payload)
}

/** Resolve the controlled tab, binding to the active tab on first use. */
async function resolveControlledTab(): Promise<{ tab: chrome.tabs.Tab } | { error: { code: string; message: string } }> {
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
    : resolveControlledTab().then((target) => 'error' in target
      ? target
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
            const pageCtx = `[浏览器上下文] 用户当前停留的页面: ${activePage.title || '(无标题)'} (${activePage.url})`
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
        const settingsMsg = message as { settings: Partial<Settings> }
        void settingsReady.then(async () => {
          await persistSettings(settingsMsg.settings)
          if (panelPorts.size > 0) await startBridge()
        })
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
