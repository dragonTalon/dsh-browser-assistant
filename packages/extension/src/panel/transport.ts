/**
 * Panel↔background transport: lazy port reconnect, `rpc()` correlation, and
 * `rpc.result` settlement. Owns no business logic — it only moves messages.
 *
 * The background service worker can be suspended by MV3, which drops the port;
 * `post()` reconnects once on failure so a single transient drop doesn't lose
 * the message.
 *
 * @module
 */

import { withCode } from '../common/tools/guards.ts'

let port: chrome.runtime.Port | null = null
let messageListener: ((message: unknown) => void) | null = null

interface PendingRpc { resolve: (value: unknown) => void; reject: (error: Error) => void }
const pendingRpc = new Map<string, PendingRpc>()
let rpcSeq = 0

/** Register the single inbound-message handler (set once by `main.ts`). */
export function setMessageListener(listener: (message: unknown) => void): void {
  messageListener = listener
}

function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: 'dsh-panel' })
  p.onMessage.addListener((message: unknown) => { messageListener?.(message) })
  p.onDisconnect.addListener(() => { if (port === p) port = null })
  return p
}

/** Send a message to the background, reconnecting once if the port dropped. */
export function post(message: unknown): void {
  if (port === null) port = connect()
  try {
    port.postMessage(message)
  } catch {
    port = connect()
    port.postMessage(message)
  }
}

/** Issue an RPC and await its settlement; rejects with a coded `Error` on failure. */
export function rpc<T>(method: string, payload: unknown): Promise<T> {
  const id = `p${++rpcSeq}`
  return new Promise<T>((resolve, reject) => {
    pendingRpc.set(id, { resolve: (value) => resolve(value as T), reject })
    try {
      post({ type: 'rpc', id, method, payload })
    } catch (e) {
      pendingRpc.delete(id)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Settle a pending `rpc()` from an inbound `rpc.result` message. */
export function settleRpcResult(r: { id: string; ok: boolean; result?: unknown; error?: { code?: string; message?: string } }): void {
  const pending = pendingRpc.get(r.id)
  if (pending === undefined) return
  pendingRpc.delete(r.id)
  // The bridge relays the gateway envelope { result: { ok, value | error } };
  // unpack the business value, converting business failures to a coded reject.
  const envelope = r.result as { result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } } | undefined
  if (r.ok && envelope?.result?.ok !== false) {
    pending.resolve(envelope?.result?.value)
  } else if (r.ok && envelope?.result?.ok === false) {
    const code = envelope.result.error?.code ?? 'rpc-failed'
    const message = envelope.result.error?.message ?? 'rpc failed'
    pending.reject(withCode(new Error(`${code}: ${message}`), code))
  } else {
    const code = r.error?.code ?? 'bridge-unavailable'
    const message = r.error?.message ?? 'rpc failed'
    pending.reject(withCode(new Error(`${code}: ${message}`), code))
  }
}
