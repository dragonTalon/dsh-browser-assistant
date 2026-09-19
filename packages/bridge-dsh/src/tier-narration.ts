/**
 * Model-facing narration of the session's browser permission tier.
 *
 * Registered like dsh's own `sandbox:policy` / `approval:policy` narrations: an
 * evaluated `text` re-read on every model request, so a switch is reflected on
 * the next step without rewriting a stable prefix. Without this the model only
 * learns the tier from a refusal, which costs a wasted call every time.
 *
 * The host service is optional — a deployment without it simply gets no
 * narration — but when it IS present the registration must satisfy its
 * contract: `systemPrompt.context` rejects an entry whose `order` is not a
 * finite number, and a throw here runs inside the plugin's `apply()`, where
 * app-boot turns it into a refused dsh start rather than a missing sentence.
 * The order therefore lives in {@link TIER_NARRATION_ORDER} and the structural
 * type below states it as required.
 *
 * @module
 */

import type { PermissionResolution, PermissionServices } from './permission.ts'

/** Prompt context name of the tier narration. */
export const TIER_NARRATION_NAME = 'browser:permission-tier'

/**
 * Position of the tier narration among dsh's ordered prompt contexts.
 *
 * A host deployment allocates its own policy narrations in a fixed band —
 * `SANDBOX_POLICY` 110, `APPROVAL_POLICY` 115, `SUBAGENT_DELEGATION` 120 — and
 * only through `systemPrompt.getContextOrder()` with exactly those names; an
 * unknown name resolves to `undefined`, which the host then rejects. The
 * browser tier is not part of that vocabulary, so the bridge names its own slot
 * inside the same band: after the approval policy it refines, before subagent
 * delegation.
 */
export const TIER_NARRATION_ORDER = 117

/**
 * Structural subset of dsh's system-prompt service. Probed, never injected:
 * a deployment without it simply gets no tier narration.
 */
export interface SystemPromptLike {
  context(entry: {
    name: string
    /** Ascending prompt position. The host rejects a non-finite value. */
    order: number
    text: (context: { agent?: { session?: unknown } }) => string
  }): () => void
}

/** What narration registration needs from its surroundings. */
export interface TierNarrationDeps {
  /** Probed host service; absent leaves narration off. */
  systemPrompt?: SystemPromptLike | undefined
  /** The shared tier toolbag; the narration uses the same solve as the gate. */
  permissions: Pick<PermissionServices, 'resolve'>
  /** Register a scoped effect with the plugin context. */
  effect: (register: () => () => void, name: string) => void
}

/**
 * Register the tier narration when the deployment offers a system prompt.
 * @param deps - probed service, tier toolbag and effect registrar.
 */
export function registerTierNarration(deps: TierNarrationDeps): void {
  const { systemPrompt } = deps
  if (systemPrompt === undefined || typeof systemPrompt.context !== 'function') return
  deps.effect(() => systemPrompt.context({
    name: TIER_NARRATION_NAME,
    order: TIER_NARRATION_ORDER,
    text: (context) => {
      const session = context.agent?.session
      if (session === undefined) return ''
      return tierNarration(deps.permissions.resolve(session))
    },
  }), 'bridge-dsh: browser tier narration')
}

/**
 * Model-facing statement of the current browser tier. Empty when the tier is
 * not solved — a deployment without tiers, or a session whose tier could not be
 * determined. Saying nothing is the only honest option in both cases: a
 * narration invented from a default would tell the model it faces a policy the
 * deployment never established.
 * @param resolution - the session's solved tier.
 * @returns the narration sentence.
 */
export function tierNarration(resolution: PermissionResolution): string {
  if (resolution.kind !== 'solved') return ''
  const { effective } = resolution
  if (effective === 'read-only') {
    return 'Browser permission tier: read-only. Reading the page and observing it (snapshot, text, scroll, wait) are allowed; '
      + 'changing page state (click, type, press) and opening or navigating pages are refused. Do not request those actions — '
      + 'ask the user to raise the tier instead.'
  }
  if (effective === 'workspace-write') {
    return 'Browser permission tier: workspace-write. Changing page state and opening or navigating pages are allowed but each one '
      + 'requires a human approval and may be refused; reading and observing need no approval.'
  }
  return 'Browser permission tier: full access. Changing page state and opening or navigating pages execute without an approval '
    + 'prompt; reading and observing need no approval.'
}
