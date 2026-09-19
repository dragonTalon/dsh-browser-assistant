/**
 * Coarse bridge connection state for the UI.
 *
 * Shared vocabulary for the panel and the background: the panel renders this
 * state and the background owns it. Kept in the common area so the panel never
 * depends on background runtime modules for a display type.
 *
 * @module
 */

/** Coarse connection state for the UI. */
export type BridgeState = 'connecting' | 'connected' | 'reconnecting' | 'stopped'
