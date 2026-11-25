#!/usr/bin/env bash
set -euo pipefail

# Aegis Desktop unified installer for macOS & Linux (Ubuntu/Debian, Arch Linux, Fedora).
# Usage:
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/heurion-org/aegis-desktop/main/install.sh)"

DESKTOP_REPO="heurion-org/aegis-desktop"
AEGIS_OS_REPO="heurion-org/aegis-os"
DEFAULT_AEGIS_OS_TAG="v0.12.1"

VERSION="${AEGIS_DESKTOP_VERSION:-latest}"
FROM_SOURCE="${AEGIS_DESKTOP_FROM_SOURCE:-0}"
NONINTERACTIVE="${NONINTERACTIVE:-0}"
DRY_RUN=0
UNINSTALL=0

WORK_DIR=""
MOUNTED_DMG_DIR=""

if [[ -t 1 ]]; then
  FMT_BLUE=$'\033[1;34m'
  FMT_GREEN=$'\033[1;32m'
  FMT_YELLOW=$'\033[1;33m'
  FMT_RED=$'\033[1;31m'
  FMT_BOLD=$'\033[1m'
  FMT_RESET=$'\033[0m'
else
  FMT_BLUE=""
  FMT_GREEN=""
  FMT_YELLOW=""
  FMT_RED=""
  FMT_BOLD=""
  FMT_RESET=""
fi

ohai() {
  printf "%s==>%s %s%s%s\n" "$FMT_BLUE" "$FMT_RESET" "$FMT_BOLD" "$*" "$FMT_RESET"
}

info() {
  printf "   %s\n" "$*"
}

warn() {
  printf "%sWarning:%s %s\n" "$FMT_YELLOW" "$FMT_RESET" "$*" >&2
}

abort() {
  printf "%sError:%s %s\n" "$FMT_RED" "$FMT_RESET" "$*" >&2
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

cleanup() {
  if [[ -n "${MOUNTED_DMG_DIR:-}" && -d "${MOUNTED_DMG_DIR:-}" ]]; then
    hdiutil detach -quiet "$MOUNTED_DMG_DIR" >/dev/null 2>&1 || true
  fi
  if [[ -n "${WORK_DIR:-}" && -d "${WORK_DIR:-}" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Aegis Desktop Installer (macOS & Linux)

Usage:
  install.sh [OPTIONS]

Options:
  --version <tag>   Install a specific release tag (e.g. desktop-v0.1.0; default: latest)
  --from-source     Force building from source instead of downloading a pre-built release
  --yes, -y         Non-interactive mode (skip confirmation prompts; same as NONINTERACTIVE=1)
  --dry-run         Show detected platform, install plan, and commands without making changes
  --uninstall       Remove user/local Aegis Desktop installation and desktop entry
  -h, --help        Show this help message

Environment Variables:
  NONINTERACTIVE=1           Skip confirmation prompt
  AEGIS_DESKTOP_VERSION      Same as --version
  AEGIS_DESKTOP_FROM_SOURCE  Set to 1 for --from-source
  AEGIS_OS_BIN               Optional path to an existing aegis-os binary for source builds
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      [[ $# -ge 2 ]] || abort "--version requires a release tag argument"
      VERSION="$2"
      shift 2
      ;;
    --from-source)
      FROM_SOURCE=1
      shift
      ;;
    -y|--yes)
      NONINTERACTIVE=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      abort "Unknown option: $1 (run with --help for usage)"
      ;;
  esac
done

detect_platform() {
  local raw_os raw_arch
  raw_os="$(uname -s)"
  raw_arch="$(uname -m)"

  case "$raw_os" in
    Darwin) OS="macos" ;;
    Linux)  OS="linux" ;;
    *) abort "Unsupported OS: $raw_os (supported: macOS, Linux)" ;;
  esac

  case "$raw_arch" in
    x86_64|amd64)
      ARCH="x86_64"
      DEB_ARCH="amd64"
      MAC_ASSET_ARCH="x64"
      ;;
    arm64|aarch64)
      ARCH="aarch64"
      DEB_ARCH="arm64"
      MAC_ASSET_ARCH="aarch64"
      ;;
    *)
      abort "Unsupported CPU architecture: $raw_arch (supported: x86_64, arm64/aarch64)"
      ;;
  esac

  if [[ "$OS" == "macos" ]]; then
    TARGET_TRIPLE="${ARCH}-apple-darwin"
    DISTRO="macos"
  else
    TARGET_TRIPLE="${ARCH}-unknown-linux-gnu"
    DISTRO="generic"
    if [[ -r /etc/os-release ]]; then
      local os_id os_like
      os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
      os_like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
      case " ${os_id} ${os_like} " in
        *" arch "*|*" archlinux "*|*" manjaro "*|*" endeavouros "*|*" cachyos "*)
          DISTRO="arch"
          ;;
        *" ubuntu "*|*" debian "*|*" linuxmint "*|*" pop "*)
          DISTRO="debian"
          ;;
        *" fedora "*|*" rhel "*|*" centos "*|*" rocky "*|*" alma "*)
          DISTRO="fedora"
          ;;
      esac
    fi
  fi
}

run_cmd() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] $*"
  else
    "$@"
  fi
}

run_as_root() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
      info "[dry-run] $*"
    else
      info "[dry-run] sudo $*"
    fi
    return 0
  fi

  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif have_cmd sudo; then
    sudo "$@"
  else
    abort "Root privileges required to run '$*', and 'sudo' is not installed."
  fi
}

confirm_or_continue() {
  if [[ "$DRY_RUN" -eq 1 || "$NONINTERACTIVE" -eq 1 || ! -t 0 ]]; then
    return 0
  fi
  printf "\nPress %sRETURN/ENTER%s to continue or any other key to abort: " "$FMT_BOLD" "$FMT_RESET"
  local key=""
  IFS= read -r -n 1 key || true
  printf "\n"
  if [[ -n "$key" ]]; then
    abort "Installation aborted by user."
  fi
}

ensure_local_bin_in_path() {
  local bin_dir="${HOME}/.local/bin"
  case ":${PATH}:" in
    *":${bin_dir}:"*) return 0 ;;
  esac

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] append ${bin_dir} to shell profile (~/.bashrc / ~/.zshrc / ~/.profile)"
    return 0
  fi

  local rc
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
    if [[ -f "$rc" ]] && ! grep -q "${bin_dir}" "$rc" 2>/dev/null; then
      printf '\nexport PATH="%s:$PATH"\n' "$bin_dir" >> "$rc"
      info "Added ${bin_dir} to ${rc}"
    fi
  done
}

install_linux_desktop_entry() {
  local exec_path="$1"
  local apps_dir="${HOME}/.local/share/applications"
  local desktop_file="${apps_dir}/aegis-desktop.desktop"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] write desktop launcher to ${desktop_file} (Exec=${exec_path} %U)"
    return 0
  fi

  mkdir -p "$apps_dir"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=Aegis Desktop
Comment=Local CoW Sandbox Workbench, Writing Studio, and Data Studio for Aegis OS
Exec=${exec_path} %U
Terminal=false
Categories=Development;Office;Utility;
StartupWMClass=aegis-desktop
EOF
  info "Installed application menu entry: ${desktop_file}"
}

uninstall_aegis_desktop() {
  ohai "Uninstalling Aegis Desktop (${OS}/${DISTRO})..."

  if [[ "$OS" == "macos" ]]; then
    run_cmd rm -rf "/Applications/Aegis Desktop.app" "${HOME}/Applications/Aegis Desktop.app"
    run_cmd rm -f "/usr/local/bin/aegis-desktop" "${HOME}/.local/bin/aegis-desktop"
    run_cmd rm -rf "${HOME}/.local/lib/aegis-desktop" "${HOME}/.local/share/aegis-desktop"
  else
    run_cmd rm -f "${HOME}/.local/bin/aegis-desktop"
    run_cmd rm -rf "${HOME}/.local/lib/aegis-desktop" "${HOME}/.local/share/aegis-desktop"
    run_cmd rm -f "${HOME}/.local/share/applications/aegis-desktop.desktop"

    if [[ "$DISTRO" == "debian" ]] && have_cmd dpkg && dpkg -s aegis-desktop >/dev/null 2>&1; then
      warn "System-wide .deb package 'aegis-desktop' is installed. Remove it with: sudo apt-get remove -y aegis-desktop"
    elif [[ "$DISTRO" == "arch" ]] && have_cmd pacman && pacman -Qi aegis-desktop >/dev/null 2>&1; then
      warn "Pacman package 'aegis-desktop' is installed. Remove it with: sudo pacman -Rs aegis-desktop"
    fi
  fi

  printf "%s✅ Aegis Desktop user installation removed.%s\n" "$FMT_GREEN" "$FMT_RESET"
}

fetch_release_asset_urls() {
  local api_url
  if [[ "$VERSION" == "latest" ]]; then
    api_url="https://api.github.com/repos/${DESKTOP_REPO}/releases/latest"
  else
    api_url="https://api.github.com/repos/${DESKTOP_REPO}/releases/tags/${VERSION}"
  fi

  curl -fsSL -H "Accept: application/vnd.github+json" "$api_url" 2>/dev/null \
    | grep -oE 'https://github\.com/[^"]+/releases/download/[^"]+' || true
}

pick_first_matching_url() {
  local urls="$1"
  shift
  local pattern found
  for pattern in "$@"; do
    found="$(printf '%s\n' "$urls" | grep -E "$pattern" | head -n 1 || true)"
    if [[ -n "$found" ]]; then
      printf '%s\n' "$found"
      return 0
    fi
  done
  return 1
}

ensure_linux_runtime_deps() {
  ohai "Checking Linux runtime dependencies (${DISTRO})..."
  case "$DISTRO" in
    debian)
      run_as_root apt-get update -qq
      run_as_root apt-get install -y bubblewrap curl
      ;;
    arch)
      run_as_root pacman -S --needed --noconfirm bubblewrap webkit2gtk-4.1 libayatana-appindicator curl
      ;;
    fedora)
      run_as_root dnf install -y bubblewrap webkit2gtk4.1 libayatana-appindicator-gtk3 curl
      ;;
    *)
      if ! have_cmd bwrap; then
        warn "'bubblewrap' (bwrap) not found. Install 'bubblewrap' with your package manager for OS sandbox isolation."
      fi
      ;;
  esac
}

install_appimage_linux() {
  local asset_url="$1"
  local share_dir="${HOME}/.local/share/aegis-desktop"
  local appimage_path="${share_dir}/AegisDesktop.AppImage"
  local bin_dir="${HOME}/.local/bin"
  local wrapper_path="${bin_dir}/aegis-desktop"

  ohai "Downloading AppImage..."
  info "$asset_url"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] download AppImage to ${appimage_path}"
    info "[dry-run] create launcher wrapper at ${wrapper_path} (auto-uses --appimage-extract-and-run if libfuse.so.2 is absent)"
    install_linux_desktop_entry "$wrapper_path"
    ensure_local_bin_in_path
    return 0
  fi

  mkdir -p "$share_dir" "$bin_dir"
  curl -fsSL "$asset_url" -o "${appimage_path}.tmp"
  chmod +x "${appimage_path}.tmp"
  mv -f "${appimage_path}.tmp" "$appimage_path"

  cat > "$wrapper_path" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
APPIMAGE="${HOME}/.local/share/aegis-desktop/AegisDesktop.AppImage"
if ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2' || [[ -e /usr/lib/libfuse.so.2 ]]; then
  exec "$APPIMAGE" "$@"
else
  exec "$APPIMAGE" --appimage-extract-and-run "$@"
fi
EOF
  chmod +x "$wrapper_path"
  install_linux_desktop_entry "$wrapper_path"
  ensure_local_bin_in_path
}

install_from_release() {
  local urls="$1"

  if [[ "$OS" == "macos" ]]; then
    local dmg_url
    dmg_url="$(pick_first_matching_url "$urls" \
      "_(${MAC_ASSET_ARCH}|${ARCH})\.dmg$" \
      "universal\.dmg$" \
      "\.dmg$")" || return 1

    ohai "Installing Aegis Desktop for macOS (${ARCH}) from DMG..."
    info "$dmg_url"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] download ${dmg_url}, mount DMG, copy Aegis Desktop.app to /Applications, link aegis-desktop wrapper"
      return 0
    fi

    local dmg_file="${WORK_DIR}/aegis-desktop.dmg"
    curl -fsSL "$dmg_url" -o "$dmg_file"

    local attach_out
    attach_out="$(hdiutil attach -nobrowse -readonly "$dmg_file")"
    MOUNTED_DMG_DIR="$(printf '%s\n' "$attach_out" | awk '/\/Volumes\// { idx = index($0, "/Volumes/"); print substr($0, idx); exit }')"
    [[ -n "$MOUNTED_DMG_DIR" && -d "$MOUNTED_DMG_DIR" ]] || abort "Failed to mount DMG volume."

    local app_src="${MOUNTED_DMG_DIR}/Aegis Desktop.app"
    [[ -d "$app_src" ]] || app_src="$(find "$MOUNTED_DMG_DIR" -maxdepth 2 -name '*.app' | head -n 1 || true)"
    [[ -n "$app_src" && -d "$app_src" ]] || abort "Could not find .app bundle inside mounted DMG."

    local target_apps="/Applications"
    if [[ ! -w "$target_apps" ]] && ! have_cmd sudo; then
      target_apps="${HOME}/Applications"
      mkdir -p "$target_apps"
    fi

    if [[ -w "$target_apps" ]]; then
      rm -rf "${target_apps}/Aegis Desktop.app"
      ditto "$app_src" "${target_apps}/Aegis Desktop.app"
    else
      run_as_root rm -rf "${target_apps}/Aegis Desktop.app"
      run_as_root ditto "$app_src" "${target_apps}/Aegis Desktop.app"
    fi

    hdiutil detach -quiet "$MOUNTED_DMG_DIR" || true
    MOUNTED_DMG_DIR=""

    local bin_dir="${HOME}/.local/bin"
    mkdir -p "$bin_dir"
    cat > "${bin_dir}/aegis-desktop" <<EOF
#!/usr/bin/env bash
exec open -a "${target_apps}/Aegis Desktop.app" "\$@"
EOF
    chmod +x "${bin_dir}/aegis-desktop"
    ensure_local_bin_in_path
    info "Installed ${target_apps}/Aegis Desktop.app and launcher ${bin_dir}/aegis-desktop"
    return 0
  fi

  # Linux release install
  if [[ "$DISTRO" == "debian" ]]; then
    local deb_url appimage_url
    deb_url="$(pick_first_matching_url "$urls" \
      "_(${DEB_ARCH}|${ARCH})\.deb$" \
      "\.deb$")" || true

    ensure_linux_runtime_deps
    if [[ -n "$deb_url" ]]; then
      ohai "Installing Aegis Desktop .deb package (${DEB_ARCH})..."
      info "$deb_url"
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] download ${deb_url} and run: sudo apt-get install -y <deb>"
        return 0
      fi
      local deb_file="${WORK_DIR}/aegis-desktop.deb"
      curl -fsSL "$deb_url" -o "$deb_file"
      run_as_root apt-get install -y "$deb_file"
      return 0
    fi

    appimage_url="$(pick_first_matching_url "$urls" \
      "_(${DEB_ARCH}|${ARCH})\.AppImage$" \
      "\.AppImage$")" || return 1
    install_appimage_linux "$appimage_url"
    return 0
  fi

  local appimage_url
  appimage_url="$(pick_first_matching_url "$urls" \
    "_(${DEB_ARCH}|${ARCH})\.AppImage$" \
    "\.AppImage$")" || return 1

  ensure_linux_runtime_deps
  install_appimage_linux "$appimage_url"
  return 0
}

ensure_source_build_deps() {
  ohai "Checking build dependencies for source installation (${OS}/${DISTRO})..."

  if [[ "$OS" == "macos" ]]; then
    if ! xcode-select -p >/dev/null 2>&1; then
      abort "Xcode Command Line Tools are required on macOS. Install with: xcode-select --install"
    fi
    if ! have_cmd node || ! have_cmd pnpm; then
      if have_cmd brew; then
        run_cmd brew install node pnpm
      else
        abort "Node.js (>= 24) and pnpm (>= 10) are required. Install Homebrew (https://brew.sh) or Node/pnpm first."
      fi
    fi
  else
    case "$DISTRO" in
      arch)
        local arch_pkgs=(
          base-devel pkgconf openssl webkit2gtk-4.1 gtk3 libayatana-appindicator
          librsvg patchelf bubblewrap curl git
        )
        have_cmd node || arch_pkgs+=(nodejs)
        have_cmd pnpm || arch_pkgs+=(pnpm)
        run_as_root pacman -S --needed --noconfirm "${arch_pkgs[@]}"
        ;;
      debian)
        run_as_root apt-get update -qq
        local appindicator_pkg="libappindicator3-dev"
        if ! apt-cache show libappindicator3-dev >/dev/null 2>&1; then
          appindicator_pkg="libayatana-appindicator3-dev"
        fi
        run_as_root apt-get install -y \
          build-essential pkg-config libssl-dev \
          libwebkit2gtk-4.1-dev "$appindicator_pkg" librsvg2-dev patchelf \
          bubblewrap curl git
        ;;
      fedora)
        local fedora_pkgs=(
          @development-tools pkgconf-pkg-config openssl-devel
          webkit2gtk4.1-devel gtk3-devel libayatana-appindicator-gtk3-devel
          librsvg2-devel patchelf bubblewrap curl git
        )
        have_cmd node || fedora_pkgs+=(nodejs)
        have_cmd pnpm || fedora_pkgs+=(pnpm)
        run_as_root dnf install -y "${fedora_pkgs[@]}"
        ;;
      *)
        warn "Unrecognized Linux distro; ensure Node >= 24, pnpm >= 10, Rust, WebKitGTK 4.1 dev headers, and bubblewrap are installed."
        ;;
    esac
  fi

  if ! have_cmd cargo || ! have_cmd rustc; then
    ohai "Installing Rust toolchain via rustup..."
    if [[ "$DRY_RUN" -eq 1 ]]; then
      info "[dry-run] curl https://sh.rustup.rs | sh -s -- -y --profile minimal"
    else
      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
      # shellcheck disable=SC1091
      source "${HOME}/.cargo/env"
    fi
  fi

  if [[ "$DRY_RUN" -eq 0 ]]; then
    have_cmd node || abort "Node.js (>= 24) is required. Install Node.js 24+ and retry."
    if ! have_cmd pnpm; then
      if have_cmd corepack; then
        corepack enable && corepack prepare pnpm@10 --activate
      else
        abort "pnpm (>= 10) is required. Install pnpm and retry."
      fi
    fi
  fi
}

resolve_or_fetch_aegis_os() {
  local dest="$1"

  if [[ -n "${AEGIS_OS_BIN:-}" && -x "${AEGIS_OS_BIN:-}" ]]; then
    info "Using AEGIS_OS_BIN=${AEGIS_OS_BIN}"
    run_cmd cp "$AEGIS_OS_BIN" "$dest"
    run_cmd chmod +x "$dest"
    return 0
  fi

  if have_cmd aegis-os; then
    local existing
    existing="$(command -v aegis-os)"
    info "Using existing aegis-os at ${existing}"
    run_cmd cp "$existing" "$dest"
    run_cmd chmod +x "$dest"
    return 0
  fi

  ohai "Downloading verified aegis-os (${DEFAULT_AEGIS_OS_TAG} / ${TARGET_TRIPLE})..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] download aegis-os sidecar from https://github.com/${AEGIS_OS_REPO}/releases into ${dest}"
    return 0
  fi

  local tmp_os_dir="${WORK_DIR}/aegis-os-bin"
  mkdir -p "$tmp_os_dir"
  local tar_name="aegis-os-${DEFAULT_AEGIS_OS_TAG}-${TARGET_TRIPLE}.tar.gz"
  local base_url="https://github.com/${AEGIS_OS_REPO}/releases/download/${DEFAULT_AEGIS_OS_TAG}"

  if curl -fsSL "${base_url}/${tar_name}" -o "${tmp_os_dir}/${tar_name}" 2>/dev/null; then
    if curl -fsSL "${base_url}/SHA256SUMS" -o "${tmp_os_dir}/SHA256SUMS" 2>/dev/null; then
      (
        cd "$tmp_os_dir"
        if have_cmd sha256sum; then
          grep "  ${tar_name}\$" SHA256SUMS | sha256sum -c -
        elif have_cmd shasum; then
          grep "  ${tar_name}\$" SHA256SUMS | shasum -a 256 -c -
        fi
      )
    fi
    tar -xzf "${tmp_os_dir}/${tar_name}" -C "$tmp_os_dir"
    cp "${tmp_os_dir}/aegis-os" "$dest"
    chmod +x "$dest"
    return 0
  fi

  info "Tarball not found; downloading signed aegis-os release binary into ${tmp_os_dir}..."
  local sig_os sig_arch sig_bin
  if [[ "$OS" == "macos" ]]; then
    sig_os="darwin"
    sig_arch="$([[ "$ARCH" == "aarch64" ]] && printf 'arm64' || printf 'x86_64')"
  else
    sig_os="linux"
    sig_arch="$ARCH"
  fi
  sig_bin="aegis-os-${sig_os}-${sig_arch}"
  local sig_base="https://github.com/${AEGIS_OS_REPO}/releases/latest/download"
  curl -fsSL "${sig_base}/${sig_bin}" -o "${tmp_os_dir}/${sig_bin}"
  curl -fsSL "${sig_base}/${sig_bin}.sig" -o "${tmp_os_dir}/${sig_bin}.sig"
  if have_cmd ssh-keygen; then
    printf '%s\n' 'aegis-os-release@heurion.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIObpFSqmFZ8/ObqSlGmN/zhTbFeDHDxlKx6ha6Y9Zi37' \
      > "${tmp_os_dir}/allowed_signers"
    ssh-keygen -Y verify -f "${tmp_os_dir}/allowed_signers" -I "aegis-os-release@heurion.org" \
      -n "aegis-os-release" -s "${tmp_os_dir}/${sig_bin}.sig" < "${tmp_os_dir}/${sig_bin}" >/dev/null
  fi
  cp "${tmp_os_dir}/${sig_bin}" "$dest"
  chmod +x "$dest"
}

install_from_source() {
  ensure_source_build_deps

  local ref="main"
  if [[ "$VERSION" != "latest" ]]; then
    ref="$VERSION"
  fi

  ohai "Building Aegis Desktop from source (${DESKTOP_REPO}@${ref})..."
  if [[ "$DRY_RUN" -eq 1 ]]; then
    info "[dry-run] fetch ${DESKTOP_REPO}@${ref} tarball into temporary directory"
    info "[dry-run] stage sidecar at apps/desktop/src-tauri/binaries/aegis-os-${TARGET_TRIPLE}"
    info "[dry-run] run: pnpm install --frozen-lockfile && pnpm --filter @aegis/desktop build"
    info "[dry-run] run: CARGO_TARGET_DIR=.../target cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml"
    info "[dry-run] install binaries under ${HOME}/.local/lib/aegis-desktop and launcher at ${HOME}/.local/bin/aegis-desktop"
    return 0
  fi

  local src_tar="${WORK_DIR}/aegis-desktop-src.tar.gz"
  local src_dir="${WORK_DIR}/src"
  mkdir -p "$src_dir"
  curl -fsSL "https://github.com/${DESKTOP_REPO}/archive/${ref}.tar.gz" -o "$src_tar"
  tar -xzf "$src_tar" --strip-components=1 -C "$src_dir"

  local sidecar_dest="${src_dir}/apps/desktop/src-tauri/binaries/aegis-os-${TARGET_TRIPLE}"
  mkdir -p "$(dirname "$sidecar_dest")"
  resolve_or_fetch_aegis_os "$sidecar_dest"

  (
    cd "$src_dir"
    export CARGO_TARGET_DIR="${src_dir}/target"
    pnpm install --frozen-lockfile
    pnpm --filter @aegis/desktop build
    cargo build --release --manifest-path apps/desktop/src-tauri/Cargo.toml
  )

  local lib_dir="${HOME}/.local/lib/aegis-desktop"
  local bin_dir="${HOME}/.local/bin"
  mkdir -p "$lib_dir" "$bin_dir"

  install -m 755 "${src_dir}/target/release/aegis-desktop" "${lib_dir}/aegis-desktop"
  install -m 755 "$sidecar_dest" "${lib_dir}/aegis-os"
  ln -sf "${lib_dir}/aegis-desktop" "${bin_dir}/aegis-desktop"

  if [[ "$OS" == "linux" ]]; then
    install_linux_desktop_entry "${bin_dir}/aegis-desktop"
  fi
  ensure_local_bin_in_path
  info "Installed source-built Aegis Desktop to ${lib_dir} (launcher: ${bin_dir}/aegis-desktop)"
}

main() {
  detect_platform

  if [[ "$UNINSTALL" -eq 1 ]]; then
    uninstall_aegis_desktop
    exit 0
  fi

  ohai "Aegis Desktop Installer"
  info "Detected platform : ${OS} (${ARCH} / ${DISTRO})"
  info "Target version    : ${VERSION}"
  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    info "Install mode      : Build from source (--from-source)"
  else
    info "Install mode      : Pre-built release (with automatic source-build fallback)"
  fi

  confirm_or_continue

  WORK_DIR="$(mktemp -d)"

  if [[ "$FROM_SOURCE" -eq 1 ]]; then
    install_from_source
  else
    local urls=""
    if [[ "$DRY_RUN" -eq 0 ]]; then
      urls="$(fetch_release_asset_urls)"
    fi

    if [[ -n "$urls" ]]; then
      if ! install_from_release "$urls"; then
        warn "No matching pre-built release asset found for ${OS}/${ARCH} (${VERSION}); falling back to source build..."
        install_from_source
      fi
    else
      if [[ "$DRY_RUN" -eq 1 ]]; then
        info "[dry-run] Would query https://api.github.com/repos/${DESKTOP_REPO}/releases/${VERSION} for matching .dmg / .deb / .AppImage; if none exists, fall back to:"
        install_from_release "" || true
        install_from_source
      else
        warn "No pre-built GitHub Release published yet for ${DESKTOP_REPO} (${VERSION}); falling back to source build..."
        install_from_source
      fi
    fi
  fi

  printf "\n%s✅ Aegis Desktop is ready!%s\n" "$FMT_GREEN" "$FMT_RESET"
  info "Run: aegis-desktop"
  if [[ "$OS" == "linux" ]]; then
    info "Note: Wayland/NVIDIA compatibility (WEBKIT_DISABLE_DMABUF_RENDERER=1) is enabled automatically."
  fi
}

main "$@"
