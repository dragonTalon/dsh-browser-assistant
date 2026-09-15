/**
 * dsh `ask_user_question` UI: renders the question block, tracks per-question
 * option/custom-answer selections, and answers or cancels the pending request.
 *
 * @module
 */

import { post } from './transport.ts'
import { el } from '../common/index.ts'

const questionEl = document.getElementById('question')!
const questionBodyEl = document.getElementById('questionBody')!
const questionSubmitBtn = document.getElementById('questionSubmitBtn')!
const questionDismissBtn = document.getElementById('questionDismissBtn')!

interface QuestionOption { label: string; description?: string }
interface QuestionItem { id: string; question: string; header?: string; detail?: string; options?: QuestionOption[]; multiSelect?: boolean }
interface PendingQuestion { rpcId: string; sessionId: string; questions: QuestionItem[] }

let pendingQuestion: PendingQuestion | null = null
/** Currently selected option labels, keyed by question index. */
const questionSelections = new Map<number, string[]>()
const questionCustoms = new Map<number, string>()

/** Bind submit/dismiss (called once from `main.ts`). */
export function initQuestion(): void {
  questionSubmitBtn.addEventListener('click', () => { respondToQuestion({ ok: true }) })
  questionDismissBtn.addEventListener('click', () => { respondToQuestion({ ok: false }) })
}

/**
 * Show a new question request.
 *
 * Shown regardless of which session the panel currently displays, unlike
 * session events: the panel is the only answerer for a session it has prompted,
 * so hiding a question that belongs to a session the user switched away from
 * would leave that turn hanging. The answer carries the question's own
 * `sessionId`, so it can never land in the wrong conversation.
 */
export function showQuestion(rpcId: unknown, payload: unknown): void {
  const p = payload as { sessionId?: string; questions?: unknown }
  if (typeof rpcId !== 'string' || !Array.isArray(p.questions) || p.questions.length === 0) return
  pendingQuestion = { rpcId, sessionId: typeof p.sessionId === 'string' ? p.sessionId : '', questions: p.questions as QuestionItem[] }
  questionSelections.clear()
  questionCustoms.clear()
  renderQuestionBody()
  questionEl.style.display = 'block'
}

/** Dismiss the block when the question is resolved elsewhere. */
export function handleQuestionResolved(): void {
  if (pendingQuestion !== null) {
    pendingQuestion = null
    questionEl.style.display = 'none'
  }
}

function renderQuestionBody(): void {
  if (pendingQuestion === null) return
  questionBodyEl.textContent = ''
  pendingQuestion.questions.forEach((item, index) => {
    const wrap = el('div', { class: 'qitem' })
    const header = item.header !== undefined && item.header !== '' ? `${item.header}：` : ''
    wrap.appendChild(el('div', { class: 'qtext', text: `${header}${item.question}` }))
    if (item.detail !== undefined && item.detail !== '') {
      wrap.appendChild(el('div', { class: 'qdetail', text: item.detail }))
    }

    if (item.options !== undefined && item.options.length > 0) {
      const opts = el('div', { class: 'qoptions' })
      for (const option of item.options) {
        const btn = el('button', { class: 'qoption', text: option.label })
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

    const custom = el('input', { class: 'qcustom', attrs: { type: 'text', placeholder: '或输入自定义回答' } })
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

function respondToQuestion(result: { ok: boolean }): void {
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
