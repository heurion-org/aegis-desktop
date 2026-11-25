export type PlanTier = 'community' | 'pro' | 'team' | 'enterprise'

export interface DesktopEntitlements {
  tier: PlanTier
  local_md_only: boolean
  dual_surface_crdt: boolean
  rich_formats: string[]
  cloud_yjs_sync: boolean
  max_workspaces: number
}

export interface DesktopEntitlementClaims {
  sub_tenant: string
  tier: PlanTier
  exp: number
  entitlements: DesktopEntitlements
}

export interface FormatAccessDecision {
  ext: string
  allowed: boolean
  mode: 'local_markdown' | 'local_code' | 'cloud_dual_surface' | 'locked_cloud_pro'
  requires_upgrade: boolean
  reason?: string
}

export const DEFAULT_FREE_ENTITLEMENTS: DesktopEntitlements = {
  tier: 'community',
  local_md_only: true,
  dual_surface_crdt: false,
  rich_formats: [],
  cloud_yjs_sync: false,
  max_workspaces: 3,
}

export const RICH_CLOUD_EXTENSIONS = new Set(['docx', 'pptx', 'pdf', 'tex'])
export const LOCAL_MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdx'])

export function normalizeExt(filenameOrExt: string): string {
  const clean = filenameOrExt.trim().toLowerCase()
  const idx = clean.lastIndexOf('.')
  return idx >= 0 ? clean.slice(idx + 1) : clean
}

/**
 * Resolves whether the current user tier may open/edit a given file extension
 * in Aegis Desktop:
 * - Free (Community) tier: full local Markdown + coding workflow access, 0 cloud sync.
 * - Cloud Pro/Team/Enterprise: unlocks Dual-Surface CRDT + OOXML/PDF/TeX & Cloud Yjs relay.
 */
export function resolveFormatAccess(
  filenameOrExt: string,
  entitlements: DesktopEntitlements = DEFAULT_FREE_ENTITLEMENTS,
): FormatAccessDecision {
  const ext = normalizeExt(filenameOrExt)
  if (LOCAL_MARKDOWN_EXTENSIONS.has(ext)) {
    return { ext, allowed: true, mode: 'local_markdown', requires_upgrade: false }
  }
  if (RICH_CLOUD_EXTENSIONS.has(ext)) {
    const richAllowed =
      entitlements.dual_surface_crdt &&
      (entitlements.rich_formats.length === 0 || entitlements.rich_formats.includes(ext))
    if (richAllowed) {
      return { ext, allowed: true, mode: 'cloud_dual_surface', requires_upgrade: false }
    }
    return {
      ext,
      allowed: false,
      mode: 'locked_cloud_pro',
      requires_upgrade: true,
      reason: `.${ext} Dual-Surface CRDT & high-fidelity conversion require Aegis Cloud Pro.`,
    }
  }
  return { ext, allowed: true, mode: 'local_code', requires_upgrade: false }
}

/** Decodes an unverified or pre-verified Ed25519 JWT payload produced by /v1/desktop/entitlements. */
export function decodeEntitlementJwtPayload(token: string): DesktopEntitlementClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const b64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const bin = atob(pad)
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
    const raw = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(raw) as DesktopEntitlementClaims
    if (!parsed || typeof parsed.exp !== 'number' || !parsed.entitlements) return null
    return parsed
  } catch {
    return null
  }
}

export function isEntitlementClaimsFresh(
  claims: DesktopEntitlementClaims | null,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!claims) return false
  return claims.exp > nowEpochSeconds
}
