/**
 * Narrow transport primitives between the bridge's host-agnostic business
 * logic (event generation, workspace grouping) and the dsh Host adapter.
 *
 * These shapes describe the stream SEMANTICS the business logic needs — a
 * follow that delivers a snapshot and then incremental entries, a remote
 * event stream that delivers a ready frame and then events — not the dsh
 * 0.1.2 wire shape. The adapter (remote-host-api.ts) translates the host's
 * wire streams into these primitives, so a future dsh version only
 * re-implements this small surface while the business logic stays untouched.
 * The business modules still validate every value they consume: the primitives
 * are a translation boundary, not a trust grant.
 *
 * Zero-runtime-dependency module: interfaces, types, and the outcome
 * vocabulary only.
 *
 * @module
 */

/** One session/follow snapshot: the durable log tip plus its records. */
export interface FollowSnapshot {
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections?: unknown
}

/** One incremental frame of a session follow stream. */
export interface FollowEntry {
  readonly type: 'event'
  readonly event: Record<string, unknown>
}

/** One frame of the remote event stream (after the ready frame). */
export type RemoteEvent = unknown

/**
 * A stream that opens a session's log: snapshot first, then increments.
 * The returned iterable yields only the incremental tail; the snapshot is
 * delivered separately so consumers cannot misplace the baseline.
 */
export interface SessionFollowSource {
  open(
    request: { readonly sessionId: string; readonly maxMessages?: number },
    signal: AbortSignal,
  ): Promise<{ readonly snapshot: FollowSnapshot } & AsyncIterable<FollowEntry>>
}

/**
 * A stream that opens the host's remote event feed: the ready frame is
 * consumed and reduced to `clientId`, then the remaining events flow.
 */
export interface RemoteEventSource {
  open(signal: AbortSignal): Promise<{ readonly clientId: string } & AsyncIterable<RemoteEvent>>
}

/** One unary host call (commands, session mutations, workspace registration). */
export interface HostInvoker {
  invoke(namespace: string, method: string, args: unknown, signal: AbortSignal): Promise<unknown>
}

/** How one remote event's outcome is reported back (`$events/result`). */
export type RemoteEventOutcome =
  | { readonly kind: 'next' }
  | { readonly kind: 'result'; readonly value?: unknown }
  | {
    readonly kind: 'rejected'
    readonly error: {
      readonly name: string
      readonly message: string
      readonly code?: string
      readonly details?: unknown
    }
  }

/** Sender of {@link RemoteEventOutcome} replies for one event generation. */
export interface EventResultSender {
  send(clientId: string, eventId: string, outcome: RemoteEventOutcome, signal: AbortSignal): Promise<void>
}
