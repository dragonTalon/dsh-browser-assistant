/**
 * The page-sharing preference vocabulary: the PRIVACY axis, independent of the
 * session permission tier.
 *
 * The tier decides what the agent may do; this preference decides whether page
 * content may leave the page at all. It is a local extension setting — it never
 * travels to the bridge. Shared by the background (persistence + enforcement)
 * and the panel (the settings control), so the three values and their
 * narrowing live in exactly one place.
 *
 * @module
 */

/** The three sharing preferences. */
export const PAGE_SHARING_PREFERENCES = ['ask', 'auto', 'off'] as const

/** One sharing preference. */
export type PageSharingPreference = typeof PAGE_SHARING_PREFERENCES[number]

/**
 * Narrow an untrusted value to a known sharing preference.
 * @param value - candidate value off a panel message or a control.
 * @returns the preference, or undefined when the value is not one of the three.
 */
export function narrowPageSharing(value: unknown): PageSharingPreference | undefined {
  return PAGE_SHARING_PREFERENCES.find((mode) => mode === value)
}
