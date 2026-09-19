/**
 * Region-selection vocabulary shared by the content script (which reports the
 * rectangle and its intersecting elements) and the background (which consumes
 * them for the screenshot crop and the panel prompt).
 *
 * Kept in the common area so the background never depends on content-script
 * modules for a type; the content script imports the same shapes.
 *
 * @module
 */

/** Selection rectangle in viewport CSS pixels. */
export interface RegionRect {
  x: number
  y: number
  width: number
  height: number
}

/** One intersecting element's structured description. */
export interface RegionElement {
  tag: string
  id?: string
  classes?: string
  role?: string
  /** Accessible name or text summary; sensitive fields carry no value. */
  name: string
  /** Coordinates relative to the selection's top-left, in CSS pixels. */
  x: number
  y: number
  width: number
  height: number
}
