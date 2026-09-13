/**
 * Side panel composition root: resolves the composer controls, wires every
 * feature module together, and routes inbound messages/events. Deliberately
 * thin — no feature logic lives here, only assembly.
 *
 * @module
 */

import type { BridgeState } from '../background/bridge.ts'
import { setMessageListener, post, rpc, settleRpcResult } from './transport.ts'
import { setStatus, setActivePage } from './status.ts'
import * as log from './log.ts'
import * as conversation from './conversation.ts'
import * as modelSelector from './model-selector.ts'
import * as region from './region.ts'
import * as question from './question.ts'
import * as approval from './approval.ts'

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
    const payload = f.payload as { event?: unknown } | undefined
    if (payload?.event !== undefined) handleSessionEvent(payload.event)
  } else if (f.method === 'question/requested') {
    // rpcId sits on the outer HostEventFrame, not inside payload.
    question.showQuestion((f as { rpcId?: unknown }).rpcId, f.payload)
  } else if (f.method === 'question/resolved') {
    question.handleQuestionResolved()
  }
}

// ---- history reload on reconnect ----

async function reloadHistory(): Promise<void> {
  if (conversation.getSessionId() === null) return
  try {
    const page = await rpc<{ events?: unknown }>('session.history', { sessionId: conversation.getSessionId() })
    // Re-align the model selection from the projection before re-rendering.
    modelSelector.alignFromProjections(page)
    if (!Array.isArray(page?.events)) return
    conversation.clear()
    for (const entry of page.events) {
      const ev = (entry as { event?: unknown } | undefined)?.event
      if (ev !== undefined) handleSessionEvent(ev)
    }
  } catch {
    /* history fetch failure: keep current state */
  }
}

// ---- inbound panel messages ----

function onPortMessage(message: unknown): void {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  switch (msg.type) {
    case 'status': {
      const s = msg as { state: BridgeState; url?: string; attempt?: number; activePage?: { url: string; title: string } | null }
      setStatus(s.state, s.url ?? '', s.attempt ?? 0)
      setActivePage(s.activePage ?? null)
      const wasConnected = lastState === 'connected'
      lastState = s.state
      modelSelector.setConnected(s.state === 'connected')
      if (s.state === 'connected') {
        // Refresh the catalog on (re)connect — adapters can change between runs.
        if (!wasConnected) void modelSelector.loadCatalog()
        if (conversation.getSessionId() === null) void conversation.ensureSession()
        else if (!wasConnected && conversation.isInterrupted()) {
          conversation.setInterrupted(false)
          void reloadHistory() // recover output missed while disconnected
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
  }
}

// ---- wiring ----

setMessageListener(onPortMessage)
log.initLog()
question.initQuestion()
approval.initApproval()
region.initRegion()
modelSelector.initModelSelector()

sendBtn.addEventListener('click', () => { void send() })
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
})

// Initial render (startup placeholder: "等待连接 dsh…"), then connect and ask
// the background for its current status. The session is created lazily once
// `status` reports connected, avoiding a `session.create` before the bridge is up.
modelSelector.renderModelRow()
post({ type: 'request-status' })

// 20s heartbeat keeps the background SW alive during long model turns (prevents
// the "stopped → reconnecting" loop from MV3 suspending the worker).
setInterval(() => { post({ type: 'request-status' }) }, 20_000)
