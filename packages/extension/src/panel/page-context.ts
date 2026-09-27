/**
 * Pure page-context assembly for panel prompts: decides WHEN the `[网页描述]`
 * prefix is prepended and keeps the per-session "already delivered" gate.
 *
 * DOM-free and dependency-light (only `@dsh-browser/protocol`) so the offline
 * check can drive the real source directly. The text/skill path injects on the
 * session's first message only; the region path injects every round (region
 * prompts keep their `[网页描述]` per `browser-region-capture`). Both mark the
 * same gate so a region capture that came first does not get a redundant
 * re-inject on the following text message.
 *
 * @module
 */

import { buildPageContext } from '@dsh-browser/protocol'

/** The active tab's identity as the background broadcasts it. */
export interface ActivePage {
  readonly url: string
  readonly title: string
}

/** One prependable page-context text block (`[网页描述]`). */
export interface PageContextBlock {
  readonly type: 'text'
  readonly text: string
}

/** Session-scoped "has page context been delivered" registry (key = sessionId). */
export type PageContextGate = Set<string>

/** Shared gate the panel's text and region paths both mark. */
export const panelPageContextGate: PageContextGate = new Set()

/** Build the `[网页描述]` block for an active page. */
export function pageContextBlock(page: ActivePage): PageContextBlock {
  return { type: 'text', text: buildPageContext(page.title, page.url) }
}

/**
 * Text/skill rule: prepend only while the session has not yet received page
 * context, and only when a page is known. Marks the gate on injection, so a
 * session whose first message had no page (e.g. a chrome:// tab) still gets
 * injected on a later message once a page is tracked.
 */
export function withTextPageContext(
  gate: PageContextGate,
  sessionId: string,
  page: ActivePage | null,
  content: readonly unknown[],
): readonly unknown[] {
  if (gate.has(sessionId) || page === null) return content
  gate.add(sessionId)
  return [pageContextBlock(page), ...content]
}

/**
 * Region rule: always prepend when a page is known, and mark the gate so a
 * following text message does not redundantly re-inject the same page context.
 */
export function withRegionPageContext(
  gate: PageContextGate,
  sessionId: string,
  page: ActivePage | null,
  content: readonly unknown[],
): readonly unknown[] {
  if (page === null) return content
  gate.add(sessionId)
  return [pageContextBlock(page), ...content]
}
