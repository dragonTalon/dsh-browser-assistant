/**
 * Conversation state + rendering: the user/assistant/system list, the animated
 * "working" indicator, session creation, and text sending.
 *
 * Renders message/turn events only; `model/selection` events are routed to the
 * model selector by `main.ts`, keeping this module decoupled from model state.
 *
 * @module
 */

import { rpc } from './transport.ts'
import { describeRpcError } from './errors.ts'
import { appendLog } from './log.ts'
import {
  bufferEvent,
  conversationRow,
  createWorkingRow,
  renderMarkdown,
  selectEventsAfterReplay,
  type BufferedSessionEvent,
  type WorkingRow,
} from '../common/index.ts'

const logEl = document.getElementById('log')!

/**
 * Active session identity — the panel's two-state session machine.
 *
 * `null` is the "new session" state: the panel has bound nothing and MUST NOT
 * create anything until the user actually sends (or picks a model). A non-null
 * id is a *bound* session — either one this panel created or one adopted from
 * the session picker; both behave identically from here on.
 */
let activeSessionId: string | null = null
let sessionPromise: Promise<boolean> | null = null
/** Notified on every identity change so the picker can follow it. */
let sessionListener: ((sessionId: string | null) => void) | null = null
let interrupted = false
let assistantRow: HTMLElement | null = null
let assistantBuffer = ''
let working: WorkingRow | null = null

/** Append a row, keeping the working indicator pinned to the tail. */
function appendRow(kind: 'user' | 'assistant' | 'system', text: string): HTMLElement {
  const row = conversationRow(kind, text)
  logEl.appendChild(row)
  if (working !== null) logEl.appendChild(working.el)
  logEl.scrollTop = logEl.scrollHeight
  return row
}

/** Append a centered system notice. */
export function appendSystem(text: string): void {
  appendRow('system', text)
}

/** Toggle the "正在分析…" indicator; strictly follows the turn lifecycle. */
export function setWorking(on: boolean): void {
  if (on) {
    if (working === null) {
      working = createWorkingRow()
      logEl.appendChild(working.el)
      logEl.scrollTop = logEl.scrollHeight
    }
  } else if (working !== null) {
    working.stop()
    working.el.remove()
    working = null
  }
}

/** Extract text from a content-block array (image/tool blocks are ignored). */
function extractTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** Handle message/turn events (not `model/selection`). */
export function handleMessageEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const ev = event as { type?: string; data?: Record<string, unknown> }
  switch (ev.type) {
    case 'turn/start':
      setWorking(true)
      break
    case 'user/message': {
      const source = (ev.data as { source?: { kind?: string } } | undefined)?.source
      if (source?.kind !== 'user') return
      const text = extractTextFromBlocks((ev.data as { content?: unknown } | undefined)?.content)
      if (text.trim() !== '') {
        assistantRow = null
        assistantBuffer = ''
        appendRow('user', text)
      }
      break
    }
    case 'assistant/message': {
      // In a multi-step turn an assistant/message with text can be an
      // intermediate product (more tool calls/text may follow), so it does not
      // clear the working indicator — only turn/start|turn/end control that.
      const text = extractTextFromBlocks((ev.data?.message as { content?: unknown } | undefined)?.content)
      if (text.trim() !== '') {
        assistantRow = null
        assistantBuffer = ''
        appendRow('assistant', text)
      }
      break
    }
    case 'assistant/chunk': {
      // Only text-delta is rendered; reasoning/tool-call deltas are skipped.
      const chunk = (ev.data as { chunk?: unknown } | undefined)?.chunk
      if (typeof chunk === 'object' && chunk !== null) {
        const c = chunk as { type?: string; text?: unknown }
        if (c.type === 'text-delta' && typeof c.text === 'string') appendAssistantChunk(c.text)
      }
      break
    }
    case 'turn/end':
      setWorking(false)
      assistantRow = null
      assistantBuffer = ''
      break
  }
}

function appendAssistantChunk(text: string): void {
  if (assistantRow === null) assistantRow = appendRow('assistant', '')
  assistantBuffer += text
  assistantRow.innerHTML = renderMarkdown(assistantBuffer)
  logEl.scrollTop = logEl.scrollHeight
}

/** The bound session id, or `null` while the panel is still on "new session". */
export function getActiveSessionId(): string | null {
  return activeSessionId
}

/** Whether a session is bound (created here or adopted from the picker). */
export function isBound(): boolean {
  return activeSessionId !== null
}

/** Register the single identity observer (set once by `main.ts`). */
export function setSessionListener(listener: (sessionId: string | null) => void): void {
  sessionListener = listener
}

/**
 * Bind the active session, or clear it with `null` to return to "new session".
 * Idempotent; the observer fires only on an actual change.
 */
export function bindSession(sessionId: string | null): void {
  const next = typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
  if (next === activeSessionId) return
  activeSessionId = next
  sessionListener?.(next)
}

/**
 * Ensure the panel has a session identity: a bound session is returned as-is,
 * otherwise one is created now. Creation stays lazy so opening the panel never
 * litters dsh's session list. Concurrent callers share one `session.create`.
 */
export async function ensureSession(): Promise<boolean> {
  if (activeSessionId !== null) return true
  if (sessionPromise === null) {
    sessionPromise = (async () => {
      try {
        const created = await rpc<{ sessionId: string }>('session.create', {})
        if (created === undefined || typeof created.sessionId !== 'string' || created.sessionId === '') {
          appendSystem('创建会话失败：dsh 返回异常')
          return false
        }
        bindSession(created.sessionId)
        appendSystem(`会话 ${created.sessionId.slice(0, 8)}…`)
        return true
      } catch (e) {
        appendSystem(`创建会话失败: ${describeRpcError(e)}`)
        return false
      }
    })().finally(() => { sessionPromise = null })
  }
  return sessionPromise
}

/** Send a plain text prompt. */
export async function sendText(text: string): Promise<void> {
  if (text === '') return
  if (!await ensureSession()) return
  // Capture the identity: a session switch while creation/awaiting was in
  // flight must not redirect this message into another conversation.
  const sessionId = activeSessionId
  if (sessionId === null) return
  setWorking(true)
  try {
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  } catch (e) {
    setWorking(false)
    appendSystem(`发送失败: ${describeRpcError(e)}`)
  }
}

/** Whether a turn was interrupted by a disconnect (set by `main.ts`). */
export function isInterrupted(): boolean {
  return interrupted
}

/** Whether the "working" indicator is currently showing. */
export function isWorking(): boolean {
  return working !== null
}

export function setInterrupted(value: boolean): void {
  interrupted = value
}

/** Clear the conversation list and streaming state (used before a re-render). */
export function clear(): void {
  while (logEl.firstChild !== null) logEl.removeChild(logEl.firstChild)
  assistantRow = null
  assistantBuffer = ''
  setWorking(false)
}

// ---- history replay ----
//
// A replay renders a history snapshot while the session may keep producing
// events. Live frames are buffered for the duration and handed back at the end
// so the caller can apply exactly the ones the snapshot cannot contain; that
// closes the window between the snapshot being taken upstream and its response
// reaching the panel, which a plain clear+replay would silently erase.

/** Session whose history is currently being replayed, or `null`. */
let replaySessionId: string | null = null
/** Live frames held back during the current replay, in arrival order. */
let replayBuffer: BufferedSessionEvent[] = []

/**
 * Start a replay: clear the transcript, then hold back live events until
 * {@link endReplay}. A second call supersedes the first — the earlier caller's
 * {@link endReplay} becomes a no-op, so a superseded replay can neither render
 * nor flush anything.
 */
export function beginReplay(sessionId: string): void {
  replaySessionId = sessionId
  replayBuffer = []
  clear()
}

/** Whether a replay is in flight (the caller then buffers instead of rendering). */
export function isReplaying(): boolean {
  return replaySessionId !== null
}

/** Hold back one live event for the in-flight replay of the same session. */
export function bufferLiveEvent(sessionId: string, event: unknown): void {
  if (replaySessionId === null || replaySessionId !== sessionId) return
  const frame = bufferEvent(sessionId, event)
  if (frame !== undefined) replayBuffer.push(frame)
}

/**
 * Finish a replay and return the buffered live frames the snapshot cannot
 * contain, in sequence order, for the caller to dispatch like any other live
 * event. Frames already inside the snapshot are dropped here rather than
 * de-duplicated by the renderer.
 *
 * @param sessionId - session this replay was for; a superseded replay returns nothing.
 * @param replayMaxSeq - highest sequence the replay applied; negative when empty.
 * @param hasMore - whether the history was truncated, i.e. older events exist.
 * @returns buffered frames to apply, oldest first.
 */
export function endReplay(
  sessionId: string,
  replayMaxSeq: number,
  hasMore: boolean,
): readonly BufferedSessionEvent[] {
  if (replaySessionId !== sessionId) return []
  replaySessionId = null
  const { apply, dropped } = selectEventsAfterReplay(replayBuffer, replayMaxSeq)
  replayBuffer = []
  if (hasMore) prependSystem('更早消息未显示')
  if (dropped > 0) {
    // Only reachable when a history read stalls long enough to overrun the
    // buffer, or when a frame arrives without a usable sequence.
    appendLog({ time: Date.now(), level: 'warn', msg: `会话历史重放丢弃了 ${dropped} 条实时事件` })
  }
  return apply
}

/** Insert a centered notice above the transcript (older-history notice). */
export function prependSystem(text: string): void {
  const row = conversationRow('system', text)
  logEl.insertBefore(row, logEl.firstChild)
}
