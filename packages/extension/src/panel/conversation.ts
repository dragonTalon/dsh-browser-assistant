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
import { conversationRow, createWorkingRow, renderMarkdown, type WorkingRow } from '../common/index.ts'

const logEl = document.getElementById('log')!

let sessionId: string | null = null
let sessionPromise: Promise<boolean> | null = null
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

/** The current session id, or `null` before first creation. */
export function getSessionId(): string | null {
  return sessionId
}

/** Create the session lazily; concurrent callers share one `session.create`. */
export async function ensureSession(): Promise<boolean> {
  if (sessionId !== null) return true
  if (sessionPromise === null) {
    sessionPromise = (async () => {
      try {
        const created = await rpc<{ sessionId: string }>('session.create', {})
        if (created === undefined || typeof created.sessionId !== 'string' || created.sessionId === '') {
          appendSystem('创建会话失败：dsh 返回异常')
          return false
        }
        sessionId = created.sessionId
        appendSystem(`会话 ${sessionId.slice(0, 8)}…`)
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
