# Changelog

All notable changes to Conduit. Each release on GitHub carries the notes
from its section here — the release workflow extracts them automatically when a
version tag is pushed.

## 0.10.0 — 2026-08-12

**Grok 4.6, and a chat that stops drowning in tool calls**

- **Grok 4.6 is available and is the default for new sessions.** xAI's current
  default coding model: 500K context, native reasoning, vision. Existing
  sessions keep whatever model they were started with, and if you already have
  settings, your default stays put until you change it in Settings.
- **`xhigh` reasoning, on the model that has it.** 4.6 adds a fourth depth above
  `high`. It only appears in the menu for models that accept it, and a session
  carried from 4.6 to another model quietly drops back to that model's default
  instead of sending a value it would reject.
- **Consecutive tool calls collapse into one row.** A turn that made twenty
  calls used to be twenty cards between you and the reply; it's now a single
  line — `7 tool calls · grep, bash, apply_patch` — that expands on click.
  Folding never hides what matters: a group containing a failure opens itself
  and says how many failed, a group with a call still running shows that call
  live, and a group never spans the reply that explains it.
- **Tool cards say what the tool did.** The card used to rebuild its own summary
  and only knew how to describe nine tools — `memory`, `skill`, `diagnostics`,
  `session_search` and every MCP tool rendered as a wall of raw JSON. Cards now
  show the summary the tool wrote, the same line the permission prompt showed
  when you approved the call.
- **Write approvals stay scoped inside a symlinked workspace.** If the path to
  your project passed through a symlink (a macOS temp dir, a redirected home),
  the per-file approval key silently degraded to the bare filename — so
  "always allow" on `src/index.ts` also covered every other `index.ts` in the
  tree. Paths are now resolved on both sides, and a target that can't be scoped
  refuses the key and asks again rather than granting more than you meant.
- **Delegated agents stop paying full price for their prompts.** Subagent and
  builder runs re-send their system prompt every turn but never pinned
  themselves to a cache server, so those turns scattered and billed uncached.
  Each fan-out now shares one cache key per persona, so siblings reuse each
  other's cached prefix.

## 0.9.1 — 2026-08-07

**Permission scoping fix, and the seams that make it testable**

- **"Always allow" on `apply_patch` no longer grants blanket write access.**
  Write approvals are scoped per file, but the scoping only ever looked at a
  `path` argument — which `apply_patch` doesn't have, since it takes a whole
  patch. The key silently fell back to the bare tool name, so one approval
  covered every future patch to every file in the workspace. A patch is now
  keyed once per file it names, and every one of those files must already be
  approved for the prompt to be skipped.
- **A write tool that can't name its targets is never allowlisted.** `lsp_edit`
  rename edits whatever files the language server resolves, so it always
  confirms rather than being remembered against the single file you pointed at.
- **Delete-only patches update the Preview panel again.** The dock parsed the
  patch format with its own regex that omitted `Delete File:`. Tools now report
  the paths they touched, so the renderer parses nothing.
- **Fewer tools batched than should be.** `ask_user`, `spawn_agent` and
  `update_plan` were treated as concurrent read-only calls — one blocks on a
  human, one fans out its own model calls, one mutates session state. Batching
  is now a property a tool declares rather than a side effect of its kind.
- **Settings can't silently fail to save.** A new on/off setting used to need a
  matching validator in the main process or it would be dropped without a word;
  boolean settings now validate from their declared default.
- **A mistyped IPC channel or menu action is a build error**, not a runtime
  "no handler registered".

Internals: the model call is now a seam, so the agent loop's permission and
tool-dispatch logic can run under test without the network; the two delegated
agent loops collapsed into one; search ranking, MCP secret handling and the
install sanitiser moved out of IPC handlers. Test count 286 → 390.

## 0.9.0 — 2026-08-04

**A real browser for agent output — plus the hardening that shipped with it**

- **Built-in browser pane.** HTML files opened from the Files panel (or anything
  served from a session workspace) now render in a full browser context inside
  the right dock: a `webview` with an address bar, back/forward/reload/stop,
  and "open in system browser". Workspace pages are served loopback
  (`http://127.0.0.1/ws/<sessionId>/…`) with **no CSP**, so CDNs, webfonts,
  `fetch()`, and JS frameworks all work, and relative assets resolve. Each
  session is jailed to its own workspace; the pane uses an isolated storage
  partition; popups are pushed to the system browser. The old sandboxed
  artifact iframe (and its `live`/static toggle) is gone.
- **Fixed: artifact preview was a blank screen.** The app's renderer CSP had no
  `frame-src`, so `conduit-artifact://` frames were blocked by
  `default-src 'self'`. Added `frame-src 'self' conduit-artifact:`.
- **Hardened the artifact path jail.** UNC (`//…`) and Windows-drive (`/C:/…`)
  absolute paths are now refused before reaching the workspace resolver.
- **Dependency audit clean.** `npm audit fix` bumped 16 build-time deps
  (electron-builder/vite/undici trees); 0 vulnerabilities remain.
- **Agent guidance updated** (`GROK.md`): previews now run with full network,
  and a note to keep secrets out of HTML you intend anyone to open.
- **Tests** for the workspace-server path jail and URL mapping.

## 0.8.0 — 2026-07-29

**A right dock that stays put, resizes, and renders real artifacts — plus a shell the agent can
actually rely on**

- **The dock no longer opens itself.** Finishing a turn used to shove the Review panel in front of
  you, every turn, however many times you closed it; entering a team project re-opened the Board the
  same way. Panels now open only when you ask — the rail icon, the menu, or clicking a file. When a
  closed panel has something new, its rail icon shows a small dot instead.
- **Panels are resizable.** Drag the dock's left edge to set its width, and drag the divider between
  stacked panels to set their heights. Both persist, and double-clicking a handle resets it. Heights
  are stored as proportions, so resizing the window keeps the split you chose instead of letting one
  panel swallow the space. Four open panels no longer means four cramped, equal slices.
- **Preview is an artifact viewer.** A page the agent writes now renders as a real page: its
  stylesheet, scripts, images, and fonts load, and scripts run. Previously the preview inlined the
  HTML with no base URL, so every relative `href`/`src` silently failed and a multi-file site showed
  up unstyled and inert. Expanding the panel widens it to most of the window so there's room to
  actually look at it, and it reloads itself as the agent edits. Artifacts are served from a
  workspace-jailed origin under a strict CSP — they can read the workspace and nothing else, and
  cannot reach the network. A `live: on/off` toggle drops back to the old static render.
- **`bash` runs a real bash on every platform.** The tool was named `bash` but ran `cmd.exe` on
  Windows and zsh on macOS, so the POSIX syntax the model writes failed — or worse, quietly returned
  the wrong answer: `npx tsc --version 2>/dev/null || echo missing` reported a `tsc` that exists as
  missing. The agent would then retry variations and start writing throwaway scripts to work around
  a shell it didn't know it was in. It now finds Git Bash on Windows (never WSL's `bash.exe`, which
  sees a different filesystem) and prefers bash over zsh elsewhere, whose unmatched-glob behaviour
  aborts commands bash would run. Where no bash exists, the tool description and prompt say so
  outright instead of letting the model guess.
- **Commands stop stalling and misreporting.** Editors and credential prompts are neutralised, so
  `git commit` with no `-m` fails immediately instead of hanging for the full timeout. A failed
  command now carries a hint naming the actual cause — wrong shell dialect, a missing binary, a glob
  the shell refused — so the agent corrects that command instead of guessing at another approach.
  Commands no longer run in a login shell, which on macOS had `path_helper` reorder `PATH` and could
  resolve a different `node` than your own terminal; the rest of your login shell's environment
  (`JAVA_HOME`, `GOPATH`, …) is recovered at startup instead.

## 0.7.1 — 2026-07-26

**Fixed: the agent could freeze permanently on a shell command**

- **`bash` no longer hangs the session.** If a command left any process running behind it — a
  backgrounded dev server, a watcher, anything that outlives the shell — that process kept the
  shell's output pipe open, so the tool never saw the command finish. The turn froze with no error,
  no timeout, and nothing in the log; the only way out was to cancel or restart. The tool now
  detects the command's exit directly instead of waiting on the pipe.
- **Timeouts and cancels now actually stop the command.** Commands run in their own process group,
  so stopping one takes its whole tree down (`npm` → `node` → bundler) instead of killing the shell
  and leaving orphans holding ports. A timed-out command says so explicitly and points at `monitor`
  for long-running processes.
- **Large output no longer balloons memory.** Output is capped as it streams, keeping the start and
  the end, rather than buffering an entire build log and truncating at the end.
- Same fixes apply to `monitor` and `diagnostics`, which shared the code path. `bash` now also runs
  your `$SHELL` when it's POSIX-compatible, instead of always `/bin/zsh`, and decodes output
  chunk-safely so multi-byte characters no longer garble.

## 0.7.0 — 2026-07-24

**Agent teams — run a team of role agents on a project**

- **Start a team project** from Home: pick a team and a folder and the orchestrator (CEO) runs the
  project. A prebuilt **App Dev Team** (CEO, Product Manager, Software Architect, Lead Developer,
  UI/UX Designer, QA Tester, Application Security Dev) ships ready to use; create/edit your own in
  **Settings → Teams**.
- **Task board + project brief.** The orchestrator manages a shared board (`team_task`) — create,
  assign, review, and close tasks — and a living **project brief** (`project_brief`, saved to
  `.conduit/PROJECT_BRIEF.md`) that every role reads. Both render live in **Board** and **Brief**
  panels in the right dock, and delegations show up as **labeled role voices** in the chat.
- **Enforced QA/AppSec gate.** A task can't be closed until every required reviewer role has recorded
  a passing review — enforced in code, so the model can't skip it. A failing review sends the task
  back for rework.
- **Two ways to work.** Advisor roles run read-only and return specs, designs, and pass/fail verdicts
  while the orchestrator writes the code — or, with **write-capable builders** (`delegate_build`,
  toggle in Settings → Teams), designated roles implement autonomously in **isolated git worktrees**
  and their diffs are merged back into the working tree for review. Builds are parallel-safe and
  rewindable; the merge is confirmed before it runs, and git commits always ask first in a team
  project.

## 0.6.2 — 2026-07-24

**Agent builder: suggested skills for the agent's stack**

- The AI agent builder now surfaces **optional, domain-relevant skills even when the agent needs no
  required skills.** Previously, describing a general coding agent (e.g. "a dev agent for Rust, Go,
  and Electron") correctly returned zero *required* skills — and so suggested nothing at all. Now the
  builder always proposes skills that fit the brief's languages/frameworks/domain as a separate
  **Suggested skills** list, each with its own **Install** button so you decide which (if any) to add.
- Required skills are unchanged (pre-selected if installed, bulk "find & install" for the rest);
  suggestions are opt-in per item and are added to the agent once installed.

## 0.6.1 — 2026-07-24

**Skill import & organization: categories and better GitHub handling**

- **Import more from a repo in one go.** The GitHub / folder importer now walks a few
  levels deep (case-insensitively) and installs *every* skill folder it finds — flat
  (`<name>/SKILL.md`), under a container (`skills/<name>/SKILL.md`), or grouped by
  category (`<category>/<name>/SKILL.md`) — instead of only the top two levels. Each
  skill's bundled files still come across in the single tarball download.
- **Automatic categories.** A grouping folder (e.g. `document-skills/`) becomes the
  skill's category, and a `category:` field in a SKILL.md's frontmatter takes
  precedence. Categories are normalized to a safe, single-line label.
- **Safer multi-skill imports.** Two folders that resolve to the same skill name no
  longer silently clobber each other — the first wins and the duplicate is reported.
- **Categorized Skills tab.** Skills are grouped under collapsible category headers with
  counts instead of one long list, with a filter box to search by name, description, or
  category, and an inline control to assign or change a skill's category. The
  system-prompt skills index the agent sees is grouped the same way.

**AI agent builder**

- **Describe an agent, get one.** The Agents tab has a new "Build an agent with AI" box:
  write what you want the agent to do and what it should be capable of, and the model
  drafts a ready-to-save persona — a name, role instructions, a suggested model and
  permission mode — prefilled into the agent form for you to tweak.
- **Skills planned for the role.** The builder inspects your installed skills and matches
  the ones that fit the agent's job. For capabilities you don't have a skill for yet, it
  proposes one from a curated skill catalog or, when nothing fits, a web search — shown as
  a "skills plan" you can review.
- **Find & install missing skills.** One click installs the planned skills: catalog entries
  install directly, and search items are located on GitHub via web search, then installed
  through the same validation and prompt-injection scanning as any other skill import. The
  freshly installed skills are auto-selected for the new agent.

## 0.6.0 — 2026-07-23

**LSP-powered edits: rename & quick-fix**

- New `lsp_edit` tool lets the agent apply changes the language server computes, not just read from it:
  - **`rename`** — rename the symbol at a position to a new name across *every* file that uses it, as one
    atomic edit that resolves imports and scoping (it will alias an import rather than break it). Far more
    precise than find/replace.
  - **`fix`** — list the quick-fixes the server offers for a diagnostic (add missing import, remove unused,
    …), then apply one by index.
- Every edit is jailed to the workspace (an edit reaching outside any file is refused entirely — no
  half-applied rename), routed through the checkpoint/rewind snapshot, and shown as a diff in the Review
  panel. Works with the same servers as `lsp` (TypeScript/JS, Python, Go, Rust, C/C++).
- Verified against a live `typescript-language-server`, including a cross-file rename and an
  edit-bearing quick-fix.

## 0.5.9 — 2026-07-23

**Fix: agent froze after you answered a question**

- When the model asked more than one `ask_user` question in a single turn (it can emit several
  tool calls at once), the chat only ever showed one question card at a time, so every card but
  the last was orphaned — its promise never resolved and the turn hung on "working…" forever.
  Questions are now serialized: each one is presented and answered before the next appears, so a
  multi-question turn always completes.
- Cancelling a run while a question is open now ends the turn cleanly instead of leaving it stuck
  waiting on a card you can no longer answer.

## 0.5.8 — 2026-07-19

**In-UI logo matches the app icon**

- The sidebar, Home, and chat-welcome brand mark still drew the old four-point spark while
  the app-bundle icon had been updated to the Monogram C. The in-UI mark is now the same C:
  an open arc with a cyan→periwinkle gradient and a glowing node at its top terminal.

## 0.5.7 — 2026-07-19

**Custom agents**

- **Define agent personas in Settings → Agents.** Each agent has a title, free-form
  instructions, a chosen subset of your installed skills, a model, and a permission mode.
- **Use them two ways.** Per session: pick an agent in the composer like you pick the
  model — its instructions are injected into the system prompt, only its skills are visible
  to it, and its model + permission mode take over (overriding the global mode). Delegated:
  the main agent can hand a scoped read-only investigation to one **by name** via
  `spawn_agent`, and the subagent runs with that agent's instructions, scoped skills (via a
  new read-only `read_skill` tool), and model.
- Agents are validated on every settings write (bounded fields, generated ids, deduped,
  capped) and the persona block is placed after the cached `HARNESS_CORE` prefix so
  prompt-caching is unaffected.

## 0.5.6 — 2026-07-19

**Language-server intelligence, versioned docs, and a dependency sweep**

- **`lsp` tool — a real language-server client.** Per-file diagnostics in milliseconds
  (no build), go-to-definition, find-references (resolves imports/scoping), hover, and
  symbols, for TypeScript/JS, Python, Go, Rust, and C/C++ when a server is installed. A
  server starts on demand per workspace, is reaped when idle, and is disposed on quit; a
  hand-rolled JSON-RPC/stdio client, dependency-free. Verified live against clangd and
  typescript-language-server.
- **`docs` tool — versioned official documentation** from devdocs.io (JavaScript, Python,
  Node, React, Go, Rust, …), so Grok checks an exact API/signature instead of guessing.
  Docset indexes cache to disk for a week (instant, stale-if-offline); an exact search hit
  returns the full page in one call. Model-supplied entry paths are sanitized.
- **Security:** language servers are now spawned with a **credential-scrubbed environment**
  (matching the shell tools), and a latent gap in the scrub regex is fixed — provider
  prefixes were anchored so `AWS_SECRET_ACCESS_KEY` was never actually stripped.
- **Dependencies (Dependabot):** react-markdown 9→10, the GitHub Actions bumps, and the
  dev-dependencies group (eslint 10, `@types/node` 26, eslint-plugin-react-hooks 7,
  vitest 4). The react-hooks 7 findings were resolved: a genuine
  write-ref-during-render fix in `App.tsx`, and the aggressive `set-state-in-effect` rule
  scoped out for legitimate async/imperative effects.

## 0.5.5 — 2026-07-16

**Memory writes stop failing silently**

- **Fixed: the background review could silently learn nothing.** It asked for JSON in
  prose and the reply was parsed by reading the outermost braces — prose, code fences, or
  a truncated object all yielded zero memory ops and no digest, with nothing logged, and
  the call site swallowed exceptions too. The reply is now pinned to a JSON schema via the
  Responses API's structured outputs, and anything the parser still rejects is logged
  instead of quietly becoming "nothing worth remembering". The digest also powers
  `session_search`, so this was degrading recall as well.
- Release pipeline: the matrix jobs could each create their own draft release for the
  same tag and scatter assets across the duplicates — v0.5.4 shipped without its Linux
  artifacts (repaired in place) and v0.4.4 without its Windows installer. The draft is now
  created once up front, and publishing fails if any platform's installer or update
  manifest is missing rather than shipping a partial release.

## 0.5.4 — 2026-07-16

**Grok 4.5 tuning, MCP in packaged builds, and history recall**

- **Fixed: MCP servers never started in installed builds** (`spawn npx ENOENT`). GUI-launched
  apps inherit a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), not your shell's, so
  `npx` was invisible — it only worked in dev, which inherits the terminal. The login
  shell's PATH is now resolved at startup, before MCP connects. (The bash tool was never
  affected: it goes through `zsh -lc`.)
- **`prompt_cache_key` per session**: pins a conversation to one cache server so the shared
  system-prompt prefix bills cached ($0.50/M) instead of full ($2.00/M). The prompt was
  already built cache-friendly; without this key it often landed cache-cold anyway.
- **`recall_history(query)`**: searches the current session's full transcript — including
  turns compacted out of context — over message text *and* tool output. Compaction never
  deleted anything (it only trims the model's working context); this is the read path back.
  Complements `session_search`, which covers other sessions.
- **Compact below the long-context threshold**: every xAI model doubles input pricing past
  200K tokens. Both profiles now compact at 180K (90% of it) instead of 375K/750K, keeping
  long sessions on the cheap tier. Compaction runs more often; `recall_history` covers what
  it drops.
- **Compaction now runs at `low` reasoning effort**, like the review and title passes.
  grok-4.5 defaults to `high` and cannot disable reasoning, so the pass meant to cheaply
  distill the transcript was reasoning hard over all of it.
- **`maxOutputTokens` 16,384 → 65,536** for Grok 4.5. xAI enforces no ceiling (the API
  accepts values past the context window), and reasoning tokens are billed as output and
  count against this cap — at 16K a high-effort turn could spend the budget thinking and
  truncate mid-answer.
- Model menu: **"Grok Build" → "Grok 4.5"**, which is what it has been running
  (`grok-build-latest` is an alias for `grok-4.5`). Saved sessions are unaffected.

## 0.5.3 — 2026-07-16

**Auth banner fix + security updates**

- **Fixed: permanent "Your session is not valid. Please sign in again." banner** after a
  successful OAuth sign-in. The health probe called `/v1/api-key`, which authenticates xAI
  API keys only and rejects a valid subscription OAuth bearer with 401. It now probes
  `/v1/models`, which accepts both credential types.
- **Fixed: stale offline status** — the probe ran before sign-in and never re-ran after it,
  so a pre-login failure could linger for up to two minutes (and a healthy status could
  outlive a logout). Probing is now scoped to the signed-in credential.
- **Fixed: MCP catalog gave no feedback** — every entry showed "Install" even when already
  installed, and successes and failures were both silent. Entries now show
  Install / Installing… / Installed, and report errors.
- **Electron 33 → 43**: Electron 33 is end-of-life and no longer receives security
  backports. Clears 18 advisories, incl. ASAR integrity bypass (GHSA-vmqv-hx8q-j7mg).
- **electron-builder 25 → 26**: clears 7 `tar` advisories in the build toolchain
  (`tar@6` had no patched release; fixes landed in 7.5.16+).
- `npm audit` now reports 0 vulnerabilities, down from 10 high.

## 0.5.2 — 2026-07-10

**Full Conduit branding + repo rename**

- GitHub repository renamed **`hypnos1450/Grok-App` → `hypnos1450/Conduit`**
- electron-builder publish target and git remote updated to the new repo
- Auto-update feed now points at Conduit releases

## 0.5.1 — 2026-07-10

**Rename to Conduit**

- Product name, window title, installers, and UI branding are now **Conduit**
- Bundle id `com.conduit.app`; npm package name `conduit`

## 0.5.0 — 2026-07-10

**Major product + agent upgrade**

- **Plan-only mode** (session toggle + permission mode): read/plan tools only; no writes/shell/MCP
- **Agent profiles**: careful / balanced / yolo map to permission defaults
- **Test-after-edit**: post-write verification hints + optional test command
- **Multi-model routing**: lighter model for titles, compaction, background review
- **Repo map**: frozen top-level tree injected into the system prompt
- **Workspace trust**: first-open gate before agent tools (banner + Settings → Security)
- **Security center**: audit log, allowlist clear, trusted workspaces
- **Command palette** (⇧⌘O) and **session search** (⇧⌘F) across titles/digests/messages
- **Review dock panel**: files changed this turn + plan checklist
- **GitHub PR** via `gh` CLI (composer chip + menu)
- **MCP catalog** one-click installs (still confirm)
- **Update channel** stable/beta; offline/auth status banner; diagnostics export
- **Reduced motion** setting; richer Home/Sidebar search entry points

## 0.4.8 — 2026-07-10

**Security hardening**

- Workspace path jail for agent file tools + panel browser (`realpath`, reject `..` / absolute escapes)
- Schema-validated `settings:set`; MCP command changes require a native confirm dialog
- Session cwd must be an existing directory; session/job IDs sanitized before path joins
- Terminal IPC session-bound with command/stdin caps (no free-form path)
- Path-scoped write allowlists; bash allowlist only for simple (non-compound) commands
- `fetch_page` re-validates DNS + every redirect hop against private IPs
- Credentials fail closed without OS secure storage; MCP env secrets in `secrets.bin`
- Permission responses bound to session + single-use request ids; updater IPC uses sender checks
- Strip credential-like env vars from agent bash; filtered env for MCP servers
- Tighter CSP (`object-src`, `base-uri`, `form-action`, `frame-ancestors`)

## 0.4.7 — 2026-07-10

**macOS quarantine after update**

- Clear `com.apple.quarantine` on launch (unsigned/ad-hoc builds)
- Custom Mac install path: unzip update, strip quarantine, swap `.app`, relaunch — so you should not need `xattr -cr` after auto-update
- Real long-term fix remains Developer ID signing + notarization (`CSC_LINK` + Apple secrets; see `build/README.md`)

## 0.4.6 — 2026-07-10

**Mac “Restart to update” fix**

- Force-quit path for `quitAndInstall` on macOS (destroy windows, `isForceRunAfter`, fall back to `app.exit`)
- Only show **Restart to update** after the package is fully downloaded; show a downloading state before that
- Quit the app when the last window closes during an update install (macOS normally stays alive)

## 0.4.5 — 2026-07-10

**Windows release runner pin**

- Pin release matrix to `windows-2022` — `windows-latest` now has VS 18, which the node-gyp bundled with electron-builder cannot detect, so `node-pty` rebuild still failed after 0.4.4

## 0.4.4 — 2026-07-10

**Release CI fix for node-pty**

- Bump GitHub Actions to Node 22 (matches `@electron/rebuild` / `node-abi` engines)
- Install Python 3.12 + setuptools so node-gyp has `distutils` on macOS/Linux
- Set up MSVC build tools on Windows (`ilammy/msvc-dev-cmd`) so `node-pty` rebuilds during `npm ci`
- Unblocks multi-platform release builds that failed on macOS and Windows in 0.4.3

## 0.4.3 — 2026-07-09

**Terminal overhaul**

- Real terminal panel with xterm.js (colors, selection, search, clickable links)
- Interactive PTY via node-pty when available, with enhanced multi-job spawn fallback
- Multiple concurrent job tabs per session (create/close, process-tree kill, restart last command)
- Sticky cwd, command history, scrollback persistence, open-in-system-terminal
- Pin agent `bash` tool cards into the Terminal panel; send terminal selection to chat
- Exit notifications when a job finishes while the app is unfocused

**MCP install-from-link**

- Paste a GitHub URL, owner/repo, or npm package in Settings → MCP to install a server
- Detects start command (package.json, mcp.json, smithery, known recipes) and required API keys
- Secrets form before install; per-server env editor afterward
- Manual add kept under a collapsible section

**Context usage meter**

- Header pill now shows live context fill vs model window (e.g. `27% · 135k / 500k`)
- Lifetime session totals moved to the tooltip so long sessions no longer look like a multi‑million-token window

## 0.4.2 — 2026-07-09

**Home dashboard**

- New Home page shown at launch and whenever no session is open: time-of-day
  welcome message, usage statistics (sessions, messages, tokens used, sessions
  this week), recent projects grouped by working folder, and recent sessions
- **New project** action opens the native folder picker and starts a session
  there; **Quick session** starts one in your home folder
- Click a recent project to start a new session in that folder; click a recent
  session to jump back into it
- Return to Home anytime via the Conduit brand in the sidebar or the home
  icon in the collapsed rail
- The in-session welcome is now a compact starter-pill row instead of the large
  card grid, keeping the focus on the composer
- Removed the old unstyled "Start a session" screen entirely

## 0.4.1 — 2026-07-09

**Welcome page redesign + SVG icon set**

- Reworked the empty-session welcome: greeting hero with glowing logo tile and
  accent halo, model/branch/folder context chips, starter cards with
  descriptions and hover arrows, keyboard-hint footer
- New shared SVG icon set replaces the small unicode glyph icons throughout the
  app (settings gear, search, sidebar collapse, new session, close, edit, fork,
  restore, regenerate, send/stop/queue, expand/shrink, warning)
- Larger icon-button hit areas across the sidebar, dock rail, and panel headers
- Accessibility: restored accessible names on icon-only buttons, bumped
  low-contrast welcome text to meet WCAG AA, reduced-motion setting now also
  neutralizes staggered animation delays
- Fixed attachment-remove icon centering and welcome-chip text truncation

## 0.4.0 — 2026-07-08

**UI polish batch + app icon**

- App icon (spark mark) on all platforms, plus Intel macOS builds alongside
  Apple Silicon
- Native system notifications when a task finishes or needs approval while the
  app is in the background — click to jump to the session
- Slash commands: built-in `/init` writes a GROK.md project guide; drop your
  own `*.md` prompts in the commands folder to add custom ones
- Drag & drop files and images anywhere in the chat to attach them
- Sidebar run awareness: colored dots show which sessions are running, blocked
  on approval, or finished unseen; sessions grouped by date; collapsible
  sidebar (⌘\)
- Welcome screen with starter prompts for empty sessions
- macOS vibrancy window chrome, refined tool cards with status colors, custom
  scrollbars, richer markdown (tables, blockquotes), circular send button,
  permission prompt card, light-theme parity pass
- Fixed a GPU crash when previewing certain HTML files: preview scripts are now
  opt-in per file, and the app auto-recovers if the renderer dies

## 0.3.0 — 2026-07-08

**Deeper Grok 4.5 support + agent tools**

- Reasoning-effort control for Grok 4.5 (low / medium / high) from the composer
- New `fetch_page` tool: the agent can read web pages (size-capped, private
  hosts blocked)
- Live plan: the agent maintains a step-by-step plan visible in the Tasks panel
  as it works
- Automatic retry with backoff on transient API errors mid-run
- Docs updated around Grok 4.5
- Fixed the release pipeline race that left macOS assets off multi-platform
  releases

## 0.2.0 — 2026-07-08

**Grok 4.5, right dock, and skill installs**

- Grok Build now runs Grok 4.5 on the wire, with served-model verification (the
  API's echoed model is logged and shown, so you can confirm what answered)
- Right-side dock, Claude Desktop style: artifact Preview, project Files tree,
  Tasks list, and a Terminal — collapsible rail, multi-panel stacking
- Install skills from a GitHub repo or a local folder, including bundled
  scripts and reference files
- Settings reorganized into tabs (General / Agent / Memory / Skills / MCP /
  About)

## 0.1.0 — 2026-07-08

**Initial release**

- Desktop agent harness for xAI Grok with xAI subscription OAuth sign-in
- Streaming agent loop with bash, file-edit, and search tools, parallel
  subagents, and permission prompts with allowlist learning
- Sessions with checkpoints and file rewind, edit-and-resend, forking,
  steering messages mid-run, export, and search
- Self-evolving memory: agent notes, user profile, and per-project memory with
  approval-gated writes; agent-authored skills
- MCP server support, git awareness, token/cost usage meter, diff previews,
  syntax highlighting, keyboard shortcuts and native menus
- Auto-updater and a multi-platform CI release pipeline (macOS, Windows, Linux)
