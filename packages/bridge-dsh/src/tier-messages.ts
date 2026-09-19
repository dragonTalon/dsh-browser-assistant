/**
 * Model-facing text for the browser gate.
 *
 * Lives apart from `tools.ts` on purpose: `tools.ts` imports the dsh tool
 * registry, so anything defined there can only be exercised by loading a whole
 * dsh host. These sentences are the only part of the gate the MODEL reads, which
 * makes them exactly the part worth asserting offline — and a message that reads
 * as "this tool is not allowed" would send the model looking for another tool
 * that performs the same act, so the distinction has to be stated and checked
 * rather than assumed.
 *
 * @module
 */

import type { PermissionResolution } from './permission.ts'

/**
 * Refusal text for a call a tier forbids.
 *
 * Names the tier and the way out, because a bare "denied" invites the model to
 * retry the identical call.
 * @param name - the refused tool.
 * @param actionClass - the call's action class.
 * @param resolution - the solved tier.
 * @returns the model-facing explanation.
 */
export function deniedMessage(
  name: string,
  actionClass: 'mutate' | 'navigate',
  resolution: PermissionResolution,
): string {
  const tier = resolution.kind === 'solved' ? resolution.value : 'read-only'
  const what = actionClass === 'navigate'
    ? 'opening or navigating pages'
    : 'changing page state'
  return `${name} was refused: the session permission tier "${tier}" does not allow ${what}. `
    + 'The user can raise the tier from the browser panel or the dsh interface; '
    + 'reading and observing the page stay available in the meantime.'
}

/**
 * Failure text for a call whose tier could not be solved.
 *
 * Deliberately does NOT name a tier and does NOT read as a permission refusal:
 * saying "not allowed" would invite the model to look for another tool that
 * performs the same act, when the real condition is that nothing is known about
 * the session's authority. It names the retry path instead.
 * @param name - the refused tool.
 * @param resolution - the failed resolution.
 * @returns the model-facing explanation.
 */
export function unresolvedMessage(name: string, resolution: PermissionResolution): string {
  const detail = resolution.kind === 'failed' ? resolution.detail : 'no tier information'
  return `${name} was not sent: the session's permission tier could not be determined (${detail}). `
    + 'This is not a tier refusal — no browser action was attempted. '
    + 'Retry the call; if it keeps failing, ask the user to check the session permission tier in the dsh interface.'
}
