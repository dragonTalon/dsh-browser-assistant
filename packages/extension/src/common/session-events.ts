/**
 * Pure helpers for handing live session frames over to a history replay.
 *
 * A session can keep producing events between the moment a history snapshot is
 * taken and the moment its response reaches the panel. Rendering the snapshot
 * with "clear + replay" would wipe those frames, so the panel buffers them and
 * re-applies exactly the ones the snapshot cannot contain — decided by durable
 * event sequence, the only stable identity a session event carries.
 *
 * @module
 */

/** Upper bound on frames buffered while one history read is in flight. */
export const MAX_BUFFERED_EVENTS = 500

/** One live session event held back while a history replay is in flight. */
export interface BufferedSessionEvent {
  /** Owning session; the caller keeps only the active session's frames. */
  readonly sessionId: string
  /** Durable event sequence, used to order against the replay snapshot. */
  readonly seq: number
  /** Raw session event object, applied verbatim after the replay. */
  readonly event: unknown
}

/** Outcome of joining a replay with the frames buffered during it. */
export interface ReplayHandoff {
  /** Frames to apply after the replay, oldest sequence first. */
  readonly apply: readonly BufferedSessionEvent[]
  /** Frames discarded instead of applied: over the cap, unusable or duplicate sequence. */
  readonly dropped: number
}

/**
 * Read the durable sequence off a raw session event.
 * @param event - raw event object from a `session/event` frame.
 * @returns the sequence, or `undefined` when the event carries no usable one.
 */
export function eventSeq(event: unknown): number | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const seq = (event as { seq?: unknown }).seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

/**
 * Wrap a live event for buffering, dropping anything without a durable
 * sequence — such a frame cannot be ordered against the replay, and every
 * durable session event carries one.
 * @param sessionId - owning session identity.
 * @param event - raw event object.
 * @returns the buffered frame, or `undefined` when the event is unusable.
 */
export function bufferEvent(sessionId: string, event: unknown): BufferedSessionEvent | undefined {
  const seq = eventSeq(event)
  return seq === undefined ? undefined : { sessionId, seq, event }
}

/**
 * Select the buffered frames a replay does not already contain.
 *
 * Frames are kept in arrival order, restricted to sequences strictly greater
 * than the replay's highest sequence, de-duplicated by sequence, and finally
 * ordered by sequence. A frame without a usable sequence is discarded.
 *
 * @param buffered - frames buffered during the replay, in arrival order.
 * @param replayMaxSeq - highest sequence present in the replayed history;
 *   pass a negative value (or `NaN`) when the history was empty.
 * @param limit - cap on how many frames may be buffered; oldest are dropped first.
 * @returns frames to apply plus how many were discarded.
 */
export function selectEventsAfterReplay(
  buffered: readonly BufferedSessionEvent[],
  replayMaxSeq: number,
  limit: number = MAX_BUFFERED_EVENTS,
): ReplayHandoff {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_BUFFERED_EVENTS
  const overflow = buffered.length > cap ? buffered.length - cap : 0
  const kept = overflow === 0 ? buffered : buffered.slice(overflow)
  const boundary = Number.isSafeInteger(replayMaxSeq) ? replayMaxSeq : -1
  const seen = new Set<number>()
  const selected: BufferedSessionEvent[] = []
  let discarded = overflow
  for (const frame of kept) {
    if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) {
      discarded += 1
      continue
    }
    // Already part of the replayed snapshot: not applied, not "dropped".
    if (frame.seq <= boundary) continue
    if (seen.has(frame.seq)) {
      discarded += 1
      continue
    }
    seen.add(frame.seq)
    selected.push(frame)
  }
  selected.sort((left, right) => left.seq - right.seq)
  return { apply: selected, dropped: discarded }
}
