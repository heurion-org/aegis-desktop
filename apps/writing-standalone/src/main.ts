import { DEFAULT_FREE_ENTITLEMENTS, type DesktopEntitlements } from '@aegis/core-shell'
import { createInMemoryWritingBridge, mountWritingStudio } from '@aegis/studio-writing'

const app = document.getElementById('app')!
const bridge = createInMemoryWritingBridge({
  'notes/design.md': '# Writing Studio Standalone\n\n- **Offline-first** local Markdown works on Free tier.\n- Zero dependency on `tauri` or `@aegis/studio-data`.',
  'deck/launch.pptx': '{\n  "slides": [\n    { "title": "Dual-Surface CRDT Deck Preview" }\n  ]\n}',
})

let activeFile = 'notes/design.md'
let entitlements: DesktopEntitlements = DEFAULT_FREE_ENTITLEMENTS

const root = document.createElement('div')
root.style.cssText = 'font-family: system-ui, sans-serif; max-width: 1100px; margin: 24px auto; padding: 0 16px;'

const bar = document.createElement('div')
bar.style.cssText = 'display: flex; gap: 8px; margin-bottom: 16px; align-items: center;'

const mdBtn = document.createElement('button')
mdBtn.textContent = 'notes/design.md'
const pptxBtn = document.createElement('button')
pptxBtn.textContent = 'deck/launch.pptx'
const tierToggle = document.createElement('button')

const stage = document.createElement('div')

async function rerender() {
  tierToggle.textContent = entitlements.dual_surface_crdt ? 'Tier: Cloud Pro' : 'Tier: Free Local'
  await mountWritingStudio({
    container: stage,
    bridge,
    workspaceId: 'standalone',
    filePath: activeFile,
    entitlements,
    onRequestUpgrade: () => {
      entitlements = {
        tier: 'pro',
        local_md_only: false,
        dual_surface_crdt: true,
        rich_formats: ['md', 'docx', 'pptx', 'pdf', 'tex'],
        cloud_yjs_sync: true,
        max_workspaces: 25,
      }
      void rerender()
    },
  })
}

mdBtn.onclick = () => {
  activeFile = 'notes/design.md'
  void rerender()
}
pptxBtn.onclick = () => {
  activeFile = 'deck/launch.pptx'
  void rerender()
}
tierToggle.onclick = () => {
  entitlements = entitlements.dual_surface_crdt
    ? DEFAULT_FREE_ENTITLEMENTS
    : {
        tier: 'pro',
        local_md_only: false,
        dual_surface_crdt: true,
        rich_formats: ['md', 'docx', 'pptx', 'pdf', 'tex'],
        cloud_yjs_sync: true,
        max_workspaces: 25,
      }
  void rerender()
}

bar.append(mdBtn, pptxBtn, tierToggle)
root.append(bar, stage)
app.appendChild(root)
void rerender()
