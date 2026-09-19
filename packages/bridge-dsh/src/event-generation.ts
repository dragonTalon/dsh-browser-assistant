/**
 * Event generation: one authenticated extension connection's event streams
 * and active Session follower.
 *
 * Host-agnostic business logic: it consumes the narrow transport primitives
 * from host-streams.ts (a follow stream, a remote event stream, an outcome
 * sender) instead of any dsh wire shape, so a dsh version change touches the
 * adapter, not this module. The session/follow lifecycle, cross-generation
 * cursor bookkeeping, backfill dedup and waterfall ownership all live here and
 * are exercised offline against fake transport sources.
 *
 * @module
 */

import type { RespondResult } from '@dsh-browser/protocol'
import { isRecord, type HostEventFrame } from './host-api.ts'
import { ExtensionSessionRegistry, shouldBridgeOwnQuestion } from './extension-sessions.ts'
import { historyRecordEvents } from './history-expand.ts'
import type {
  EventResultSender,
  FollowEntry,
  FollowSnapshot,
  RemoteEventSource,
  RemoteEventOutcome,
  SessionFollowSource,
} from './host-streams.ts'

/** A follow snapshot: the inclusive Host log tip plus the page's records. */
export { type FollowSnapshot }

/** Validates a `session/follow` snapshot frame. */
export function isSessionSnapshot(value: unknown): value is {
  readonly type: 'snapshot'
  readonly cursor: number
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly projections?: unknown
} {
  return isRecord(value)
    && value.type === 'snapshot'
    && Number.isSafeInteger(value.cursor)
    && (value.cursor as number) >= -1
    && (value.cursor as number) !== Number.MAX_SAFE_INTEGER
    && Array.isArray(value.records)
    && typeof value.hasMore === 'boolean'
}

/** Validates a `session/follow` incremental frame. */
export function isSessionEventEntry(value: unknown): value is FollowEntry {
  return isRecord(value) && value.type === 'event' && isRecord(value.event)
}

interface PendingQuestion {
  readonly sessionId: string
  settled: boolean
}

/**
 * One authenticated extension connection's event streams and active Session
 * follower. Constructed once per connection generation by the Host adapter;
 * `events()` is the pump the WebSocket carrier iterates.
 */
export class EventGeneration {
  private readonly lifetime = new AbortController()
  private readonly signal: AbortSignal
  private readonly queue = new AsyncEventQueue()
  private readonly tasks = new Set<Promise<void>>()
  private readonly pendingQuestions = new Map<string, PendingQuestion>()
  private clientId: string | undefined
  private followAbort: AbortController | undefined
  private followedSessionId: string | undefined
  private followRevision = 0
  private disposed = false

  constructor(
    private readonly followSource: SessionFollowSource,
    private readonly remoteSource: RemoteEventSource,
    private readonly sender: EventResultSender,
    private readonly extensionSessions: ExtensionSessionRegistry,
    private readonly onHistoryCursor: (sessionId: string, cursor: number) => void,
    /** Read the cross-generation delivered-seq cursor (RemoteHostApi.historyCursors). */
    private readonly historyCursorOf: (sessionId: string) => number | undefined,
    /** Report a successfully established follow so later generations can resume it. */
    private readonly onFollowed: (sessionId: string) => void,
    outerSignal: AbortSignal,
  ) {
    this.signal = AbortSignal.any([outerSignal, this.lifetime.signal])
  }

  start(): void {
    this.track(this.pumpRemoteEvents())
  }

  events(): AsyncIterable<HostEventFrame> {
    return this.queue.iterate(this.signal)
  }

  async openSessionHistory(
    sessionId: string,
    callSignal: AbortSignal,
    maxMessages?: number,
  ): Promise<FollowSnapshot> {
    return this.openSessionFollow(sessionId, callSignal, maxMessages)
  }

  async ensureSessionFollow(sessionId: string, callSignal: AbortSignal): Promise<void> {
    if (this.followedSessionId === sessionId && this.followAbort?.signal.aborted === false) return
    await this.openSessionFollow(sessionId, callSignal)
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const pending = this.pendingQuestions.get(rpcId)
    const clientId = this.clientId
    if (pending === undefined || pending.settled || clientId === undefined) {
      return { accepted: false, reason: 'not-pending' }
    }
    pending.settled = true
    try {
      await this.sender.send(clientId, rpcId, respondOutcome(result), AbortSignal.any([this.signal, signal]))
      return { accepted: true }
    } catch (error: unknown) {
      pending.settled = false
      throw error
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.followAbort?.abort(new Error('browser bridge event generation closed'))
    this.lifetime.abort(new Error('browser bridge event generation closed'))
    this.queue.end()
    await Promise.all(this.tasks)
  }

  private async openSessionFollow(
    sessionId: string,
    callSignal: AbortSignal,
    maxMessages?: number,
  ): Promise<FollowSnapshot> {
    const revision = ++this.followRevision
    this.followAbort?.abort(new Error('browser bridge Session follower replaced'))
    const controller = new AbortController()
    this.followAbort = controller
    this.followedSessionId = sessionId
    const signal = AbortSignal.any([this.signal, callSignal, controller.signal])
    try {
      const source = await this.followSource.open(
        { sessionId, ...(maxMessages === undefined ? {} : { maxMessages }) },
        signal,
      )
      const iterator = source[Symbol.asyncIterator]()
      if (!isSessionSnapshot(source.snapshot)) {
        await iterator.return?.()
        throw new TypeError('session/follow did not begin with a snapshot')
      }
      if (revision !== this.followRevision || signal.aborted) {
        await iterator.return?.()
        signal.throwIfAborted()
        throw new Error('browser bridge Session follower was replaced while opening')
      }
      // Backfill BEFORE noting the snapshot cursor (the filter needs the
      // pre-snapshot tip) and BEFORE returning to the caller: a
      // session.history rpc.result is written only after this return, so
      // backfilled frames always reach the extension ahead of that response
      // on the single ordered WebSocket — the panel renders them, then its
      // reloadHistory re-render replaces them with the same events. Exactly
      // once, no panel-side dedup needed.
      this.backfillSnapshot(sessionId, source.snapshot.records)
      this.onHistoryCursor(sessionId, source.snapshot.cursor)
      this.onFollowed(sessionId)
      this.track(this.pumpSessionEvents(sessionId, revision, iterator, signal))
      return {
        cursor: source.snapshot.cursor,
        records: source.snapshot.records,
        hasMore: source.snapshot.hasMore,
        ...(source.snapshot.projections === undefined ? {} : { projections: source.snapshot.projections }),
      }
    } catch (error: unknown) {
      if (revision === this.followRevision) {
        this.followedSessionId = undefined
        this.followAbort = undefined
      }
      throw error
    }
  }

  /**
   * Re-deliver events the extension missed while disconnected: expand the
   * follow snapshot into scalar events and push only those strictly newer
   * than the cross-generation delivered cursor. Without a cursor (first
   * follow of this Session in the process) nothing is pushed — flooding the
   * extension with full history on every first prompt is not wanted. A
   * malformed record is skipped rather than failing the whole follow.
   */
  private backfillSnapshot(sessionId: string, records: readonly unknown[]): void {
    const deliveredSeq = this.historyCursorOf(sessionId)
    if (deliveredSeq === undefined) return
    for (const record of records) {
      let events: Record<string, unknown>[]
      try {
        events = historyRecordEvents(record)
      } catch {
        continue
      }
      for (const event of events) {
        const seq = event.seq
        if (typeof seq !== 'number' || seq <= deliveredSeq) continue
        this.queue.push({
          rpcId: crypto.randomUUID(),
          method: 'session/event',
          payload: { type: 'session/event', sessionId, event },
        })
      }
    }
  }

  private async pumpSessionEvents(
    sessionId: string,
    revision: number,
    iterator: AsyncIterator<unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        const next = await iterator.next()
        // Abort is advisory to an AsyncIterator: a buffered frame may still
        // resolve after this follower was replaced. Never let that stale
        // generation update the extension's active/recent session state.
        if (signal.aborted || revision !== this.followRevision) break
        if (next.done) break
        if (!isSessionEventEntry(next.value)) {
          throw new TypeError('session/follow emitted an invalid incremental frame')
        }
        const seq = next.value.event.seq
        if (typeof seq === 'number') this.onHistoryCursor(sessionId, seq)
        this.queue.push({
          rpcId: crypto.randomUUID(),
          method: 'session/event',
          payload: { type: 'session/event', sessionId, event: next.value.event },
        })
      }
      if (!signal.aborted && revision === this.followRevision) {
        throw new Error('session/follow ended unexpectedly')
      }
    } catch (error: unknown) {
      if (!signal.aborted && revision === this.followRevision) this.queue.fail(error)
    } finally {
      await iterator.return?.()
      if (revision === this.followRevision) {
        this.followedSessionId = undefined
        this.followAbort = undefined
      }
    }
  }

  private async pumpRemoteEvents(): Promise<void> {
    try {
      const source = await this.remoteSource.open(this.signal)
      this.clientId = source.clientId
      for await (const value of source) {
        await this.handleRemoteEvent(value)
      }
      if (!this.signal.aborted) throw new Error('$events ended unexpectedly')
    } catch (error: unknown) {
      if (!this.signal.aborted) this.queue.fail(error)
    }
  }

  private async handleRemoteEvent(value: unknown): Promise<void> {
    if (!isRecord(value) || typeof value.type !== 'string') {
      throw new TypeError('$events emitted an invalid frame')
    }
    if (value.type === 'emit') return
    if (value.type === 'cancel' && typeof value.eventId === 'string') {
      const pending = this.pendingQuestions.get(value.eventId)
      if (pending === undefined) return
      this.pendingQuestions.delete(value.eventId)
      this.queue.push({
        rpcId: crypto.randomUUID(),
        method: 'question/resolved',
        payload: {
          type: 'question/resolved',
          sessionId: pending.sessionId,
          questionRpcId: value.eventId,
        },
      })
      return
    }
    if (value.type !== 'waterfall'
      || typeof value.event !== 'string'
      || typeof value.eventId !== 'string'
      || typeof value.agentId !== 'string'
      || !isRecord(value.request)) {
      throw new TypeError('$events emitted an invalid waterfall frame')
    }
    if (value.event !== 'user-questions/request' || !Array.isArray(value.request.questions)) {
      const clientId = this.clientId
      if (clientId !== undefined) {
        await this.sender.send(clientId, value.eventId, { kind: 'next' }, this.signal)
      }
      return
    }
    // Desktop-owned sessions keep the native waterfall. Only forward questions
    // for sessions the extension successfully created or prompted.
    if (!shouldBridgeOwnQuestion({
      hasExtensionConnection: true,
      sessionId: value.agentId,
      extensionSessions: this.extensionSessions,
    })) {
      const clientId = this.clientId
      if (clientId !== undefined) {
        await this.sender.send(clientId, value.eventId, { kind: 'next' }, this.signal)
      }
      return
    }
    this.pendingQuestions.set(value.eventId, { sessionId: value.agentId, settled: false })
    this.queue.push({
      rpcId: value.eventId,
      method: 'question/requested',
      payload: {
        type: 'question/requested',
        sessionId: value.agentId,
        questions: value.request.questions,
      },
    })
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch((error: unknown) => {
      if (!this.signal.aborted) this.queue.fail(error)
    })
    this.tasks.add(tracked)
    void tracked.finally(() => { this.tasks.delete(tracked) })
  }
}

/** Convert a panel's waterfall answer into the host's outcome vocabulary. */
function respondOutcome(result: RespondResult): RemoteEventOutcome {
  if (result.ok) {
    const value = isRecord(result.value) && isRecord(result.value.answer)
      ? result.value.answer
      : result.value
    return value === undefined ? { kind: 'result' } : { kind: 'result', value }
  }
  return {
    kind: 'rejected',
    error: {
      name: 'Error',
      message: result.error.message,
      code: result.error.code,
      details: result.error.details,
    },
  }
}

/** Bounded, failure-aware queue between the host streams and the carrier pump. */
export class AsyncEventQueue {
  private readonly frames: HostEventFrame[] = []
  private wake: (() => void) | undefined
  private failure: unknown
  private closed = false

  push(frame: HostEventFrame): void {
    if (this.closed || this.failure !== undefined) return
    this.frames.push(frame)
    this.wake?.()
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) return
    this.failure = error
    this.wake?.()
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.wake?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<HostEventFrame> {
    const onAbort = (): void => { this.wake?.() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.frames.length > 0) yield this.frames.shift() as HostEventFrame
        if (this.failure !== undefined) throw this.failure
        if (this.closed || signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
        this.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }
}
