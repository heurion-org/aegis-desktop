import type { AegisDaemonClient, DesktopAgentStatus, DesktopWorkspace } from '../daemon-client.ts'
import { brandMarkSvg, iconHtml, type IconName } from '../icons.ts'
import { getThemePref, setThemePref, type ThemePref } from '../theme.ts'

export const ONBOARDING_COMPLETED_KEY = 'aegis.desktop.onboarding_completed'

export type OnboardingIntent = 'write' | 'data' | 'agent'

export interface WizardStepMeta {
  index: number
  code: string
  title: string
  subtitle: string
  icon: IconName
}

export const WIZARD_STEPS: readonly WizardStepMeta[] = [
  {
    index: 0,
    code: '01',
    title: 'Workspace',
    subtitle: 'Pick a local folder',
    icon: 'folderOpen',
  },
  {
    index: 1,
    code: '02',
    title: 'Start With',
    subtitle: 'Choose your first workflow',
    icon: 'compass',
  },
  {
    index: 2,
    code: '03',
    title: 'Launch',
    subtitle: 'Theme & enter workbench',
    icon: 'sun',
  },
] as const

function esc(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function shouldShowOnboardingWizard(opts: {
  completedBefore: boolean
  workspaceCount: number
  forceOpen?: boolean
}): boolean {
  if (opts.forceOpen) return true
  if (!opts.completedBefore) return true
  return opts.workspaceCount === 0
}

export function isOnboardingCompleted(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(ONBOARDING_COMPLETED_KEY) === '1'
  } catch {
    return false
  }
}

export function markOnboardingWizardCompleted(): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ONBOARDING_COMPLETED_KEY, '1')
    }
  } catch {
    // Ignore storage errors
  }
}

export function resetOnboardingWizard(): void {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ONBOARDING_COMPLETED_KEY)
    }
  } catch {
    // Ignore storage errors
  }
}

export interface OnboardingWizardOptions {
  root: HTMLElement
  client: Pick<AegisDaemonClient, 'openWorkspace' | 'listAgents' | 'installAgent'>
  sandboxHealthy: boolean
  sandboxDriver: string
  workspaces: DesktopWorkspace[]
  activeWorkspace: DesktopWorkspace | null
  agents: DesktopAgentStatus[]
  cloudYjsSync: boolean
  onPickFolder?: () => Promise<string | null>
  onWorkspaceSelected: (ws: DesktopWorkspace) => Promise<void> | void
  onAgentsUpdated?: (agents: DesktopAgentStatus[]) => void
  onThemeChanged?: () => void
  onComplete: (intent?: OnboardingIntent) => void
}

export function renderOnboardingWizard(opts: OnboardingWizardOptions): () => void {
  document.querySelector('.aos-wizard-backdrop')?.remove()

  let step = 0
  let selectedIntent: OnboardingIntent = 'write'
  let agents = [...opts.agents]
  let workspaces = [...opts.workspaces]
  let activeWorkspace = opts.activeWorkspace
  let busyMessage = ''
  let errorMessage = ''

  const backdrop = document.createElement('div')
  backdrop.className = 'aos-wizard-backdrop'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')
  backdrop.setAttribute('aria-label', 'Aegis Desktop Onboarding Wizard')

  const shell = document.createElement('div')
  shell.className = 'aos-wizard-shell'

  const finish = (intent?: OnboardingIntent) => {
    markOnboardingWizardCompleted()
    window.removeEventListener('keydown', onKey)
    backdrop.remove()
    opts.onComplete(intent)
  }

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      finish()
    }
  }
  window.addEventListener('keydown', onKey)

  const openPath = async (rawPath: string) => {
    const clean = rawPath.trim()
    if (!clean) return
    errorMessage = ''
    busyMessage = `Opening ${clean}…`
    paint()
    try {
      const ws = await opts.client.openWorkspace({
        path: clean,
        mode: opts.cloudYjsSync ? 'cloud' : 'local',
      })
      if (!workspaces.some(w => w.id === ws.id)) {
        workspaces = [ws, ...workspaces]
      }
      activeWorkspace = ws
      await opts.onWorkspaceSelected(ws)
      busyMessage = ''
      step = 1
      paint()
    } catch (err) {
      busyMessage = ''
      errorMessage = err instanceof Error ? err.message : String(err)
      paint()
    }
  }

  const paint = () => {
    shell.innerHTML = ''

    const header = document.createElement('header')
    header.className = 'aos-wizard-header'

    const brand = document.createElement('div')
    brand.className = 'aos-wizard-brand'
    brand.innerHTML = `${brandMarkSvg()}<div><span class="aos-eyebrow">HEURION × AEGIS OS</span><strong>Quick Setup</strong></div>`

    const stepper = document.createElement('nav')
    stepper.className = 'aos-wizard-stepper'
    for (const meta of WIZARD_STEPS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = `aos-wizard-step-pill ${meta.index === step ? 'is-active' : meta.index < step ? 'is-done' : ''}`
      const icon = meta.index < step ? 'check' : meta.icon
      btn.innerHTML = `<span class="aos-step-code">${meta.code}</span>${iconHtml(icon)}<span>${meta.title}</span>`
      btn.onclick = () => {
        errorMessage = ''
        step = meta.index
        paint()
      }
      stepper.appendChild(btn)
    }

    const skipBtn = document.createElement('button')
    skipBtn.type = 'button'
    skipBtn.className = 'aos-btn aos-btn-sm'
    skipBtn.innerHTML = `${iconHtml('x')}<span>Skip</span>`
    skipBtn.onclick = () => finish()

    header.append(brand, stepper, skipBtn)

    const body = document.createElement('div')
    body.className = 'aos-wizard-body'

    if (step === 0) {
      const hero = document.createElement('div')
      hero.className = 'aos-wizard-hero'
      hero.innerHTML = `
        <div class="aos-wizard-top-tags">
          <span class="aos-eyebrow">STEP 01 · WORKSPACE</span>
          <span class="aos-badge ${opts.sandboxHealthy ? 'ok' : 'warn'}">${iconHtml('shield')}<span>${opts.sandboxHealthy ? `Sandbox ready (${esc(opts.sandboxDriver)})` : esc(opts.sandboxDriver)}</span></span>
        </div>
        <h1 class="aos-serif-title">Write, analyze, and ship <em>without fear.</em></h1>
        <p class="aos-wizard-lede">
          Pick a project folder to begin — every edit stays isolated until you accept it.
        </p>
      `

      const pickerRow = document.createElement('div')
      pickerRow.className = 'aos-wizard-picker-row'

      const chooseBtn = document.createElement('button')
      chooseBtn.type = 'button'
      chooseBtn.className = 'aos-btn aos-btn-primary aos-btn-lg'
      chooseBtn.innerHTML = `${iconHtml('folderOpen')}<span>Browse Folder…</span>`
      chooseBtn.disabled = Boolean(busyMessage)
      chooseBtn.onclick = async () => {
        const picked = (await opts.onPickFolder?.()) ?? window.prompt('Workspace directory path:')
        if (picked) {
          await openPath(picked)
        }
      }

      const pathForm = document.createElement('form')
      pathForm.className = 'aos-wizard-path-form'
      const pathInput = document.createElement('input')
      pathInput.type = 'text'
      pathInput.className = 'aos-input'
      pathInput.placeholder = '/home/you/projects/my-workspace'
      pathInput.value = activeWorkspace?.path ?? ''
      const openPathBtn = document.createElement('button')
      openPathBtn.type = 'submit'
      openPathBtn.className = 'aos-btn'
      openPathBtn.innerHTML = `${iconHtml('arrowRight')}<span>Open Path</span>`
      openPathBtn.disabled = Boolean(busyMessage)
      pathForm.append(pathInput, openPathBtn)
      pathForm.onsubmit = async ev => {
        ev.preventDefault()
        await openPath(pathInput.value)
      }

      pickerRow.append(chooseBtn, pathForm)
      body.append(hero, pickerRow)

      if (workspaces.length > 0) {
        const existingSection = document.createElement('div')
        existingSection.className = 'aos-wizard-existing'
        existingSection.innerHTML = `<div class="aos-eyebrow">CONNECTED WORKSPACES (${workspaces.length})</div>`
        const wsList = document.createElement('div')
        wsList.className = 'aos-wizard-ws-list'
        for (const ws of workspaces) {
          const isCurrent = activeWorkspace?.id === ws.id
          const repoCount = ws.child_repos?.length ?? 0
          const btn = document.createElement('button')
          btn.type = 'button'
          btn.className = `aos-wizard-ws-item ${isCurrent ? 'is-selected' : ''}`
          btn.innerHTML = `
            <div class="aos-ws-main">
              ${iconHtml(isCurrent ? 'check' : 'folder')}
              <div>
                <strong>${esc(ws.name)}</strong>
                <small>${esc(ws.path)}</small>
              </div>
            </div>
            <span class="aos-badge ${repoCount > 0 ? 'info' : 'muted'}">${repoCount} repo(s)</span>
          `
          btn.onclick = async () => {
            activeWorkspace = ws
            await opts.onWorkspaceSelected(ws)
            step = 1
            paint()
          }
          wsList.appendChild(btn)
        }
        existingSection.appendChild(wsList)
        body.appendChild(existingSection)
      }
    } else if (step === 1) {
      const intro = document.createElement('div')
      intro.className = 'aos-wizard-intro'
      intro.innerHTML = `
        <div class="aos-eyebrow">STEP 02 · CHOOSE YOUR STARTING POINT</div>
        <h2 class="aos-serif-title">What would you like to do first?</h2>
        <p class="aos-wizard-lede">
          Pick one to open directly inside your workspace.
        </p>
      `

      const intentGrid = document.createElement('div')
      intentGrid.className = 'aos-wizard-intent-grid'
      const intents: Array<{ id: OnboardingIntent; icon: IconName; title: string; desc: string }> = [
        {
          id: 'write',
          icon: 'pen',
          title: 'Write & Edit Docs',
          desc: 'Open README or create a Markdown note with live diff.',
        },
        {
          id: 'data',
          icon: 'chartBar',
          title: 'Explore Data & Charts',
          desc: 'Inspect CSV/JSON tables, stats, and SVG charts.',
        },
        {
          id: 'agent',
          icon: 'terminal',
          title: 'Run an AI Task',
          desc: 'Send a sandboxed prompt to Claude, OpenCode, or Codex.',
        },
      ]
      for (const it of intents) {
        const card = document.createElement('button')
        card.type = 'button'
        card.className = `aos-wizard-intent-card ${selectedIntent === it.id ? 'is-selected' : ''}`
        card.innerHTML = `
          <div class="aos-card-icon">${iconHtml(it.icon)}</div>
          <div class="aos-intent-title-row">
            <strong>${it.title}</strong>
            ${iconHtml(selectedIntent === it.id ? 'check' : 'arrowRight')}
          </div>
          <p>${it.desc}</p>
        `
        card.onclick = () => {
          selectedIntent = it.id
          paint()
        }
        intentGrid.appendChild(card)
      }

      const cliBox = document.createElement('div')
      cliBox.className = 'aos-wizard-existing'
      cliBox.innerHTML = `<div class="aos-eyebrow">OPTIONAL · AI CLIs DETECTED ON YOUR MACHINE</div>`
      const grid = document.createElement('div')
      grid.className = 'aos-wizard-agent-grid'
      for (const ag of agents) {
        const card = document.createElement('div')
        card.className = `aos-wizard-card is-compact ${ag.installed ? 'is-ready' : ''}`
        const badgeCls = ag.installed ? (ag.authenticated ? 'ok' : 'warn') : 'muted'
        const badgeTxt = ag.installed ? (ag.authenticated ? 'Ready' : 'Needs Auth') : 'Optional'
        const top = document.createElement('div')
        top.className = 'aos-approval-top'
        top.innerHTML = `<strong>${esc(ag.display_name)}</strong><span class="aos-badge ${badgeCls}">${badgeTxt}</span>`
        card.appendChild(top)
        if (!ag.installed) {
          const instBtn = document.createElement('button')
          instBtn.type = 'button'
          instBtn.className = 'aos-btn aos-btn-sm'
          instBtn.innerHTML = `${iconHtml('plus')}<span>Install</span>`
          instBtn.onclick = async () => {
            instBtn.disabled = true
            instBtn.textContent = 'Installing…'
            errorMessage = ''
            try {
              await opts.client.installAgent(ag.id, false)
              agents = await opts.client.listAgents()
              opts.onAgentsUpdated?.(agents)
              paint()
            } catch (err) {
              errorMessage = err instanceof Error ? err.message : String(err)
              instBtn.disabled = false
              paint()
            }
          }
          card.appendChild(instBtn)
        } else if (!ag.authenticated && ag.auth_hint) {
          const hint = document.createElement('small')
          hint.className = 'aos-muted'
          hint.textContent = ag.auth_hint
          card.appendChild(hint)
        }
        grid.appendChild(card)
      }
      cliBox.appendChild(grid)

      body.append(intro, intentGrid, cliBox)
    } else {
      const intro = document.createElement('div')
      intro.className = 'aos-wizard-intro'
      intro.innerHTML = `
        <div class="aos-eyebrow">STEP 03 · APPEARANCE &amp; LAUNCH</div>
        <h2 class="aos-serif-title">Make it yours</h2>
        <p class="aos-wizard-lede">
          Pick a theme — then jump straight into your workspace.
        </p>
      `

      const currentPref = getThemePref()
      const themeRow = document.createElement('div')
      themeRow.className = 'aos-wizard-theme-row'
      const themes: Array<{ pref: ThemePref; icon: IconName; label: string; desc: string }> = [
        { pref: 'light', icon: 'sun', label: 'Nordic Editorial Light', desc: 'Warm paper #FAF8F4 · Forest #233E33' },
        { pref: 'dark', icon: 'moon', label: 'Nordic Forest Dark', desc: 'Deep pine #111614 · Mint #00C472' },
        { pref: 'system', icon: 'monitor', label: 'Match System', desc: 'Auto-follow OS appearance' },
      ]
      for (const th of themes) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = `aos-wizard-theme-card ${currentPref === th.pref ? 'is-selected' : ''}`
        btn.innerHTML = `${iconHtml(th.icon)}<div><strong>${th.label}</strong><small>${th.desc}</small></div>`
        btn.onclick = () => {
          setThemePref(th.pref)
          opts.onThemeChanged?.()
          paint()
        }
        themeRow.appendChild(btn)
      }

      const tour = document.createElement('div')
      tour.className = 'aos-wizard-cards'
      const zones: Array<{ icon: IconName; title: string; desc: string }> = [
        {
          icon: 'layers',
          title: 'Left · Files & Privacy',
          desc: 'Browse files and keep sensitive folders local_only.',
        },
        {
          icon: 'pen',
          title: 'Center · Studios',
          desc: 'Markdown split view, CSV charts, and live CoW diffs.',
        },
        {
          icon: 'bell',
          title: 'Right · Assistant & Approvals',
          desc: 'Run AI tasks and approve boundary actions.',
        },
      ]
      for (const z of zones) {
        const c = document.createElement('div')
        c.className = 'aos-wizard-card'
        c.innerHTML = `<div class="aos-card-icon">${iconHtml(z.icon)}</div><strong>${z.title}</strong><p>${z.desc}</p>`
        tour.appendChild(c)
      }

      body.append(intro, themeRow, tour)
    }

    if (busyMessage) {
      const busy = document.createElement('div')
      busy.className = 'aos-wizard-feedback info'
      busy.textContent = busyMessage
      body.appendChild(busy)
    }
    if (errorMessage) {
      const errEl = document.createElement('div')
      errEl.className = 'aos-wizard-feedback error'
      errEl.innerHTML = `${iconHtml('alertTriangle')}<span>${esc(errorMessage)}</span>`
      body.appendChild(errEl)
    }

    const footer = document.createElement('footer')
    footer.className = 'aos-wizard-footer'

    const leftNote = document.createElement('small')
    leftNote.className = 'aos-muted'
    leftNote.textContent = activeWorkspace
      ? `Workspace: ${activeWorkspace.name} · Next: ${selectedIntent === 'write' ? 'Writing Studio' : selectedIntent === 'data' ? 'Data Studio' : 'AI Assistant'}`
      : 'Tip: Pick a workspace folder in Step 01 to start editing right away.'

    const navBtns = document.createElement('div')
    navBtns.className = 'aos-wizard-nav-btns'

    if (step > 0) {
      const backBtn = document.createElement('button')
      backBtn.type = 'button'
      backBtn.className = 'aos-btn'
      backBtn.innerHTML = `${iconHtml('arrowLeft')}<span>Back</span>`
      backBtn.onclick = () => {
        errorMessage = ''
        step -= 1
        paint()
      }
      navBtns.appendChild(backBtn)
    }

    if (step < WIZARD_STEPS.length - 1) {
      const nextBtn = document.createElement('button')
      nextBtn.type = 'button'
      nextBtn.className = 'aos-btn aos-btn-primary'
      nextBtn.innerHTML = `<span>Continue</span>${iconHtml('arrowRight')}`
      nextBtn.onclick = () => {
        errorMessage = ''
        step += 1
        paint()
      }
      navBtns.appendChild(nextBtn)
    } else {
      const enterBtn = document.createElement('button')
      enterBtn.type = 'button'
      enterBtn.className = 'aos-btn aos-btn-primary'
      enterBtn.innerHTML = `<span>Start Working</span>${iconHtml('arrowRight')}`
      enterBtn.onclick = () => finish(selectedIntent)
      navBtns.appendChild(enterBtn)
    }

    footer.append(leftNote, navBtns)
    shell.append(header, body, footer)
  }

  paint()
  backdrop.appendChild(shell)
  document.body.appendChild(backdrop)
  return () => finish()
}
