/**
 * Small pure formatting helpers shared across the panel (and reusable by any
 * future surface that needs the same rendering).
 *
 * @module
 */

/** Format a Unix-epoch millisecond timestamp as local `HH:MM:SS`. */
export function fmtTime(time: number): string {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * Render one region element as a single `<tag#id.class role="…"> "name" @(x,y W×H)`
 * line. Tolerates an unknown/partial object shape because it re-parses a
 * structured value that crossed the content→background→panel message boundary;
 * every field is independently validated.
 * @param el - the (untrusted) element description.
 * @returns a stable one-line description.
 */
export function formatRegionElement(el: unknown): string {
  const e = el as { tag?: unknown; id?: unknown; classes?: unknown; role?: unknown; name?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  const tag = typeof e.tag === 'string' ? e.tag : '?'
  const id = typeof e.id === 'string' && e.id !== '' ? `#${e.id}` : ''
  const cls = typeof e.classes === 'string' && e.classes !== '' ? `.${e.classes.trim().split(/\s+/).join('.')}` : ''
  const role = typeof e.role === 'string' && e.role !== '' ? ` role="${e.role}"` : ''
  const name = typeof e.name === 'string' && e.name !== '' ? ` "${e.name}"` : ''
  const coords = ` @(${String(e.x)},${String(e.y)} ${String(e.width)}×${String(e.height)})`
  return `<${tag}${id}${cls}${role}>${name}${coords}`
}
