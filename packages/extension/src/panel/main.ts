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

let sessionId: string | null = null
let pendingApprovalId: string | null = null
const pendingRpc = new Map<string, (value: unknown) => void>()
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

// ---- 会话（简单对话通道）----

function appendRow(kind: 'user' | 'assistant' | 'system', text: string): HTMLElement {
  const row = document.createElement('div')
  row.className = `row ${kind}`
  row.textContent = text
  logEl.appendChild(row)
  // turn 进行中保持指示行在对话末尾：新内容行插入到它上方。
  if (workingRow !== null) logEl.appendChild(workingRow)
  logEl.scrollTop = logEl.scrollHeight
  return row
}

let assistantRow: HTMLElement | null = null
function appendAssistantText(text: string): void {
  if (assistantRow === null) assistantRow = appendRow('assistant', '')
  assistantRow.textContent += text
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
    pendingRpc.set(id, (value) => resolve(value as T))
    try { post({ type: 'rpc', id, method, payload }) } catch (e) { pendingRpc.delete(id); reject(e) }
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
    if (!Array.isArray(page?.events)) return
    // 清空对话并整体重渲染（简单可靠）。
    while (logEl.firstChild !== null) logEl.removeChild(logEl.firstChild)
    assistantRow = null
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
        // 连接成功后再建会话（面板打开时 bridge 可能还没连上）。
        if (sessionId === null) void ensureSession()
        else if (!wasConnected && interrupted) {
          interrupted = false
          void reloadHistory()  // 重连后恢复中断期间遗漏的最终输出
        }
      } else if (workingRow !== null) {
        // 连接断开且有一个未完成的 turn：清掉「正在分析」并标记中断。
        interrupted = true
        setWorking(false)
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
      const r = msg as { id: string; ok: boolean; result?: unknown }
      const resolve = pendingRpc.get(r.id)
      if (resolve === undefined) return
      pendingRpc.delete(r.id)
      // 桥接会中继网关信封 { result: { ok, value } }，解包出业务值。
      const envelope = r.result as { result?: { ok?: boolean; value?: unknown } } | undefined
      if (r.ok && envelope?.result?.ok !== false) resolve(envelope?.result?.value)
      else resolve(undefined)
      break
    }
  }
}

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

// 初始状态 + 日志快照。会话在「已连接」后由 status 分支懒创建，避免
// 面板打开瞬间 bridge 尚未连上导致 session.create 失败。
port = connect()
post({ type: 'request-status' })

// 心跳：每 20s 发一次 request-status，让后台 SW 有活动、不被 MV3 挂起，
// 避免模型长思考期间 WebSocket 中断（这是之前「已停止→重连」循环的根因）。
setInterval(() => { post({ type: 'request-status' }) }, 20_000)
