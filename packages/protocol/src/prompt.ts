/**
 * Model-facing prompt assembly vocabulary, shared by the extension's panel and
 * background. This is a *contract*, not just formatting: the browser-region-capture
 * spec pins the section order and labels, so both halves must import the same
 * constants instead of re-typing string literals (which would let them drift).
 *
 * Pure constants + string builders, zero dependencies — safe to keep in the
 * protocol package (same "single source of truth" role as protocol.ts).
 *
 * @module
 */

/** Fixed section labels of a region-capture prompt (spec: 分段结构). */
export const PROMPT_SECTION = {
  /** Page context; shared by region prompts and plain text messages. */
  PAGE: '[网页描述]',
  /** Region screenshot description (wrapped element list lives here). */
  SCREENSHOT: '[截图描述]',
  /** The user's intent; always comes last. */
  QUESTION: '[用户问题]',
} as const

/** Placeholder intent used when the user sends a region capture without text. */
export const EMPTY_INTENT = '(未补充具体意图)'

/** Build the page-context prefix prepended to every `session.prompt`. */
export function buildPageContext(title: string, url: string): string {
  const label = title === '' ? '(无标题)' : title
  return `${PROMPT_SECTION.PAGE}：${label} (${url})\n`
}

/**
 * Build the [截图描述] section. `wrappedElementList` must already be wrapped in
 * the untrusted-content boundary by the caller (the panel does this with
 * `wrapUntrustedContent` before assembling the prompt).
 */
export function buildRegionScreenshotText(wrappedElementList: string): string {
  return `${PROMPT_SECTION.SCREENSHOT}：用户框选了当前页面的一块区域，截图见随附图片；区域内 DOM 元素清单如下：\n${wrappedElementList}`
}

/** Build the [用户问题] section; leading newline keeps it on its own line. */
export function buildRegionQuestionText(intent: string): string {
  const trimmed = intent.trim()
  return `\n${PROMPT_SECTION.QUESTION}：${trimmed === '' ? EMPTY_INTENT : trimmed}`
}
