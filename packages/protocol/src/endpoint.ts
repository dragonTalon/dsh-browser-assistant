/**
 * Bridge endpoint resolution: the single source of truth for turning what the
 * user typed in the panel's system-config dialog into the WebSocket endpoint
 * the extension connects to.
 *
 * Pure and dependency-free (no browser or node globals beyond `URL`), so the
 * plugin and the extension can share it verbatim. The bridge path itself comes
 * from `protocol.ts` — never a literal — so the two halves cannot drift.
 *
 * @module
 */

import { BRIDGE_PATH } from './protocol.ts'

/** Scheme-less input defaults to a plaintext bridge connection. */
export const DEFAULT_BRIDGE_SCHEME = 'ws'

/** Schemes a bridge address may use (remote deployments may terminate TLS). */
const ALLOWED_SCHEMES = new Set(['ws:', 'wss:', 'http:', 'https:'])

/** Stable reasons a host input cannot become an endpoint, for UI wording. */
export type BridgeHostErrorCode = 'unsupported-scheme' | 'invalid-url' | 'invalid-port'

/** A resolved bridge endpoint. */
export interface BridgeEndpoint {
  readonly ok: true
  /** Normalized WebSocket endpoint; empty when the input asks for local discovery. */
  readonly url: string
  /** True when the endpoint points at this machine (the zero-config path). */
  readonly loopback: boolean
  /** True when traffic is plaintext and therefore crosses a network in the clear. */
  readonly plaintext: boolean
}

/** A host input that cannot be used as an endpoint. */
export interface BridgeHostError {
  readonly ok: false
  readonly code: BridgeHostErrorCode
  /** Human-readable reason, ready to render in the config dialog. */
  readonly message: string
}

/** Result of resolving one host input. */
export type BridgeHostResolution = BridgeEndpoint | BridgeHostError

const HOST_ERRORS: Record<BridgeHostErrorCode, string> = {
  'unsupported-scheme': '地址只支持 ws:// wss:// http:// https:// 四种前缀',
  'invalid-url': '地址格式无效，示例：10.0.0.7:3080 或 wss://dsh.example.com',
  'invalid-port': '端口必须是 1–65535 之间的数字',
}

function hostError(code: BridgeHostErrorCode): BridgeHostError {
  return { ok: false, code, message: HOST_ERRORS[code] }
}

/**
 * Split a scheme-less authority off its optional port. `new URL` silently
 * drops an out-of-range port (`example.com:99999` loses the port entirely),
 * so `:0` and `:99999` would slip through unvalidated. Reading the digits from
 * the input is the only way to reject them. Userinfo (`@`) and IPv6 literals
 * are left to `URL`.
 * @param authority - scheme-less `host[:port]` text.
 * @returns the port as written, or undefined when the input carries none.
 */
function portFromAuthority(authority: string): string | undefined {
  const withoutPath = authority.split(/[/?#]/, 1)[0]!
  // Requires at least one digit: `:::` and `host:` are malformed URLs, not
  // bad ports, and must reach the URL parser so they report as invalid.
  const match = /:(\d+)$/.exec(withoutPath)
  return match?.[1]
}

/**
 * Whether a host resolves to this machine. Mirrors the bridge's own loopback
 * notion (IPv4-mapped IPv6 included) so the panel's plaintext warning and the
 * server's trust decisions agree on what counts as local.
 * @param hostname - hostname as parsed by `URL` (brackets already stripped).
 * @returns true for the loopback family.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host.startsWith('127.') || host.startsWith('::ffff:127.')
}

/**
 * Parse one address into the endpoint shape `resolveBridgeHost` returns.
 * Shared by both input forms so the loopback/plaintext verdicts cannot drift.
 * @param url - the address, already carrying a scheme.
 * @returns the resolved endpoint.
 */
function parseEndpoint(url: string): BridgeEndpoint {
  const parsed = new URL(url)
  const loopback = isLoopbackHost(parsed.hostname)
  return { ok: true, url: parsed.toString(), loopback, plaintext: parsed.protocol === 'ws:' && !loopback }
}

/**
 * Resolve one host input into a bridge endpoint.
 *
 * Rules: blank means "discover a local dsh" and resolves to an empty url;
 * scheme-less input gets {@link DEFAULT_BRIDGE_SCHEME}; `http`/`https` map to
 * `ws`/`wss`; a path that is empty or `/` gets {@link BRIDGE_PATH}; any other
 * path is preserved so a reverse proxy mounted under a sub-path stays
 * addressable.
 *
 * @param host - raw user input (trimmed internally).
 * @returns the endpoint, or a coded reason the input is unusable.
 */
export function resolveBridgeHost(host: string): BridgeHostResolution {
  const trimmed = host.trim()
  if (trimmed === '') return { ok: true, url: '', loopback: true, plaintext: false }

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed)
  const scheme = schemeMatch === null ? undefined : `${schemeMatch[1]!.toLowerCase()}:`

  // Bare authority: `10.0.0.7:3080`, `localhost:3080`, `[::1]:3080`. The URL
  // parser would read the text before the colon as a scheme, so the only safe
  // reading is `ws://<input>` with the bridge path appended.
  if (scheme !== undefined && !ALLOWED_SCHEMES.has(scheme)) {
    if (trimmed.startsWith(`${scheme}//`)) return hostError('unsupported-scheme')
    const barePort = portFromAuthority(trimmed)
    if (barePort !== undefined && (Number(barePort) < 1 || Number(barePort) > 65535)) return hostError('invalid-port')
    return safeEndpoint(`${DEFAULT_BRIDGE_SCHEME}://${trimmed}`, BRIDGE_PATH)
  }

  // Explicit scheme. Only ws/wss have a URL form without `//`; http(s) always
  // need it, so an authority is reconstructed for the forms that lack one.
  const rest = scheme === undefined ? trimmed : trimmed.slice(scheme.length)
  const authority = scheme === undefined || rest.startsWith('//') ? rest : `//${rest}`
  const targetScheme = scheme === undefined ? `${DEFAULT_BRIDGE_SCHEME}:` : scheme
  // `indexOf` returns -1 for an authority-only input; slicing on that would
  // turn the port's last digit into the pathname.
  const slashAt = authority.indexOf('/', authority.startsWith('//') ? 2 : 0)
  const rawPath = slashAt === -1 ? '' : authority.slice(slashAt)
  const barePath = rawPath.split(/[?#]/, 1)[0]!
  if (barePath === '') {
    const explicitPort = portFromAuthority(authority)
    if (explicitPort !== undefined && (Number(explicitPort) < 1 || Number(explicitPort) > 65535)) return hostError('invalid-port')
  }
  const path = barePath === '' || barePath === '/' ? BRIDGE_PATH : rawPath

  let parsed: URL
  try {
    parsed = new URL(`${targetScheme}${authority}`)
  } catch {
    return hostError('invalid-url')
  }
  if (parsed.hostname === '') return hostError('invalid-url')
  if (parsed.protocol === 'http:') parsed.protocol = 'ws:'
  else if (parsed.protocol === 'https:') parsed.protocol = 'wss:'
  parsed.pathname = path
  return parseEndpoint(parsed.toString())
}

/**
 * Build an endpoint from an address whose host form `URL` cannot parse
 * directly (a scheme-less `host:port`), reporting parse failures as a coded
 * error instead of throwing.
 * @param url - address to parse.
 * @param path - pathname to force onto the result.
 * @returns the resolved endpoint or an `invalid-url` reason.
 */
function safeEndpoint(url: string, path: string): BridgeHostResolution {
  try {
    const target = new URL(url)
    if (target.hostname === '') return hostError('invalid-url')
    target.pathname = path
    return parseEndpoint(target.toString())
  } catch {
    return hostError('invalid-url')
  }
}

/**
 * Normalize a bearer token typed or pasted by the user. The bridge writes its
 * token file as `${token}\n` and compares bytes exactly, so reading it back
 * with `cat` always yields a trailing newline that must not reach the
 * handshake.
 * @param token - raw user input.
 * @returns the token with surrounding whitespace removed.
 */
export function normalizeBridgeToken(token: string): string {
  return token.trim()
}
