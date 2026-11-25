export type ThemePref = 'light' | 'dark' | 'system'

const THEME_STORAGE_KEY = 'heurion.theme'

export function getThemePref(): ThemePref {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(THEME_STORAGE_KEY) : null
    if (raw === 'dark' || raw === 'system' || raw === 'light') return raw
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return 'light'
}

export function resolveEffectiveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return pref === 'dark' ? 'dark' : 'light'
}

export function applyTheme(pref = getThemePref()): 'light' | 'dark' {
  const resolved = resolveEffectiveTheme(pref)
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved
    const meta = document.querySelector('meta[name="theme-color"]')
    meta?.setAttribute('content', resolved === 'dark' ? '#111614' : '#FAF8F4')
  }
  return resolved
}

export function setThemePref(pref: ThemePref): 'light' | 'dark' {
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, pref)
    }
  } catch {
    // Ignore storage errors in restricted contexts
  }
  return applyTheme(pref)
}
