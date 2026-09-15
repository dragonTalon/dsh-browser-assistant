/**
 * Session picker: renders the status bar's session dropdown and reports the
 * user's choice.
 *
 * The picker owns presentation only — which sessions are offered and how they
 * read is decided by the pure `common/session-list.ts` rules, and what a
 * selection *does* is the composer's job (`main.ts`). It follows the panel's
 * model-selector idiom: a render signature keeps 20s status heartbeats from
 * rebuilding the `<option>` list, and every label is written as text (session
 * titles come from user prompts upstream and are never interpolated as HTML).
 *
 * @module
 */

import { rpc } from './transport.ts'
import { describeCodeSuffix, describeRpcError } from './errors.ts'
import { appendSystem, getActiveSessionId, setSessionListener } from './conversation.ts'
import {
  SESSION_OPTION_LIMIT,
  buildSessionOptions,
  el,
  errorCode,
  formatSessionOption,
  type SessionOption,
} from '../common/index.ts'

const selectEl = document.getElementById('sessionSelect') as HTMLSelectElement

/** `<option>` value of the always-present "create a new session" choice. */
const NEW_SESSION_VALUE = '__new__'

/** Placeholder shown before the bridge reports connected. */
const CONNECTING_LABEL = '等待连接…'
/** Placeholder shown while the session list is being fetched. */
const LOADING_LABEL = '会话加载中…'
/** Placeholder shown when the session list could not be read. */
const UNAVAILABLE_LABEL = '会话列表不可用'

/** Reusable sessions from the last successful list read, newest first. */
let options: readonly SessionOption[] = []
/** Rows from the last successful read, so a bound session keeps its full label. */
const currentOptionCache = new Map<string, SessionOption>()
let truncated = false
let connected = false
let loading = false
let failed = false
/** Last render signature: status heartbeats re-broadcast constantly. */
let rowSignature = ''
/** Reported selections; set once by `main.ts`. */
let onSelect: ((sessionId: string | null) => void) | null = null

/**
 * Bind the dropdown's change handler and start following identity changes.
 * The picker re-renders whenever a session is created lazily inside
 * `conversation.ensureSession()`, so a first send visibly binds the new session.
 * @param handler - receives the selected session id, or `null` for "new session".
 */
export function initSessionSelector(handler: (sessionId: string | null) => void): void {
  onSelect = handler
  selectEl.addEventListener('change', () => { reportSelection() })
  setSessionListener(() => { renderSessionRow(true) })
  renderSessionRow(true)
}

/** Set the bridge connection state so the placeholder is correct. */
export function setConnected(value: boolean): void {
  connected = value
  renderSessionRow()
}

/**
 * Refresh the reusable-session candidates. A failure is surfaced in the
 * conversation area and leaves "new session" selected: the picker degrades to
 * "you can still start a new conversation", never to a blocker.
 */
export async function loadSessions(): Promise<void> {
  if (loading) return
  loading = true
  failed = false
  renderSessionRow(true)
  try {
    const page = await rpc<{ items?: unknown }>('session.list', {})
    const built = buildSessionOptions(page?.items, Date.now())
    options = built.options
    truncated = built.truncated
    for (const option of options) currentOptionCache.set(option.id, option)
  } catch (error: unknown) {
    options = []
    truncated = false
    failed = true
    appendSystem(`会话列表加载失败${describeCodeSuffix(errorCode(error))}: ${describeRpcError(error)}`)
  } finally {
    loading = false
    renderSessionRow(true)
  }
}

/**
 * Rebuild the dropdown. Skipped when nothing visible changed, so the 20s
 * status heartbeat does not churn the element the user is interacting with.
 * @param force - render even when the signature is unchanged.
 */
export function renderSessionRow(force = false): void {
  const bound = getActiveSessionId()
  const sig = JSON.stringify({ o: options, t: truncated, c: connected, l: loading, f: failed, b: bound })
  if (!force && sig === rowSignature) return
  rowSignature = sig
  selectEl.textContent = ''

  if (!connected) {
    appendPlaceholder(CONNECTING_LABEL, '等待连接 dsh')
    return
  }
  if (loading) {
    appendPlaceholder(LOADING_LABEL, '正在读取 dsh 会话列表')
    return
  }

  selectEl.disabled = false
  selectEl.title = '选择本次驱动哪个 dsh 会话；默认「新会话」'
  selectEl.appendChild(el('option', {
    text: '新会话',
    attrs: { value: NEW_SESSION_VALUE, ...(bound === null ? { selected: '' } : {}) },
  }))

  // A session created moments ago is not in the last list read yet; show it
  // anyway so the dropdown always names the session the panel is driving.
  const known = new Set(options.map((option) => option.id))
  if (bound !== null && !known.has(bound)) {
    const cached = currentOptionCache.get(bound)
    selectEl.appendChild(el('option', {
      text: cached === undefined
        ? `${bound.slice(0, 8)}…（当前）`
        : `${formatSessionOption(cached)}（当前）`,
      title: `${bound}（当前会话）`,
      attrs: { value: bound, selected: '' },
    }))
  }

  for (const option of options) {
    selectEl.appendChild(el('option', {
      text: formatSessionOption(option),
      title: formatSessionOption(option),
      attrs: { value: option.id, ...(option.id === bound ? { selected: '' } : {}) },
    }))
  }

  if (truncated) {
    selectEl.appendChild(el('option', {
      text: `仅显示最近 ${SESSION_OPTION_LIMIT} 个`,
      attrs: { value: '__truncated__', disabled: '' },
    }))
  }
  if (failed) {
    selectEl.appendChild(el('option', { text: UNAVAILABLE_LABEL, attrs: { value: '__failed__', disabled: '' } }))
  }
}

/** Disable the dropdown behind a single placeholder option. */
function appendPlaceholder(label: string, title: string): void {
  selectEl.disabled = true
  selectEl.title = title
  selectEl.appendChild(el('option', { text: label, attrs: { value: '__placeholder__', selected: '' } }))
}

/** Report the user's choice; the composer decides what it means. */
function reportSelection(): void {
  if (selectEl.disabled) return
  const value = selectEl.value
  if (value === NEW_SESSION_VALUE) {
    onSelect?.(null)
  } else if (!value.startsWith('__')) {
    onSelect?.(value)
  }
  // Re-render either way: when the composer refuses or ignores the choice, the
  // dropdown must fall back to naming the session the panel actually drives.
  renderSessionRow(true)
}
