// One syntax-highlighting wrapper for the whole renderer.
//
// There were two, keyed differently (markdown language class vs file
// extension) and with different fallbacks, so a fix to one never reached the
// other. The keying difference was never real — both are just a language hint.
// `lib/common` rather than the full bundle — same set both call sites already used.
import hljs from 'highlight.js/lib/common'

/** HTML-escape, for the path where highlighting is not possible. */
export function escapeHtml(code: string): string {
  return code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Highlighted HTML for `code`, or null when highlight.js fails outright — the
 * caller then renders the text as-is rather than risking unescaped markup.
 *
 * `hint` is a language name or a file extension; an unrecognised one falls back
 * to auto-detection rather than giving up.
 */
export function highlight(code: string, hint?: string): string | null {
  try {
    if (hint && hljs.getLanguage(hint)) {
      return hljs.highlight(code, { language: hint, ignoreIllegals: true }).value
    }
    return hljs.highlightAuto(code).value
  } catch {
    return null
  }
}

/** Highlighted HTML, falling back to escaped plain text. Never returns null. */
export function highlightOrEscape(code: string, hint?: string): string {
  return highlight(code, hint) ?? escapeHtml(code)
}
