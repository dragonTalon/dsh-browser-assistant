#!/usr/bin/env node
/**
 * 探针：验证 dsh 里的 bridge 是否加载、WebSocket 通信是否通。
 * 用法：node scripts/probe.mjs [port]   （默认 3080）
 *
 * 步骤：fetch /ext/bridge-config 拿 wsUrl → WebSocket 连上 → hello 握手
 *       → 发一个真实 rpc（session.list）→ 打印结果。
 */
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'

const port = process.argv[2] ?? '3080'
const base = `http://127.0.0.1:${port}`

// 1) 发现桥地址
let wsUrl
try {
  const res = await fetch(`${base}/ext/bridge-config`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await res.json()
  if (typeof body.wsUrl !== 'string' || !body.wsUrl.startsWith('ws')) throw new Error('无 wsUrl')
  wsUrl = body.wsUrl
  console.log(`✔ 桥配置端点正常: ${body.wsUrl}`)
} catch (e) {
  console.error(`✘ 桥未加载 (${base}/ext/bridge-config): ${e.message}`)
  console.error('  → 未加载时该地址返回的是 HTML 页面而非 JSON')
  process.exit(1)
}

// 2) 读 token（回环免 token，但带上更贴近扩展真实行为）
const tokenFile = `${process.env.HOME}/.dsh/ext-bridge-token`
let token = ''
try { token = readFileSync(tokenFile, 'utf8').trim() } catch { /* 可空 */ }
if (token) console.log(`✔ token 已读取 (${token.slice(0, 12)}…)`)

// 3) 握手 + 发 rpc
const ws = new WebSocket(wsUrl)
const timer = setTimeout(() => { console.error('✘ 超时'); process.exit(2) }, 8000)

ws.on('open', () => {
  ws.send(JSON.stringify({
    t: 'hello',
    token,
    caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 },
  }))
})
ws.on('message', (data) => {
  const frame = JSON.parse(data.toString())
  if (frame.t === 'hello.ok') {
    console.log('✔ hello.ok，协商 caps:', JSON.stringify(frame.caps))
    ws.send(JSON.stringify({ t: 'rpc', id: 'probe-1', method: 'session.list', payload: {} }))
  } else if (frame.t === 'rpc.result') {
    if (!frame.ok) { console.error('✘ rpc 失败:', JSON.stringify(frame.error)); process.exit(1) }
    const items = frame.result?.result?.value?.items
    console.log(`✔ rpc(session.list) 成功，共 ${Array.isArray(items) ? items.length : '?'} 个会话`)
    console.log('  完整链路：扩展 → WebSocket → bridge → Typert Gateway → 返回，全部打通')
    clearTimeout(timer); ws.close(); process.exit(0)
  } else if (frame.t === 'error') {
    console.error('✘ 收到 error 帧:', JSON.stringify(frame))
    clearTimeout(timer); process.exit(1)
  }
})
ws.on('error', (e) => { console.error('✘ WebSocket 连接失败:', e.message); clearTimeout(timer); process.exit(1) })
