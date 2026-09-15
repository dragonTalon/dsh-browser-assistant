#!/usr/bin/env node
/**
 * End-to-end check for the panel's session-adoption path.
 *
 * Speaks the real bridge wire protocol — the same path the Chrome panel uses —
 * and asserts the premise the panel session picker is built on: an existing
 * session can be bound and read through `session.list` + `session.history`
 * ALONE, with no `session.create` anywhere in the flow.
 *
 * That premise is what lets the picker adopt a session without triggering the
 * Host's create-by-identity path (which injects the bridge's configured
 * workspace and fails with `session/conflict` for a session living elsewhere).
 * This script never creates a session, so it also proves adoption is read-only:
 * the session list is compared before and after.
 *
 * Usage: pnpm check:selection:e2e
 *   BRIDGE_BASE   default http://127.0.0.1:3080
 *
 * NOTE: the bridge serves ONE extension connection at a time, so running this
 * briefly supersedes the Chrome panel's connection; the extension reconnects on
 * its own once this script disconnects.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const BASE = process.env.BRIDGE_BASE ?? 'http://127.0.0.1:3080'
const TOKEN_FILE = join(homedir(), '.dsh', 'ext-bridge-token')

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`        ${detail}`)
}
const skip = (name, why) => console.log(`SKIP  ${name}\n        ${why}`)

// --- connect through the real bridge ---------------------------------------
const cfg = await (await fetch(`${BASE}/ext/bridge-config`)).json()
console.log('discovered wsUrl:', cfg.wsUrl)
const token = readFileSync(TOKEN_FILE, 'utf8').trim()

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

/** Unwrap the bridge's `{ result: { ok, value } }` envelope. */
const valueOf = (frame) => frame?.ok === true && frame?.result?.result?.ok === true
  ? frame.result.result.value
  : undefined

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

// --- 1. session.list supplies the picker's candidates ----------------------
const firstList = await rpc('session.list', {})
const items = valueOf(firstList)?.items
check(
  'session.list 返回 items 数组',
  firstList?.ok === true && Array.isArray(items),
  JSON.stringify(firstList).slice(0, 300),
)

const all = Array.isArray(items) ? items : []
const reusable = all.filter((item) => item?.blank !== true && item?.origin !== 'subagent')
console.log(
  `会话总数 ${all.length}，其中可复用（非空、非子代理）${reusable.length}，`
  + `空会话 ${all.filter((item) => item?.blank === true).length}，子代理 ${all.filter((item) => item?.origin === 'subagent').length}`,
)
check('列表中存在可复用的历史会话', reusable.length > 0, `items=${all.length}`)

const target = [...reusable].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
const titled = reusable.filter((item) => typeof item?.projections?.values?.title === 'string' && item.projections.values.title !== '')
const withCwd = reusable.filter((item) => typeof item?.cwd === 'string' && item.cwd !== '')
console.log('候选样本:', JSON.stringify({
  sessionId: target?.sessionId,
  title: target?.projections?.values?.title,
  cwd: target?.cwd,
  updatedAt: target?.updatedAt,
  running: target?.running,
}))
check(
  '候选项带标题投影（可为空，但字段可用）',
  titled.length > 0,
  `titled=${titled.length}/${reusable.length}`,
)
check('候选项带 cwd', withCwd.length > 0, `withCwd=${withCwd.length}/${reusable.length}`)
check(
  '候选项带可排序的 updatedAt',
  typeof target?.updatedAt === 'number' && Number.isFinite(target.updatedAt),
  JSON.stringify(target?.updatedAt),
)

if (target === undefined) {
  skip('session.history 收养路径', '没有可复用的会话可供收养')
  ws.close()
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

// --- 2. session.history alone presents that session ------------------------
const history = await rpc('session.history', { sessionId: target.sessionId })
const historyValue = valueOf(history)
const events = Array.isArray(historyValue?.events) ? historyValue.events : []
check(
  'session.history 以既有 sessionId 成功返回',
  history?.ok === true && historyValue !== undefined,
  JSON.stringify(history).slice(0, 300),
)
check('历史含事件数组', events.length > 0, `events=${events.length}`)
check(
  '历史响应带 hasMore 截断标记',
  typeof historyValue?.hasMore === 'boolean',
  JSON.stringify(historyValue?.hasMore),
)
check(
  '历史响应带投影（面板据此对齐模型显示）',
  historyValue?.projections !== undefined,
  JSON.stringify(Object.keys(historyValue ?? {})),
)

const seqs = events
  .map((entry) => entry?.event?.seq)
  .filter((value) => typeof value === 'number' && Number.isSafeInteger(value))
check(
  '每个事件都带可用的 seq（重放边界与补齐依据）',
  seqs.length === events.length && seqs.length > 0,
  `sequenced=${seqs.length}/${events.length}`,
)
const maxSeq = seqs.length > 0 ? Math.max(...seqs) : -1
console.log('重放边界 maxSeq:', maxSeq, '| 事件类型样本:', JSON.stringify(
  [...new Set(events.map((entry) => entry?.event?.type))].slice(0, 8),
))
check(
  '历史含用户或助手消息（可读的对话内容）',
  events.some((entry) => entry?.event?.type === 'user/message' || entry?.event?.type === 'assistant/message'),
  JSON.stringify(events.slice(0, 3).map((entry) => entry?.event?.type)),
)

// --- 3. adoption created nothing ------------------------------------------
const secondList = await rpc('session.list', {})
const after = valueOf(secondList)?.items
check(
  '全程未调用 session.create：会话数量不变',
  Array.isArray(after) && after.length === all.length,
  `before=${all.length} after=${Array.isArray(after) ? after.length : JSON.stringify(after)}`,
)
const stillThere = Array.isArray(after) && after.some((item) => item?.sessionId === target.sessionId)
check('被收养的会话仍在列表中（未被搬迁或替换）', stillThere === true, `sessionId=${target.sessionId}`)

ws.close()
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
