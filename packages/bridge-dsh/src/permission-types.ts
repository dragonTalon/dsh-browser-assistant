/**
 * Wire and solving types shared by the tier modules.
 *
 * Separate from `permission.ts` so the cross-check module can describe what it
 * compares without importing the module that performs the comparison — a
 * dependency that would otherwise run both ways. Everything here is either a
 * declaration or a plain data shape; the behaviour lives in `permission.ts`.
 *
 * @module
 */

import type { BridgePermissionTier } from '@dsh-browser/protocol'

/**
 * The `permissions` session projection's WIRE VIEW, as dsh publishes it.
 *
 * Structurally typed rather than imported: the bridge deliberately does not
 * depend on dsh's permission-presets package (the plugin's narrow-interface rule
 * keeps the dsh version surface in one adapter). Only the fields this bridge
 * needs are declared.
 *
 * The distinction from the unit's host state is load-bearing. `stateOf` returns
 * the FOLD state (`preset`/`sandbox`/`approval`/`seeded`), which carries neither
 * of these fields; the published client view is produced by the unit's own
 * `view()`. Reading the wrong one yields `undefined` here — never an error.
 */
export interface PermissionProjection {
  readonly options?: readonly PresetTableEntry[]
  readonly currentValue?: unknown
}

/**
 * The slice of a session the tier solver reads.
 *
 * Structurally typed for the same reason the projection reader is: the bridge
 * keeps its dsh-version surface narrow. Only the event log is needed — `seq` is
 * the log length and `eventAt` addresses one position, both of which dsh
 * documents as stable session readers.
 */
export interface SessionShaped {
  readonly seq: number
  eventAt(seq: number): EventShaped | undefined
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly EventShaped[]
}

/** One session event as this bridge reads it. */
export interface EventShaped {
  readonly seq?: number
  readonly type?: string
  readonly data?: unknown
}

/** The sandbox/approval pair one preset expands to. */
export interface PresetBundle {
  readonly sandbox: string
  readonly approval: string
}

/**
 * One preset as the deployment publishes it.
 *
 * `sandbox`/`approval` are optional because a deployment may publish only the
 * names; a name without a bundle falls back to the built-in table, and a name
 * known to neither simply cannot be recognized as "still matching" (which is
 * the strict direction, not a silent pass).
 */
export interface PresetTableEntry {
  readonly value: string
  readonly name?: string
  readonly sandbox?: string
  readonly approval?: string
}

/**
 * One preset with its bundle resolved, as the fold consumes it.
 *
 * The bundle stays optional: a name no source can explain is carried through
 * bundle-less so the caller can report it as unresolvable rather than treat it
 * as matching something.
 */
export interface PresetBundleEntry {
  readonly value: string
  readonly sandbox?: string
  readonly approval?: string
}

/** Why a tier could not be solved. Each reason is separately diagnosable. */
export type SolveFailureReason =
  /** The session's event log could not be read at all. */
  | 'session-unreadable'
  /** A knob event was present but did not carry a usable payload. */
  | 'malformed-knob-event'
  /** The session records no permission knob event yet. */
  | 'no-knob-events'
  /**
   * The session records a preset whose knobs are unknowable — neither the
   * deployment's declarations nor the built-in table explain it. A name that is
   * merely absent from the advertised list is NOT this case: the session's log
   * remains the authority on what it runs under.
   */
  | 'preset-bundle-unknown'

/**
 * Why a deployment has no tier capability. A positive finding, unlike
 * {@link SolveFailureReason}.
 */
export type CapabilityAbsentReason =
  /** The deployment advertises no preset table. */
  | 'no-preset-table'

/**
 * The three outcomes of solving a tier.
 *
 * These MUST NOT be folded into each other. `solved` is the tier itself;
 * `unresolved` is a deployment that provably has no tiers (the pre-tier
 * behavior applies); `failed` is an absence of knowledge, which is a different
 * fact and must surface as such.
 */
export type PermissionResolution =
  | {
    readonly kind: 'solved'
    /** Tier as solved, kept verbatim for display (`custom` stays `custom`). */
    readonly value: BridgePermissionTier
    /** Tier used for gating; `custom` folds to the strictest. */
    readonly effective: BridgePermissionTier
    /** Preset names this session advertises. */
    readonly options: readonly string[]
  }
  | {
    readonly kind: 'unresolved'
    readonly reason: CapabilityAbsentReason
    readonly options: readonly string[]
  }
  | {
    readonly kind: 'failed'
    readonly reason: SolveFailureReason
    /** Human-readable detail for the log; never shown to the model verbatim. */
    readonly detail: string
    readonly options: readonly string[]
  }
