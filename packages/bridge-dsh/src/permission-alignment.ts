/**
 * Cross-check between the folded tier and the deployment's own projection.
 *
 * The tier is folded from the session's knob events (see `permission.ts`), which
 * means the bridge mirrors dsh's derivation instead of reading its result. A
 * mirror can be WRONG, not merely unavailable — and a wrong tier authorizes or
 * refuses the wrong work, which is worse than the failure it replaced, because
 * nothing about it looks broken.
 *
 * dsh derives the projection from the very same events, so the two agree by
 * construction in a healthy deployment. A disagreement therefore means one of
 * them is misreading, and that is a fact the operator must be able to see rather
 * than a condition to paper over. The comparison itself lives here as a pure
 * function; the decision it feeds — gate on the stricter of the two — lives in
 * `permission.ts` next to the fold, so there is one place where the tier can be
 * tightened and no path that tightens it differently.
 *
 * @module
 */

import type { BridgePermissionTier } from '@dsh-browser/protocol'
import type { PermissionProjection, PermissionResolution } from './permission-types.ts'

/** What one cross-check found. */
export type AlignmentVerdict =
  /** Both sources name the same tier. */
  | { readonly kind: 'agree'; readonly tier: BridgePermissionTier }
  /** The projection names a different tier than the fold. */
  | { readonly kind: 'diverged'; readonly tier: BridgePermissionTier; readonly projected: string }
  /** No comparable projection value; nothing to check against. */
  | { readonly kind: 'incomparable'; readonly reason: string }

/**
 * Compare a solved tier against the projection's own current value.
 *
 * A projection naming `custom` while the fold names a concrete preset IS a
 * divergence: the two then disagree about whether the session matches a preset
 * at all, which is exactly the kind of mirror error this check exists to catch.
 *
 * @param resolution - the folded resolution.
 * @param view - the deployment's published projection value, when readable.
 * @returns the verdict; never throws, and never itself a failure condition.
 */
export function checkAlignment(
  resolution: PermissionResolution,
  view: PermissionProjection | undefined,
): AlignmentVerdict {
  if (resolution.kind !== 'solved') {
    return { kind: 'incomparable', reason: `tier not solved (${resolution.kind})` }
  }
  if (view === undefined) return { kind: 'incomparable', reason: 'projection unreadable' }
  const projected = typeof view.currentValue === 'string' ? view.currentValue : undefined
  if (projected === undefined || projected === '') {
    return { kind: 'incomparable', reason: 'projection published no current value' }
  }
  if (projected === resolution.value) return { kind: 'agree', tier: resolution.value }
  return { kind: 'diverged', tier: resolution.value, projected }
}
