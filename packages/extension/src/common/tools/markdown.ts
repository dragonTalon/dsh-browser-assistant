/**
 * Markdown rendering for assistant replies, sanitized before any DOM write.
 *
 * Model output is semi-trusted content (a page can steer the model toward
 * prompt injection), so `DOMPurify.sanitize` MUST run before `innerHTML`.
 * This is the single place that policy lives — every assistant row goes
 * through `conversationRow()` in `common/ui/row.ts`, which calls this.
 *
 * @module
 */

import { marked } from 'marked'
import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
]

const ALLOWED_ATTR = ['href', 'title', 'src', 'alt']

/** Render Markdown to a sanitized HTML string safe for `innerHTML`. */
export function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md) as string, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
  })
}
