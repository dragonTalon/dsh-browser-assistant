/**
 * Session permission tier selector for the panel.
 *
 * The tier is a property of the dsh session, so this module holds no authority
 * over it: candidates and the current value come from the session's
 * `permissions` projection, and a pick is submitted as a bridge RPC whose
 * effect is confirmed by the projection flowing back. Nothing here derives a
 * tier from local settings, and no local value can widen what the bridge
 * enforces.
 *
 * @module
 */

import { BRIDGE_PERMISSION_SET_METHOD, CUSTOM_PERMISSION_VALUE } from '@dsh-browser/protocol'
import { rpc } from './transport.ts'
import { describeCodeSuffix, describeRpcError } from './errors.ts'
import { ensureSession, appendSystem, getActiveSessionId, bindSession } from './conversation.ts'
import { el, errorCode } from '../common/index.ts'

/**
 * Resolved DOM handles, filled by {@link initPermissionSelector} / {@link initFullAccessGate}.
 *
 * Deliberately resolved lazily rather than at module scope: a module-scope
 * `document` read makes the whole file unloadable outside a browser, which
 * would leave the tier rules (label mapping, `custom` handling, candidate
 * selection) reachable only by opening Chrome. Every function below tolerates
 * the handles being absent so the pure parts can be driven headlessly.
 */
let selectEl: HTMLSelectElement | null = null
let lockEl: HTMLElement | null = null
let overlayEl: HTMLElement | null = null
let ackEl: HTMLInputElement | null = null
let confirmEl: HTMLButtonElement | null = null
let cancelEl: HTMLElement | null = null

function resolveElements(): void {
  selectEl = document.getElementById('permissionSelect') as HTMLSelectElement | null
  lockEl = document.getElementById('permissionLock')
}

function resolveGateElements(): void {
  overlayEl = document.getElementById('fullAccessOverlay')
  ackEl = document.getElementById('fullAccessAck') as HTMLInputElement | null
  confirmEl = document.getElementById('fullAccessConfirm') as HTMLButtonElement | null
  cancelEl = document.getElementById('fullAccessCancel')
}

/** One tier the session advertises. */
interface TierOption {
  value: string
  /** Display label as the projection published it, when it published one. */
  name?: string
}

let options: TierOption[] = []
/**
 * The tiers this DEPLOYMENT offers, learned from the session list.
 *
 * Kept apart from {@link options} because it is not any one session's data: it
 * is what lets a user configure the tier for a session that does not exist yet.
 * The panel's "new session" state has no bound session, but the deployment's
 * preset table is already knowable — every session's projection publishes it.
 */
let deploymentOptions: TierOption[] = []
let currentValue: string | null = null
let pending = false
let connected = false
let deploymentLoading = false
/**
 * The connected bridge answered the switch RPC with "no such method".
 *
 * That means the bridge process predates the tier RPC even though the dsh-side
 * projection already advertises tiers (a rebuilt bundle is not a reloaded one).
 * Once known, the control stops offering switches — retrying can only produce
 * the same refusal, and pretending the capability exists while every click fails
 * is worse than saying so. Cleared on reconnect, so reloading the plugin is
 * enough to recover without touching the extension.
 */
let switchUnsupported = false
/**
 * An announcement that arrived while a history replay owned the display.
 *
 * The tier is a current-value snapshot, but it still cannot be applied during a
 * replay: the replay ends by adopting the history response's projection, which
 * was computed BEFORE this announcement — so applying it eagerly would let a
 * stale baseline overwrite it, and nothing re-announces a value that already
 * changed. Holding the newest frame and applying it right after the replay keeps
 * the projection as the baseline while never losing a later change.
 */
let deferred: { sessionId: string; value: string } | null = null

/**
 * Labels for the tiers dsh ships, mirroring the dsh interface verbatim so the
 * two surfaces name the same tier the same way. A deployment that publishes its
 * own preset names gets those names instead — never a borrowed standard label.
 */
const TIER_LABELS: Record<string, string> = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
}

/**
 * What each standard tier means for BROWSER operations specifically. dsh's own
 * copy describes files and commands; the browser half needs its own sentence so
 * the user can tell what picking a tier will actually do here.
 */
const TIER_BROWSER_SCOPE: Record<string, string> = {
  'read-only': '只能读取页面与观察（快照、读文本、滚动、等待）；不能操作页面，也不能打开或跳转网站',
  'workspace-write': '可以操作页面与打开网站，但每一次都需要人工确认',
  'danger-full-access': '可以操作页面与打开网站，且不再需要人工确认',
}

/**
 * The shared refusal copy for a bridge whose process predates the tier RPC.
 * Referenced by the control's disabled-state tooltip and the system message
 * after a failed switch, so the two surfaces cannot drift apart.
 */
const SWITCH_UNSUPPORTED_MESSAGE =
  '所连 dsh 的桥接进程尚未支持切换权限档位（bundle 已更新但插件未重载）。'

/** Label for one tier value; a non-standard name keeps its published name or raw value. */
export function labelOf(value: string): string {
  if (value === CUSTOM_PERMISSION_VALUE) return '自定义'
  return TIER_LABELS[value] ?? options.find(option => option.value === value)?.name ?? value
}

/** Browser-scope annotation for one tier value, or an empty string when unknown. */
export function scopeOf(value: string): string {
  if (value === CUSTOM_PERMISSION_VALUE) {
    return '当前生效的 sandbox 模式与审批策略不匹配任何预设，按最严档位「仅可查看」判定浏览器操作'
  }
  return TIER_BROWSER_SCOPE[value] ?? '该档位由所连 dsh 定义，浏览器操作按桥接下发的策略执行'
}

/**
 * Whether one tier may be picked.
 *
 * `custom` is a derived description of settings, not a preset, so it can be
 * shown but never selected — sending it would ask dsh to switch to a state that
 * has no configuration.
 * @param value - candidate tier value.
 * @returns true when the tier is a switch target.
 */
export function isSelectable(value: string): boolean {
  return value !== CUSTOM_PERMISSION_VALUE
}

/** Read the `permissions` projection out of a `session.history` response. */
function permissionProjection(page: unknown): { options?: unknown; currentValue?: unknown } | undefined {
  return (page as { projections?: { values?: { permissions?: { options?: unknown; currentValue?: unknown } } } })
    .projections?.values?.permissions
}

/** Adopt a projection view as the authoritative state. */
function adopt(view: { options?: unknown; currentValue?: unknown } | undefined): boolean {
  if (view === undefined) return false
  const next: TierOption[] = []
  if (Array.isArray(view.options)) {
    for (const raw of view.options) {
      if (typeof raw !== 'object' || raw === null) continue
      const entry = raw as { value?: unknown; name?: unknown }
      if (typeof entry.value !== 'string' || entry.value === '') continue
      next.push({ value: entry.value, ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}) })
    }
  }
  const nextCurrent = typeof view.currentValue === 'string' && view.currentValue !== '' ? view.currentValue : null
  // A deployment that publishes no tier list has no tier capability: keep the
  // control unavailable rather than showing an empty picker.
  if (next.length === 0 && nextCurrent === null) return false
  // A current value the list omits still gets a row: hiding the real state to
  // satisfy a list would misreport what the session is actually running under.
  if (nextCurrent !== null && !next.some(option => option.value === nextCurrent)) {
    next.push({ value: nextCurrent })
  }
  options = next
  currentValue = nextCurrent
  return true
}

/** Render the control from the current state. No-op without a resolved handle. */
export function renderPermissionRow(): void {
  const target = selectEl
  if (target === null) return
  target.replaceChildren()
  const current = currentValue
  target.className = ''

  if (!connected) {
    target.appendChild(el('option', { text: '等待连接…', attrs: { selected: '' } }))
    target.disabled = true
    target.title = '等待连接 dsh'
    return
  }
  if (current === null) {
    // No tier value has been read yet. Two situations share this state and they
    // need different copy, because only one of them is a limitation:
    //   • a session is bound whose projection has not arrived yet;
    //   • the panel is on "new session" and no session exists at all — the tier
    //     is still configurable there, because picking one creates the session
    //     (the same lazy creation the model picker already triggers).
    const tiers = candidateTiers()
    if (tiers.length === 0) {
      target.appendChild(el('option', { text: '权限不可用', attrs: { selected: '' } }))
      target.disabled = true
      target.title = 'dsh 未提供权限档位——浏览器操作按默认策略执行'
      return
    }
    for (const option of tiers) {
      target.appendChild(el('option', {
        text: labelOf(option.value),
        attrs: {
          value: option.value,
          ...(isSelectable(option.value) && !pending ? {} : { disabled: '' }),
        },
      }))
    }
    target.disabled = pending
    target.className = ''
    target.title = hasSession()
      ? '读取本会话权限中…选定即切换'
      : '为新会话选择权限档位；选定后会创建会话并生效'
    return
  }

  if (switchUnsupported) {
    target.appendChild(el('option', { text: '需重载 dsh 插件', attrs: { selected: '' } }))
    target.disabled = true
    target.title = `${SWITCH_UNSUPPORTED_MESSAGE}在 dsh 中重载 bridge-dsh 插件后，本控件会自动恢复。`
    return
  }

  for (const option of candidateTiers()) {
    const selectable = isSelectable(option.value) && !pending
    target.appendChild(el('option', {
      text: labelOf(option.value),
      attrs: {
        value: option.value,
        ...(option.value === current ? { selected: '' } : {}),
        ...(selectable ? {} : { disabled: '' }),
      },
    }))
  }
  target.disabled = pending
  // The class drives the tier colour; an unknown tier keeps the neutral border.
  target.className = current === 'danger-full-access'
    ? 'tier-danger-full-access'
    : current === 'workspace-write' ? 'tier-workspace-write' : 'tier-read-only'
  target.title = `${labelOf(current)}\n${scopeOf(current)}`
}

/**
 * Test seam for the session-bound probe.
 *
 * The branch this guards — "a session is bound but its tier projection has not
 * been read yet" — cannot be reached from outside the module, because binding a
 * session is the conversation module's job and there is no way to bind one
 * without a live bridge. Leaving the branch unverifiable would be worse than a
 * one-line seam that production never assigns.
 */
let sessionProbeOverride: (() => string | null) | null = null

/**
 * The panel's transport wiring, re-exported for headless checks.
 *
 * `main.ts` installs the inbound-listener switch at startup; a check that
 * bundles this module alone would otherwise have every `rpc.result` silently
 * dropped, because the transport forwards inbound messages only to that
 * installed listener. Re-exporting the setter lets a check complete the wiring
 * without importing a second copy of the transport (which would be a different
 * instance with its own pending-call table).
 */
export { setMessageListener } from './transport.ts'

/**
 * Override the session probe. Test-only: production never calls this, and the
 * default keeps reading the real bound session.
 *
 * Passing a session ID also BINDS it through this module's own conversation
 * instance. That matters because a check bundles this module on its own, so its
 * conversation copy is separate from any the check might import directly — a
 * session bound over there would be invisible to the guards here.
 * @param probe - a replacement probe, a session ID to bind, or null to restore.
 */
export function setDeploymentTiersForTest(options: unknown): void {
  // Assign unconditionally, including empty: a check must be able to clear it,
  // otherwise one case's deployment list leaks into every later case.
  deploymentOptions = tierOptionsOf({ options })
  renderPermissionRow()
}

export function setSessionProbeForTest(probe: (() => string | null) | string | null): void {
  if (typeof probe === 'string') {
    // The empty string means "no session": it must genuinely UNBIND, because a
    // case that merely drops the override would still see a session an earlier
    // case bound through this same module instance.
    bindSession(probe === '' ? null : probe)
    sessionProbeOverride = null
    renderPermissionRow()
    return
  }
  sessionProbeOverride = probe
  renderPermissionRow()
}

/** Whether a session is bound, so a tier can be addressed at all. */
function hasSession(): boolean {
  return (sessionProbeOverride ?? getActiveSessionId)() !== null
}

/**
 * Parse one projection value into the tiers it advertises.
 * @param value - a `permissions` projection value, or anything else.
 * @returns the advertised tiers; empty when the value carries none.
 */
function tierOptionsOf(value: unknown): TierOption[] {
  if (typeof value !== 'object' || value === null) return []
  const entries = (value as { options?: unknown }).options
  if (!Array.isArray(entries)) return []
  const tiers: TierOption[] = []
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as { value?: unknown; name?: unknown }
    if (typeof entry.value !== 'string' || entry.value === '') continue
    tiers.push({ value: entry.value, ...(typeof entry.name === 'string' && entry.name !== '' ? { name: entry.name } : {}) })
  }
  return tiers
}

/**
 * Learn this deployment's tier list from the session list.
 *
 * This is what makes the tier configurable BEFORE a session exists. Any session's
 * projection publishes the deployment's preset table, so one read-only list call
 * is enough — and it deliberately does not create a session, keeping the panel's
 * "opening it never litters dsh's session list" rule intact.
 *
 * Called on connect; a failure is silent because the control simply falls back to
 * showing nothing until a session is bound and its own projection arrives.
 */
export async function loadDeploymentTiers(): Promise<void> {
  if (deploymentLoading) return
  deploymentLoading = true
  try {
    const page = await rpc<{ items?: unknown }>('session.list', {})
    const items = Array.isArray(page?.items) ? page.items : []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const projections = (item as { projections?: { values?: { permissions?: unknown } } }).projections
      const tiers = tierOptionsOf(projections?.values?.permissions)
      if (tiers.length > 0) {
        deploymentOptions = tiers
        renderPermissionRow()
        return
      }
    }
  } catch {
    // Leave it empty: the session-bound path still fills the control.
  } finally {
    deploymentLoading = false
  }
}

/** The tiers to offer right now: this session's if read, else the deployment's. */
function candidateTiers(): TierOption[] {
  return options.length > 0 ? options : deploymentOptions
}

/** Align from a `session.history` projection (called after a history replay). */
export function alignFromProjections(page: unknown): void {
  if (adopt(permissionProjection(page))) renderPermissionRow()
}

/**
 * Read one session's tier projection directly.
 *
 * Needed because a session can be bound without any history read: the panel's
 * own `ensureSession` creates one for the first send or the first model pick,
 * and only `openSession` replays history. The tier lives in that projection, so
 * a freshly created session would otherwise show as having no tier at all.
 *
 * Fire-and-forget by design: the caller is a bind notification with no place to
 * await, and a failed read leaves the control in its "unavailable" state rather
 * than blocking anything.
 * @param sessionId - the session to read, or null to clear the display.
 */
export function loadForSession(sessionId: string | null): void {
  resetTier()
  if (sessionId === null) return
  void (async () => {
    try {
      const page = await rpc<unknown>('session.history', { sessionId })
      // The user may have switched while this read was in flight; applying it
      // then would put one session's tier on another session's control.
      if (!hasSession() || getActiveSessionId() !== sessionId) return
      alignFromProjections(page)
    } catch {
      // Leave the control unavailable; the next bind or history replay retries.
    }
  })()
}

/**
 * Apply a tier pushed by the bridge after it actually changed.
 *
 * While a history replay is in flight the frame is held instead of applied; see
 * {@link deferred} and {@link flushDeferred}.
 * @param data - `{ sessionId, value }` payload.
 * @param replaying - whether the transcript is currently replaying history.
 */
export function applyPermissionEvent(data: unknown, replaying = false): void {
  if (typeof data !== 'object' || data === null) return
  const payload = data as { sessionId?: unknown; value?: unknown }
  const active = getActiveSessionId()
  // Another session's tier is not this panel's business.
  if (typeof payload.sessionId !== 'string' || active === null || payload.sessionId !== active) return
  if (typeof payload.value !== 'string' || payload.value === '') return
  if (replaying) {
    deferred = { sessionId: payload.sessionId, value: payload.value }
    return
  }
  adoptTier(payload.value)
}

/**
 * Apply the newest announcement held back during a replay. Called once the
 * replay's own projection baseline is in place, so a change that happened
 * during the replay wins over the older baseline — and a replay that produced
 * no announcement leaves the baseline alone.
 */
export function flushDeferred(): void {
  const held = deferred
  deferred = null
  if (held === null) return
  if (held.sessionId !== getActiveSessionId()) return
  adoptTier(held.value)
}

/** Adopt one announced tier value as the current display state. */
function adoptTier(value: string): void {
  currentValue = value
  if (!options.some(option => option.value === value)) options.push({ value })
  pending = false
  renderPermissionRow()
}

/** Set the bridge connection state so the placeholder is correct. */
export function setConnected(value: boolean): void {
  // A reconnect is the signal that the bridge process may have been reloaded, so
  // the "unsupported" conclusion is re-tested rather than cached forever.
  if (value && !connected) switchUnsupported = false
  connected = value
  // On the first connect, learn the deployment's tier list so the control is
  // usable before any session exists. Read-only and session-free by design.
  if (value && deploymentOptions.length === 0) void loadDeploymentTiers()
  renderPermissionRow()
}

/**
 * Drop the displayed tier on a session switch.
 *
 * The previous session's tier must not linger: `alignFromProjections` only ever
 * sets a value, so a session whose projection has not arrived yet would keep
 * showing the old one — and the user would read it as this session's authority.
 */
export function resetTier(): void {
  // Only this session's own tier is cleared: `deploymentOptions` describes the
  // deployment, so it stays valid across a session switch and is what keeps the
  // "new session" state configurable.
  options = []
  currentValue = null
  // A frame held for the previous session must not survive the switch: its
  // sessionId would fail the active check anyway, but discarding it here keeps
  // the held state from outliving the replay that created it.
  deferred = null
  renderPermissionRow()
}

/** Bind the change handler (called once from `main.ts`). */
export function initPermissionSelector(): void {
  resolveElements()
  resolveGateElements()
  selectEl?.addEventListener('change', () => { void onTierChange() })
  initFullAccessGate()
}

async function onTierChange(): Promise<void> {
  const target = selectEl?.value ?? ''
  if (pending || target === '' || target === currentValue) {
    renderPermissionRow()
    return
  }
  if (!isSelectable(target)) {
    renderPermissionRow()
    return
  }
  // Full access needs its own risk acknowledgement every single time.
  if (target === 'danger-full-access' && !await requestFullAccessConsent()) {
    renderPermissionRow()
    return
  }
  const previous = currentValue
  if (!await ensureSession()) { renderPermissionRow(); return }
  const sid = getActiveSessionId()
  if (sid === null) { renderPermissionRow(); return }
  pending = true
  currentValue = target
  renderPermissionRow()
  try {
    await rpc(BRIDGE_PERMISSION_SET_METHOD, { sessionId: sid, preset: target })
    // No local confirmation: the projection frame pushed on a real change is
    // what settles this, so a write that had no effect cannot look successful.
  } catch (error: unknown) {
    currentValue = previous
    const code = errorCode(error)
    // An older bridge reports the missing method as a plain not-found, so that
    // code has to be read together with the capability's own error.
    if (code === 'not-found' || code === 'permission-capability-unavailable') {
      switchUnsupported = true
      appendSystem(`${SWITCH_UNSUPPORTED_MESSAGE}请在 dsh 中重载 bridge-dsh 插件后重试。`)
    } else {
      appendSystem(`切换权限档位失败${describeCodeSuffix(code)}: ${describeRpcError(error)}`)
    }
  } finally {
    pending = false
    renderPermissionRow()
  }
}

/*
 * Full-access consent gate.
 *
 * Deliberately NOT remembered: choosing full access again must warn again. The
 * gate lives here because the tier change is a session-level act the user is
 * performing; the bridge validates only the target name, and never treats this
 * acknowledgement as authorization.
 */

let consentResolve: ((granted: boolean) => void) | null = null

function initFullAccessGate(): void {
  ackEl?.addEventListener('change', () => {
    if (confirmEl !== null && ackEl !== null) confirmEl.disabled = !ackEl.checked
  })
  confirmEl?.addEventListener('click', () => { settleConsent(true) })
  cancelEl?.addEventListener('click', () => { settleConsent(false) })
}

/**
 * Ask the user to acknowledge the full-access risk.
 * @returns true only when the user checked the box and confirmed.
 */
function requestFullAccessConsent(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    consentResolve = resolve
    if (ackEl !== null) ackEl.checked = false
    if (confirmEl !== null) confirmEl.disabled = true
    overlayEl?.classList.add('open')
  })
}

function settleConsent(granted: boolean): void {
  overlayEl?.classList.remove('open')
  const resolve = consentResolve
  consentResolve = null
  resolve?.(granted)
}
