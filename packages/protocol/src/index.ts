/**
 * Package root for `@dsh-browser/protocol`: the wire contract plus the
 * address rules for reaching it.
 *
 * `protocol.ts` stays the single source of truth for frames and constants;
 * `endpoint.ts` owns how a user-typed address becomes a bridge WebSocket URL.
 * Both halves import this barrel so a module move never touches importers.
 *
 * @module
 */

export * from './protocol.ts'
export * from './endpoint.ts'
