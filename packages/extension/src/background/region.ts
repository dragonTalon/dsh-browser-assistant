/**
 * Background-side region capture: requests the drag-select from the content
 * script, then captures the active tab's viewport and crops it to the reported
 * selection rectangle.
 *
 * `chrome.tabs.captureVisibleTab` returns the active tab in a window, so this
 * path targets the tab the user is physically viewing (the drag happens there),
 * not the model's controlled-tab affinity. It is user-initiated and explicitly
 * confirmed in the panel, so it does not weaken the model-facing single-tab
 * boundary.
 *
 * @module
 */

import { MAX_SCREENSHOT_BYTES } from '@dsh-browser/protocol'
import type { RegionElement, RegionRect } from '../content/region.ts'

const CONTENT_SCRIPT_FILE = 'content.js'

/** Cropped screenshot result for the panel. */
export interface RegionScreenshot {
  mediaType: 'image/jpeg'
  /** Canonical base64 (no data-URL prefix). */
  data: string
  width: number
  height: number
}

/** Result of the region-capture round trip, delivered to the panel. */
export type RegionCaptureResult =
  | { ok: true; screenshot: RegionScreenshot; elements: RegionElement[] }
  | { ok: false; cancelled: true }
  | { ok: false; error: string }

/**
 * Ask the content script to run a drag-select and await its selection.
 * Recovers tabs opened before the extension was installed/reloaded by
 * injecting the content script on a missing-listener rejection.
 * @param tabId - the top-level tab the user is viewing.
 * @returns the selection, a cancellation marker, or an error string.
 */
export async function requestRegionSelection(tabId: number, windowId: number): Promise<RegionCaptureResult> {
  const result = await sendRegionStart(tabId, windowId)
  if (result !== undefined) return result
  // Content script not present (tab predates install/reload): inject and retry.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: [CONTENT_SCRIPT_FILE] })
  const retried = await sendRegionStart(tabId, windowId)
  if (retried !== undefined) return retried
  return { ok: false, error: '页面内容脚本无法加载，无法框选该页面。' }
}

async function sendRegionStart(tabId: number, windowId: number): Promise<RegionCaptureResult | undefined> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'DSH_REGION_START' }, { frameId: 0 }) as
      | { cancelled?: boolean; rect?: unknown }
      | undefined
    if (response === undefined || response.cancelled === true) return { ok: false, cancelled: true }
    if (!isSelection(response)) return { ok: false, error: '内容脚本返回了无效的选区。' }
    const screenshot = await captureRegionCrop(windowId, response.rect, response.dpr)
    return { ok: true, screenshot, elements: response.elements }
  } catch (error: unknown) {
    // sendMessage rejects with "Receiving end does not exist" when the content
    // script is missing; return undefined so the caller can inject and retry.
    const message = error instanceof Error ? error.message : String(error)
    if (/receiving end does not exist|could not establish connection/i.test(message)) return undefined
    return { ok: false, error: message }
  }
}

function isSelection(value: unknown): value is { rect: RegionRect; dpr: number; elements: RegionElement[] } {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { rect?: unknown; dpr?: unknown; elements?: unknown }
  if (typeof v.rect !== 'object' || v.rect === null) return false
  const rect = v.rect as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  return typeof rect.x === 'number' && typeof rect.y === 'number'
    && typeof rect.width === 'number' && typeof rect.height === 'number'
    && typeof v.dpr === 'number' && Array.isArray(v.elements)
}

/**
 * Capture the active tab's viewport and crop to the selection rectangle.
 * @param rect - selection in viewport CSS pixels.
 * @param dpr - device pixel ratio reported by the content script.
 * @returns the cropped JPEG as base64 plus intrinsic pixel dimensions.
 */
export async function captureRegionCrop(windowId: number, rect: RegionRect, dpr: number): Promise<RegionScreenshot> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
  const bitmap = await loadBitmap(dataUrl)
  const width = Math.max(1, Math.round(rect.width * dpr))
  const height = Math.max(1, Math.round(rect.height * dpr))

  let quality = 0.8
  let blob = await crop(bitmap, rect, dpr, width, height, quality)
  if (blob.size > MAX_SCREENSHOT_BYTES) {
    quality = 0.45
    blob = await crop(bitmap, rect, dpr, width, height, quality)
  }
  if (blob.size > MAX_SCREENSHOT_BYTES) {
    bitmap.close()
    throw new Error(`选区截图超过大小上限（${MAX_SCREENSHOT_BYTES} 字节）。`)
  }
  const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
  bitmap.close()
  return { mediaType: 'image/jpeg', data, width, height }
}

async function loadBitmap(dataUrl: string): Promise<ImageBitmap> {
  // 不能 fetch(dataURL)：扩展 CSP 的 connect-src 不含 data:，会被拦截。
  // 直接解码 base64 → Blob → createImageBitmap。
  const comma = dataUrl.indexOf(',')
  if (comma === -1) throw new Error('无效的截图数据。')
  const bytes = base64ToBytes(dataUrl.slice(comma + 1))
  const blob = new Blob([bytes], { type: 'image/png' })
  return createImageBitmap(blob)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function crop(bitmap: ImageBitmap, rect: RegionRect, dpr: number, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('无法创建裁剪画布。')
  const sx = Math.max(0, Math.min(bitmap.width, rect.x * dpr))
  const sy = Math.max(0, Math.min(bitmap.height, rect.y * dpr))
  const sw = Math.max(0, Math.min(bitmap.width - sx, rect.width * dpr))
  const sh = Math.max(0, Math.min(bitmap.height - sy, rect.height * dpr))
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
