/**
 * List-row components for the panel: conversation rows (user/assistant/system),
 * the animated "working" indicator, and diagnostics log lines.
 *
 * The Markdown-vs-plain-text policy is centralized here: assistant rows render
 * sanitized Markdown, every other kind uses `textContent` (never parsed as HTML).
 *
 * @module
 */

import { el } from './el.ts'
import { renderMarkdown } from '../tools/markdown.ts'
import { fmtTime } from '../tools/format.ts'

export type RowKind = 'user' | 'assistant' | 'system'

/** Build one conversation row, applying the correct rendering policy per kind. */
export function conversationRow(kind: RowKind, text: string): HTMLElement {
  const row = el('div', { class: `row ${kind}` })
  if (kind === 'assistant') {
    row.innerHTML = renderMarkdown(text)
  } else {
    row.textContent = text
  }
  return row
}

export interface WorkingRow {
  readonly el: HTMLElement
  /** Stop the animation timer and release resources. */
  stop(): void
}

/** Build the animated "正在分析…" indicator; `stop()` clears its interval. */
export function createWorkingRow(): WorkingRow {
  const row = el('div', { class: 'row working', children: [
    el('span', { class: 'spinner' }),
    el('span', { text: '正在分析' }),
  ] })
  const timer = setInterval(() => {
    const label = row.querySelector('span:last-child')
    if (label === null) return
    const dots = (label.textContent?.match(/\./g) ?? []).length
    label.textContent = '正在分析' + '.'.repeat((dots % 3) + 1)
  }, 500)
  return { el: row, stop() { clearInterval(timer) } }
}

/** Build one diagnostics log line (`HH:MM:SS` + message). */
export function logLine(entry: { time: number; level: string; msg: string }): HTMLElement {
  return el('div', { class: `logline ${entry.level}`, children: [
    el('span', { class: 't', text: fmtTime(entry.time) }),
    entry.msg,
  ] })
}
