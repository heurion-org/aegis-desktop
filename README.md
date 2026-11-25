# Aegis Desktop (`aegis-desktop`)

Tauri v2 + Vanilla Vite/TypeScript desktop shell and Writing Studio for **Aegis OS**.

## Monorepo Layout

- `packages/core-shell` — Authenticated `AegisDaemonClient`, built-in BYO CLI onboarding (`opencode`, `claude`, `agy`), role-based routing (`coder | writer | analyst | reviewer`), selective `SyncPolicy` workspace tree, Ed25519 entitlement JWT gate (`Free Local .md + Code` vs `Cloud Pro`).
- `packages/studio-writing` — Standalone-extractable Writing Studio via `WritingHostBridge`:
  - **Free Local Tier**: Local Markdown split editor + CoW diff / accept / rollback (zero cloud sync).
  - **Cloud Pro Tier**: `@heurion/doc-ui` Dual-Surface CRDT canvas (`.docx`, `.pptx`, `.pdf`, `.tex`) + turn-level `revertTurn` + `ArtifactEmbed`.
- `packages/studio-data` — V1.5 `DataArtifact` / `DataArtifactProducer` interface stub.
- `apps/desktop` — Main desktop shell + Tauri v2 (`src-tauri`) sidecar lifecycle manager for `aegis-os desktop-daemon`.
- `apps/writing-standalone` — Minimal standalone Vite app proving `@aegis/studio-writing` builds cleanly without Tauri or `@aegis/studio-data`.

## Local Development

```bash
# Terminal 1: start the pure-Rust Aegis OS desktop daemon
cd ../aegis-os
cargo run -p aos-cli -- desktop-daemon --listen 127.0.0.1:43123

# Terminal 2: launch Vite frontend (copy the human_token from stdout JSON)
cd ../aegis-desktop
pnpm install
pnpm dev
# Open http://localhost:1420/?daemon_url=http://127.0.0.1:43123&token=<human_token>
```
