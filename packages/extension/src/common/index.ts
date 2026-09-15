/**
 * Common area: reusable, stateless tools and UI components for the extension.
 *
 * Import from here instead of reaching into per-feature modules, so a change
 * to shared behavior lands in exactly one place. No business state or feature
 * orchestration lives here — that belongs to the panel modules.
 *
 * @module
 */

// tools
export { renderMarkdown } from './tools/markdown.ts'
export { wrapUntrustedContent } from './tools/untrusted.ts'
export { fmtTime, formatRegionElement } from './tools/format.ts'
export { withCode, isRecord, errorCode } from './tools/guards.ts'
export {
  buildSessionOptions,
  formatSessionOption,
  SESSION_OPTION_LIMIT,
  type SessionOption,
  type SessionOptions,
} from './session-list.ts'
export {
  bufferEvent,
  eventSeq,
  selectEventsAfterReplay,
  MAX_BUFFERED_EVENTS,
  type BufferedSessionEvent,
  type ReplayHandoff,
} from './session-events.ts'

// ui
export { el, type ElOptions } from './ui/el.ts'
export { conversationRow, createWorkingRow, logLine, type RowKind, type WorkingRow } from './ui/row.ts'
