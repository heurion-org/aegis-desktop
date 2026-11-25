import './styles.css'
import {
  AegisCoreShell,
  AegisDaemonClient,
  DEFAULT_FREE_ENTITLEMENTS,
  applyTheme,
  brandMarkSvg,
  decodeEntitlementJwtPayload,
  iconHtml,
  isEntitlementClaimsFresh,
  isOnboardingCompleted,
  renderOnboardingWizard,
  shouldShowOnboardingWizard,
  type DesktopConnection,
  type DesktopEntitlements,
  type FetchLike,
} from '@aegis/core-shell'
import {
  createLocalDataArtifactProducer,
  isDataFile,
  mountDataStudio,
  type LocalDataArtifactProducer,
} from '@aegis/studio-data'
import { mountWritingStudio, type WritingHostBridge } from '@aegis/studio-writing'

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
    }
  }
}

const SESSION_CONN_KEY = 'aegis.desktop.dev_connection'
const ENTITLEMENT_JWT_KEY = 'aegis.desktop.entitlement_jwt'

applyTheme()

async function resolveConnection(): Promise<DesktopConnection | null> {
  const tauri = window.__TAURI_INTERNALS__
  if (tauri?.invoke) {
    return tauri.invoke<DesktopConnection>('get_daemon_connection')
  }
  const params = new URLSearchParams(window.location.search)
  const baseUrl = params.get('daemon_url')
  const token = params.get('token')
  if (baseUrl && token) {
    const parsed = new URL(baseUrl)
    return {
      protocol: 'aos-desktop/v1',
      port: Number(parsed.port || '80'),
      base_url: baseUrl,
      human_token: token,
    }
  }
  const saved = window.sessionStorage.getItem(SESSION_CONN_KEY)
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as DesktopConnection
      if (parsed.base_url && parsed.human_token) return parsed
    } catch {
      window.sessionStorage.removeItem(SESSION_CONN_KEY)
    }
  }
  return null
}

function loadSavedEntitlements(): DesktopEntitlements {
  const jwt = window.localStorage.getItem(ENTITLEMENT_JWT_KEY)
  if (!jwt) return DEFAULT_FREE_ENTITLEMENTS
  const claims = decodeEntitlementJwtPayload(jwt)
  if (!isEntitlementClaimsFresh(claims)) return DEFAULT_FREE_ENTITLEMENTS
  return claims!.entitlements
}

function createDesktopWritingBridge(
  client: AegisDaemonClient,
  dataProducer: LocalDataArtifactProducer,
  getActiveRepo: () => string | null,
): WritingHostBridge {
  return {
    async readTextFile(workspaceId, relPath) {
      const res = await client.readWorkspaceFile(workspaceId, relPath)
      return res.content
    },
    async writeTextFile(workspaceId, relPath, content) {
      await client.writeWorkspaceFile(workspaceId, relPath, content)
    },
    async diffWorkspace(workspaceId) {
      return client.workspaceDiff(workspaceId, getActiveRepo())
    },
    async commitWorkspace(workspaceId, message) {
      return client.commitWorkspace(workspaceId, {
        repo: getActiveRepo(),
        message,
      })
    },
    async rollbackWorkspace(workspaceId) {
      return client.rollbackWorkspace(workspaceId, {
        repo: getActiveRepo(),
      })
    },
    async listArtifactEmbeds(workspaceId) {
      const list = await dataProducer.listArtifacts(workspaceId)
      return list.map(a => ({
        id: a.id,
        title: a.title,
        kind: a.kind,
        version: a.version,
        sourcePath: a.sourcePath,
        previewMarkdown: a.previewMarkdown,
        svgMarkup: a.svgMarkup,
      }))
    },
  }
}

function showUpgradeModal(opts: {
  reason: string
  current: DesktopEntitlements
  onApply: (next: DesktopEntitlements) => void
}): void {
  document.querySelector('.aos-modal-backdrop')?.remove()

  const backdrop = document.createElement('div')
  backdrop.className = 'aos-modal-backdrop'

  const modal = document.createElement('div')
  modal.className = 'aos-modal'

  const heading = document.createElement('h3')
  heading.className = 'aos-serif-title'
  heading.textContent = 'Aegis Cloud Pro Entitlements'

  const reasonEl = document.createElement('p')
  reasonEl.className = 'aos-muted'
  reasonEl.textContent = opts.reason

  const features = document.createElement('ul')
  features.className = 'aos-modal-list'
  features.innerHTML = `
    <li><strong>Dual-Surface CRDT:</strong> Rich <code>.docx</code>, <code>.pptx</code>, <code>.pdf</code>, <code>.tex</code> editing.</li>
    <li><strong>Encrypted Yjs Cloud Sync:</strong> Selective sync with <code>local_only</code> stay-on-device privacy rules.</li>
  `

  const tokenInput = document.createElement('textarea')
  tokenInput.className = 'aos-textarea'
  tokenInput.rows = 3
  tokenInput.placeholder = 'Paste Aegis Cloud Entitlement JWT (from /v1/desktop/entitlements)…'
  tokenInput.value = window.localStorage.getItem(ENTITLEMENT_JWT_KEY) ?? ''

  const errorEl = document.createElement('div')
  errorEl.className = 'aos-modal-error'
  errorEl.hidden = true

  const actions = document.createElement('div')
  actions.className = 'aos-modal-actions'

  const activateBtn = document.createElement('button')
  activateBtn.type = 'button'
  activateBtn.className = 'aos-btn aos-btn-primary'
  activateBtn.textContent = 'Activate Pro Token'

  const resetBtn = document.createElement('button')
  resetBtn.type = 'button'
  resetBtn.className = 'aos-btn'
  resetBtn.textContent = 'Use Free Local'
  resetBtn.hidden = !opts.current.dual_surface_crdt

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'aos-btn'
  closeBtn.textContent = 'Cancel'

  const close = () => {
    window.removeEventListener('keydown', onKey)
    backdrop.remove()
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close()
  }
  window.addEventListener('keydown', onKey)

  activateBtn.onclick = () => {
    const raw = tokenInput.value.trim()
    const claims = decodeEntitlementJwtPayload(raw)
    if (!isEntitlementClaimsFresh(claims)) {
      errorEl.hidden = false
      errorEl.textContent = 'Invalid or expired Aegis entitlement JWT.'
      return
    }
    window.localStorage.setItem(ENTITLEMENT_JWT_KEY, raw)
    opts.onApply(claims!.entitlements)
    close()
  }

  resetBtn.onclick = () => {
    window.localStorage.removeItem(ENTITLEMENT_JWT_KEY)
    opts.onApply(DEFAULT_FREE_ENTITLEMENTS)
    close()
  }

  closeBtn.onclick = close
  backdrop.onclick = ev => {
    if (ev.target === backdrop) close()
  }

  actions.append(closeBtn, resetBtn, activateBtn)
  modal.append(heading, reasonEl, features, tokenInput, errorEl, actions)
  backdrop.appendChild(modal)
  document.body.appendChild(backdrop)
}

function renderBootSplash(root: HTMLElement): void {
  root.innerHTML = `
    <div class="aos-connect-wrap">
      <div class="aos-boot-card">
        ${brandMarkSvg('aos-boot-mark')}
        <div class="aos-eyebrow">HEURION × AEGIS OS</div>
        <h2 class="aos-serif-title">Starting Local Control Plane…</h2>
        <p class="aos-muted">Initializing Copy-on-Write sandbox daemon on 127.0.0.1</p>
        <div class="aos-boot-bar"><span></span></div>
      </div>
    </div>
  `
}

function renderStandaloneConnectScreen(
  root: HTMLElement,
  onConnected: (conn: DesktopConnection) => void,
  errorDetail?: string,
  onRetrySidecar?: () => void,
): void {
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'aos-connect-wrap'

  const card = document.createElement('form')
  card.className = 'aos-connect-card'

  const head = document.createElement('div')
  head.className = 'aos-wizard-brand'
  head.innerHTML = `${brandMarkSvg()}<div><span class="aos-eyebrow">HEURION × AEGIS DESKTOP</span><strong>Local Control Plane</strong></div>`

  const desc = document.createElement('p')
  desc.className = 'aos-muted'
  desc.textContent = errorDetail
    ? 'Could not auto-start the bundled aegis-os daemon. Retry sidecar startup or connect manually below.'
    : 'Run inside Tauri (auto-spawns aegis-os desktop-daemon) or connect to a running local daemon session:'

  card.append(head, desc)

  if (errorDetail) {
    const errBox = document.createElement('div')
    errBox.className = 'aos-wizard-feedback error'
    errBox.innerHTML = `${iconHtml('alertTriangle')}`
    const errSpan = document.createElement('span')
    errSpan.textContent = errorDetail
    errBox.appendChild(errSpan)
    card.appendChild(errBox)

    if (onRetrySidecar) {
      const retryBtn = document.createElement('button')
      retryBtn.type = 'button'
      retryBtn.className = 'aos-btn aos-btn-primary'
      retryBtn.innerHTML = `${iconHtml('refresh')}<span>Retry Sidecar Startup</span>`
      retryBtn.onclick = onRetrySidecar
      card.appendChild(retryBtn)
    }
  }

  const urlInput = document.createElement('input')
  urlInput.type = 'url'
  urlInput.className = 'aos-input'
  urlInput.placeholder = 'http://127.0.0.1:43123'
  urlInput.required = true

  const tokenInput = document.createElement('input')
  tokenInput.type = 'password'
  tokenInput.className = 'aos-input'
  tokenInput.placeholder = 'aht_...'
  tokenInput.required = true

  const connectBtn = document.createElement('button')
  connectBtn.type = 'submit'
  connectBtn.className = 'aos-btn aos-btn-primary'
  connectBtn.innerHTML = `${iconHtml('arrowRight')}<span>Connect to Daemon</span>`

  card.append(urlInput, tokenInput, connectBtn)
  card.onsubmit = ev => {
    ev.preventDefault()
    const base_url = urlInput.value.trim().replace(/\/+$/, '')
    const human_token = tokenInput.value.trim()
    if (!base_url || !human_token) return
    const parsed = new URL(base_url)
    const conn: DesktopConnection = {
      protocol: 'aos-desktop/v1',
      port: Number(parsed.port || '80'),
      base_url,
      human_token,
    }
    window.sessionStorage.setItem(SESSION_CONN_KEY, JSON.stringify(conn))
    onConnected(conn)
  }

  wrap.appendChild(card)
  root.appendChild(wrap)
}

async function pickFolderViaHost(): Promise<string | null> {
  const tauri = window.__TAURI_INTERNALS__
  if (tauri?.invoke) {
    return tauri.invoke<string | null>('pick_workspace_folder')
  }
  return window.prompt('Workspace folder path:')
}

interface TauriDaemonHttpResponse {
  status: number
  content_type: string
  body: string
}

function createTauriDaemonFetch(): FetchLike | undefined {
  const tauri = window.__TAURI_INTERNALS__
  if (!tauri?.invoke) return undefined
  return async (input, init) => {
    const parsed = new URL(input)
    const path = `${parsed.pathname}${parsed.search}`
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? init.body : null
    const res = await tauri.invoke<TauriDaemonHttpResponse>('daemon_http_request', {
      method,
      path,
      body,
    })
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.content_type || 'application/json',
      },
    })
  }
}

let activeShell: AegisCoreShell | null = null

async function mountWithConnection(root: HTMLElement, conn: DesktopConnection): Promise<void> {
  activeShell?.dispose()
  const client = new AegisDaemonClient(conn, createTauriDaemonFetch())
  const dataProducer = createLocalDataArtifactProducer()
  const rawTextOverrides = new Set<string>()
  let entitlements = loadSavedEntitlements()
  const bridge = createDesktopWritingBridge(client, dataProducer, () => activeShell?.getActiveRepo() ?? null)

  const launchWizard = (shell: AegisCoreShell) => {
    const sandbox = shell.getSandboxStatus()
    renderOnboardingWizard({
      root,
      client,
      sandboxHealthy: sandbox.ready,
      sandboxDriver: sandbox.driver,
      workspaces: shell.getWorkspacesSnapshot(),
      activeWorkspace: shell.getActiveWorkspaceSnapshot(),
      agents: shell.getAgentsSnapshot(),
      cloudYjsSync: shell.getEntitlementsSnapshot().cloud_yjs_sync,
      onPickFolder: pickFolderViaHost,
      onWorkspaceSelected: async ws => {
        await shell.refresh()
        await shell.selectWorkspace(ws)
      },
      onAgentsUpdated: nextAgents => {
        shell.setAgentsSnapshot(nextAgents)
      },
      onThemeChanged: () => {
        shell.render()
      },
      onComplete: intent => {
        void shell.runIntentAction(intent)
      },
    })
  }

  const shell = new AegisCoreShell({
    root,
    client,
    entitlements,
    approvalPollIntervalMs: 5000,
    listArtifacts: wsId => dataProducer.listArtifacts(wsId),
    onNewEscalation: esc => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Aegis Approval Required', {
          body: `${esc.agent_id}: ${esc.action} -> ${esc.target_resource}`,
        })
      }
    },
    onOpenWorkspacePrompt: pickFolderViaHost,
    onOpenWizard: () => launchWizard(shell),
    onRequestUpgrade: reason => {
      showUpgradeModal({
        reason,
        current: entitlements,
        onApply: next => {
          entitlements = next
          shell.setEntitlements(next)
        },
      })
    },
    renderStudio: ctx => {
      const wsId = ctx.workspace?.id ?? null
      const filePath = ctx.file?.path ?? null
      if (wsId && filePath && isDataFile(filePath) && !rawTextOverrides.has(filePath)) {
        void mountDataStudio({
          container: ctx.container,
          workspaceId: wsId,
          filePath,
          readTextFile: (id, rel) => bridge.readTextFile(id, rel),
          producer: dataProducer,
          onArtifactPublished: () => {
            void activeShell?.refreshArtifacts()
          },
          onOpenRawText: () => {
            rawTextOverrides.add(filePath)
            activeShell?.render()
          },
        })
        return
      }
      void mountWritingStudio({
        container: ctx.container,
        bridge,
        workspaceId: wsId,
        filePath,
        entitlements: ctx.entitlements,
        onRequestUpgrade: ctx.onRequestUpgrade,
        quickActions: ctx.quickActions,
      })
    },
  })
  activeShell = shell

  await shell.refresh()

  if (
    shouldShowOnboardingWizard({
      completedBefore: isOnboardingCompleted(),
      workspaceCount: shell.getWorkspacesSnapshot().length,
    })
  ) {
    launchWizard(shell)
  }
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app')!
  renderBootSplash(root)
  try {
    const conn = await resolveConnection()
    if (!conn) {
      renderStandaloneConnectScreen(root, nextConn => {
        void mountWithConnection(root, nextConn)
      })
      return
    }
    await mountWithConnection(root, conn)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    renderStandaloneConnectScreen(
      root,
      nextConn => {
        void mountWithConnection(root, nextConn)
      },
      message,
      () => {
        void bootstrap()
      },
    )
  }
}

void bootstrap()
