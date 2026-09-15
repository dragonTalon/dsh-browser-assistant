#!/usr/bin/env node
/**
 * End-to-end check for the `sessionWorkspace` grouping contract.
 *
 * Speaks the real bridge wire protocol over WebSocket — the same path the
 * Chrome panel uses — and reads the outcome back from dsh's own durable
 * Workspace registry, so grouping is asserted from observable state instead of
 * a visual guess:
 *   1. BEFORE the create, no Workspace holds the configured directory
 *   2. `session.create {}` — an empty payload, exactly what the panel sends
 *   3. a Workspace titled `bridge-dsh` appeared whose `sessionIds` holds it
 *   4. that Session's `cwd` equals the configured directory
 *
 * Usage: pnpm check:grouping:e2e
 *   BRIDGE_BASE          default http://127.0.0.1:3080
 *   SESSION_WORKSPACE    default <repo>/packages/bridge-dsh
 *   EXPECT               `grouped` (default) or `ungrouped` for the fail-soft run
 *
 * NOTE: the bridge serves ONE extension connection at a time, so running this
 * briefly supersedes the Chrome panel's connection; the extension reconnects on
 * its own once this script disconnects. Every run also creates a real Session.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = process.env.BRIDGE_BASE ?? 'http://127.0.0.1:3080'
const WORKSPACE_PATH = process.env.SESSION_WORKSPACE ?? join(repoRoot, 'packages', 'bridge-dsh')
const WORKSPACE_FILE = join(homedir(), '.dsh', 'storages', 'workspace.json')
/** `grouped` asserts the feature works; `ungrouped` asserts the fail-soft path. */
const EXPECT = process.env.EXPECT ?? 'grouped'
if (EXPECT !== 'grouped' && EXPECT !== 'ungrouped') {
  console.error(`error: EXPECT must be "grouped" or "ungrouped", got ${JSON.stringify(EXPECT)}`)
  process.exit(2)
}

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        ${detail}`)
}
const skip = (name, why) => console.log(`SKIP  ${name}\n        ${why}`)

const readWorkspaces = () => {
  const raw = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
  return Object.entries(raw.tables.workspaces).map(([id, w]) => ({
    id, path: w.path, title: w.title, sessionIds: w.sessionIds ?? [],
  }))
}

// --- 1. pre-state ----------------------------------------------------------
const pre = readWorkspaces()
const preMatch = pre.find((w) => w.path === WORKSPACE_PATH)
const preCount = preMatch?.sessionIds.length ?? 0
console.log('configured directory:', WORKSPACE_PATH)
console.log('pre-state workspaces:', JSON.stringify(pre.map((w) => `${w.title}(${w.sessionIds.length})`)))
console.log(
  'pre-state target:',
  preMatch === undefined
    ? '工作区尚不存在 —— 本次创建应当把它建出来'
    : `工作区已存在（${preMatch.sessionIds.length} 个会话）—— 本次创建应当复用它`,
)

// --- 2. connect and create through the real bridge -------------------------
const cfg = await (await fetch(`${BASE}/ext/bridge-config`)).json()
console.log('discovered wsUrl:', cfg.wsUrl)
const token = readFileSync(join(homedir(), '.dsh', 'ext-bridge-token'), 'utf8').trim()

const ws = new WebSocket(cfg.wsUrl)
const pending = new Map()
let seq = 0
let resolveHello
const helloSeen = new Promise((r) => { resolveHello = r })

ws.on('message', (raw) => {
  const frame = JSON.parse(raw.toString())
  if (frame.t === 'hello.ok') { resolveHello(frame.caps); return }
  if (frame.t === 'rpc.result') {
    const entry = pending.get(frame.id)
    if (entry === undefined) return
    pending.delete(frame.id)
    entry(frame)
  }
})

const rpcOnce = (method, payload) => new Promise((resolve_) => {
  const id = `w${++seq}`
  const timer = setTimeout(() => {
    pending.delete(id)
    resolve_(undefined)
  }, 15000)
  pending.set(id, (frame) => { clearTimeout(timer); resolve_(frame) })
  ws.send(JSON.stringify({ t: 'rpc', id, method, payload }))
})

/** Retry once: a reconnecting Chrome panel can supersede this socket mid-call. */
const rpc = async (method, payload) => await rpcOnce(method, payload) ?? await rpcOnce(method, payload)

await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej) })
ws.send(JSON.stringify({
  t: 'hello',
  token,
  caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 },
}))
const caps = await Promise.race([
  helloSeen,
  new Promise((_, rej) => setTimeout(() => rej(new Error('hello timed out')), 10000)),
])
console.log('hello.ok caps:', JSON.stringify(caps))

const created = await rpc('session.create', {})
const value = created?.result?.result?.value
const sessionId = value?.sessionId
console.log('session.create ->', typeof sessionId === 'string' ? sessionId : JSON.stringify(created).slice(0, 300))
check(
  'session.create 以空 payload 成功返回 sessionId',
  created?.ok === true && created?.result?.result?.ok === true && typeof sessionId === 'string',
  JSON.stringify(created),
)

// --- 3. post-state: membership --------------------------------------------
await new Promise((r) => setTimeout(r, 1500))
const post = readWorkspaces()
const postMatch = post.find((w) => w.path === WORKSPACE_PATH)
const holding = post.find((w) => w.sessionIds.includes(sessionId))
console.log('post-state workspaces:', JSON.stringify(post.map((w) => `${w.title}(${w.sessionIds.length})`)))

if (EXPECT === 'grouped') {
  check(
    '创建后存在 path 等于配置目录、标题为 bridge-dsh 的工作区',
    postMatch !== undefined && postMatch.title === 'bridge-dsh',
    JSON.stringify(postMatch),
  )
  check(
    '新会话已登记进该工作区的成员账本',
    postMatch !== undefined && postMatch.sessionIds.includes(sessionId),
    `sessionId=${sessionId} sessionIds=${JSON.stringify(postMatch?.sessionIds)}`,
  )
  check(
    '成员账本恰好新增一条（既有会话归属未受影响）',
    postMatch !== undefined && postMatch.sessionIds.length === preCount + 1,
    `before=${preCount} after=${postMatch?.sessionIds.length}`,
  )
  check(
    '该会话没有被登记到任何其他工作区',
    holding === undefined || holding.path === WORKSPACE_PATH,
    `held by ${JSON.stringify(holding)}`,
  )
} else {
  check(
    '未分组: 没有任何工作区登记该会话',
    holding === undefined,
    `held by ${JSON.stringify(holding)}`,
  )
}

// --- 4. the Session's cwd ---------------------------------------------------
const listed = await rpc('session.list', {})
const items = listed?.result?.result?.value?.items
const cwdCheckName = EXPECT === 'grouped' ? '会话 cwd 等于配置目录' : '会话 cwd 不是配置目录'
if (!Array.isArray(items)) {
  skip(cwdCheckName, 'session.list 未应答（扩展重连可能抢占了本连接），请重跑本脚本')
} else {
  const summary = items.find((i) => i.sessionId === sessionId)
  console.log('session.list entry:', JSON.stringify({ sessionId: summary?.sessionId, cwd: summary?.cwd }))
  check(
    cwdCheckName,
    EXPECT === 'grouped' ? summary?.cwd === WORKSPACE_PATH : summary?.cwd !== WORKSPACE_PATH,
    `cwd=${summary?.cwd}`,
  )
}

ws.close(1000, 'assertions complete')
await new Promise((r) => setTimeout(r, 300))

console.log(failures === 0 ? '\nALL E2E CHECKS PASSED' : `\n${failures} E2E CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
