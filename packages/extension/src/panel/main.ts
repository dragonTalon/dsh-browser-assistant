/**
 * Side panel: a simple conversation channel backed by a real dsh session,
 * plus bridge status, a diagnostics log, and the browser-action approval dialog.
 *
 * The conversation itself is lightweight (user/assistant plain text), but it
 * lives in dsh's session store — the same session you'd see in the dsh GUI.
 *
 * @module
 */

import type { BridgeState } from '../background/bridge.ts'
import { wrapUntrustedContent } from '../security/untrusted.ts'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/**
 * 把 assistant 回复的 Markdown 渲染为受限 HTML。
 * 消毒 MUST 先于写入 DOM：模型输出是半可信内容（可被页面诱导做提示注入）。
 */
function renderMarkdown(md: string): string {
  return DOMPurify.sanitize(marked.parse(md) as string, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'hr',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'img',
    ],
    ALLOWED_ATTR: ['href', 'title', 'src', 'alt'],
  })
}

// 后台 service worker 被挂起后 port 会断开；这里做惰性重连，post 时若断开则重连一次。
let port: chrome.runtime.Port | null = null

function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: 'dsh-panel' })
  p.onMessage.addListener(onPortMessage)
  p.onDisconnect.addListener(() => {
    if (port === p) port = null
  })
  return p
}

function post(message: unknown): void {
  if (port === null) port = connect()
  try {
    port.postMessage(message)
  } catch {
    // 端口已断开（SW 被挂起/重启）：重连一次后重发。
    port = connect()
    port.postMessage(message)
  }
}

const statusEl = document.getElementById('status')!
const statusText = document.getElementById('statusText')!
const statusUrlEl = document.getElementById('statusUrl')!
const pageUrlEl = document.getElementById('pageUrl')!
const logPanelEl = document.getElementById('logPanel')!
const logToggleEl = document.getElementById('logToggle') as HTMLButtonElement
const logEl = document.getElementById('log')!
const inputEl = document.getElementById('input') as HTMLTextAreaElement
const sendBtn = document.getElementById('sendBtn') as HTMLButtonElement
const approvalEl = document.getElementById('approval')!
const approvalText = document.getElementById('approvalText')!
const approveBtn = document.getElementById('approveBtn')!
const denyBtn = document.getElementById('denyBtn')!
const questionEl = document.getElementById('question')!
const questionBodyEl = document.getElementById('questionBody')!
const questionSubmitBtn = document.getElementById('questionSubmitBtn')!
const questionDismissBtn = document.getElementById('questionDismissBtn')!
const regionBtn = document.getElementById('regionBtn') as HTMLButtonElement
// 框选截图作为输入区附件（对齐 dsh GUI 附件交互：缩略图挂在输入区，意图走主输入框）
const attachmentEl = document.getElementById('attachment')!
const attachmentImgEl = document.getElementById('attachmentImg') as HTMLImageElement
const attachmentElementsEl = document.getElementById('attachmentElements')!
const attachmentRemoveBtn = document.getElementById('attachmentRemove') as HTMLButtonElement
const modelSelectEl = document.getElementById('modelSelect') as HTMLSelectElement
const modelCapEl = document.getElementById('modelCap')!

let sessionId: string | null = null
let pendingApprovalId: string | null = null
interface PendingRpc { resolve: (value: unknown) => void; reject: (error: Error) => void }
const pendingRpc = new Map<string, PendingRpc>()
let rpcSeq = 0
let lastState: BridgeState = 'stopped'
let interrupted = false

interface QuestionOption { label: string; description?: string }
interface QuestionItem { id: string; question: string; header?: string; detail?: string; options?: QuestionOption[]; multiSelect?: boolean }
interface PendingQuestion { rpcId: string; sessionId: string; questions: QuestionItem[] }
let pendingQuestion: PendingQuestion | null = null
/** 每个问题当前选中的选项 label（按问题下标）。 */
const questionSelections = new Map<number, string[]>()
const questionCustoms = new Map<number, string>()

const STATE_LABELS: Record<string, string> = {
  connected: '已连接 dsh',
  connecting: '连接中…',
  reconnecting: '重连中…',
  stopped: '已停止',
}

// ---- 模型目录与当前选择 ----

interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
interface CatalogModel { id: string; name: string; description?: string; inputModalities?: readonly string[] }
interface ModelCatalog {
  default: ModelSelection
  groups: { id: string; name: string; models: CatalogModel[] }[]
  failures: { id: string; name: string; message: string }[]
}

let catalog: ModelCatalog | null = null
let catalogLoading = false
/** 会话实际选中的模型（投影/事件/乐观更新三源合一）；null = 未见会话级选择。 */
let currentSelection: ModelSelection | null = null
let selectingModel = false
/** 上次渲染的状态签名：20s 心跳状态广播会反复进来，签名相同则跳过 DOM 重建。 */
let modelRowSig = ''
/** 本次 render 的 option value → 目标选择 映射（每轮重建）。 */
const optionMap = new Map<string, { provider: string; model: string }>()

// ---- 会话（简单对话通道）----

function appendRow(kind: 'user' | 'assistant' | 'system', text: string): HTMLElement {
  const row = document.createElement('div')
  row.className = `row ${kind}`
  if (kind === 'assistant') {
    row.innerHTML = renderMarkdown(text)
  } else {
    row.textContent = text
  }
  logEl.appendChild(row)
  // turn 进行中保持指示行在对话末尾：新内容行插入到它上方。
  if (workingRow !== null) logEl.appendChild(workingRow)
  logEl.scrollTop = logEl.scrollHeight
  return row
}

let assistantRow: HTMLElement | null = null
let assistantBuffer = ''
function appendAssistantText(text: string): void {
  if (assistantRow === null) assistantRow = appendRow('assistant', '')
  assistantBuffer += text
  assistantRow.innerHTML = renderMarkdown(assistantBuffer)
  logEl.scrollTop = logEl.scrollHeight
}

/**
 * 模型处理中的指示行：转圈 spinner + 「正在分析」动画点。
 * 生命周期严格跟随 turn：turn/start 显示、turn/end 清除（dsh 在 finally
 * 中保证每个 turn 都有 turn/end）。多步 turn 中间的文本/工具事件不影响它。
 */
let workingRow: HTMLElement | null = null
let workingTimer: ReturnType<typeof setInterval> | null = null
function setWorking(on: boolean): void {
  if (on) {
    if (workingRow === null) {
      workingRow = document.createElement('div')
      workingRow.className = 'row working'
      const spinner = document.createElement('span')
      spinner.className = 'spinner'
      workingRow.appendChild(spinner)
      const label = document.createElement('span')
      label.textContent = '正在分析'
      workingRow.appendChild(label)
      logEl.appendChild(workingRow)
      logEl.scrollTop = logEl.scrollHeight
      workingTimer = setInterval(() => {
        const l = workingRow?.querySelector('span:last-child')
        if (l === null || l === undefined) return
        const dots = (l.textContent?.match(/\./g) ?? []).length
        l.textContent = '正在分析' + '.'.repeat((dots % 3) + 1)
      }, 500)
    }
  } else {
    if (workingTimer !== null) { clearInterval(workingTimer); workingTimer = null }
    if (workingRow !== null) { workingRow.remove(); workingRow = null }
  }
}

function rpc<T>(method: string, payload: unknown): Promise<T> {
  const id = `p${++rpcSeq}`
  return new Promise<T>((resolve, reject) => {
    pendingRpc.set(id, { resolve: (value) => resolve(value as T), reject })
    try { post({ type: 'rpc', id, method, payload }) } catch (e) { pendingRpc.delete(id); reject(e instanceof Error ? e : new Error(String(e))) }
  })
}

function extractTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

function handleSessionEvent(event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const ev = event as { type?: string; data?: Record<string, unknown> }
  switch (ev.type) {
    case 'turn/start': {
      setWorking(true)
      break
    }
    case 'user/message': {
      const source = (ev.data as { source?: { kind?: string } } | undefined)?.source
      if (source?.kind !== 'user') return
      const text = extractTextFromBlocks((ev.data as { content?: unknown } | undefined)?.content)
      if (text.trim() !== '') {
        assistantRow = null
        assistantBuffer = ''
        appendRow('user', text)
      }
      break
    }
    case 'assistant/message': {
      // 多步 turn 里一条带文本的 assistant/message 只是中间产物（之后可能还有
      // 工具调用与更多文本），不清除「正在分析」——它只由 turn/start|turn/end 控制。
      const text = extractTextFromBlocks((ev.data?.message as { content?: unknown } | undefined)?.content)
      if (text.trim() !== '') {
        assistantRow = null
        assistantBuffer = ''
        appendRow('assistant', text)
      }
      break
    }
    case 'assistant/chunk': {
      // 只渲染 text-delta；reasoning-delta/tool-call-delta 不渲染。
      const chunk = (ev.data as { chunk?: unknown } | undefined)?.chunk
      if (typeof chunk === 'object' && chunk !== null) {
        const c = chunk as { type?: string; text?: unknown }
        if (c.type === 'text-delta' && typeof c.text === 'string') {
          appendAssistantText(c.text)
        }
      }
      break
    }
    case 'turn/end': {
      setWorking(false)
      assistantRow = null
      assistantBuffer = ''
      break
    }
    case 'model/selection': {
      // 会话模型被改（面板内选定生效、或面板外其他客户端改动）→ 即时对齐显示。
      const sel = pickSelection(ev.data)
      if (sel !== null) {
        currentSelection = sel
        renderModelRow()
      }
      break
    }
  }
}

function handleEvent(serverFrame: unknown): void {
  if (typeof serverFrame !== 'object' || serverFrame === null) return
  // 后台广播的是完整 ServerFrame: { t:'event', frame:{ method, payload } }。
  // 解出内层 HostEventFrame 再按 method 分发。
  const outer = serverFrame as { t?: string; frame?: unknown }
  const f = (outer.t === 'event' && outer.frame !== undefined ? outer.frame : outer) as { method?: string; payload?: unknown }
  if (f.method === 'session/event') {
    const payload = f.payload as { event?: unknown } | undefined
    if (payload?.event !== undefined) handleSessionEvent(payload.event)
  } else if (f.method === 'question/requested') {
    // rpcId 在事件帧外层（HostEventFrame.rpcId），不在 payload 里。
    showQuestion((f as { rpcId?: unknown }).rpcId, f.payload)
  } else if (f.method === 'question/resolved') {
    if (pendingQuestion !== null) {
      pendingQuestion = null
      questionEl.style.display = 'none'
    }
  }
}

let sessionPromise: Promise<boolean> | null = null
async function ensureSession(): Promise<boolean> {
  if (sessionId !== null) return true
  // 去重：并发调用（多次 connected 广播）只发一次 session.create。
  if (sessionPromise === null) {
    sessionPromise = (async () => {
      try {
        const created = await rpc<{ sessionId: string }>('session.create', {})
        if (created === undefined || typeof created.sessionId !== 'string' || created.sessionId === '') {
          appendRow('system', '创建会话失败：dsh 返回异常')
          return false
        }
        sessionId = created.sessionId
        appendRow('system', `会话 ${sessionId.slice(0, 8)}…`)
        return true
      } catch (e) {
        appendRow('system', `创建会话失败: ${String(e)}`)
        return false
      }
    })().finally(() => { sessionPromise = null })
  }
  return sessionPromise
}

async function send(): Promise<void> {
  const text = inputEl.value.trim()
  // 有框选附件时：输入内容即意图，截图+元素随同一 prompt 发出（空意图也允许）。
  if (pendingRegion !== null) {
    inputEl.value = ''
    await sendRegion(text)
    return
  }
  if (text === '') return
  if (!await ensureSession()) return
  inputEl.value = ''
  setWorking(true)  // 立即显示「正在分析…」，直到收到回复/turn 结束
  try {
    await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text }] })
  } catch (e) {
    setWorking(false)
    appendRow('system', `发送失败: ${String(e)}`)
  }
}

/** 重连后重新拉取会话历史，恢复中断期间遗漏的最终输出。 */
async function reloadHistory(): Promise<void> {
  if (sessionId === null) return
  try {
    const page = await rpc<{ events?: unknown }>('session.history', { sessionId })
    // 投影兜底：重连后把当前选中模型对齐回会话实际值。
    alignSelectionFromProjections(page)
    if (!Array.isArray(page?.events)) return
    // 清空对话并整体重渲染（简单可靠）。
    while (logEl.firstChild !== null) logEl.removeChild(logEl.firstChild)
    assistantRow = null
    assistantBuffer = ''
    setWorking(false)
    for (const entry of page.events) {
      const ev = (entry as { event?: unknown } | undefined)?.event
      if (ev !== undefined) handleSessionEvent(ev)
    }
  } catch {
    /* 历史拉取失败：忽略，保持现状 */
  }
}

// ---- 状态 + 日志 ----

function setStatus(state: BridgeState, url = '', attempt = 0): void {
  statusEl.className = state
  statusText.textContent = STATE_LABELS[state] ?? state
  const attemptSuffix = state === 'reconnecting' && attempt > 0 ? `（第 ${attempt} 次）` : ''
  statusUrlEl.textContent = url !== ''
    ? `${attemptSuffix}${url.replace('ws://127.0.0.1:', ':')}`
    : attemptSuffix
}

function fmtTime(time: number): string {
  const d = new Date(time)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function appendLog(entry: { time: number; level: string; msg: string }): void {
  const line = document.createElement('div')
  line.className = `logline ${entry.level}`
  const t = document.createElement('span')
  t.className = 't'
  t.textContent = fmtTime(entry.time)
  line.appendChild(t)
  line.appendChild(document.createTextNode(entry.msg))
  logPanelEl.appendChild(line)
  logPanelEl.scrollTop = logPanelEl.scrollHeight
}

function renderLogSnapshot(entries: unknown): void {
  if (!Array.isArray(entries)) return
  logPanelEl.textContent = ''
  for (const e of entries) appendLog(e as { time: number; level: string; msg: string })
}

logToggleEl.addEventListener('click', () => {
  logPanelEl.classList.toggle('open')
})

// ---- 审批 ----

function showApproval(request: unknown): void {
  const req = request as { id?: string; summary?: string }
  if (typeof req.id !== 'string') return
  pendingApprovalId = req.id
  approvalText.textContent = typeof req.summary === 'string' ? req.summary : '确认此浏览器操作？'
  approvalEl.style.display = 'block'
}

// ---- dsh 提问（ask_user_question）----

function showQuestion(rpcId: unknown, payload: unknown): void {
  const p = payload as { sessionId?: string; questions?: unknown }
  if (typeof rpcId !== 'string' || !Array.isArray(p.questions) || p.questions.length === 0) return
  pendingQuestion = { rpcId, sessionId: typeof p.sessionId === 'string' ? p.sessionId : '', questions: p.questions as QuestionItem[] }
  questionSelections.clear()
  questionCustoms.clear()
  renderQuestionBody()
  questionEl.style.display = 'block'
}

function renderQuestionBody(): void {
  if (pendingQuestion === null) return
  questionBodyEl.textContent = ''
  pendingQuestion.questions.forEach((item, index) => {
    const wrap = document.createElement('div')
    wrap.className = 'qitem'

    const text = document.createElement('div')
    text.className = 'qtext'
    text.textContent = `${item.header !== undefined && item.header !== '' ? item.header + '：' : ''}${item.question}`
    wrap.appendChild(text)

    if (item.detail !== undefined && item.detail !== '') {
      const detail = document.createElement('div')
      detail.className = 'qdetail'
      detail.textContent = item.detail
      wrap.appendChild(detail)
    }

    if (item.options !== undefined && item.options.length > 0) {
      const opts = document.createElement('div')
      opts.className = 'qoptions'
      for (const option of item.options) {
        const btn = document.createElement('button')
        btn.className = 'qoption'
        btn.textContent = option.label
        if (option.description !== undefined && option.description !== '') btn.title = option.description
        btn.addEventListener('click', () => {
          const selected = questionSelections.get(index) ?? []
          const next = item.multiSelect === true
            ? (selected.includes(option.label) ? selected.filter((l) => l !== option.label) : [...selected, option.label])
            : (selected.includes(option.label) ? [] : [option.label])
          questionSelections.set(index, next)
          renderQuestionBody()
        })
        if ((questionSelections.get(index) ?? []).includes(option.label)) btn.classList.add('selected')
        opts.appendChild(btn)
      }
      wrap.appendChild(opts)
    }

    const custom = document.createElement('input')
    custom.className = 'qcustom'
    custom.type = 'text'
    custom.placeholder = '或输入自定义回答'
    custom.value = questionCustoms.get(index) ?? ''
    custom.addEventListener('input', () => { questionCustoms.set(index, custom.value) })
    wrap.appendChild(custom)

    questionBodyEl.appendChild(wrap)
  })
}

function buildQuestionAnswers(): { id: string; selected: string[]; custom?: string }[] | null {
  if (pendingQuestion === null) return null
  const answers: { id: string; selected: string[]; custom?: string }[] = []
  for (const [index, item] of pendingQuestion.questions.entries()) {
    const selected = questionSelections.get(index) ?? []
    const custom = (questionCustoms.get(index) ?? '').trim()
    if (selected.length === 0 && custom === '') return null
    answers.push({ id: item.id, selected, ...(custom === '' ? {} : { custom }) })
  }
  return answers
}

function respondToQuestion(result: { ok: boolean; value?: unknown; error?: unknown }): void {
  if (pendingQuestion === null) return
  const rpcId = pendingQuestion.rpcId
  if (result.ok) {
    const answers = buildQuestionAnswers()
    if (answers === null) return
    post({ type: 'respond', id: crypto.randomUUID(), rpcId, result: { ok: true, value: { sessionId: pendingQuestion.sessionId, answer: { answers } } } })
  } else {
    post({ type: 'respond', id: crypto.randomUUID(), rpcId, result: { ok: false, error: { code: 'cancelled', message: '用户取消了提问', details: {} } } })
  }
  pendingQuestion = null
  questionEl.style.display = 'none'
}

questionSubmitBtn.addEventListener('click', () => { respondToQuestion({ ok: true }) })
questionDismissBtn.addEventListener('click', () => { respondToQuestion({ ok: false }) })

function onPortMessage(message: unknown): void {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  switch (msg.type) {
    case 'status': {
      const s = msg as { state: BridgeState; url?: string; attempt?: number; activePage?: { url: string; title: string } | null }
      setStatus(s.state, s.url ?? '', s.attempt ?? 0)
      if (s.activePage !== undefined && s.activePage !== null) {
        pageUrlEl.textContent = `${s.activePage.title || '(无标题)'} — ${s.activePage.url}`
      } else {
        pageUrlEl.textContent = '—'
      }
      const wasConnected = lastState === 'connected'
      lastState = s.state
      if (s.state === 'connected') {
        // 连接成功后再建会话（面板打开时 bridge 可能还没连上）；
        // 每次连接成功重拉模型目录（目录会随 adapter 注册变化，D2 刷新点）。
        if (!wasConnected) void loadCatalog()
        renderModelRow()
        if (sessionId === null) void ensureSession()
        else if (!wasConnected && interrupted) {
          interrupted = false
          void reloadHistory()  // 重连后恢复中断期间遗漏的最终输出
        }
      } else {
        renderModelRow()  // 非连接态：模型行回到占位「等待连接 dsh…」
        if (workingRow !== null) {
          // 连接断开且有一个未完成的 turn：清掉「正在分析」并标记中断。
          interrupted = true
          setWorking(false)
        }
      }
      break
    }
    case 'log':
      appendLog((msg as { entry: { time: number; level: string; msg: string } }).entry)
      break
    case 'log.snapshot':
      renderLogSnapshot((msg as { entries: unknown }).entries)
      break
    case 'event':
      handleEvent((msg as { frame: unknown }).frame)
      break
    case 'approval.request':
      showApproval((msg as { request: unknown }).request)
      break
    case 'approval.resolved':
      approvalEl.style.display = 'none'
      pendingApprovalId = null
      break
    case 'rpc.result': {
      const r = msg as { id: string; ok: boolean; result?: unknown; error?: { code?: string; message?: string } }
      const pending = pendingRpc.get(r.id)
      if (pending === undefined) return
      pendingRpc.delete(r.id)
      // 桥接会中继网关信封 { result: { ok, value | error } }，解包出业务值；
      // 业务失败（如 session/attachment-invalid）转为 reject，携带稳定错误码。
      const envelope = r.result as { result?: { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } } | undefined
      if (r.ok && envelope?.result?.ok !== false) {
        pending.resolve(envelope?.result?.value)
      } else if (r.ok && envelope?.result?.ok === false) {
        const code = envelope.result.error?.code ?? 'rpc-failed'
        const message = envelope.result.error?.message ?? 'rpc failed'
        pending.reject(withCode(new Error(`${code}: ${message}`), code))
      } else {
        const code = r.error?.code ?? 'bridge-unavailable'
        const message = r.error?.message ?? 'rpc failed'
        pending.reject(withCode(new Error(`${code}: ${message}`), code))
      }
      break
    }
    case 'region.result': {
      handleRegionResult((msg as { result: unknown }).result)
      break
    }
  }
}

function withCode(error: Error, code: string): Error & { code: string } {
  return Object.assign(error, { code })
}

// ---- 模型目录与选择（D2/D3：投影优先、default 兜底、三元态标记）----

/** 显示用选中：会话级选择优先，否则目录部署默认（会话从未选择时的真实使用对象）。 */
function effectiveSelection(): ModelSelection | null {
  return currentSelection ?? catalog?.default ?? null
}

/** 在最新目录里查 (provider, model) 条目；目录未加载或查无此项返回 undefined。 */
function catalogEntryOf(sel: ModelSelection): CatalogModel | undefined {
  if (catalog === null) return undefined
  return catalog.groups.find((g) => g.id === sel.provider)?.models.find((m) => m.id === sel.model)
}

/** 能力三元态：inputModalities 含 image→视觉；公布且不含→文本；未公布/查无条目→未知（不臆断）。 */
function capabilityOf(sel: ModelSelection | null): { cls: 'vision' | 'text' | 'unknown' | 'none'; label: string } {
  if (sel === null) return catalog === null ? { cls: 'none', label: '' } : { cls: 'unknown', label: '能力未知' }
  const entry = catalogEntryOf(sel)
  if (entry?.inputModalities === undefined) return { cls: 'unknown', label: '能力未知' }
  return entry.inputModalities.includes('image') ? { cls: 'vision', label: '视觉' } : { cls: 'text', label: '文本' }
}

/** 逐字段校验一个 ModelSelection 形对象。 */
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

/** 刷新模型选择器：占位三态（加载中/待连接/目录不可用）、目录 optgroup、能力 badge、tooltip 常驻提示。 */
function renderModelRow(force = false): void {
  const sig = JSON.stringify({ c: catalog, s: currentSelection, l: catalogLoading, st: lastState, d: selectingModel })
  if (!force && sig === modelRowSig) return
  modelRowSig = sig
  optionMap.clear()
  modelSelectEl.textContent = ''
  const cap = capabilityOf(effectiveSelection())
  modelCapEl.className = `capBadge ${cap.cls}`
  modelCapEl.textContent = cap.label

  const placeholder = (label: string, title: string): void => {
    // 占位时模型语义不可见，能力 badge 一并隐藏；原因经 tooltip 呈现。
    modelCapEl.className = 'capBadge none'
    modelCapEl.textContent = ''
    const opt = document.createElement('option')
    opt.textContent = label
    opt.selected = true
    modelSelectEl.appendChild(opt)
    modelSelectEl.disabled = true
    modelSelectEl.title = title
  }

  if (catalogLoading) { placeholder('模型加载中…', '模型目录加载中'); return }
  if (lastState !== 'connected') { placeholder('等待连接…', '等待连接 dsh'); return }
  if (catalog === null) { placeholder('模型不可用', '模型目录不可用——消息收发不受影响；失败原因见对话提示'); return }

  const sel = effectiveSelection()
  let matched = false
  for (const group of catalog.groups) {
    const optgroup = document.createElement('optgroup')
    optgroup.label = group.name
    for (const model of group.models) {
      // option value 用 JSON 对子串键，杜绝 provider/model 拼接碰撞。
      const key = JSON.stringify([group.id, model.id])
      optionMap.set(key, { provider: group.id, model: model.id })
      const opt = document.createElement('option')
      opt.value = key
      opt.textContent = model.inputModalities?.includes('image') === true ? `${model.name} 👁` : model.name
      if (sel !== null && group.id === sel.provider && model.id === sel.model) { opt.selected = true; matched = true }
      optgroup.appendChild(opt)
    }
    modelSelectEl.appendChild(optgroup)
  }
  if (sel !== null && !matched) {
    // 会话投影/默认中的模型不在当前目录（adapter 目录漂移）：保留显示，不强行改选。
    const opt = document.createElement('option')
    opt.value = '__current'
    optionMap.set('__current', { provider: sel.provider, model: sel.model })
    opt.textContent = `${sel.model}（当前，目录外）`
    opt.selected = true
    modelSelectEl.appendChild(opt)
  }
  modelSelectEl.disabled = selectingModel
  modelSelectEl.title = catalog.failures.length > 0
    ? `选择会话模型；选择会成为 dsh 默认模型；${catalog.failures.length} 个 provider 目录加载失败`
    : '选择会话模型；选择会成为 dsh 默认模型'
}

/** 连接成功后拉取模型目录；失败不阻断对话，且把根因显示在对话里，不做静默降级。 */
async function loadCatalog(): Promise<void> {
  if (catalogLoading) return
  catalogLoading = true
  renderModelRow()
  try {
    catalog = await rpc<ModelCatalog>('model.catalog', {})
  } catch (error: unknown) {
    catalog = null
    const code = (error as { code?: unknown } | null)?.code
    appendRow('system', `模型目录加载失败${typeof code === 'string' ? ` [${code}]` : ''}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    catalogLoading = false
    renderModelRow()
  }
}

/** 从 session.history 响应的 projections 对齐当前选中（next ?? lastUsed；投影缺失则不动本地态）。 */
function alignSelectionFromProjections(page: unknown): void {
  const projections = (page as { projections?: { values?: { modelSelection?: { next?: unknown; lastUsed?: unknown } } } })
    .projections?.values?.modelSelection
  if (projections === undefined) return
  const sel = pickSelection(projections.next) ?? pickSelection(projections.lastUsed)
  if (sel !== null) {
    currentSelection = sel
    renderModelRow()
  }
}

/** 用户在下拉选定模型：调 session.selectModel，乐观更新、失败回退并显示错误码提示。 */
async function onModelChange(): Promise<void> {
  const target = optionMap.get(modelSelectEl.value)
  if (target === undefined || selectingModel) return
  const previous = effectiveSelection()
  renderModelRow(true)  // change 已改 DOM 选中态；先强行还原到实际选中，避免未决期间假显示
  if (!await ensureSession()) { renderModelRow(true); return }
  selectingModel = true
  currentSelection = { provider: target.provider, model: target.model }
  renderModelRow()
  try {
    await rpc('session.selectModel', { sessionId, provider: target.provider, model: target.model })
  } catch (error: unknown) {
    currentSelection = previous
    const code = (error as { code?: unknown } | null)?.code
    appendRow('system', `切换模型失败${typeof code === 'string' ? ` [${code}]` : ''}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    selectingModel = false
    renderModelRow()
  }
}

// ---- 框选截图 ----

interface PendingRegion {
  mediaType: string
  data: string
  width: number
  height: number
  elements: unknown[]
}

let pendingRegion: PendingRegion | null = null
let regionSelecting = false

function formatRegionElement(el: unknown): string {
  const e = el as { tag?: unknown; id?: unknown; classes?: unknown; role?: unknown; name?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown }
  const tag = typeof e.tag === 'string' ? e.tag : '?'
  const id = typeof e.id === 'string' && e.id !== '' ? `#${e.id}` : ''
  const cls = typeof e.classes === 'string' && e.classes !== '' ? `.${e.classes.trim().split(/\s+/).join('.')}` : ''
  const role = typeof e.role === 'string' && e.role !== '' ? ` role="${e.role}"` : ''
  const name = typeof e.name === 'string' && e.name !== '' ? ` "${e.name}"` : ''
  const coords = ` @(${String(e.x)},${String(e.y)} ${String(e.width)}×${String(e.height)})`
  return `<${tag}${id}${cls}${role}>${name}${coords}`
}

/** [截图描述] 段：框选区域说明 + 元素清单（保持不可信包裹，D8）。 */
function buildRegionScreenshotText(elements: unknown[]): string {
  const list = elements.map(formatRegionElement).join('\n')
  const wrapped = wrapUntrustedContent(list, 8_000)
  return `[截图描述]：用户框选了当前页面的一块区域，截图见随附图片；区域内 DOM 元素清单如下：\n${wrapped}`
}

/** [用户问题] 段：用户意图，空意图用固定文案兜底（D8）。前导换行保证与截图/上一段分行。 */
function buildRegionQuestionText(intent: string): string {
  const intentText = intent.trim() === '' ? '(未补充具体意图)' : intent.trim()
  return `\n[用户问题]：${intentText}`
}

function isImageUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  return code === 'session/attachment-invalid'
    || message.includes('session/attachment-invalid')
    || message.includes('does not support image input')
}

function showRegionAttachment(region: PendingRegion): void {
  pendingRegion = region
  attachmentImgEl.src = `data:${region.mediaType};base64,${region.data}`
  attachmentElementsEl.textContent = region.elements.map(formatRegionElement).join('\n')
  attachmentEl.classList.add('show')
  // 意图直接在主输入框里补——把焦点交还给用户正在打的字。
  inputEl.focus()
}

function clearRegionAttachment(): void {
  pendingRegion = null
  attachmentImgEl.src = ''
  attachmentElementsEl.textContent = ''
  attachmentEl.classList.remove('show')
}

function handleRegionResult(result: unknown): void {
  regionSelecting = false
  if (typeof result !== 'object' || result === null) {
    appendRow('system', '框选失败：返回了无效结果。')
    return
  }
  const r = result as { ok?: boolean; cancelled?: boolean; error?: string; screenshot?: unknown; elements?: unknown }
  if (r.ok === true && typeof r.screenshot === 'object' && r.screenshot !== null) {
    const shot = r.screenshot as { mediaType?: unknown; data?: unknown; width?: unknown; height?: unknown }
    if (typeof shot.mediaType !== 'string' || typeof shot.data !== 'string' || !Array.isArray(r.elements)) {
      appendRow('system', '框选失败：截图或元素数据不完整。')
      return
    }
    showRegionAttachment({ mediaType: shot.mediaType, data: shot.data, width: 0, height: 0, elements: r.elements })
    appendRow('system', '已截取选区：输入意图后直接发送（点 × 移除）。')
    return
  }
  if (r.cancelled === true) {
    appendRow('system', '已取消框选。')
    return
  }
  appendRow('system', `框选失败：${typeof r.error === 'string' ? r.error : '未知错误'}`)
}

async function sendRegion(intent: string): Promise<void> {
  if (pendingRegion === null) return
  // 会话不可用时保留附件，让用户连上后能重发同一张截图。
  if (!await ensureSession()) return
  const region = pendingRegion
  // D8 三段式：截图描述（含元素清单）→ 截图 → 用户问题；意图移到最后。
  const screenshotText = buildRegionScreenshotText(region.elements)
  const questionText = buildRegionQuestionText(intent)
  const content: unknown[] = [{ type: 'text', text: screenshotText }]
  if (region.mediaType !== '' && region.data !== '') {
    content.push({ type: 'image', mediaType: region.mediaType, data: region.data, name: 'region.jpeg' })
  }
  content.push({ type: 'text', text: questionText })
  // 降级路径用：不含图片的两段文本。
  const textOnlyContent: unknown[] = [
    { type: 'text', text: screenshotText },
    { type: 'text', text: questionText },
  ]
  clearRegionAttachment()
  setWorking(true)
  try {
    await rpc('session.prompt', { sessionId, mode: 'queue', content })
  } catch (error: unknown) {
    if (isImageUnsupported(error)) {
      // 非视觉模型：剥离图片，仅以元素清单+意图重发一次。
      appendRow('system', '当前模型无视觉，已降级为元素描述。')
      try {
        await rpc('session.prompt', { sessionId, mode: 'queue', content: textOnlyContent })
      } catch (retryError: unknown) {
        setWorking(false)
        appendRow('system', `发送失败: ${retryError instanceof Error ? retryError.message : String(retryError)}`)
      }
    } else {
      setWorking(false)
      appendRow('system', `发送失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

regionBtn.addEventListener('click', () => {
  if (regionSelecting) return
  regionSelecting = true
  appendRow('system', '请在页面上拖拽框选区域（Esc 取消）…')
  post({ type: 'region.start' })
})
attachmentRemoveBtn.addEventListener('click', () => { clearRegionAttachment() })

sendBtn.addEventListener('click', () => { void send() })
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
})

approveBtn.addEventListener('click', () => {
  if (pendingApprovalId !== null) {
    post({ type: 'approval.response', id: pendingApprovalId, decision: 'allow-once' })
  }
})
denyBtn.addEventListener('click', () => {
  if (pendingApprovalId !== null) {
    post({ type: 'approval.response', id: pendingApprovalId, decision: 'deny' })
  }
})

modelSelectEl.addEventListener('change', () => { void onModelChange() })

// 初始状态 + 日志快照。会话在「已连接」后由 status 分支懒创建，避免
// 面板打开瞬间 bridge 尚未连上导致 session.create 失败。
renderModelRow()  // 启动占位：「等待连接 dsh…」
port = connect()
post({ type: 'request-status' })

// 心跳：每 20s 发一次 request-status，让后台 SW 有活动、不被 MV3 挂起，
// 避免模型长思考期间 WebSocket 中断（这是之前「已停止→重连」循环的根因）。
setInterval(() => { post({ type: 'request-status' }) }, 20_000)
