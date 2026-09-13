/**
 * Browser-action approval dialog: shows a write-operation request and answers
 * with an allow-once or deny decision.
 *
 * @module
 */

import { post } from './transport.ts'

const approvalEl = document.getElementById('approval')!
const approvalText = document.getElementById('approvalText')!
const approveBtn = document.getElementById('approveBtn')!
const denyBtn = document.getElementById('denyBtn')!

let pendingApprovalId: string | null = null

/** Bind allow/deny buttons (called once from `main.ts`). */
export function initApproval(): void {
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
}

/** Show an approval request. */
export function showApproval(request: unknown): void {
  const req = request as { id?: string; summary?: string }
  if (typeof req.id !== 'string') return
  pendingApprovalId = req.id
  approvalText.textContent = typeof req.summary === 'string' ? req.summary : '确认此浏览器操作？'
  approvalEl.style.display = 'block'
}

/** Hide the dialog when the request resolves (or is resolved elsewhere). */
export function handleApprovalResolved(): void {
  approvalEl.style.display = 'none'
  pendingApprovalId = null
}
