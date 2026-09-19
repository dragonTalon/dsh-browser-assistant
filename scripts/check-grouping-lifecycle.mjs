#!/usr/bin/env node
/**
 * Behavioral check for the bridge's Session-workspace grouping lifecycle.
 *
 * The repo has no test suite, so this bundles the REAL `RemoteHostApi` and
 * drives it with a fake Typert gateway. It asserts the scenario added by
 * `openspec/changes/slash-command-fixes/specs/bridge-session-workspace/spec.md`:
 * a registration interrupted by a connection replacement must not disable
 * grouping for later callers.
 *
 * Usage: pnpm check:grouping-lifecycle   (no dsh, no Chrome, no network)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'node_modules', '.cache', 'grouping-lifecycle')

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
const outfile = join(outDir, 'api.mjs')
const built = spawnSync(resolveEsbuild(), [
  join(repoRoot, 'packages/bridge-dsh/src/remote-host-api.ts'),
  '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${outfile}`,
  '--log-level=error',
], { stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const { createRemoteHostApi } = await import(pathToFileURL(outfile).href)

let failures = 0
function check(name, condition, detail) {
  if (!condition) failures += 1
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`)
  if (!condition) console.log(`        ${detail}`)
}

/** Whether an abort signal was already aborted when the gateway saw it. */
function seenAborted(signal) {
  return signal === undefined || signal.aborted
}

/**
 * Build one API instance plus the gateway that records what it was asked to do.
 * @param hangFirstCreate when true, the first `workspace.create` never settles
 *   on its own, so the caller's abort is what ends its wait.
 */
function makeApi({ hangFirstCreate }) {
  const calls = []
  let createCount = 0
  let releaseFirst
  const gateway = {
    wireStream: {
      open: async () => (async function* () {})(),
      failure: (error) => ({ code: 'internal', message: String(error) }),
    },
    invoke: (request) => {
      calls.push({ method: request.method, signal: request.signal, args: request.args })
      // A real Remote call rejects when its caller's signal aborts, rather
      // than resolving anyway. Without this the fake hides the whole bug.
      if (request.signal?.aborted === true) {
        return Promise.reject(request.signal.reason ?? new Error('aborted'))
      }
      if (request.method === 'create') {
        createCount += 1
        if (hangFirstCreate && createCount === 1) {
          return new Promise((resolve, reject) => {
            releaseFirst = () => { resolve({ workspace: { workspaceId: 'ws-1' } }) }
            request.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
          })
        }
        // The host's own value shape; a wrong shape here would silently make
        // the cache useless, so it is asserted separately below.
        return Promise.resolve({ workspace: { workspaceId: 'ws-1' } })
      }
      // A session id, so the caller can tell the session apart from grouping.
      return Promise.resolve('sess-1')
    },
  }
  const connection = {
    createSharedFetchHandler: () => ({ fetch: async () => new Response('{}') }),
  }
  const api = createRemoteHostApi(gateway, connection, undefined, { workspacePath: '/tmp/grouped' })
  return { api, calls, release: () => { releaseFirst?.() } }
}

const create = (signal) => ({ rpcId: 'r', method: 'session.create', payload: {}, signal })

// ---- 1. a caller that aborts mid-registration must not poison the cache ----
{
  const { api, calls, release } = makeApi({ hangFirstCreate: true })
  const connA = new AbortController()
  const before = calls.length
  const waiting = Promise.resolve(api.call(create(connA.signal))).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  await new Promise((done) => { setTimeout(done, 10) })
  check(
    '注册发起时使用桥自己的 signal（未被调用方中止）',
    calls.length > 0 && !seenAborted(calls[0]?.signal),
    `gateway saw signal aborted=${seenAborted(calls[0]?.signal)}`,
  )
  // Connection A is replaced while registration is still in flight.
  connA.abort()
  const first = await waiting
  const firstFailed = first.error !== undefined
    || (first.value?.ok === false && first.value?.error?.message?.includes('abort') === true)
  check(
    '连接被替换时该调用方自身以失败告终（其连接已死）',
    firstFailed,
    `first call settled as ${JSON.stringify(first)}`,
  )
  check(
    '被替换的连接下，注册没有被算作「一次失败尝试」而重复发起',
    calls.filter((entry) => entry.method === 'create' && entry.args?.request?.path !== undefined).length === 1,
    `registration attempts: ${JSON.stringify(calls.filter((e) => e.args?.request?.path !== undefined).length)}`,
  )

  // The registration the bridge owns must survive that replacement. Flush one
  // macrotask so its success is cached before the next caller asks.
  release()
  await new Promise((done) => { setTimeout(done, 10) })
  const connB = new AbortController()
  const second = await api.call(create(connB.signal))
  const groupedId = (entry) => entry.args?.request?.workspaceId
  const injects = calls.filter((entry) => entry.method === 'create' && groupedId(entry) !== undefined)
  check(
    '连接替换后新调用仍能把会话归入工作区',
    second?.ok === true && injects.length > 0,
    `second call returned ${JSON.stringify(second)}; grouping-injecting creates: ${injects.length}`,
  )
}

// ---- 1b. the registration must actually cache a usable id ----
{
  const { api, calls } = makeApi({ hangFirstCreate: false })
  await api.call(create(new AbortController().signal))
  const second = await api.call(create(new AbortController().signal))
  const groupedCreates = calls.filter(
    (entry) => entry.method === 'create' && entry.args?.request?.workspaceId !== undefined,
  )
  check(
    '注册成功后工作区 id 被缓存并用于后续会话创建',
    second?.ok === true && groupedCreates.length > 0,
    `grouped creates: ${groupedCreates.length}; gateway saw ${JSON.stringify(calls.map((c) => c.args))}`,
  )
}

// ---- 2. an already-aborted caller does not add a wait ----
{
  const { api, calls } = makeApi({ hangFirstCreate: false })
  const dead = new AbortController()
  dead.abort()
  const settles = await Promise.resolve(api.call(create(dead.signal))).then(
    (value) => ({ value }),
    (error) => ({ error }),
  )
  const registrations = calls.filter((entry) => entry.args?.request?.path !== undefined)
  check(
    '已中止的调用方不会触发一次注定被中止的注册',
    registrations.length === 0,
    `settled as ${JSON.stringify(settles)}; registration attempts: ${registrations.length}`,
  )
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)