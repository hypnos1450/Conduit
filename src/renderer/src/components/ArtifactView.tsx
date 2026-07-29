// Renders an HTML file the agent wrote as a real, working page.
//
// Loaded over the conduit-artifact:// scheme (see main/artifact.ts) rather than
// as `srcDoc`, because srcDoc has no base URL and a page's relative stylesheet,
// script and image references simply cannot resolve — the old preview showed
// unstyled, inert markup. With a document URL they resolve against the
// workspace, and the page renders the way it would in a browser.
//
// Containment is the protocol's job (path jail + a CSP pinning every fetch to
// this origin), so all this component decides is the sandbox and the cache-bust.
import { JSX, useCallback, useMemo, useRef, useState } from 'react'
import { RefreshIcon } from './Icons'

/**
 * What the page may do. Notably absent: allow-top-navigation, so the page can
 * never replace the app's own document.
 *
 * allow-same-origin is deliberate. Without it the frame gets an opaque origin
 * and `fetch()` of its own assets plus localStorage both throw, so pages render
 * but misbehave in ways that look like app bugs. It is safe here because the
 * embedding renderer is a *different* origin, so same-origin does not grant any
 * reach into the app — and the CSP still blocks anything remote.
 */
const SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-same-origin allow-downloads'

/** Build the artifact URL for a workspace-relative path. */
export function artifactUrl(sessionId: string, file: string, version: number | string): string {
  const segments = file
    .replace(/\\/g, '/') // agent paths on Windows may use backslashes
    .split('/')
    .filter((s) => s && s !== '.')
    .map(encodeURIComponent)
  return `conduit-artifact://${sessionId}/${segments.join('/')}?v=${version}`
}

export default function ArtifactView({
  sessionId,
  file,
  version
}: {
  sessionId: string
  file: string
  /** Bumped when the agent rewrites the file, which reloads the frame. */
  version: number
}): JSX.Element {
  const [nonce, setNonce] = useState(0)
  const frame = useRef<HTMLIFrameElement | null>(null)

  // Keyed on version+nonce so a rewrite or a manual reload produces a genuinely
  // new document rather than a cached one.
  const src = useMemo(() => artifactUrl(sessionId, file, `${version}.${nonce}`), [sessionId, file, version, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return (
    <div className="artifact-wrap">
      <div className="artifact-bar">
        <span className="artifact-path" title={file}>
          {file}
        </span>
        <button className="icon-btn" title="Reload artifact" onClick={reload}>
          <RefreshIcon size={14} />
        </button>
      </div>
      <iframe
        ref={frame}
        key={src}
        className="artifact-frame"
        src={src}
        sandbox={SANDBOX}
        title={file}
        // Keep an artifact from reaching the network even if a CSP were missing.
        referrerPolicy="no-referrer"
      />
    </div>
  )
}
