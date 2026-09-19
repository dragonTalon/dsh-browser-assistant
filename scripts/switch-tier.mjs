#!/usr/bin/env node
/**
 * Switch one session's browser permission tier through the bridge's own RPC.
 *
 * Verification aid for the tier change: drives the exact RPC the Chrome panel
 * uses (`permission.set`), so a live check can move a session between tiers
 * without impersonating the panel. Fails closed on every step — a refused
 * switch is reported as a failure rather than silently ignored.
 *
 * Usage: node scripts/switch-tier.mjs <sessionId> <preset>
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const [sessionId, preset] = process.argv.slice(2)
if (!sessionId || !preset) {
  console.error('usage: node scripts/switch-tier.mjs <sessionId> <preset>')
  process.exit(2)
}

const token = readFileSync(join(homedir(), '.dsh', 'ext-bridge-token'), 'utf8').trim()
const ws = new WebSocket('ws://127.0.0.1:3080/ext/bridge')

const timer = setTimeout(() => { console.error('FAIL: timed out after 15s'); process.exit(1) }, 15_000)

ws.on('open', () => {
  ws.send(JSON.stringify({
    t: 'hello',
    token,
    caps: { textOnly: true, snapshotMaxChars: 32000, maxInteractiveItems: 60 },
  }))
})

ws.on('message', (raw) => {
  let frame
  try { frame = JSON.parse(String(raw)) } catch { return }
  if (frame.t === 'hello.ok') {
    ws.send(JSON.stringify({
      t: 'rpc',
      id: 'switch-1',
      method: 'permission.set',
      payload: { sessionId, preset },
    }))
    return
  }
  if (frame.t === 'rpc.result' && frame.id === 'switch-1') {
    clearTimeout(timer)
    if (frame.ok) {
      console.log(`OK: ${sessionId} -> ${preset}`)
      ws.close()
      process.exit(0)
    }
    console.error(`FAIL: ${frame.error?.code}: ${frame.error?.message}`)
    ws.close()
    process.exit(1)
  }
  if (frame.t === 'error') {
    clearTimeout(timer)
    console.error(`FAIL: bridge error ${frame.code}: ${frame.message}`)
    process.exit(1)
  }
})

ws.on('error', (error) => {
  clearTimeout(timer)
  console.error(`FAIL: socket error: ${error.message}`)
  process.exit(1)
})
