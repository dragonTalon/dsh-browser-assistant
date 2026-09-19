#!/usr/bin/env node
/**
 * Behavioral check for the bridge's session-ordered RPC release.
 *
 * The repo has no test suite, so this bundles the REAL `BridgeServer` with the
 * same esbuild resolution order as `packages/bridge-dsh/build.sh` and drives it
 * over a real WebSocket with a fake host adapter. It asserts the scenarios in
 * `openspec/changes/slash-command-fixes/specs/bridge-session-events/spec.md`
 * that are decidable without a live dsh: a host call that never settles must
 * not hold its session's queue slot forever, and its failure must not claim the
 * call was cancelled.
 *
 * Usage: pnpm check:ordered-rpc      (no dsh, no Chrome, no network required)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'ordered-rpc')

/** Mirror build.sh's esbuild resolution: override → workspace → offline fallback. */
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
const outfile = join(outDir, 'server.mjs')
const built = spawnSync(resolveEsbuild(), [
  join(repoRoot, 'packages/bridge-dsh/src/server.ts'),
  '--bundle', '--platform=node', '--format=esm', '--target=node22',
  '--external:ws',
  `--outfile=${outfile}`,
  '--log-level=error',
], { stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const { BridgeServer } = await import(pathToFileURL(outfile).href)

const TOKEN = 'check-token'
const HELLO_CAPS = { textOnly: true, snapshotMaxChars: 4_000, maxInteractiveItems: 50 }

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

/** A host adapter whose `call` resolves, hangs, or rejects per method. */
function makeHost(calls) {
  return {
    call(call) {
      calls.push(call.method)
      if (call.method === 'session.history') {
        return Promise.resolve({ events: [], hasMore: false })
      }
      if (call.method === 'commands.execute') {
        // The host's execute settles only after its handler finishes: model it
        // as a call that never settles unless the caller aborts it.
        return new Promise((_resolve, reject) => {
          const fail = () => reject(call.signal.reason ?? new Error('aborted'))
          if (call.signal.aborted) fail()
          else call.signal.addEventListener('abort', fail, { once: true })
        })
      }
      return Promise.resolve({ ok: true })
    },
    events: async function* () {},
    respond: () => Promise.resolve({ accepted: true }),
  }
}

const calls = []
const deadlineMs = 250
const server = new BridgeServer({
  token: TOKEN,
  api: makeHost(calls),
  toolTimeoutMs: 5_000,
  caps: HELLO_CAPS,
  pingIntervalMs: 60_000,
  orderedRpcDeadlineMs: deadlineMs,
})

const http = createServer()
http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head))
await new Promise((done) => http.listen(0, '127.0.0.1', done))
const port = http.address().port

const ws = new WebSocket(`ws://127.0.0.1:${port}/ext/bridge`)
const answers = new Map()
ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.t === 'rpc.result') answers.get(frame.id)?.(frame)
})
await new Promise((done, fail) => { ws.on('open', done); ws.on('error', fail) })

/** Send one rpc frame and resolve with its rpc.result (or null on timeout). */
function rpc(id, method, payload) {
  return new Promise((done) => {
    const timer = setTimeout(() => done(null), 5_000)
    answers.set(id, (frame) => { clearTimeout(timer); done(frame) })
    ws.send(JSON.stringify({ t: 'rpc', id, method, payload }))
  })
}

ws.send(JSON.stringify({ t: 'hello', token: TOKEN, caps: HELLO_CAPS }))
await new Promise((done) => { ws.once('message', done) })

// ---- the ordered call hangs and must be released by its own deadline ----
const slow = await rpc('slow', 'commands.execute', { sessionId: 'S', line: '/compact' })

check(
  '长命令超时后以失败收尾',
  slow !== null && slow.ok === false,
  `expected a failed rpc.result, got ${JSON.stringify(slow)}`,
)
check(
  '超时错误码为 timeout（不是 internal）',
  slow?.error?.code === 'timeout',
  `got code ${JSON.stringify(slow?.error?.code)}`,
)
check(
  '超时文案不声称已取消',
  typeof slow?.error?.message === 'string'
    && !/cancel|abort|stopped/i.test(slow.error.message)
    && /may still be running/i.test(slow.error.message),
  `message was ${JSON.stringify(slow?.error?.message)}`,
)

// ---- the released slot lets the same session run again ----
const started = Date.now()
const next = await rpc('next', 'session.history', { sessionId: 'S' })
const elapsed = Date.now() - started

check(
  '超时后同会话后续 RPC 继续被处理',
  next !== null && next.ok === true,
  `expected a successful rpc.result, got ${JSON.stringify(next)}`,
)
check(
  '后续 RPC 不等待已超时的调用',
  elapsed < deadlineMs * 2,
  `took ${elapsed}ms, which suggests it is still queued behind the timed-out call`,
)

// ---- arrival order is still preserved for calls that settle in time ----
calls.length = 0
const ordered = await rpc('ordered', 'session.prompt', { sessionId: 'S' })
check(
  '未超时的调用正常返回',
  ordered !== null && ordered.ok === true,
  `expected success, got ${JSON.stringify(ordered)}`,
)
check(
  '未超时的调用确实到达宿主',
  calls.includes('session.prompt'),
  `host saw ${JSON.stringify(calls)}`,
)

ws.close()
await server.close()
http.close()

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)