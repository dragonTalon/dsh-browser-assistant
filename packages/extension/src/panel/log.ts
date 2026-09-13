/**
 * Diagnostics log panel (collapsible ring-buffer replay, distinct from the
 * conversation list).
 *
 * @module
 */

import { logLine } from '../common/ui/row.ts'

const logPanelEl = document.getElementById('logPanel')!
const logToggleEl = document.getElementById('logToggle') as HTMLButtonElement

/** Append one diagnostics line, keeping the panel scrolled to the tail. */
export function appendLog(entry: { time: number; level: string; msg: string }): void {
  logPanelEl.appendChild(logLine(entry))
  logPanelEl.scrollTop = logPanelEl.scrollHeight
}

/** Replace the whole diagnostics panel with a snapshot (on panel open). */
export function renderLogSnapshot(entries: unknown): void {
  if (!Array.isArray(entries)) return
  logPanelEl.textContent = ''
  for (const e of entries) appendLog(e as { time: number; level: string; msg: string })
}

/** Bind the collapse/expand toggle (called once from `main.ts`). */
export function initLog(): void {
  logToggleEl.addEventListener('click', () => {
    logPanelEl.classList.toggle('open')
  })
}
