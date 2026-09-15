/**
 * Region capture flow on the panel side: holds the pending crop as an input
 * attachment and assembles the three-section prompt when the user sends.
 *
 * Degradation to text-only is now *predictive*: when the selected model is
 * known text-only we skip the guaranteed-to-fail image round-trip; otherwise
 * we try with the image and fall back on the stable `session/attachment-invalid`
 * error code.
 *
 * @module
 */

import { rpc, post } from './transport.ts'
import { ensureSession, appendSystem, setWorking, getActiveSessionId } from './conversation.ts'
import { capabilityOf, effectiveSelection } from './model-selector.ts'
import { formatRegionElement, wrapUntrustedContent, errorCode } from '../common/index.ts'
import { buildRegionScreenshotText, buildRegionQuestionText } from '@dsh-browser/protocol'

const attachmentEl = document.getElementById('attachment')!
const attachmentImgEl = document.getElementById('attachmentImg') as HTMLImageElement
const attachmentElementsEl = document.getElementById('attachmentElements')!
const attachmentRemoveBtn = document.getElementById('attachmentRemove') as HTMLButtonElement
const regionBtn = document.getElementById('regionBtn') as HTMLButtonElement
const inputEl = document.getElementById('input') as HTMLTextAreaElement

interface PendingRegion {
  mediaType: string
  data: string
  elements: unknown[]
}

interface TextBlock { type: 'text'; text: string }
interface ImageBlock { type: 'image'; mediaType: string; data: string; name: string }
type PromptBlock = TextBlock | ImageBlock

let pendingRegion: PendingRegion | null = null
let regionSelecting = false

/** Whether a cropped region is waiting to be sent. */
export function hasPendingRegion(): boolean {
  return pendingRegion !== null
}

/** Bind the region button + attachment remove button (called once). */
export function initRegion(): void {
  regionBtn.addEventListener('click', () => {
    if (regionSelecting) return
    regionSelecting = true
    appendSystem('请在页面上拖拽框选区域（Esc 取消）…')
    post({ type: 'region.start' })
  })
  attachmentRemoveBtn.addEventListener('click', () => { clearRegionAttachment() })
}

function showRegionAttachment(region: PendingRegion): void {
  pendingRegion = region
  attachmentImgEl.src = `data:${region.mediaType};base64,${region.data}`
  attachmentElementsEl.textContent = region.elements.map(formatRegionElement).join('\n')
  attachmentEl.classList.add('show')
  // The intent goes into the main input; hand focus back to the composer.
  inputEl.focus()
}

function clearRegionAttachment(): void {
  pendingRegion = null
  attachmentImgEl.src = ''
  attachmentElementsEl.textContent = ''
  attachmentEl.classList.remove('show')
}

/** Handle the background's `region.result` message. */
export function handleRegionResult(result: unknown): void {
  regionSelecting = false
  if (typeof result !== 'object' || result === null) {
    appendSystem('框选失败：返回了无效结果。')
    return
  }
  const r = result as { ok?: boolean; cancelled?: boolean; error?: string; screenshot?: unknown; elements?: unknown }
  if (r.ok === true && typeof r.screenshot === 'object' && r.screenshot !== null) {
    const shot = r.screenshot as { mediaType?: unknown; data?: unknown }
    if (typeof shot.mediaType !== 'string' || typeof shot.data !== 'string' || !Array.isArray(r.elements)) {
      appendSystem('框选失败：截图或元素数据不完整。')
      return
    }
    showRegionAttachment({ mediaType: shot.mediaType, data: shot.data, elements: r.elements })
    appendSystem('已截取选区：输入意图后直接发送（点 × 移除）。')
    return
  }
  if (r.cancelled === true) {
    appendSystem('已取消框选。')
    return
  }
  appendSystem(`框选失败：${typeof r.error === 'string' ? r.error : '未知错误'}`)
}

/** The non-visual-model degradation is identified by its stable error code. */
function isImageUnsupported(error: unknown): boolean {
  return errorCode(error) === 'session/attachment-invalid'
}

/** Send the pending region: intent + cropped screenshot + element list. */
export async function sendRegion(intent: string): Promise<void> {
  if (pendingRegion === null) return
  // Keep the attachment if there's no session yet, so it can be re-sent.
  if (!await ensureSession()) return
  const sid = getActiveSessionId()
  if (sid === null) return
  const region = pendingRegion
  const list = region.elements.map(formatRegionElement).join('\n')
  const screenshotText = buildRegionScreenshotText(wrapUntrustedContent(list, 8_000))
  const questionText = buildRegionQuestionText(intent)
  const imageBlock: ImageBlock[] = region.mediaType !== '' && region.data !== ''
    ? [{ type: 'image', mediaType: region.mediaType, data: region.data, name: 'region.jpeg' }]
    : []

  clearRegionAttachment()
  setWorking(true)

  const textOnly = (): PromptBlock[] => [
    { type: 'text', text: screenshotText },
    { type: 'text', text: questionText },
  ]

  const cap = capabilityOf(effectiveSelection())
  if (cap.cls === 'text' && imageBlock.length > 0) {
    // Predictive degrade: a known text-only model can't take the image.
    appendSystem('当前模型无视觉，已降级为元素描述。')
    await deliver(sid, textOnly())
    return
  }

  try {
    await deliver(sid, [{ type: 'text', text: screenshotText }, ...imageBlock, { type: 'text', text: questionText }])
  } catch (error: unknown) {
    if (isImageUnsupported(error) && imageBlock.length > 0) {
      appendSystem('当前模型无视觉，已降级为元素描述。')
      await deliver(sid, textOnly())
    } else {
      setWorking(false)
      appendSystem(`发送失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function deliver(sid: string, content: PromptBlock[]): Promise<void> {
  await rpc('session.prompt', { sessionId: sid, mode: 'queue', content })
}
