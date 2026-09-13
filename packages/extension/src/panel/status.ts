/**
 * Connection status bar rendering (dot + label + URL + current page).
 *
 * @module
 */

import type { BridgeState } from '../background/bridge.ts'

const STATE_LABELS: Record<string, string> = {
  connected: '已连接 dsh',
  connecting: '连接中…',
  reconnecting: '重连中…',
  stopped: '已停止',
}

const statusEl = document.getElementById('status')!
const statusText = document.getElementById('statusText')!
const statusUrlEl = document.getElementById('statusUrl')!
const pageUrlEl = document.getElementById('pageUrl')!

/** Update the status bar to reflect the current bridge connection state. */
export function setStatus(state: BridgeState, url = '', attempt = 0): void {
  statusEl.className = state
  statusText.textContent = STATE_LABELS[state] ?? state
  const attemptSuffix = state === 'reconnecting' && attempt > 0 ? `（第 ${attempt} 次）` : ''
  statusUrlEl.textContent = url !== ''
    ? `${attemptSuffix}${url.replace('ws://127.0.0.1:', ':')}`
    : attemptSuffix
}

/** Update the "current page" line, or reset to a dash when none is tracked. */
export function setActivePage(page: { url: string; title: string } | null): void {
  if (page !== null) {
    pageUrlEl.textContent = `${page.title || '(无标题)'} — ${page.url}`
  } else {
    pageUrlEl.textContent = '—'
  }
}
