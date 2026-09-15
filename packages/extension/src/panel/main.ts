/**
 * Side panel composition root: resolves the composer controls, wires every
 * feature module together, and routes inbound messages/events. Deliberately
 * thin — no feature logic lives here, only assembly.
 *
 * @module
 */

import type { BridgeState } from '../background/bridge.ts'
import { eventSeq } from '../common/index.ts'
import { setMessageListener, post, rpc, settleRpcResult } from './transport.ts'
import { setStatus, setActivePage } from './status.ts'
import * as log from './log.ts'
import * as conversation from './conversation.ts'
import * as modelSelector from './model-selector.ts'
import * as sessionSelector from './session-selector.ts'
import * as region from './region.ts'
import * as question from './question.ts'
import * as approval from './approval.ts'
import * as settings from './settings.ts'
import * as errors from './errors.ts'

const inputEl = document.getElementById('input') as HTMLTextAreaElement
const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement

let lastState: BridgeState = 'stopped'

// ---- send ----

function send(): void {
  const text = inputEl.value.trim()
  inputEl.value = ''
  // A pending region turns the input into the intent for the crop.
  if (region.hasPendingRegion()) {
    void region.sendRegion(text)
    return
  }
  if (text === '') return
  void conversation.sendText(text)
}

// ---- session events ----

function handleSessionEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const ev = event as { type?: string; data?: Record<string, unknown> }
  // Model selection is model-selector's concern; everything else is conversation.
  if (ev.type === 'model/selection') {
    modelSelector.applySelectionEvent(ev.data)
    return
  }
  conversation.handleMessageEvent(event)
}

// ---- server frames ----

function handleEvent(serverFrame: unknown): void {
  if (typeof serverFrame !== 'object' || serverFrame === null) return
  // The background broadcasts the full ServerFrame: { t:'event', frame:{ method, payload } }.
  const outer = serverFrame as { t?: string; frame?: unknown }
  const f = (outer.t === 'event' && outer.frame !== undefined ? outer.frame : outer) as { method?: string; payload?: unknown }
  if (f.method === 'session/event') {
    const payload = f.payload as { sessionId?: unknown; event?: unknown } | undefined
    const sessionId = payload?.sessionId
    const event = payload?.event
    if (typeof sessionId !== 'string' || event === undefined) return
    // Session isolation. The bridge follows one session per connection, but a
    // switch can leave frames of the previous session queued; rendering those
    // would graft one conversation onto another.
    if (sessionId !== conversation.getActiveSessionId()) return
    if (conversation.isReplaying()) {
      conversation.bufferLiveEvent(sessionId, event)
      return
    }
    handleSessionEvent(event)
  } else if (f.method === 'question/requested') {
    // Interactions are deliberately NOT session-filtered: the panel is the only
    // answerer for a session it has prompted, so dropping a question that
    // belongs to a session the user switched away from would hang that turn.
    // rpcId sits on the outer HostEventFrame, not inside payload.
    question.showQuestion((f as { rpcId?: unknown }).rpcId, f.payload)
  } else if (f.method === 'question/resolved') {
    question.handleQuestionResolved()
  }
}

// ---- session binding ----

/**
 * Bind a session and present its transcript.
 *
 * Replay owns the transcript until it ends: live frames for `sessionId`
 * arriving meanwhile are buffered by `handleEvent` and applied afterwards by
 * sequence, which is what keeps an event emitted between the history snapshot
 * and its response from being erased by the clear+replay.
 *
 * Deliberately NOT via `session.create { sessionId }`: an existing session
 * already owns a working directory, and creating it by identity makes the
 * bridge inject its configured workspace, which dsh rejects with
 * `session/conflict` — and it would re-home the session into that workspace.
 * A cold session is resumed by dsh itself on the next prompt.
 */
async function openSession(sessionId: string): Promise<void> {
  conversation.bindSession(sessionId)
  modelSelector.resetSelection()
  conversation.beginReplay(sessionId)
  try {
    const page = await rpc<{ events?: unknown; hasMore?: unknown }>('session.history', { sessionId })
    // Superseded by a newer switch: that switch already owns the transcript and
    // the buffer, so this replay must contribute neither.
    if (conversation.getActiveSessionId() !== sessionId) return
    let maxSeq = -1
    if (Array.isArray(page?.events)) {
      for (const entry of page.events) {
        const event = (entry as { event?: unknown } | undefined)?.event
        if (event === undefined) continue
        const seq = eventSeq(event)
        if (seq !== undefined && seq > maxSeq) maxSeq = seq
        handleSessionEvent(event)
      }
    }
    // After the replay: the history projection is authoritative over any
    // `model/selection` event inside the snapshot. Buffered live frames are
    // newer than both and are applied last, by `endReplay`.
    modelSelector.alignFromProjections(page)
    for (const frame of conversation.endReplay(sessionId, maxSeq, page?.hasMore === true)) {
      handleSessionEvent(frame.event)
    }
  } catch (error: unknown) {
    if (conversation.getActiveSessionId() !== sessionId) return
    conversation.appendSystem(`读取会话历史失败: ${errors.describeRpcError(error)}`)
    // Without a usable boundary, apply every buffered frame in arrival order:
    // the live tail is all this session can show now.
    for (const frame of conversation.endReplay(sessionId, -1, false)) {
      handleSessionEvent(frame.event)
    }
  }
}

/** Return to "new session": unbind, forget the transcript, reset the model row. */
function startNewSession(): void {
  conversation.bindSession(null)
  conversation.clear()
  modelSelector.resetSelection()
}

// ---- inbound panel messages ----

function onPortMessage(message: unknown): void {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  switch (msg.type) {
    case 'status': {
      const s = msg as {
        state: BridgeState
        url?: string
        attempt?: number
        activePage?: { url: string; title: string } | null
        settings?: settings.PanelSettings & { loopback?: boolean }
      }
      setStatus(s.state, s.url ?? '', s.attempt ?? 0)
      setActivePage(s.activePage ?? null)
      if (s.settings !== undefined) {
        settings.rememberSettings(s.settings)
        // Decides whether a `forbidden` failure is explained as a remote
        // limitation rather than echoed as a bare code.
        errors.setRemoteConnection(s.settings.loopback !== true)
      }
      // A saved configuration only counts as working once the bridge reports it
      // connected; until then the dialog waits (see settings.applyConnectionState).
      settings.applyConnectionState(s.state)
      const wasConnected = lastState === 'connected'
      lastState = s.state
      modelSelector.setConnected(s.state === 'connected')
      sessionSelector.setConnected(s.state === 'connected')
      if (s.state === 'connected') {
        // Refresh the catalog and the session candidates on (re)connect —
        // adapters and sessions can both change between runs.
        if (!wasConnected) {
          void modelSelector.loadCatalog()
          void sessionSelector.loadSessions()
        }
        const active = conversation.getActiveSessionId()
        if (active !== null && !wasConnected) {
          // Re-present the bound session so output produced while disconnected
          // is back on screen; the bridge backfills its own event window too.
          conversation.setInterrupted(false)
          void openSession(active)
        }
      } else if (conversation.isWorking()) {
        // Disconnect mid-turn: drop the indicator and mark the turn interrupted.
        conversation.setInterrupted(true)
        conversation.setWorking(false)
      }
      break
    }
    case 'log':
      log.appendLog((msg as { entry: { time: number; level: string; msg: string } }).entry)
      break
    case 'log.snapshot':
      log.renderLogSnapshot((msg as { entries: unknown }).entries)
      break
    case 'event':
      handleEvent((msg as { frame: unknown }).frame)
      break
    case 'approval.request':
      approval.showApproval((msg as { request: unknown }).request)
      break
    case 'approval.resolved':
      approval.handleApprovalResolved()
      break
    case 'rpc.result':
      settleRpcResult(msg as { id: string; ok: boolean; result?: unknown; error?: { code?: string; message?: string } })
      break
    case 'region.result':
      region.handleRegionResult((msg as { result: unknown }).result)
      break
    case 'bridge.test.result':
      settings.applyTestResult(msg as { id: string; result: settings.BridgeTestResult })
      break
    case 'settings.applied': {
      const applied = msg as { ok: boolean; error?: string; pendingUrl?: string; settings?: settings.PanelSettings }
      if (applied.settings !== undefined) settings.rememberSettings(applied.settings)
      settings.applySettingsApplied(applied.ok, applied.error ?? '连接失败', applied.pendingUrl ?? '')
      break
    }
  }
}

// ---- wiring ----

setMessageListener(onPortMessage)
log.initLog()
question.initQuestion()
approval.initApproval()
region.initRegion()
modelSelector.initModelSelector()
sessionSelector.initSessionSelector((sessionId) => {
  if (sessionId === null) startNewSession()
  else void openSession(sessionId)
})
settings.initSettings()

sendBtn.addEventListener('click', () => { void send() })
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
})

// Initial render (startup placeholders: "等待连接 dsh…"/"等待连接…"), then
// connect and ask the background for its current status. Nothing is created
// here: the panel stays on "new session" until the user actually sends, so
// opening it never litters dsh's session list.
modelSelector.renderModelRow()
sessionSelector.renderSessionRow(true)
post({ type: 'request-status' })

// 20s heartbeat keeps the background SW alive during long model turns (prevents
// the "stopped → reconnecting" loop from MV3 suspending the worker).
setInterval(() => { post({ type: 'request-status' }) }, 20_000)
