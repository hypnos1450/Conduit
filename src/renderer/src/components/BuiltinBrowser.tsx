// A full-capability browser pane for the right dock. Renders agent-written HTML
// (served from the loopback workspace server with no CSP) and lets the user
// browse the open web. Backed by an Electron <webview>, so it runs in its own
// isolated WebContents with a private storage partition — pages here can never
// reach the app's origin, tokens, or preload bridge.
import React, { createElement, forwardRef, useEffect, useRef, useState, type JSX } from 'react'

// Electron's <webview> tag (enabled via webviewTag) isn't a JSX element; wrap
// it in a typed component whose ref exposes the element for its DOM methods.
type WebviewProps = { className?: string; src?: string; partition?: string }
const WebviewTag = forwardRef<HTMLElement, WebviewProps>((props, ref) =>
  createElement(
    'webview',
    { ...props, ref } as React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
  )
)
WebviewTag.displayName = 'WebviewTag'

interface WebviewEl extends HTMLElement {
  loadURL(url: string): Promise<void>
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  getURL(): string
}

/** Turn an address-bar string into a navigable URL (assume https:// when bare). */
function normalizeUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t
  return `https://${t}`
}

export default function BuiltinBrowser({ src }: { src: string }): JSX.Element {
  const wvRef = useRef<HTMLElement | null>(null)
  const [addr, setAddr] = useState(src)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [busy, setBusy] = useState(false)

  const wv = (): WebviewEl | null => wvRef.current as WebviewEl | null

  useEffect(() => {
    const el = wvRef.current as WebviewEl | null
    if (!el) return
    // The guest is only usable after 'did-attach'; calling webview methods
    // before that throws and would unmount the whole app from an uncaught
    // error in the effect, so sync() only ever runs post-attach (or from a
    // navigation event) and stays defensive regardless.
    const sync = (): void => {
      try {
        const u = el.getURL()
        if (u) setAddr(u)
        setCanBack(el.canGoBack())
        setCanFwd(el.canGoForward())
      } catch {
        // guest not attached yet — events fire again once it is
      }
    }
    const onAttach = (): void => sync()
    const start = (): void => setBusy(true)
    const stop = (): void => {
      setBusy(false)
      sync()
    }
    // Pages that open a new tab/window go to the system browser instead.
    const openExternal = (e: Event): void => {
      const ev = e as Event & { url?: string }
      void window.harness.browser.openExternal(ev.url ?? '')
    }
    el.addEventListener('did-attach', onAttach)
    el.addEventListener('did-navigate', sync)
    el.addEventListener('did-navigate-in-page', sync)
    el.addEventListener('page-title-updated', sync)
    el.addEventListener('did-start-loading', start)
    el.addEventListener('did-stop-loading', stop)
    el.addEventListener('new-window', openExternal)
    return () => {
      el.removeEventListener('did-attach', onAttach)
      el.removeEventListener('did-navigate', sync)
      el.removeEventListener('did-navigate-in-page', sync)
      el.removeEventListener('page-title-updated', sync)
      el.removeEventListener('did-start-loading', start)
      el.removeEventListener('did-stop-loading', stop)
      el.removeEventListener('new-window', openExternal)
    }
  }, [src])

  const navigate = (url: string): void => {
    const u = normalizeUrl(url)
    if (!u) return
    setAddr(u)
    const el = wv()
    if (el) void el.loadURL(u).catch(() => undefined)
  }

  const go = (dir: 'back' | 'forward' | 'reload'): void => {
    const el = wv()
    if (!el) return
    if (dir === 'back') el.goBack()
    else if (dir === 'forward') el.goForward()
    else el.reload()
  }

  return (
    <div className="browser">
      <div className="browser-bar">
        <button className="mini-btn" disabled={!canBack} title="Back" onClick={() => go('back')}>
          ◀
        </button>
        <button className="mini-btn" disabled={!canFwd} title="Forward" onClick={() => go('forward')}>
          ▶
        </button>
        <button className="mini-btn" title={busy ? 'Stop loading' : 'Reload'} onClick={() => go('reload')}>
          {busy ? '✕' : '⟳'}
        </button>
        <input
          className="browser-addr"
          type="text"
          value={addr}
          spellCheck={false}
          placeholder="Type a URL, then Enter — or open a workspace file from Files"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(addr)
          }}
        />
        <button
          className="mini-btn"
          title="Open in the system browser"
          onClick={() => void window.harness.browser.openExternal(addr)}
        >
          ↗
        </button>
      </div>
      <WebviewTag
        ref={wvRef}
        className="browser-webview"
        src={src}
        partition="persist:conduit-browser"
      />
    </div>
  )
}
