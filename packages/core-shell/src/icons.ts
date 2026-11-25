export type IconName =
  | 'shield'
  | 'folder'
  | 'folderOpen'
  | 'file'
  | 'fileCode'
  | 'fileTable'
  | 'fileDoc'
  | 'chevronRight'
  | 'chevronDown'
  | 'cloud'
  | 'lock'
  | 'packageBox'
  | 'bell'
  | 'refresh'
  | 'plus'
  | 'search'
  | 'pen'
  | 'terminal'
  | 'chartBar'
  | 'sparkles'
  | 'paperclip'
  | 'check'
  | 'undo'
  | 'diff'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'compass'
  | 'server'
  | 'arrowRight'
  | 'arrowLeft'
  | 'x'
  | 'layers'
  | 'alertTriangle'

const ICON_BODY: Record<IconName, string> = {
  shield:
    '<path d="M10 2.5L4 5v4.8c0 3.7 2.55 7.1 6 8.2 3.45-1.1 6-4.5 6-8.2V5l-6-2.5z"/><path d="M7.5 10.2l1.8 1.8 3.4-3.6"/>',
  folder:
    '<path d="M2.75 5.25A1.5 1.5 0 0 1 4.25 3.75h3.5l1.5 1.75h6.5a1.5 1.5 0 0 1 1.5 1.5v7.75a1.5 1.5 0 0 1-1.5 1.5H4.25a1.5 1.5 0 0 1-1.5-1.5V5.25z"/>',
  folderOpen:
    '<path d="M2.75 6a1.5 1.5 0 0 1 1.5-1.5h3.2l1.5 1.5h6.8a1.25 1.25 0 0 1 1.25 1.25v1.5M2.75 15.25l1.7-5.5a1.25 1.25 0 0 1 1.2-.9h10.8a1 1 0 0 1 .95 1.3l-1.55 4.9a1.25 1.25 0 0 1-1.2.85H4a1.25 1.25 0 0 1-1.25-1.65z"/>',
  file:
    '<path d="M5 2.75h6.75L15.25 6.25v11H5z"/><path d="M11.75 2.75v3.5h3.5"/>',
  fileCode:
    '<path d="M5 2.75h6.75L15.25 6.25v11H5z"/><path d="M11.75 2.75v3.5h3.5"/><path d="M8.5 10.5L7 12l1.5 1.5M11.5 10.5L13 12l-1.5 1.5"/>',
  fileTable:
    '<path d="M5 2.75h6.75L15.25 6.25v11H5z"/><path d="M11.75 2.75v3.5h3.5"/><path d="M7 9.75h6M7 12.75h6M10 9.75v5"/>',
  fileDoc:
    '<path d="M5 2.75h6.75L15.25 6.25v11H5z"/><path d="M11.75 2.75v3.5h3.5"/><path d="M7.5 10h5M7.5 13h5"/>',
  chevronRight: '<path d="M7.5 5.25L12.5 10l-5 4.75"/>',
  chevronDown: '<path d="M5.25 7.5L10 12.5l4.75-5"/>',
  cloud:
    '<path d="M6.25 15.25h8a3.25 3.25 0 0 0 .35-6.48A4.75 4.75 0 0 0 5.5 7.6 3.5 3.5 0 0 0 6.25 15.25z"/>',
  lock:
    '<rect x="4.5" y="8.75" width="11" height="8" rx="1.5"/><path d="M7 8.75V6.5a3 3 0 0 1 6 0v2.25"/>',
  packageBox:
    '<path d="M3.5 6.5L10 3l6.5 3.5v7L10 17l-6.5-3.5v-7z"/><path d="M3.5 6.5L10 10l6.5-3.5M10 10v7"/>',
  bell:
    '<path d="M15 13.5H5l1.2-1.8V8.5a3.8 3.8 0 0 1 7.6 0v3.2L15 13.5z"/><path d="M8.5 15.5a1.5 1.5 0 0 0 3 0"/>',
  refresh:
    '<path d="M16.25 8.5A6.25 6.25 0 0 0 5.4 5.75L3.75 7.5M3.75 4.25v3.25h3.25"/><path d="M3.75 11.5a6.25 6.25 0 0 0 10.85 2.75l1.65-1.75M16.25 15.75V12.5H13"/>',
  plus: '<path d="M10 4.25v11.5M4.25 10h11.5"/>',
  search: '<circle cx="8.75" cy="8.75" r="5"/><path d="M12.5 12.5l3.75 3.75"/>',
  pen: '<path d="M13.75 3.75l2.5 2.5-8.5 8.5-3.5 1 1-3.5 8.5-8.5z"/><path d="M11.75 5.75l2.5 2.5"/>',
  terminal: '<rect x="2.75" y="4" width="14.5" height="12" rx="1.75"/><path d="M6 8.25l2.25 1.75L6 11.75M10.25 12.25h3.5"/>',
  chartBar: '<path d="M3.25 3.75v12.5h13.5M6.75 13.5V9.25M10.25 13.5V5.5M13.75 13.5V10"/>',
  sparkles:
    '<path d="M10 2.75l1.35 3.9 3.9 1.35-3.9 1.35L10 13.25l-1.35-3.9-3.9-1.35 3.9-1.35L10 2.75z"/><path d="M15.25 12.75l.65 1.6 1.6.65-1.6.65-.65 1.6-.65-1.6-1.6-.65 1.6-.65.65-1.6z"/>',
  paperclip:
    '<path d="M13.75 6.75l-5.9 5.9a2.1 2.1 0 1 1-3-2.97l6.2-6.2a3.35 3.35 0 1 1 4.74 4.74l-6.2 6.2a4.6 4.6 0 0 1-6.5-6.5l5.4-5.4"/>',
  check: '<path d="M4.25 10.5l3.75 3.75 7.75-8"/>',
  undo: '<path d="M4.5 8.25H12a4 4 0 1 1 0 8H8.5"/><path d="M7.5 5.25L4.5 8.25l3 3"/>',
  diff: '<rect x="3.25" y="3.75" width="5.5" height="12.5" rx="1"/><rect x="11.25" y="3.75" width="5.5" height="12.5" rx="1"/><path d="M6 7.5v3M4.5 9h3M12.5 9h3"/>',
  sun: '<circle cx="10" cy="10" r="3.25"/><path d="M10 2.75v1.75M10 15.5v1.75M2.75 10H4.5M15.5 10h1.75M4.9 4.9l1.25 1.25M13.85 13.85l1.25 1.25M15.1 4.9l-1.25 1.25M6.15 13.85L4.9 15.1"/>',
  moon: '<path d="M15.75 12.4A6.25 6.25 0 0 1 7.6 4.25a6.25 6.25 0 1 0 8.15 8.15z"/>',
  monitor: '<rect x="2.75" y="3.75" width="14.5" height="9.75" rx="1.5"/><path d="M6.75 16.5h6.5M10 13.5v3"/>',
  compass: '<circle cx="10" cy="10" r="7.25"/><polygon points="12.75,7.25 11.2,11.2 7.25,12.75 8.8,8.8"/>',
  server: '<rect x="3.25" y="3.5" width="13.5" height="5" rx="1"/><rect x="3.25" y="11.5" width="13.5" height="5" rx="1"/><circle cx="6.25" cy="6" r="0.6" fill="currentColor"/><circle cx="6.25" cy="14" r="0.6" fill="currentColor"/>',
  arrowRight: '<path d="M4.25 10h11.5M11.25 5.5L15.75 10l-4.5 4.5"/>',
  arrowLeft: '<path d="M15.75 10H4.25M8.75 5.5L4.25 10l4.5 4.5"/>',
  x: '<path d="M5.25 5.25l9.5 9.5M14.75 5.25l-9.5 9.5"/>',
  layers: '<path d="M10 3.25L3.25 7 10 10.75 16.75 7 10 3.25z"/><path d="M3.25 10.25L10 14l6.75-3.75M3.25 13.25L10 17l6.75-3.75"/>',
  alertTriangle: '<path d="M10 3.25l7 12.75H3L10 3.25z"/><path d="M10 8v4M10 14.25h.01"/>',
}

/** Render a crisp inline vector SVG icon (`viewBox="0 0 20 20"`). */
export function iconHtml(name: IconName, className = ''): string {
  const cls = className ? `aos-icon ${className}` : 'aos-icon'
  return `<svg class="${cls}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_BODY[name]}</svg>`
}

/** Render the Heurion × Aegis architectural H-mark SVG. */
export function brandMarkSvg(className = ''): string {
  const cls = className ? `aos-brand-mark ${className}` : 'aos-brand-mark'
  return `<svg class="${cls}" viewBox="-2 6 96 88" aria-hidden="true"><rect class="mark-ink" x="0" y="10" width="18" height="80" rx="9"/><rect class="mark-ink" x="62" y="30" width="18" height="60" rx="9"/><rect class="mark-mint" x="14" y="42" width="52" height="18" rx="9"/><circle class="mark-mint" cx="80" cy="20" r="11"/></svg>`
}
