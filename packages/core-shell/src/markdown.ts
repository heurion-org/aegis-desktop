export function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatInline(escaped: string): string {
  return escaped.replace(/`([^`]+)`|\*\*(.+?)\*\*|\*([^*]+)\*/g, (_m, code, bold, italic) => {
    if (code !== undefined) return `<code>${code}</code>`
    if (bold !== undefined) return `<strong>${bold}</strong>`
    return `<em>${italic}</em>`
  })
}

/**
 * Zero-dependency, XSS-safe Markdown-to-HTML renderer for assistant replies in the Workstream.
 * Always escapes raw HTML before formatting inline styles so untrusted output cannot inject scripts.
 */
export function renderChatMarkdownHtml(markdown: string): string {
  const lines = markdown.split(/\r?\n/)
  const out: string[] = []
  let inFence = false
  let fenceLines: string[] = []
  let inTable = false
  let listMode: 'ul' | 'ol' | null = null

  const closeList = () => {
    if (listMode) {
      out.push(`</${listMode}>`)
      listMode = null
    }
  }

  const closeTable = () => {
    if (inTable) {
      out.push('</tbody></table>')
      inTable = false
    }
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx]!
    if (rawLine.trimStart().startsWith('```')) {
      closeList()
      closeTable()
      if (!inFence) {
        inFence = true
        fenceLines = []
      } else {
        out.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`)
        inFence = false
        fenceLines = []
      }
      continue
    }
    if (inFence) {
      fenceLines.push(rawLine)
      continue
    }

    const trimmed = rawLine.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeList()
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map(c => c.trim())
      const nextLine = (lines[idx + 1] ?? '').trim()
      const isSeparatorNext =
        nextLine.startsWith('|') &&
        nextLine.endsWith('|') &&
        /^[\s|:-]+$/.test(nextLine)
      if (!inTable && isSeparatorNext) {
        out.push(
          `<table><thead><tr>${cells.map(c => `<th>${formatInline(escapeHtml(c))}</th>`).join('')}</tr></thead><tbody>`,
        )
        inTable = true
        idx += 1
        continue
      }
      if (inTable) {
        out.push(
          `<tr>${cells.map(c => `<td>${formatInline(escapeHtml(c))}</td>`).join('')}</tr>`,
        )
        continue
      }
    } else {
      closeTable()
    }

    const ulMatch = rawLine.match(/^\s*[-*]\s+(.+)$/)
    if (ulMatch) {
      if (listMode !== 'ul') {
        closeList()
        out.push('<ul>')
        listMode = 'ul'
      }
      out.push(`<li>${formatInline(escapeHtml(ulMatch[1]!))}</li>`)
      continue
    }

    const olMatch = rawLine.match(/^\s*\d+\.\s+(.+)$/)
    if (olMatch) {
      if (listMode !== 'ol') {
        closeList()
        out.push('<ol>')
        listMode = 'ol'
      }
      out.push(`<li>${formatInline(escapeHtml(olMatch[1]!))}</li>`)
      continue
    }

    closeList()

    if (trimmed === '') {
      continue
    }

    if (/^---+$/.test(trimmed)) {
      out.push('<hr>')
      continue
    }

    const escaped = escapeHtml(trimmed)
    if (escaped.startsWith('#### ')) {
      out.push(`<h4>${formatInline(escaped.slice(5))}</h4>`)
    } else if (escaped.startsWith('### ')) {
      out.push(`<h3>${formatInline(escaped.slice(4))}</h3>`)
    } else if (escaped.startsWith('## ')) {
      out.push(`<h2>${formatInline(escaped.slice(3))}</h2>`)
    } else if (escaped.startsWith('# ')) {
      out.push(`<h1>${formatInline(escaped.slice(2))}</h1>`)
    } else if (escaped.startsWith('&gt; ')) {
      out.push(`<blockquote>${formatInline(escaped.slice(5))}</blockquote>`)
    } else {
      out.push(`<p>${formatInline(escaped)}</p>`)
    }
  }

  closeList()
  closeTable()
  if (inFence && fenceLines.length > 0) {
    out.push(`<pre><code>${escapeHtml(fenceLines.join('\n'))}</code></pre>`)
  }
  return out.join('\n')
}
