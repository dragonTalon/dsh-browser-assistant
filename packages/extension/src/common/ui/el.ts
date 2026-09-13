/**
 * Minimal DOM construction primitive: replaces the scattered
 * `document.createElement` + `appendChild` boilerplate with one declarative
 * helper, so components read as data instead of imperative DOM surgery.
 *
 * This is the lowest-level building block of the panel UI — every row, badge,
 * option, and dialog in the common/ui components is built on top of it.
 *
 * @module
 */

export interface ElOptions {
  /** `className` (raw string; multiple classes join with spaces). */
  class?: string
  /** Set `textContent` (safe — never parsed as HTML). */
  text?: string
  /** Set `innerHTML` (UNSAFE — only use with already-sanitized HTML). */
  html?: string
  /** `title` tooltip. */
  title?: string
  /** Arbitrary attributes. */
  attrs?: Record<string, string>
  /** Child nodes; `null`/`undefined` entries are skipped, strings become text. */
  children?: Array<Node | string | null | undefined>
  /** Click handler. */
  onClick?: (event: MouseEvent) => void
}

/** Create and configure an element in one call. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (opts.class !== undefined && opts.class !== '') node.className = opts.class
  if (opts.title !== undefined) node.title = opts.title
  if (opts.text !== undefined) node.textContent = opts.text
  if (opts.html !== undefined) node.innerHTML = opts.html
  if (opts.attrs !== undefined) {
    for (const [key, value] of Object.entries(opts.attrs)) node.setAttribute(key, value)
  }
  if (opts.onClick !== undefined) node.addEventListener('click', opts.onClick as EventListener)
  if (opts.children !== undefined) {
    for (const child of opts.children) {
      if (child === null || child === undefined) continue
      node.append(child)
    }
  }
  return node
}
