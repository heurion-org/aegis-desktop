import './styles.css'
import {
  AegisCoreShell,
  AegisDaemonClient,
  DEFAULT_FREE_ENTITLEMENTS,
  decodeEntitlementJwtPayload,
  isEntitlementClaimsFresh,
  type DesktopConnection,
  type DesktopEntitlements,
} from '@aegis/core-shell'
import { createStubDataProducer } from '@aegis/studio-data'
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
  getActiveRepo: () => string | null,
): WritingHostBridge {
  const dataProducer = createStubDataProducer()
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
  heading.textContent = 'Aegis Cloud Pro Entitlements'

  const reasonEl = document.createElement('p')
  reasonEl.className = 'aos-muted'
  reasonEl.textContent = opts.reason

  const features = document.createElement('ul')
  features.className = 'aos-modal-list'
  features.innerHTML = `
    <li><strong>Dual-Surface CRDT:</strong> Rich <code>.docx</code>, <code>.pptx</code>, <code>.pdf</code>, <code>.tex</code> editing.</li>
    <li><strong>Encrypted Yjs Cloud Sync:</strong> Selective sync with <code>local_only</code> data stay-on-device privacy rules.</li>
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

function renderStandaloneConnectScreen(root: HTMLElement, onConnected: (conn: DesktopConnection) => void): void {
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.className = 'aos-connect-wrap'

  const card = document.createElement('form')
  card.className = 'aos-connect-card'
  card.innerHTML = `
    <h2>Aegis Desktop · Local Control Plane</h2>
    <p class="aos-muted">Run inside Tauri (auto-spawns bundled <code>aegis-os desktop-daemon</code>) or connect to a running daemon session below:</p>
  `

  const urlInput = document.createElement('input')
  urlInput.type = 'url'
  urlInput.className = 'aos-textarea'
  urlInput.placeholder = 'http://127.0.0.1:43123'
  urlInput.required = true

  const tokenInput = document.createElement('input')
  tokenInput.type = 'password'
  tokenInput.className = 'aos-textarea'
  tokenInput.placeholder = 'aht_...'
  tokenInput.required = true

  const connectBtn = document.createElement('button')
  connectBtn.type = 'submit'
  connectBtn.className = 'aos-btn aos-btn-primary'
  connectBtn.textContent = 'Connect to Daemon'

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

let activeShell: AegisCoreShell | null = null

async function mountWithConnection(root: HTMLElement, conn: DesktopConnection): Promise<void> {
  activeShell?.dispose()
  const client = new AegisDaemonClient(conn)
  let entitlements = loadSavedEntitlements()
  const bridge = createDesktopWritingBridge(client, () => activeShell?.getActiveRepo() ?? null)

  const shell = new AegisCoreShell({
    root,
    client,
    entitlements,
    approvalPollIntervalMs: 5000,
    onNewEscalation: esc => {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('Aegis Approval Required', {
          body: `${esc.agent_id}: ${esc.action} -> ${esc.target_resource}`,
        })
      }
    },
    onOpenWorkspacePrompt: async () => {
      const tauri = window.__TAURI_INTERNALS__
      if (tauri?.invoke) {
        return tauri.invoke<string | null>('pick_workspace_folder')
      }
      return window.prompt('Workspace folder path:')
    },
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
      void mountWritingStudio({
        container: ctx.container,
        bridge,
        workspaceId: ctx.workspace?.id ?? null,
        filePath: ctx.file?.path ?? null,
        entitlements: ctx.entitlements,
        onRequestUpgrade: ctx.onRequestUpgrade,
      })
    },
  })
  activeShell = shell

  await shell.refresh()
}

async function bootstrap(): Promise<void> {
  const root = document.getElementById('app')!
  const conn = await resolveConnection()
  if (!conn) {
    renderStandaloneConnectScreen(root, nextConn => {
      void mountWithConnection(root, nextConn)
    })
    return
  }
  await mountWithConnection(root, conn)
}

void bootstrap()
