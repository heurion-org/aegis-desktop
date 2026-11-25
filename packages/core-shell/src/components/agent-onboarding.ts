import type { AegisDaemonClient, DesktopAgentStatus } from '../daemon-client.ts'

export interface AgentOnboardingOptions {
  container: HTMLElement
  client: AegisDaemonClient
  agents: DesktopAgentStatus[]
  onAgentsChanged?: (agents: DesktopAgentStatus[]) => void
}

export function renderAgentOnboarding(opts: AgentOnboardingOptions): void {
  const { container, client, agents, onAgentsChanged } = opts
  container.innerHTML = ''

  const heading = document.createElement('div')
  heading.className = 'aos-panel-header'
  heading.innerHTML = '<span>Coding &amp; Writing CLIs</span><small>BYO / Built-in</small>'
  container.appendChild(heading)

  const list = document.createElement('div')
  list.className = 'aos-agent-list'

  for (const item of agents) {
    const card = document.createElement('div')
    card.className = `aos-agent-card ${item.installed ? 'is-installed' : 'is-missing'}`

    const top = document.createElement('div')
    top.className = 'aos-agent-top'
    const title = document.createElement('strong')
    title.textContent = item.display_name
    const badge = document.createElement('span')
    badge.className = `aos-badge ${item.installed ? (item.authenticated ? 'ok' : 'warn') : 'muted'}`
    badge.textContent = item.installed
      ? item.authenticated
        ? 'Ready'
        : 'Needs Auth'
      : 'Not Installed'
    top.append(title, badge)

    const meta = document.createElement('div')
    meta.className = 'aos-agent-meta'
    meta.textContent = item.version
      ? `${item.id} (${item.version})`
      : `${item.id} · Roles: ${item.roles.join(', ')}`

    const actions = document.createElement('div')
    actions.className = 'aos-agent-actions'
    if (!item.installed) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'aos-btn aos-btn-sm'
      btn.textContent = 'Install'
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = 'Installing…'
        try {
          await client.installAgent(item.id, false)
          const refreshed = await client.listAgents()
          onAgentsChanged?.(refreshed)
        } catch (err) {
          btn.textContent = 'Retry Install'
          const errNote = document.createElement('small')
          errNote.className = 'aos-muted'
          errNote.textContent = err instanceof Error ? err.message : String(err)
          actions.appendChild(errNote)
        } finally {
          btn.disabled = false
        }
      }
      actions.appendChild(btn)
    } else if (!item.authenticated) {
      const hint = document.createElement('small')
      hint.className = 'aos-muted'
      hint.textContent = item.auth_hint || item.install_recipe.notes
      actions.appendChild(hint)
    }

    card.append(top, meta, actions)
    list.appendChild(card)
  }

  container.appendChild(list)
}
