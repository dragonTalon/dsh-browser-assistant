/**
 * RPC error wording for the panel.
 *
 * One code needs translating rather than echoing: `forbidden` is what the
 * bridge returns when a method outside the loopback trust fence is called from
 * a non-loopback connection. That is a documented deployment limit, not a
 * failure the user can fix by retrying, so it is spelled out instead of being
 * shown as a raw code — while every other code keeps its original message.
 *
 * @module
 */

import { errorCode } from '../common/index.ts'

/** The bridge's code for "this method is loopback-only". */
const FORBIDDEN = 'forbidden'

let remoteConnection = false

/**
 * Record whether the bridge is currently connected to a non-loopback dsh,
 * which decides how a `forbidden` failure is explained.
 * @param remote - true when the active endpoint is not loopback.
 */
export function setRemoteConnection(remote: boolean): void {
  remoteConnection = remote
}

/** The explanation shown when a loopback-only method is rejected. */
export function forbiddenMessage(): string {
  const suffix = remoteConnection ? '（当前连接的是远端 dsh）' : ''
  return `该操作仅在连接本机 dsh 时可用，远端连接不支持${suffix}`
}

/**
 * Turn an RPC failure into the text the conversation area shows.
 * @param error - whatever the RPC rejected with.
 * @returns a user-facing message.
 */
export function describeRpcError(error: unknown): string {
  if (errorCode(error) === FORBIDDEN) return forbiddenMessage()
  return String(error)
}

/**
 * The `[code]` marker shown next to a failed action, kept for diagnostics.
 * `forbidden` is omitted because {@link forbiddenMessage} already states the
 * cause in words; repeating the code adds noise, not information.
 * @param code - the error code, when the transport attached one.
 * @returns the suffix to append, or an empty string.
 */
export function describeCodeSuffix(code: string | undefined): string {
  if (code === undefined || code === FORBIDDEN) return ''
  return ` [${code}]`
}
