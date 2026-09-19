/**
 * System config dialog: the panel-side entry point for pointing the extension
 * at a dsh that is not on this machine.
 *
 * The dialog is deliberately able to answer "is this configuration right?"
 * on the spot: typing resolves the address locally (no network), `测试连接`
 * runs one isolated handshake through the background, and saving reports the
 * outcome of the real reconnect — a failed save keeps the dialog open with the
 * user's input intact instead of dropping them into an unexplained retry loop.
 *
 * @module
 */

import { normalizeBridgeToken, resolveBridgeHost } from '@dsh-browser/protocol'
import type { BridgeCaps } from '@dsh-browser/protocol'
import { post } from './transport.ts'
import { narrowPageSharing, type PageSharingPreference } from '../common/page-sharing.ts'

/** Settings as the panel knows them (mirrors the background's persisted shape). */
export interface PanelSettings {
  host: string
  token: string
  /** Present on a status broadcast so the sharing control can mirror the real value. */
  sharePageContent?: PageSharingPreference
}

/** Result of one connection test, as the background reports it. */
export type BridgeTestResult =
  | { ok: true; url: string; caps: BridgeCaps }
  | { ok: false; phase: BridgeTestPhase; message: string }

/** How long a save may wait for the background's receipt. */
const APPLY_TIMEOUT_MS = 15_000
/** How long a saved endpoint may take to reach `connected` before we call it unreachable. */
const CONFIRM_TIMEOUT_MS = 20_000

/** Failure stage reported by one connection test. */
export type BridgeTestPhase = 'invalid-address' | 'unusable-url' | 'unreachable' | 'token-rejected' | 'handshake-timeout'

const PHASE_LABELS: Record<BridgeTestPhase, string> = {
  'invalid-address': '地址格式无效',
  'unusable-url': '地址无法使用',
  unreachable: '地址不可达',
  'token-rejected': '地址可达，但 token 被拒绝',
  'handshake-timeout': '地址可达，但握手超时',
}

const overlayEl = document.getElementById('settingsOverlay')!
const hostEl = document.getElementById('settingsHost') as HTMLInputElement
const tokenEl = document.getElementById('settingsToken') as HTMLInputElement
const effectiveEl = document.getElementById('settingsEffective')!
const resultEl = document.getElementById('settingsResult')!
const toggleBtn = document.getElementById('settingsToggle') as HTMLButtonElement
const testBtn = document.getElementById('settingsTest') as HTMLButtonElement
const saveBtn = document.getElementById('settingsSave') as HTMLButtonElement
const resetBtn = document.getElementById('settingsReset') as HTMLButtonElement
const closeBtn = document.getElementById('settingsClose') as HTMLButtonElement
const sharingEl = document.getElementById('settingsSharing') as HTMLSelectElement

let current: PanelSettings = { host: '', token: '' }
/** Mirror of the persisted sharing preference, so the control never shows a stale value. */
let sharing: PageSharingPreference = 'auto'
let testPending = false
/** A save is in flight: awaiting the background's receipt. */
let applyPending = false
/** A save was accepted and the bridge is connecting right now. */
let awaitingConnect: string | null = null
let applyTimer: ReturnType<typeof setTimeout> | undefined
/** Bounds how long a saved endpoint may take to report `connected`. */
let confirmTimer: ReturnType<typeof setTimeout> | undefined

function clearApplyTimer(): void {
  if (applyTimer !== undefined) {
    clearTimeout(applyTimer)
    applyTimer = undefined
  }
}

function clearConfirmTimer(): void {
  if (confirmTimer !== undefined) {
    clearTimeout(confirmTimer)
    confirmTimer = undefined
  }
}

/** Render a result line in one of the three visual states; `''` hides it. */
function setResult(kind: 'pending' | 'ok' | 'error' | 'none', text: string): void {
  resultEl.className = kind === 'none' ? '' : `show ${kind}`
  resultEl.textContent = text
}

/**
 * Recompute the effective address preview from the current inputs. Pure and
 * local: this runs on every keystroke and must never touch the network.
 */
function renderEffective(): void {
  const raw = hostEl.value
  if (raw.trim() === '') {
    effectiveEl.className = ''
    effectiveEl.textContent = '留空：自动发现本机 dsh（探测 3080 / 3081 / 3090 / 14389 / 43189）'
    testBtn.disabled = true
    testBtn.title = '留空时由背景自动发现本机 dsh，无需测试'
    return
  }
  testBtn.disabled = testPending
  testBtn.title = ''
  const resolved = resolveBridgeHost(raw)
  if (!resolved.ok) {
    effectiveEl.className = 'invalid'
    effectiveEl.textContent = `✗ ${resolved.message}`
    return
  }
  const token = normalizeBridgeToken(tokenEl.value)
  const needsToken = !resolved.loopback
  if (resolved.plaintext) {
    effectiveEl.className = 'warn'
    effectiveEl.textContent = `⚠ 生效地址 ${resolved.url}（明文 ws，跨网段传输不安全，建议用 wss:// 反代）`
    return
  }
  effectiveEl.className = ''
  effectiveEl.textContent = `生效地址 ${resolved.url}${needsToken && token === '' ? '（远端连接必须填 token）' : ''}`
}

function setOpen(open: boolean): void {
  overlayEl.classList.toggle('open', open)
  if (open) {
    renderEffective()
    if (hostEl.value.trim() === '') hostEl.focus()
  } else {
    clearApplyTimer()
    clearConfirmTimer()
    applyPending = false
    awaitingConnect = null
    saveBtn.disabled = false
    testPending = false
  }
}

/**
 * Remember the settings the background is actually using. Called on every
 * `status` broadcast, so opening the dialog always reflects what is in effect
 * (including the host auto-discovery resolved).
 */
export function rememberSettings(next: PanelSettings): void {
  current = next
}

/** Open the dialog, pre-filled with the settings the background reported. */
export function openSettings(): void {
  hostEl.value = current.host
  tokenEl.value = current.token
  setResult('none', '')
  setOpen(true)
}

function closeDialog(): void {
  setOpen(false)
}

interface TestResultMessage {
  id: string
  result: BridgeTestResult
}

let lastTestId: string | null = null
let testSeq = 0

/** Start one isolated handshake for the typed address; never touches the live bridge. */
function runTest(): void {
  if (testPending || applyPending) return
  const resolved = resolveBridgeHost(hostEl.value)
  if (!resolved.ok) {
    setResult('error', `✗ ${resolved.message}`)
    return
  }
  testPending = true
  testBtn.disabled = true
  lastTestId = `t${++testSeq}`
  setResult('pending', '正在建立一次性连接并握手…')
  post({ type: 'bridge.test', id: lastTestId, host: hostEl.value, token: tokenEl.value })
}

/** Settle the pending test (or ignore a result that belongs to an older one). */
export function applyTestResult(message: TestResultMessage): void {
  if (lastTestId === null || message.id !== lastTestId) return
  lastTestId = null
  testPending = false
  testBtn.disabled = hostEl.value.trim() === ''
  const { result } = message
  if (result.ok) {
    setResult('ok', `✓ 已验证：${result.url} 连接并握手成功（快照预算 ${result.caps.snapshotMaxChars} 字符 / ${result.caps.maxInteractiveItems} 项）`)
    return
  }
  setResult('error', `✗ ${PHASE_LABELS[result.phase]}：${result.message}`)
}

/** Persist the typed settings and reconnect; the dialog stays open until the outcome arrives. */
function runSave(): void {
  if (applyPending) return
  const resolved = resolveBridgeHost(hostEl.value)
  if (!resolved.ok) {
    setResult('error', `✗ ${resolved.message}`)
    return
  }
  applyPending = true
  saveBtn.disabled = true
  setResult('pending', resolved.url === '' ? '已保存，正在回到本机自动发现…' : `已保存，正在连接 ${resolved.url}…`)
  clearApplyTimer()
  applyTimer = setTimeout(() => {
    applyPending = false
    saveBtn.disabled = false
    setResult('error', '✗ 保存后台未回报结果（扩展可能被重新加载）。请再点一次「保存并重连」。')
  }, APPLY_TIMEOUT_MS)
  post({ type: 'settings', settings: { host: hostEl.value, token: tokenEl.value } })
}

/**
 * Settle a pending save with the receipt the background sent. `ok` here only
 * means the bridge was told to connect — the honest outcome arrives as the next
 * status broadcast, so this only closes the dialog when the bridge is already
 * connected, and otherwise arms {@link applyConnectionState}.
 * @param ok - whether an endpoint was resolved and handed to the bridge.
 * @param error - the reason, when no endpoint could be used.
 * @param pendingUrl - the endpoint being connected to, when `ok` is true.
 */
export function applySettingsApplied(ok: boolean, error: string, pendingUrl = ''): void {
  if (!applyPending) return
  clearApplyTimer()
  applyPending = false
  hostEl.value = current.host
  tokenEl.value = current.token
  renderEffective()
  if (!ok) {
    saveBtn.disabled = false
    setResult('error', `✗ ${error}`)
    return
  }
  awaitingConnect = pendingUrl
  setResult('pending', pendingUrl === ''
    ? '已保存，正在回到本机自动发现…'
    : `已保存，正在连接 ${pendingUrl}…`)
  clearConfirmTimer()
  confirmTimer = setTimeout(failConnection, CONFIRM_TIMEOUT_MS)
}

/**
 * Track the connection state of a saved configuration. `connected` is the only
 * honest success signal — it means the handshake completed — so the dialog
 * closes only then. `reconnecting` keeps waiting, because the bridge keeps
 * retrying and a slow link may still come up; {@link CONFIRM_TIMEOUT_MS} bounds
 * that wait.
 * @param state - the live bridge state from the latest status broadcast.
 */
export function applyConnectionState(state: string): void {
  if (awaitingConnect === null) return
  if (state === 'connected') {
    clearConfirmTimer()
    awaitingConnect = null
    saveBtn.disabled = false
    setOpen(false)
    return
  }
  if (state === 'connecting' || state === 'reconnecting') return
  // `stopped` after a save: the manager gave up (e.g. superseded by another
  // profile), which no amount of waiting will resolve.
  failConnection()
}

/** Report a saved-but-unreachable endpoint and hand the dialog back to the user. */
function failConnection(): void {
  const url = awaitingConnect ?? ''
  clearConfirmTimer()
  awaitingConnect = null
  saveBtn.disabled = false
  setResult('error', url === ''
    ? '✗ 未发现本机 dsh（探测 3080 / 3081 / 3090 / 14389 / 43189 均无响应）'
    : `✗ 地址不可达：无法连接到 ${url}（网络不可达、端口未开放或被防火墙拦截）`)
}

/** Reset to zero-config local discovery (does not reconnect until saved). */
function runReset(): void {
  hostEl.value = ''
  tokenEl.value = ''
  setResult('none', '')
  renderEffective()
  hostEl.focus()
}

/** Wire the dialog controls. Called once by the panel composition root. */
export function initSettings(): void {
  toggleBtn.addEventListener('click', () => {
    if (overlayEl.classList.contains('open')) closeDialog()
    else openSettings()
  })
  closeBtn.addEventListener('click', closeDialog)
  overlayEl.addEventListener('click', (event) => { if (event.target === overlayEl) closeDialog() })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlayEl.classList.contains('open')) closeDialog()
  })
  hostEl.addEventListener('input', renderEffective)
  tokenEl.addEventListener('input', renderEffective)
  testBtn.addEventListener('click', runTest)
  saveBtn.addEventListener('click', runSave)
  resetBtn.addEventListener('click', runReset)
  // Applied on change rather than on save: the preference takes effect on the
  // next tool call, so folding it into a connection reconnect would be a lie
  // about when it applies.
  sharingEl.addEventListener('change', () => {
    setPageSharing(sharingEl.value)
    post({ type: 'page-sharing.set', value: sharing })
  })
  renderEffective()
  renderSharing()
}

/**
 * Adopt the background's sharing preference and reflect it in the control.
 *
 * Called from the status broadcast, which is how a change made elsewhere — the
 * approval dialog's "总是允许读取" — becomes visible and reversible here.
 * @param value - the persisted preference.
 */
export function setPageSharing(value: unknown): void {
  sharing = narrowPageSharing(value) ?? 'auto'
  renderSharing()
}

function renderSharing(): void {
  if (sharingEl.value !== sharing) sharingEl.value = sharing
}
