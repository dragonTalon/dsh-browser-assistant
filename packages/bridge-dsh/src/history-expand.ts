/**
 * Host history-shape expansion: turns dsh snapshot records — including the
 * compacted `chunkrow/*` runs dsh 0.1.2 writes — into the scalar event model
 * the extension consumes.
 *
 * Pure functions only, exported so offline checks can exercise the expansion
 * directly without a host. Kept separate from the adapter so a dsh version
 * that changes its history rows changes only this module's input shapes, not
 * the event generation that consumes the output.
 *
 * @module
 */

import { isRecord } from './host-api.ts'
import type { FollowSnapshot } from './host-streams.ts'

/** Wrap one follow snapshot into the bridge's history envelope. */
export function historyValue(snapshot: FollowSnapshot): Record<string, unknown> {
  return {
    // 0.1.2 snapshots compact consecutive Assistant deltas into chunk rows.
    // The extension intentionally keeps its small scalar-event model, so the
    // Host boundary expands those rows losslessly before crossing our wire.
    events: snapshot.records.flatMap(historyRecordEvents).map(event => ({ event })),
    hasMore: snapshot.hasMore,
    ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
  }
}

/** Wrap one `session/page` result into the same envelope. */
export function historyPageValue(page: unknown): Record<string, unknown> {
  if (!isRecord(page) || !Array.isArray(page.records) || typeof page.hasMore !== 'boolean') {
    throw new TypeError('session/page returned an invalid history page')
  }
  return historyValue({
    cursor: -1,
    records: page.records,
    hasMore: page.hasMore,
    ...(page.projections === undefined ? {} : { projections: page.projections }),
  })
}

/**
 * Expand one history record into scalar events. A `chunks` record carrying a
 * compacted `chunkrow/*` event expands into one event per member; an ordinary
 * `event` record passes through untouched. Malformed records throw so the
 * caller can classify the failure instead of rendering a partial history.
 */
export function historyRecordEvents(record: unknown): Record<string, unknown>[] {
  if (!isRecord(record)
    || (record.type !== 'event' && record.type !== 'chunks')
    || !isRecord(record.event)) {
    throw new TypeError('session history carried an invalid record')
  }
  const event = record.event
  if (!isChunkRowEvent(event)) {
    if (record.type === 'chunks') {
      throw new TypeError('session history chunks record carried a non-chunk event')
    }
    return [event]
  }

  const data = event.data
  const members = event.type === 'chunkrow/tool-call-chunks' ? data.args : data.texts
  const deltas = data.dt
  if (!Array.isArray(members) || members.length === 0 || members.some(member => typeof member !== 'string')
    || !Array.isArray(deltas) || deltas.length !== members.length - 1
    || deltas.some(delta => !Number.isSafeInteger(delta))) {
    throw new TypeError(`${event.type} carried an invalid compact run`)
  }
  if (members.length - 1 > Number.MAX_SAFE_INTEGER - event.seq) {
    throw new TypeError(`${event.type} sequence range is unsafe`)
  }

  const events: Record<string, unknown>[] = []
  let time = event.time
  for (let index = 0; index < members.length; index += 1) {
    if (index > 0) time += deltas[index - 1] as number
    if (!Number.isSafeInteger(time)) throw new TypeError(`${event.type} timestamp range is unsafe`)
    const chunk = compactChunk(event.type, data, members[index] as string)
    events.push({
      type: 'assistant/chunk',
      seq: event.seq + index,
      time,
      data: { turn: data.turn, step: data.step, chunk },
    })
  }
  return events
}

type ChunkRowEvent = {
  readonly type: 'chunkrow/text-chunks' | 'chunkrow/reasoning-chunks' | 'chunkrow/tool-call-chunks'
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown> & {
    readonly turn: number
    readonly step: number
    readonly index: number
    readonly dt: readonly unknown[]
    readonly texts?: readonly unknown[]
    readonly args?: readonly unknown[]
  }
}

function isChunkRowEvent(event: Record<string, unknown>): event is ChunkRowEvent {
  if (event.type !== 'chunkrow/text-chunks'
    && event.type !== 'chunkrow/reasoning-chunks'
    && event.type !== 'chunkrow/tool-call-chunks') return false
  if (!Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || !Number.isSafeInteger(event.time)
    || !isRecord(event.data)) {
    throw new TypeError(`${String(event.type)} carried an invalid compact envelope`)
  }
  const data = event.data
  if (typeof data.turn !== 'number' || typeof data.step !== 'number' || typeof data.index !== 'number') {
    throw new TypeError(`${String(event.type)} carried invalid compact coordinates`)
  }
  if (event.type === 'chunkrow/tool-call-chunks'
    && (typeof data.id !== 'string' || (data.name !== undefined && typeof data.name !== 'string'))) {
    throw new TypeError(`${event.type} carried an invalid tool identity`)
  }
  return true
}

function compactChunk(
  type: ChunkRowEvent['type'],
  data: ChunkRowEvent['data'],
  member: string,
): Record<string, unknown> {
  if (type === 'chunkrow/text-chunks') {
    return { type: 'text-delta', index: data.index, text: member }
  }
  if (type === 'chunkrow/reasoning-chunks') {
    return { type: 'reasoning-delta', index: data.index, text: member }
  }
  return {
    type: 'tool-call-delta',
    index: data.index,
    id: data.id,
    ...(data.name === undefined ? {} : { name: data.name }),
    argumentsDelta: member,
  }
}
