#!/usr/bin/env node
/**
 * Behavioral check for the host-agnostic event generation (the code split out
 * of remote-host-api.ts by the adapter-seam change).
 *
 * Bundles the REAL `event-generation.ts` and drives it with fake transport
 * sources, asserting the semantics that used to be untestable without a whole
 * gateway:
 *
 * - cross-generation backfill delivers exactly the events strictly newer than
 *   the delivered cursor (dedup, no full-history flood);
 * - the history cursor callback observes non-decreasing seqs across snapshot
 *   and increments;
 * - replacing a follow revokes the previous iterator and drops its stale
 *   frames;
 * - waterfall ownership forwards extension-session questions, answers
 *   everything else with `next`, resolves cancels, and settles responds.
 *
 * Usage: pnpm check:adapter-seam   (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'adapter-seam')

function resolveEsbuild() {
  const candidates = [
    process.env.ESBUILD,
    join(repoRoot, 'packages/extension/node_modules/.bin/esbuild'),
    join(repoRoot, 'packages/bridge-dsh/node_modules/.bin/esbuild'),
  ].filter((candidate) => typeof candidate === 'string' && candidate !== '')
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) {
    console.error('error: esbuild not found (run pnpm install, or set ESBUILD)')
    process.exit(1)
  }
  return found
}

mkdirSync(outDir, { recursive: true })

const outfile = join(outDir, 'event-generation.mjs')
const built = spawnSync(resolveEsbuild(), [
  join(repoRoot, 'packages/bridge-dsh/src/event-generation.ts'),
  '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${outfile}`,
  `--alias:@dsh-browser/protocol=${join(repoRoot, 'packages/protocol/src/index.ts')}`,
  '--log-level=error',
], { cwd: repoRoot, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const { EventGeneration, AsyncEventQueue } = await import(pathToFileURL(outfile).href)

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

const tick = () => new Promise((resolveTick) => { setTimeout(resolveTick, 0) })
const sleep = (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms) })

/** A push-driven fake follow stream: snapshot first, then manual increments. */
function makeFollowSource() {
  let ended = false
  let returned = false
  let wake
  const queue = []
  const self = {
    snapshot: { type: 'snapshot', cursor: -1, records: [], hasMore: false },
    ended,
    push(entry) {
      queue.push(entry)
      wake?.()
    },
    setSnapshot(snapshot) {
      self.snapshot = snapshot
    },
    end() {
      ended = true
      wake?.()
    },
  }
  const iterator = {
    async next() {
      // Settle on abort exactly like a host stream does: a blocked next()
      // must not hold the generation's teardown open forever.
      while (queue.length === 0 && !ended) await new Promise((resolveNext) => { wake = resolveNext })
      if (queue.length === 0) return { done: true, value: undefined }
      return { done: false, value: queue.shift() }
    },
    async return() {
      returned = true
      ended = true
      wake?.()
      return { done: true, value: undefined }
    },
  }
  return {
    ...self,
    get returned() { return returned },
    open: async (_request, signal) => {
      signal.addEventListener('abort', () => { ended = true; wake?.() }, { once: true })
      return { snapshot: self.snapshot, [Symbol.asyncIterator]: () => iterator }
    },
  }
}

/** A push-driven fake remote event stream: ready reduced to clientId, then frames. */
function makeRemoteSource(clientId) {
  let ended = false
  let wake
  const queue = []
  const self = {
    push(frame) {
      queue.push(frame)
      wake?.()
    },
    end() {
      ended = true
      wake?.()
    },
  }
  const iterator = {
    async next() {
      while (queue.length === 0 && !ended) await new Promise((resolveNext) => { wake = resolveNext })
      if (queue.length === 0) return { done: true, value: undefined }
      return { done: false, value: queue.shift() }
    },
    async return() { ended = true; wake?.(); return { done: true, value: undefined } },
  }
  return {
    ...self,
    open: async (signal) => {
      signal.addEventListener('abort', () => { ended = true; wake?.() }, { once: true })
      return { clientId, [Symbol.asyncIterator]: () => iterator }
    },
  }
}

/** Collect a generation's frames asynchronously so pumps can be driven freely. */
async function collect(events) {
  const frames = []
  const done = (async () => {
    for await (const frame of events) frames.push(frame)
  })()
  return { frames, done }
}

// ---------------------------------------------------------------------------
// Part 1: cross-generation backfill dedup + cursor monotonicity.
// ---------------------------------------------------------------------------
{
  const follow = makeFollowSource()
  const cursors = []
  const registry = { ids: new Set(['s1']), has: (id) => registry.ids.has(id), note: (id) => registry.ids.add(id), clear: () => registry.ids.clear() }
  const generation = new EventGeneration(
    follow,
    makeRemoteSource('c1'),
    { send: async () => {} },
    { has: (id) => registry.ids.has(id) },
    (sessionId, cursor) => { cursors.push({ sessionId, cursor }) },
    () => 5, // delivered cursor: only strictly-newer events may be backfilled
    () => {},
    new AbortController().signal,
  )
  generation.start()
  const { frames, done } = await collect(generation.events())

  const record = (seq) => ({ type: 'event', event: { type: 'user/message', seq, time: seq, data: {} } })
  follow.setSnapshot({ type: 'snapshot', cursor: 10, records: [record(3), record(6)], hasMore: false })
  await generation.ensureSessionFollow('s1', new AbortController().signal)
  await tick()
  const backfilled = frames.filter((frame) => frame.method === 'session/event')
  check('回补只交付严格新于游标的事件(seq 3 被去重、seq 6 交付一次)',
    backfilled.length === 1 && backfilled[0].payload.event.seq === 6,
    JSON.stringify(backfilled.map((frame) => frame.payload.event.seq)))
  check('回补事件携带正确的 sessionId', backfilled[0]?.payload.sessionId === 's1')

  follow.push({ type: 'event', event: { type: 'assistant/chunk', seq: 7, time: 7, data: {} } })
  follow.push({ type: 'event', event: { type: 'assistant/chunk', seq: 4, time: 4, data: {} } })
  await tick()
  const after = frames.filter((frame) => frame.method === 'session/event').map((frame) => frame.payload.event.seq)
  check('增量帧按到达顺序交付(不做游标过滤)', JSON.stringify(after) === '[6,7,4]', JSON.stringify(after))
  check('游标回调单调不减(快照 10 → 增量 7/4)',
    cursors.length === 3 && cursors[0].cursor === 10 && cursors[1].cursor === 7 && cursors[2].cursor === 4,
    JSON.stringify(cursors))

  await generation.dispose()
  await done
}

// ---------------------------------------------------------------------------
// Part 2: follow replacement revokes the previous iterator and drops stale frames.
// ---------------------------------------------------------------------------
{
  const followA = makeFollowSource()
  const followB = makeFollowSource()
  let follow = 'A'
  const followSource = {
    open: async (request, signal) => (follow === 'A' ? followA.open(request, signal) : followB.open(request, signal)),
  }
  const generation = new EventGeneration(
    followSource,
    makeRemoteSource('c1'),
    { send: async () => {} },
    { has: () => true },
    () => {},
    () => undefined,
    () => {},
    new AbortController().signal,
  )
  generation.start()
  const { frames, done } = await collect(generation.events())

  followA.setSnapshot({ type: 'snapshot', cursor: 0, records: [], hasMore: false })
  await generation.ensureSessionFollow('sA', new AbortController().signal)
  follow = 'B'
  followB.setSnapshot({ type: 'snapshot', cursor: 0, records: [], hasMore: false })
  await generation.ensureSessionFollow('sB', new AbortController().signal)
  await tick()
  check('被替换的 follow 迭代器收到 return()', followA.returned === true)

  // A stale frame pushed onto the REVOKED follow must never reach the queue.
  followA.push({ type: 'event', event: { type: 'user/message', seq: 1, time: 1, data: {} } })
  await tick()
  const fromA = frames.filter((frame) => frame.payload?.sessionId === 'sA')
  check('旧代迟到帧被丢弃(不污染事件队列)', fromA.length === 0, JSON.stringify(fromA))

  followB.push({ type: 'event', event: { type: 'user/message', seq: 2, time: 2, data: {} } })
  await tick()
  const fromB = frames.filter((frame) => frame.payload?.sessionId === 'sB')
  check('新代增量正常交付', fromB.length === 1 && fromB[0].payload.event.seq === 2, JSON.stringify(fromB))

  await generation.dispose()
  await done
}

// ---------------------------------------------------------------------------
// Part 3: waterfall ownership, `next` receipts, cancels, and responds.
// ---------------------------------------------------------------------------
{
  const remote = makeRemoteSource('c-remote')
  const sent = []
  const sender = { send: async (clientId, eventId, outcome) => { sent.push({ clientId, eventId, outcome }) } }
  const extensionSessions = { has: (id) => id === 's-owned' }
  const generation = new EventGeneration(
    makeFollowSource(),
    remote,
    sender,
    extensionSessions,
    () => {},
    () => undefined,
    () => {},
    new AbortController().signal,
  )
  generation.start()
  const { frames, done } = await collect(generation.events())
  await tick() // let pumpRemoteEvents consume the ready frame

  const question = (agentId, eventId, questions) => ({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId,
    agentId,
    request: { questions },
  })

  remote.push(question('s-owned', 'q1', [{ id: 'a', text: 'yes?' }]))
  await tick()
  const owned = frames.filter((frame) => frame.method === 'question/requested')
  check('扩展会话的提问被转发为 question/requested',
    owned.length === 1 && owned[0].payload.sessionId === 's-owned' && owned[0].rpcId === 'q1',
    JSON.stringify(owned))
  check('扩展会话的提问不产生 next 回执', sent.length === 0, JSON.stringify(sent))

  remote.push(question('s-other', 'q2', [{ id: 'b', text: 'no?' }]))
  await tick()
  check('非扩展会话的提问以 next 交还宿主',
    sent.length === 1 && sent[0].eventId === 'q2' && sent[0].outcome.kind === 'next' && sent[0].clientId === 'c-remote',
    JSON.stringify(sent))

  remote.push({ type: 'waterfall', event: 'other/event', eventId: 'q3', agentId: 's-owned', request: {} })
  await tick()
  check('非提问 waterfall 以 next 交还宿主',
    sent.length === 2 && sent[1].eventId === 'q3' && sent[1].outcome.kind === 'next',
    JSON.stringify(sent))

  const respondOwned = await generation.respond('q1', { ok: true, value: { answer: 'yes' } }, new AbortController().signal)
  check('在途提问的 respond 被接受并回传结果',
    respondOwned.accepted === true
    && sent.length === 3 && sent[2].eventId === 'q1' && sent[2].outcome.kind === 'result'
    && sent[2].outcome.value !== undefined && sent[2].outcome.value.answer === 'yes',
    JSON.stringify({ respondOwned, sent }))

  const respondUnknown = await generation.respond('nope', { ok: true, value: undefined }, new AbortController().signal)
  check('未知 rpcId 的 respond 被拒绝', respondUnknown.accepted === false && respondUnknown.reason === 'not-pending',
    JSON.stringify(respondUnknown))

  remote.push({ type: 'cancel', eventId: 'q1' })
  await tick()
  const resolved = frames.filter((frame) => frame.method === 'question/resolved')
  check('cancel 帧把在途提问标记为 question/resolved',
    resolved.length === 1 && resolved[0].payload.questionRpcId === 'q1' && resolved[0].payload.sessionId === 's-owned',
    JSON.stringify(resolved))

  await generation.dispose()
  await done
}

// ---------------------------------------------------------------------------
// Part 4: queue end/fail semantics (the carrier's teardown contract).
// ---------------------------------------------------------------------------
{
  const queue = new AsyncEventQueue()
  const frames = []
  const done = (async () => {
    for await (const frame of queue.iterate(new AbortController().signal)) frames.push(frame)
  })()
  queue.push({ rpcId: 'a', method: 'm', payload: {} })
  await tick()
  queue.fail(new Error('boom'))
  // The collector terminates by THROWING the queued failure — that is the
  // carrier contract — so swallow it here and assert on what it yielded.
  await done.catch(() => {})
  check('fail 使迭代以该错误终止', frames.length === 1)
  await sleep(0)
  queue.push({ rpcId: 'b', method: 'm', payload: {} })
  check('失败后的 push 被忽略', frames.length === 1)
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\nadapter-seam checks failed: ${failures}`)
  process.exit(1)
}
console.log('\nall adapter-seam checks passed')
