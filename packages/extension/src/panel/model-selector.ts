/**
 * Model catalog + selection state machine for the panel dropdown.
 *
 * Three sources merge into `currentSelection` (projection → event → optimistic
 * update), and capability is a strict tri-state (vision/text/unknown) that
 * never guesses when the catalog omits `inputModalities`.
 *
 * @module
 */

import { rpc } from './transport.ts'
import { describeCodeSuffix, describeRpcError } from './errors.ts'
import { ensureSession, appendSystem, getActiveSessionId } from './conversation.ts'
import { el, errorCode } from '../common/index.ts'

const modelSelectEl = document.getElementById('modelSelect') as HTMLSelectElement
const modelCapEl = document.getElementById('modelCap')!

export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
interface CatalogModel { id: string; name: string; description?: string; inputModalities?: readonly string[] }
interface ModelCatalog {
  default: ModelSelection
  groups: { id: string; name: string; models: CatalogModel[] }[]
  failures: { id: string; name: string; message: string }[]
}

let catalog: ModelCatalog | null = null
let catalogLoading = false
let currentSelection: ModelSelection | null = null
let selectingModel = false
let connected = false
/** Last render signature: 20s status heartbeats re-broadcast constantly. */
let modelRowSig = ''
/** This render's option `value` → target selection (rebuilt each render). */
const optionMap = new Map<string, { provider: string; model: string }>()

/** Display selection: session-level choice first, else the deployment default. */
export function effectiveSelection(): ModelSelection | null {
  return currentSelection ?? catalog?.default ?? null
}

function catalogEntryOf(sel: ModelSelection): CatalogModel | undefined {
  if (catalog === null) return undefined
  return catalog.groups.find((g) => g.id === sel.provider)?.models.find((m) => m.id === sel.model)
}

/** Capability tri-state; `none` only while the catalog hasn't loaded yet. */
export function capabilityOf(sel: ModelSelection | null): { cls: 'vision' | 'text' | 'unknown' | 'none'; label: string } {
  if (sel === null) return catalog === null ? { cls: 'none', label: '' } : { cls: 'unknown', label: '能力未知' }
  const entry = catalogEntryOf(sel)
  if (entry?.inputModalities === undefined) return { cls: 'unknown', label: '能力未知' }
  return entry.inputModalities.includes('image') ? { cls: 'vision', label: '视觉' } : { cls: 'text', label: '文本' }
}

function pickSelection(value: unknown): ModelSelection | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof v.provider !== 'string' || v.provider === '' || typeof v.model !== 'string' || v.model === '') return null
  return {
    provider: v.provider,
    model: v.model,
    ...(typeof v.reasoningEffort === 'string' ? { reasoningEffort: v.reasoningEffort } : {}),
  }
}

/** Refresh the dropdown: placeholder tri-state, optgroups, badge, tooltip. */
export function renderModelRow(force = false): void {
  const sig = JSON.stringify({ c: catalog, s: currentSelection, l: catalogLoading, st: connected, d: selectingModel })
  if (!force && sig === modelRowSig) return
  modelRowSig = sig
  optionMap.clear()
  modelSelectEl.textContent = ''
  const cap = capabilityOf(effectiveSelection())
  modelCapEl.className = `capBadge ${cap.cls}`
  modelCapEl.textContent = cap.label

  const placeholder = (label: string, title: string): void => {
    modelCapEl.className = 'capBadge none'
    modelCapEl.textContent = ''
    modelSelectEl.appendChild(el('option', { text: label, attrs: { selected: '' } }))
    modelSelectEl.disabled = true
    modelSelectEl.title = title
  }

  if (catalogLoading) { placeholder('模型加载中…', '模型目录加载中'); return }
  if (!connected) { placeholder('等待连接…', '等待连接 dsh'); return }
  if (catalog === null) { placeholder('模型不可用', '模型目录不可用——消息收发不受影响；失败原因见对话提示'); return }

  const sel = effectiveSelection()
  let matched = false
  for (const group of catalog.groups) {
    const optgroup = el('optgroup', { attrs: { label: group.name } })
    for (const model of group.models) {
      // JSON-pair key avoids provider/model string-concatenation collisions.
      const key = JSON.stringify([group.id, model.id])
      optionMap.set(key, { provider: group.id, model: model.id })
      const isMatch = sel !== null && group.id === sel.provider && model.id === sel.model
      if (isMatch) matched = true
      const isImage = model.inputModalities?.includes('image') === true
      optgroup.appendChild(el('option', {
        text: isImage ? `${model.name} 👁` : model.name,
        attrs: { value: key, ...(isMatch ? { selected: '' } : {}) },
      }))
    }
    modelSelectEl.appendChild(optgroup)
  }
  if (sel !== null && !matched) {
    // Session/default model absent from the current catalog (adapter drift):
    // keep showing it without forcing a change.
    optionMap.set('__current', { provider: sel.provider, model: sel.model })
    modelSelectEl.appendChild(el('option', {
      text: `${sel.model}（当前，目录外）`,
      attrs: { value: '__current', selected: '' },
    }))
  }
  modelSelectEl.disabled = selectingModel
  modelSelectEl.title = catalog.failures.length > 0
    ? `选择会话模型；选择会成为 dsh 默认模型；${catalog.failures.length} 个 provider 目录加载失败`
    : '选择会话模型；选择会成为 dsh 默认模型'
}

/** Pull the catalog after connect; failure is surfaced, never fatal. */
export async function loadCatalog(): Promise<void> {
  if (catalogLoading) return
  catalogLoading = true
  renderModelRow()
  try {
    catalog = await rpc<ModelCatalog>('model.catalog', {})
  } catch (error: unknown) {
    catalog = null
    const code = errorCode(error)
    appendSystem(`模型目录加载失败${describeCodeSuffix(code)}: ${describeRpcError(error)}`)
  } finally {
    catalogLoading = false
    renderModelRow()
  }
}

/** Align the current selection from a `session.history` projection. */
export function alignFromProjections(page: unknown): void {
  const projections = (page as { projections?: { values?: { modelSelection?: { next?: unknown; lastUsed?: unknown } } } })
    .projections?.values?.modelSelection
  if (projections === undefined) return
  const sel = pickSelection(projections.next) ?? pickSelection(projections.lastUsed)
  if (sel !== null) {
    currentSelection = sel
    renderModelRow()
  }
}

/** Apply a `model/selection` event (panel-internal or another client). */
export function applySelectionEvent(data: unknown): void {
  const sel = pickSelection(data)
  if (sel !== null) {
    currentSelection = sel
    renderModelRow()
  }
}

/** Set the bridge connection state so the dropdown placeholder is correct. */
export function setConnected(value: boolean): void {
  connected = value
  renderModelRow()
}

/**
 * Clear the displayed selection, falling back to the catalog default.
 *
 * The active session changed, so the previous session's choice must not linger
 * on screen: `alignFromProjections` only ever *sets* a selection, and a session
 * carrying no model event of its own would otherwise keep showing the old one.
 */
export function resetSelection(): void {
  currentSelection = null
  renderModelRow(true)
}

/** Bind the dropdown change handler (called once from `main.ts`). */
export function initModelSelector(): void {
  modelSelectEl.addEventListener('change', () => { void onModelChange() })
}

async function onModelChange(): Promise<void> {
  const target = optionMap.get(modelSelectEl.value)
  if (target === undefined || selectingModel) return
  const previous = effectiveSelection()
  renderModelRow(true) // restore the real selection before the pending state
  if (!await ensureSession()) { renderModelRow(true); return }
  const sid = getActiveSessionId()
  if (sid === null) { renderModelRow(true); return }
  selectingModel = true
  currentSelection = { provider: target.provider, model: target.model }
  renderModelRow()
  try {
    await rpc('session.selectModel', { sessionId: sid, provider: target.provider, model: target.model })
  } catch (error: unknown) {
    currentSelection = previous
    const code = errorCode(error)
    appendSystem(`切换模型失败${describeCodeSuffix(code)}: ${describeRpcError(error)}`)
  } finally {
    selectingModel = false
    renderModelRow()
  }
}
