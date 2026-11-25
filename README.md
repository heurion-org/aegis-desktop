# Aegis Desktop (`aegis-desktop`)

Tauri v2 + Vanilla Vite/TypeScript desktop workbench for **Aegis OS** — combining a 3-layer **Org / Workspace / Repo** control plane, **BYO CLI Agent Onboarding**, **Writing Studio**, and **Data Studio** on top of Copy-on-Write (CoW) OS sandboxes.

---

## Overview

- **Core Shell (`packages/core-shell`)**: Authenticated `AegisDaemonClient`, 3-layer Org/Workspace/Repo selector, BYO CLI agent onboarding (`opencode`, `claude`, `codex`, `agy`), role-based routing (`coder | writer | analyst | reviewer`), selective `SyncPolicy` workspace tree (`local_only` vs `cloud_sync`), `+ @File / @Artifact` multi-reference Task Stream composer, and live 5s Approval Inbox polling.
- **Writing Studio (`packages/studio-writing`)**: Standalone-extractable editor decoupled via `WritingHostBridge`:
  - **Free Local Tier**: Local Markdown & Code Split/Source/Preview editor (`Ctrl+S`), CoW Diff / Commit / Rollback, and `+ Embed Artifact` snapshot/chart insertion (zero cloud sync).
  - **Cloud Pro Tier**: Dual-Surface Pro canvas (word-level AI diff, block outline, turn history revert, interactive `+ ArtifactEmbed`), gated by Ed25519 entitlement JWT for `.docx`, `.pptx`, `.pdf`, `.tex`.
- **Data Studio (`packages/studio-data`, V1.5)**: Client-side CSV / TSV / tabular JSON loader, sortable & filterable table explorer, per-column summary statistics, SVG bar chart builder, and versioned `DataArtifact` publisher (`LocalDataArtifactProducer`) handing off snapshots/charts to Writing Studio and Task Stream.
- **Desktop App (`apps/desktop`)**: Main desktop frontend + Tauri v2 (`src-tauri`) native shell and `aegis-os desktop-daemon` sidecar manager.
- **Standalone Writing App (`apps/writing-standalone`)**: Minimal Vite app verifying `@aegis/studio-writing` builds cleanly without Tauri or `@aegis/studio-data`.

---

## Dependencies: What You Actually Need

Requirements differ sharply depending on whether you are running a **pre-built release** or **building from source**:

| Mode | Node.js & pnpm | Rust Toolchain | OS WebView / GTK Dev Libs | `aegis-os` Binary | OS Sandbox (`bwrap`) | AI CLIs (BYO) |
| --- | --- | --- | --- | --- | --- | --- |
| **1. End-User Installer** (`.dmg` / `.deb` / `.AppImage` / Arch `PKGBUILD`) | **No** *(except `makepkg` build)* | **No** *(except `makepkg` build)* | **No** *(runtime only; `.deb` & `PKGBUILD` declare deps)* | **Bundled** | Linux: **Yes** (`bubblewrap`) · macOS: Built-in (`sandbox-exec`) | Optional *(only to run AI agent tasks)* |
| **2. Developer Web Mode** (`pnpm dev` + daemon) | **Yes** (`Node >= 24`, `pnpm >= 10`) | **No** | **No** | **Yes** (`>= v0.12.1` or `cargo run` from source) | Linux: Recommended (`bubblewrap`) | Optional |
| **3. Developer Native Tauri Mode** (`tauri dev` / `tauri build`) | **Yes** (`Node >= 24`, `pnpm >= 10`) | **Yes** (`rustup` / `cargo`) | **Yes** *(macOS Xcode CLT; Linux WebKitGTK 4.1 + GTK dev libs)* | Dev: `AEGIS_OS_BIN` or `PATH` · Release bundle: `src-tauri/binaries/` | Linux: Recommended (`bubblewrap`) | Optional |

### Linux System Dependencies

#### Ubuntu / Debian

- **End-users** (to enforce CoW sandbox isolation and WebKit runtime if using `.AppImage`):
  ```bash
  sudo apt-get update && sudo apt-get install -y bubblewrap
  ```
- **Developers building `apps/desktop/src-tauri` from source**:
  ```bash
  sudo apt-get update
  sudo apt-get install -y \
    build-essential pkg-config libssl-dev \
    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf \
    bubblewrap
  ```
  *(On newer Ubuntu/Debian releases where `libappindicator3-dev` is unavailable, install `libayatana-appindicator3-dev` instead.)*

#### Arch Linux (`pacman` / `makepkg`)

- **End-users running `.AppImage`**:
  ```bash
  sudo pacman -S --needed bubblewrap webkit2gtk-4.1 libayatana-appindicator fuse2
  ```
  *(If you skip `fuse2`, you can run the AppImage with `--appimage-extract-and-run`.)*
- **End-users installing native Arch package via [`packaging/arch/PKGBUILD`](packaging/arch/PKGBUILD)** *(installs `aegis-desktop` + bundled `aegis-os` sidecar + `.desktop` entry)*:
  ```bash
  cd aegis-desktop/packaging/arch
  makepkg -si
  ```
- **Developers in Web Mode (`pnpm dev`)**:
  ```bash
  sudo pacman -S --needed nodejs pnpm bubblewrap
  ```
- **Developers building Native Tauri (`tauri dev` / `tauri build`)**:
  ```bash
  sudo pacman -S --needed \
    base-devel pkgconf openssl \
    webkit2gtk-4.1 libayatana-appindicator librsvg patchelf \
    bubblewrap rustup nodejs pnpm
  rustup default stable
  ```

#### Wayland / Hyprland / NVIDIA on Linux (Arch & Ubuntu)

[lib.rs](apps/desktop/src-tauri/src/lib.rs) sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` by default on Linux to prevent blank WebKitGTK windows under mixed Wayland / NVIDIA setups. If you prefer hardware DMABUF rendering on AMD/Intel or want XWayland fallback:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=0 aegis-desktop
# or force XWayland if needed:
GDK_BACKEND=x11 aegis-desktop
```

### macOS

- **macOS**: End-users need nothing extra; native Tauri developers need Xcode Command Line Tools (`xcode-select --install`).

---

## Installation & Quick Start

### Option 1: Pre-built Desktop Installer or Arch `PKGBUILD` (End Users)

1. Download the installer for your platform from [GitHub Releases](https://github.com/heurion-org/aegis-desktop/releases):
   - **macOS (Apple Silicon / Intel)**: `.dmg`
   - **Debian / Ubuntu (x86_64 / ARM64)**: `.deb` or `.AppImage`
   - **Arch Linux**: `.AppImage`, or build & install natively from [packaging/arch/PKGBUILD](packaging/arch/PKGBUILD) via `cd packaging/arch && makepkg -si`
2. On Linux, ensure `bubblewrap` is installed (`sudo apt install bubblewrap` or `sudo pacman -S bubblewrap`).
3. Launch **Aegis Desktop**. The bundled `aegis-os desktop-daemon` sidecar starts automatically on `127.0.0.1:0` with a per-session `human_token`.

---

### Option 2: Developer Web Mode (Lightest — No Rust or WebKit Dev Libs Required)

Run the frontend in your browser while talking to a local `aegis-os desktop-daemon`:

```bash
# Terminal 1: start the Aegis OS desktop daemon (using installed aegis-os >= v0.12.1,
# or `cargo run -p aos-cli -- desktop-daemon --listen 127.0.0.1:43123` from ../aegis-os)
aegis-os desktop-daemon --listen 127.0.0.1:43123
# Copy the `human_token` ("aht_...") printed in the 1-line JSON handshake on stdout

# Terminal 2: install workspace packages and launch Vite frontend
cd aegis-desktop
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://localhost:1420` and paste the Daemon URL (`http://127.0.0.1:43123`) and `human_token` into the connect form, or open directly with query parameters:

```
http://localhost:1420/?daemon_url=http://127.0.0.1:43123&token=<human_token>
```

---

### Option 3: Developer Native Tauri Mode (`tauri dev` / `tauri build`)

Ensure Node (`>= 24`), pnpm (`>= 10`), Rust, and the OS WebView dev libraries listed above are installed first.

#### Live Development (`tauri dev`)

In debug builds, [sidecar.rs](apps/desktop/src-tauri/src/sidecar.rs) checks for the bundled sidecar first and automatically falls back to `$AEGIS_OS_BIN` or `aegis-os` on your `PATH` — so you do **not** need to copy any binary manually during development:

```bash
cd aegis-desktop
pnpm install --frozen-lockfile
AEGIS_OS_BIN="$(which aegis-os)" pnpm --filter @aegis/desktop tauri dev
```

#### Production Bundle (`tauri build`)

Release builds require the target-triple-suffixed `aegis-os` sidecar binary to exist at `apps/desktop/src-tauri/binaries/aegis-os-<target-triple>` (matching `externalBin: ["binaries/aegis-os"]` in [tauri.conf.json](apps/desktop/src-tauri/tauri.conf.json)):

```bash
TARGET_TRIPLE="$(rustc -vV | awk '/host:/ { print $2 }')"
mkdir -p apps/desktop/src-tauri/binaries
cp "$(which aegis-os)" "apps/desktop/src-tauri/binaries/aegis-os-${TARGET_TRIPLE}"
chmod +x "apps/desktop/src-tauri/binaries/aegis-os-${TARGET_TRIPLE}"

pnpm --filter @aegis/desktop tauri build
```

---

## Using Aegis Desktop

1. **Workspaces, Multi-Repo Switching & Selective `SyncPolicy`**
   - Click `+ Open Workspace` in the sidebar to register a local folder or multi-repo workspace root (`Org / Workspace / Repo` switcher).
   - Search files or create files with `+ File`.
   - Toggle per-folder sync rules between `local_only` (never leaves your machine, ideal for sensitive datasets) and `cloud_sync`.
2. **Writing Studio**
   - Click any `.md`, source code, or text file to open the **Split / Source / Preview** editor (`Ctrl+S` saves directly into the workspace's CoW shadow).
   - Inspect live **CoW Diff** in the bottom/right drawer and click **Commit** to land verified edits or **Rollback** to discard shadow changes.
   - Click `+ Embed Artifact` to insert snapshots or SVG charts published from **Data Studio** directly into Markdown or Pro Dual-Surface blocks.
   - Open a rich format (`.docx`, `.pptx`, `.pdf`, `.tex`) to preview the **Cloud Pro** gate and optionally paste an Ed25519 entitlement JWT to unlock the **Dual-Surface Pro** canvas (`word diff`, `block outline`, `Revert Last AI Turn`).
3. **Data Studio**
   - Opening `.csv`, `.tsv`, or tabular `.json` files automatically routes into **Data Studio** (with a `Raw Text` toggle in the toolbar if you want source view).
   - Sort and filter rows interactively, inspect column statistics (`min`, `max`, `mean`, missing count), build **SVG Bar Charts**, and click **Publish Artifact** (`table_snapshot` or `chart_svg`) to make them available in Writing Studio and Task Stream.
4. **BYO Agents, `@File / @Artifact` Task Stream & Approval Inbox**
   - In the Agent panel, check availability or follow onboarding guidance for your installed CLIs (`claude`, `opencode`, `codex`, `agy`).
   - Pick a role preset (`coder`, `writer`, `analyst`, `reviewer`), attach files or published data artifacts via `+ @File / @Artifact` mention chips, and dispatch tasks.
   - High-risk agent actions surface in the **Approval Inbox** (auto-polled every 5s with topbar badge & refresh) for explicit human **Approve / Reject** decisions.

---

## Monorepo Layout & Development Scripts

```text
aegis-desktop/
├── packaging/
│   └── arch/                # Arch Linux PKGBUILD & .desktop entry
├── packages/
│   ├── core-shell/          # Daemon API client, 3-layer tree, agent/task/approval UI
│   ├── studio-writing/      # Free Markdown/Code editor & Pro Dual-Surface canvas
│   └── studio-data/         # Tabular CSV/TSV/JSON explorer, SVG charts & artifacts
└── apps/
    ├── desktop/             # Tauri v2 native host + full workbench entrypoint
    └── writing-standalone/  # Pure-web minimal host for @aegis/studio-writing
```

Common workspace verification commands:

```bash
pnpm -r typecheck   # Type-check all packages and apps (tsc --noEmit)
pnpm -r test        # Run Node native unit tests across core-shell, studio-data, studio-writing
pnpm -r build       # Build @aegis/desktop and @aegis/writing-standalone Vite bundles
```
