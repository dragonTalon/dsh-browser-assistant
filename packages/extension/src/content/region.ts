/**
 * Region selection: a user-initiated drag-to-select overlay plus element
 * extraction for the selected rectangle.
 *
 * The user presses the panel's arrow button; the background forwards a
 * `DSH_REGION_START` message here; this module injects a full-viewport
 * crosshair overlay, tracks the drag, and — on release — reports the selection
 * rectangle (viewport CSS pixels + devicePixelRatio) and a one-line-per-element
 * description of the DOM elements intersecting that rectangle.
 *
 * Element text is derived from `accessibleName`, which never reads input
 * `.value`, so sensitive fields (passwords/card numbers) cannot leak into the
 * element list.
 *
 * @module
 */

import { MAX_REGION_ELEMENTS } from '@dsh-browser/protocol'
import { accessibleName, directText, isVisible, truncate } from './extract.ts'
import { isSensitiveField } from './privacy.ts'

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

/** The payload the content script reports after a completed drag. */
export interface RegionSelection {
  rect: RegionRect
  dpr: number
  elements: RegionElement[]
}

/** Tags that are meaningful on their own and always described. */
const DESCRIBABLE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'img', 'picture',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'label', 'summary',
  'form', 'nav', 'header', 'footer', 'section', 'article', 'table',
  'canvas', 'video', 'svg', 'figure', 'figcaption',
  'code', 'pre', 'blockquote', 'dl', 'dt', 'dd',
])

const OVERLAY_ID = '__dshRegionOverlay__'
const BOX_ID = '__dshRegionBox__'

/**
 * Begin a drag-to-select interaction. Exactly one overlay is active at a time.
 * @param onDone - called once with the selection, or `null` when cancelled.
 */
export function startRegionSelection(onDone: (selection: RegionSelection | null) => void): void {
  if (document.getElementById(OVERLAY_ID) !== null) {
    onDone(null)
    return
  }

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.04);'
  const box = document.createElement('div')
  box.id = BOX_ID
  box.style.cssText = 'position:fixed;z-index:2147483647;display:none;border:1px solid #2e86de;background:rgba(46,134,222,0.15);pointer-events:none;'

  let startX = 0
  let startY = 0
  let dragging = false

  const finish = (selection: RegionSelection | null): void => {
    cleanup()
    onDone(selection)
  }

  const cleanup = (): void => {
    overlay.remove()
    box.remove()
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', onBlur)
  }

  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return
    dragging = true
    startX = event.clientX
    startY = event.clientY
    box.style.display = 'block'
    updateBox(event.clientX, event.clientY)
  }

  const updateBox = (clientX: number, clientY: number): void => {
    const left = Math.min(startX, clientX)
    const top = Math.min(startY, clientY)
    const width = Math.abs(clientX - startX)
    const height = Math.abs(clientY - startY)
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    box.style.width = `${width}px`
    box.style.height = `${height}px`
  }

  const onMouseMove = (event: MouseEvent): void => {
    if (!dragging) return
    updateBox(event.clientX, event.clientY)
  }

  const onMouseUp = (event: MouseEvent): void => {
    if (!dragging) return
    dragging = false
    const left = Math.min(startX, event.clientX)
    const top = Math.min(startY, event.clientY)
    const width = Math.abs(event.clientX - startX)
    const height = Math.abs(event.clientY - startY)
    if (width < 1 || height < 1) {
      finish(null)
      return
    }
    const rect: RegionRect = { x: left, y: top, width, height }
    finish({ rect, dpr: window.devicePixelRatio || 1, elements: describeRegionElements(rect) })
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') finish(null)
  }

  const onBlur = (): void => {
    // Losing focus mid-drag abandons the selection rather than leaving a stale overlay.
    finish(null)
  }

  overlay.addEventListener('mousedown', onMouseDown)
  overlay.addEventListener('mousemove', onMouseMove)
  overlay.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', onBlur)

  overlay.appendChild(box)
  document.body.appendChild(overlay)
}

/** Whether an element is worth a line in the region description. */
function isDescribable(el: HTMLElement): boolean {
  if (el.id !== '') return true
  const role = el.getAttribute('role')
  if (role !== null && role !== '') return true
  return DESCRIBABLE_TAGS.has(el.tagName.toLowerCase())
}

/** Build the structured description for one intersecting element. */
function describe(el: HTMLElement, rect: RegionRect): RegionElement {
  const r = el.getBoundingClientRect()
  const isSemantic = DESCRIBABLE_TAGS.has(el.tagName.toLowerCase())
  const rawName = isSemantic ? accessibleName(el) : directText(el)
  const name = isSensitiveField(el) ? `${rawName} (value masked)` : rawName
  const role = el.getAttribute('role')
  const classes = typeof el.className === 'string' ? el.className : ''
  return {
    tag: el.tagName.toLowerCase(),
    ...(el.id === '' ? {} : { id: el.id }),
    ...(classes.trim() === '' ? {} : { classes: truncate(classes, 60).text }),
    ...(role === null || role === '' ? {} : { role }),
    name,
    x: Math.round(r.left - rect.x),
    y: Math.round(r.top - rect.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  }
}

/** Collect visible, describable elements intersecting the selection rectangle. */
function describeRegionElements(rect: RegionRect): RegionElement[] {
  const result: RegionElement[] = []
  for (const el of document.querySelectorAll('body *')) {
    if (!(el instanceof HTMLElement)) continue
    if (el.id === OVERLAY_ID || el.id === BOX_ID) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const intersects = r.right >= rect.x
      && r.left <= rect.x + rect.width
      && r.bottom >= rect.y
      && r.top <= rect.y + rect.height
    if (!intersects) continue
    if (!isVisible(el)) continue
    if (!isDescribable(el)) continue
    result.push(describe(el, rect))
    if (result.length >= MAX_REGION_ELEMENTS) break
  }
  return result
}
