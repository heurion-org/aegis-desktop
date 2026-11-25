import type { AegisDaemonClient, PendingEscalation } from '../daemon-client.ts'

export interface ApprovalPanelOptions {
  container: HTMLElement
  escalations: PendingEscalation[]
  client?: Pick<AegisDaemonClient, 'decideApproval'>
  onDecided?: () => void | Promise<void>
}

export function renderApprovalPanel(opts: ApprovalPanelOptions): void {
  const { container, escalations, client, onDecided } = opts
  container.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'aos-panel-header'
  head.innerHTML = `<span>Policy Approvals</span><small>${escalations.length}</small>`
  container.appendChild(head)

  if (escalations.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'aos-muted'
    empty.textContent = 'No pending egress or sandbox escalations.'
    container.appendChild(empty)
    return
  }

  const list = document.createElement('div')
  list.className = 'aos-approval-list'
  for (const item of escalations) {
    const card = document.createElement('div')
    card.className = 'aos-approval-card'

    const title = document.createElement('div')
    title.className = 'aos-approval-top'
    const actionEl = document.createElement('strong')
    actionEl.textContent = `${item.agent_id}: ${item.action}`
    const orgBadge = document.createElement('span')
    orgBadge.className = 'aos-badge info'
    orgBadge.textContent = item.org_id
    title.append(actionEl, orgBadge)

    const targetEl = document.createElement('div')
    targetEl.className = 'aos-approval-target'
    targetEl.textContent = item.target_resource

    const reasonEl = document.createElement('small')
    reasonEl.className = 'aos-muted'
    reasonEl.textContent = item.rationale ? `${item.reason} — ${item.rationale}` : item.reason

    card.append(title, targetEl, reasonEl)

    if (client) {
      const actions = document.createElement('div')
      actions.className = 'aos-approval-actions'

      const approveBtn = document.createElement('button')
      approveBtn.type = 'button'
      approveBtn.className = 'aos-btn aos-btn-sm aos-btn-primary'
      approveBtn.textContent = 'Approve (15m)'

      const denyBtn = document.createElement('button')
      denyBtn.type = 'button'
      denyBtn.className = 'aos-btn aos-btn-sm'
      denyBtn.textContent = 'Deny'

      const handleDecision = async (decision: 'approve' | 'deny') => {
        approveBtn.disabled = true
        denyBtn.disabled = true
        try {
          await client.decideApproval(item.escalation_id, decision, 900)
          await onDecided?.()
        } catch (err) {
          reasonEl.textContent = err instanceof Error ? err.message : String(err)
          approveBtn.disabled = false
          denyBtn.disabled = false
        }
      }

      approveBtn.onclick = () => void handleDecision('approve')
      denyBtn.onclick = () => void handleDecision('deny')
      actions.append(approveBtn, denyBtn)
      card.appendChild(actions)
    }

    list.appendChild(card)
  }
  container.appendChild(list)
}
