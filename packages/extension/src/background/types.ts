/**
 * Shared background vocabulary: the types every background module addresses a
 * tool call, its answer, a frame, or a content budget through.
 *
 * Kept in its own leaf module so feature modules (`tools.ts`,
 * `authorization.ts`, `frames.ts`) import their shared shapes from here
 * instead of from each other — that is what keeps the module graph acyclic and
 * what lets the panel consume these contracts without depending on
 * background runtime modules.
 *
 * @module
 */

import type { ToolCallPolicy, ToolError } from '@dsh-browser/protocol'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  /** Server-authored wall-clock deadline; absent only in direct unit tests. */
  expiresAt?: number
  /** Owning Agent session, when supplied by a current bridge. */
  sessionId?: string
  /**
   * The bridge's solved authorization for this call. Absent when the connected
   * dsh exposes no permission tier; consumers then apply `ask`.
   */
  policy?: ToolCallPolicy
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/** Snapshot limits negotiated with the bridge and forwarded after lazy injection. */
export interface ContentBudget {
  maxItems: number
  maxChars: number
}

/** A live document frame in one tab. Main frame id is always zero. */
export interface TabFrame {
  frameId: number
  parentFrameId: number
  documentId?: string
  url: string
}
