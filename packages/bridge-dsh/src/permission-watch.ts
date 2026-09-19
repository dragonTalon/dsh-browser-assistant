/**
 * Watches every session's permission tier and reacts when one actually moves.
 *
 * Two things depend on an observed move rather than on a switch request:
 * a downgrade must withdraw in-flight browser calls (the tier means "stop
 * now"), and a change must reach the panel so a switch made in the dsh
 * interface shows up without reopening it. Both are driven from the session's
 * own append feed — the log the tier is folded from — so a request that fails,
 * is refused, or changes nothing appends no knob event and produces no effect
 * at all.
 *
 * @module
 */

import {
  BRIDGE_SESSION_PERMISSION_EVENT,
  type BridgePermissionTier,
} from '@dsh-browser/protocol'
import {
  APPROVAL_POLICY_EVENT,
  PERMISSION_PRESET_EVENT,
  SANDBOX_MODE_EVENT,
  sessionIdOf,
  tierRankOf,
  type PermissionServices,
} from './permission.ts'

/** What the watcher needs from the surroundings. */
export interface PermissionWatchDeps {
  /**
   * The shared tier toolbag. The watcher announces and reacts to exactly the
   * tier the gate enforces — including any cross-check tightening — because
   * both read it through this one accessor.
   */
  permissions: Pick<PermissionServices, 'gatedTier'>
  /** Push a tier change to the connected extension. */
  announce: (sessionId: string, value: BridgePermissionTier) => void
  /** Withdraw one session's in-flight browser calls. */
  withdraw: (sessionId: string) => number
  /** Diagnosable log line for a withdrawn batch. */
  log: (message: string) => void
}

/**
 * Start watching tier changes.
 *
 * The returned function is fed every `session/event` append; events that are
 * not permission knobs cost one string comparison and return. Solving happens
 * through the SAME toolbag the gate uses, so a tier the watcher announces and a
 * tier the gate enforces cannot disagree.
 *
 * @param deps - the tier toolbag and the two reactions.
 * @returns the observer to call for each appended session event.
 */
export function watchPermissionTiers(deps: PermissionWatchDeps): (
  session: unknown,
  event: unknown,
) => void {
  /** Last reported tier per session, so only real changes are announced. */
  const lastSeen = new Map<string, BridgePermissionTier>()
  return (session, event) => {
    if (!isPermissionKnobEvent(event)) return
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    // The tier the gate would enforce right now — including any cross-check
    // tightening — so the panel can never be told a tier the gate will not use.
    const value = deps.permissions.gatedTier(session)
    // No tier has nothing to track. Forget the session rather than recording a
    // placeholder, so a later real value is announced instead of being
    // suppressed as "unchanged" — and so a failed solve can never be mistaken
    // for a downgrade and withdraw calls that are still authorized.
    if (value === undefined) {
      lastSeen.delete(sessionId)
      return
    }
    const previous = lastSeen.get(sessionId)
    if (previous === value) return
    lastSeen.set(sessionId, value)
    // A first sighting is a baseline, not a change: announcing it would push a
    // frame for every session the moment the extension connects. The panel gets
    // its baseline from session history.
    if (previous !== undefined && tierRankOf(value) < tierRankOf(previous)) {
      const withdrawn = deps.withdraw(sessionId)
      if (withdrawn > 0) {
        deps.log(`browser bridge: tier dropped to "${value}"; withdrew ${withdrawn} in-flight browser call(s)`)
      }
    }
    if (previous !== undefined) deps.announce(sessionId, value)
  }
}

/**
 * Whether one appended event is a permission knob.
 *
 * Deliberately a pure name check: the event's payload is validated by the
 * solver, which owns the malformed-event verdict and reports it there.
 */
export function isPermissionKnobEvent(event: unknown): boolean {
  if (event === null || typeof event !== 'object') return false
  const type = (event as { type?: unknown }).type
  return type === PERMISSION_PRESET_EVENT || type === SANDBOX_MODE_EVENT || type === APPROVAL_POLICY_EVENT
}
