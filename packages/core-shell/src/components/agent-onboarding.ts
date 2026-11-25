import type { AegisDaemonClient, DesktopAgentStatus } from '../daemon-client.ts'
import { iconHtml } from '../icons.ts'

export interface AgentOnboardingOptions {
  container: HTMLElement
  client: AegisDaemonClient
  agents: DesktopAgentStatus[]
  onAgentsChanged?: (agents: DesktopAgentStatus[]) => void
}

const AUTH_LOGIN_COMMANDS: Record<string, string> = {
  claude: 'claude login',
  opencode: 'opencode auth login',
  agy: 'agy auth login',
  codex: 'codex login',
}

export function renderAgentOnboarding(opts: AgentOnboardingOptions): void {
  const { container, client, agents, onAgentsChanged } = opts
  container.innerHTML = ''

  const heading = document.createElement('div')
  heading.className = 'aos-panel-header'
  const readyCount = agents.filter(a => a.installed && a.authenticated).length
  heading.innerHTML = `<span>Coding &amp; Writing CLIs</span><small>${readyCount}/${agents.length} ready</small>`
  container.appendChild(heading)

  const list = document.createElement('div')
  list.className = 'aos-agent-list'

  for (const item of agents) {
    const card = document.createElement('div')
    card.className = `aos-agent-card ${item.installed ? 'is-installed' : 'is-missing'}`

    const top = document.createElement('div')
    top.className = 'aos-agent-top'
    const titleWrap = document.createElement('span')
    titleWrap.className = 'aos-tree-name-wrap'
    titleWrap.innerHTML = iconHtml('terminal')
    const title = document.createElement('strong')
    title.textContent = item.display_name
    title.title = item.binary_path ?? item.description
    titleWrap.appendChild(title)

    const badge = document.createElement('span')
    badge.className = `aos-badge ${item.installed ? (item.authenticated ? 'ok' : 'warn') : 'muted'}`
    badge.textContent = item.installed
      ? item.authenticated
        ? 'Ready'
        : 'Needs Auth'
      : 'Not Installed'
    top.append(titleWrap, badge)

    const meta = document.createElement('div')
    meta.className = 'aos-muted'
    meta.textContent = item.version
      ? `${item.id} (${item.version}) · ${item.roles.join(', ')}`
      : `${item.id} · Roles: ${item.roles.join(', ')}`

    const actions = document.createElement('div')
    actions.className = 'aos-agent-actions'
    if (!item.installed) {
      const cmdPreview = item.install_command_for_os.join(' ')
      if (cmdPreview) {
        const cmdCode = document.createElement('code')
        cmdCode.className = 'aos-cli-cmd-code'
        cmdCode.textContent = cmdPreview
        actions.appendChild(cmdCode)
      }
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'aos-btn aos-btn-sm'
      btn.innerHTML = `${iconHtml('plus')}<span>Install</span>`
      btn.onclick = async () => {
        btn.disabled = true
        btn.textContent = 'Installing…'
        try {
          await client.installAgent(item.id, false)
          const refreshed = await client.listAgents()
          onAgentsChanged?.(refreshed)
        } catch (err) {
          btn.innerHTML = `${iconHtml('plus')}<span>Retry Install</span>`
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
      const authCmd = AUTH_LOGIN_COMMANDS[item.id] ?? `${item.id} login`
      const cmdRow = document.createElement('div')
      cmdRow.className = 'aos-cli-cmd-row'
      const cmdCode = document.createElement('code')
      cmdCode.className = 'aos-cli-cmd-code'
      cmdCode.textContent = authCmd
      const copyBtn = document.createElement('button')
      copyBtn.type = 'button'
      copyBtn.className = 'aos-btn aos-btn-sm'
      copyBtn.innerHTML = `${iconHtml('copy')}<span>Copy</span>`
      copyBtn.onclick = () => {
        void navigator.clipboard?.writeText(authCmd).then(() => {
          copyBtn.innerHTML = `${iconHtml('check')}<span>Copied</span>`
          setTimeout(() => {
            copyBtn.innerHTML = `${iconHtml('copy')}<span>Copy</span>`
          }, 1500)
        })
      }
      cmdRow.append(cmdCode, copyBtn)
      actions.appendChild(cmdRow)

      if (item.auth_hint) {
        const hint = document.createElement('small')
        hint.className = 'aos-muted'
        hint.textContent = item.auth_hint
        actions.appendChild(hint)
      }
    }

    card.append(top, meta)
    if (actions.childElementCount > 0) {
      card.appendChild(actions)
    }
    list.appendChild(card)
  }

  container.appendChild(list)
}
