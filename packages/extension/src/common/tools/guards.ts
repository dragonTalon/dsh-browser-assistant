/**
 * Generic runtime guards and error helpers shared across the panel.
 *
 * @module
 */

/**
 * Tag an `Error` with a stable machine-readable code (survives the RPC layer,
 * which loses `instanceof` but preserves enumerable own properties).
 */
export function withCode(error: Error, code: string): Error & { code: string } {
  return Object.assign(error, { code })
}

/** Narrow a value to a non-null object (useful at message boundaries). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read an error's stable code, if the transport attached one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
