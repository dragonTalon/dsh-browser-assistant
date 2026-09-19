/**
 * Single source of truth for the browser tool vocabulary: wire names plus the
 * semantic classifications every consumer derives from.
 *
 * The bridge tier gate, the extension approval judgement, the page-delta
 * attachment policy and the navigation snapshot policy all consult this
 * registry — no consumer MAY keep a local classification list, because a tool
 * added to one list but not another is exactly how a mutating action loses its
 * tier gate. An unregistered name is never guessable: {@link actionClassOf}
 * returns `undefined` and the bridge MUST refuse the call (see the
 * `unknown-tool` error code in protocol.ts).
 *
 * Zero-dependency module (pure types, constants, and lookups): both the plugin
 * and the extension bundle import this file through the same esbuild alias as
 * protocol.ts, so the classifications can never drift between the two halves.
 * It deliberately carries no frame shapes and no model-facing description
 * text — the wire contract stays in protocol.ts and the descriptions stay in
 * the bridge tool definitions.
 *
 * @module
 */

/** Effect class the permission-tier gate and the approval axis operate on. */
export type ToolActionClass = 'read' | 'observe' | 'mutate' | 'navigate'

/** One registered browser tool: its wire name plus orthogonal semantics. */
export interface ToolDescriptor {
  /** Wire action name (tool name == content-script action name). */
  readonly name: string
  /** Effect class for the tier gate and the approval judgement. */
  readonly actionClass: ToolActionClass
  /** Whether a successful call may attach the settled page delta. */
  readonly attachesDelta: boolean
  /** Whether a successful call may have changed the controlled tab's URL. */
  readonly navigationCandidate: boolean
}

/**
 * The complete browser tool set, in registration order.
 *
 * Mirrors the pre-registry classification tables exactly: reads are
 * `browser_snapshot`/`browser_get_text`; observes are `browser_scroll`/
 * `browser_wait`; mutates are `browser_click`/`browser_type`/`browser_press`;
 * navigations are `browser_navigate`/`browser_open_tab`/`browser_back`/
 * `browser_forward`/`browser_reload`. `attachesDelta` matches the action-delta
 * set (click/type/press/scroll/wait); `navigationCandidate` matches the
 * navigation set (click/navigate/open_tab/back/forward/reload).
 */
export const BROWSER_TOOL_DESCRIPTORS: readonly ToolDescriptor[] = [
  { name: 'browser_snapshot', actionClass: 'read', attachesDelta: false, navigationCandidate: false },
  { name: 'browser_get_text', actionClass: 'read', attachesDelta: false, navigationCandidate: false },
  { name: 'browser_scroll', actionClass: 'observe', attachesDelta: true, navigationCandidate: false },
  { name: 'browser_wait', actionClass: 'observe', attachesDelta: true, navigationCandidate: false },
  { name: 'browser_click', actionClass: 'mutate', attachesDelta: true, navigationCandidate: true },
  { name: 'browser_type', actionClass: 'mutate', attachesDelta: true, navigationCandidate: false },
  { name: 'browser_press', actionClass: 'mutate', attachesDelta: true, navigationCandidate: false },
  { name: 'browser_navigate', actionClass: 'navigate', attachesDelta: false, navigationCandidate: true },
  { name: 'browser_open_tab', actionClass: 'navigate', attachesDelta: false, navigationCandidate: true },
  { name: 'browser_back', actionClass: 'navigate', attachesDelta: false, navigationCandidate: true },
  { name: 'browser_forward', actionClass: 'navigate', attachesDelta: false, navigationCandidate: true },
  { name: 'browser_reload', actionClass: 'navigate', attachesDelta: false, navigationCandidate: true },
]

const DESCRIPTORS_BY_NAME = new Map(BROWSER_TOOL_DESCRIPTORS.map((descriptor) => [descriptor.name, descriptor]))

/** Every registered wire action name, in registration order. */
export const BROWSER_TOOL_NAMES: readonly string[] = BROWSER_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)

/**
 * Classify one wire action name.
 * @param name - tool/action name off the wire.
 * @returns its effect class, or `undefined` when the name is not registered —
 *   callers MUST treat `undefined` as a refusal, never as a default class.
 */
export function actionClassOf(name: string): ToolActionClass | undefined {
  return DESCRIPTORS_BY_NAME.get(name)?.actionClass
}

/** Whether the action's sole effect is reading page content to the model. */
export function isPageReadTool(name: string): boolean {
  return actionClassOf(name) === 'read'
}

/** Whether the action changes state inside the already-controlled page or tab. */
export function isStateChangingTool(name: string): boolean {
  const actionClass = actionClassOf(name)
  return actionClass === 'mutate' || actionClass === 'navigate'
}

/** Whether a successful call may attach the settled page delta to its result. */
export function attachesPageDelta(name: string): boolean {
  return DESCRIPTORS_BY_NAME.get(name)?.attachesDelta === true
}

/** Whether a successful call may have changed the controlled tab's URL. */
export function isNavigationCandidate(name: string): boolean {
  return DESCRIPTORS_BY_NAME.get(name)?.navigationCandidate === true
}
