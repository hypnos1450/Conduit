// The IPC channel names, written once.
//
// Both sides used to spell every channel out as its own string literal — main
// in `handle(...)`, preload in `ipcRenderer.invoke(...)` — so a typo in either
// was a runtime "no handler registered" rather than a build failure. Importing
// the name from here makes the two agree by construction.

/** Request/response channels: renderer invokes, main handles. */
export const CHANNELS = [
  // app
  'app:version',
  'revealLogs',
  'pickFolder',
  'openExternal',
  // auth
  'auth:getState',
  'auth:loginOAuth',
  'auth:setApiKey',
  'auth:logout',
  'auth:probe',
  // sessions
  'sessions:list',
  'sessions:create',
  'sessions:load',
  'sessions:restoreCheckpoint',
  'sessions:delete',
  'sessions:rename',
  'sessions:setModel',
  'sessions:createTeam',
  'sessions:setAgent',
  'sessions:setEffort',
  'sessions:fork',
  'sessions:export',
  'sessions:gitStatus',
  'sessions:search',
  'sessions:setPlanOnly',
  'sessions:turnChanges',
  // agent
  'agent:send',
  'agent:cancel',
  'agent:isRunning',
  'agent:queue',
  'agent:retry',
  'agent:editResend',
  'agent:respondPermission',
  'agent:respondQuestion',
  // memory
  'memory:entries',
  'memory:removeEntry',
  'memory:pending',
  'memory:resolvePending',
  // skills
  'skills:list',
  'skills:get',
  'skills:remove',
  'skills:pending',
  'skills:resolvePending',
  'skills:installGithub',
  'skills:reveal',
  'skills:setCategory',
  'skills:importFolder',
  // files
  'files:suggest',
  // commands
  'commands:list',
  'commands:resolve',
  'commands:openFolder',
  // panels
  'panels:listDir',
  'panels:readFile',
  // browser
  'browser:workspaceUrl',
  'browser:openExternal',
  // term
  'term:open',
  'term:run',
  'term:createJob',
  'term:write',
  'term:resize',
  'term:kill',
  'term:closeJob',
  'term:setActiveJob',
  'term:clear',
  'term:restart',
  'term:snapshot',
  'term:history',
  'term:openExternal',
  'term:pin',
  // mcp
  'mcp:status',
  'mcp:reconnect',
  'mcp:previewInstall',
  'mcp:install',
  // settings
  'settings:get',
  'settings:set',
  // workspace
  'workspace:getTrust',
  'workspace:setTrust',
  'workspace:listTrusted',
  // audit
  'audit:list',
  'audit:clear',
  'audit:export',
  // palette
  'palette:list',
  // github
  'github:repo',
  'github:createPr',
  'github:openPr',
  // crash
  'crash:list',
  'crash:reveal',
  'crash:copyDiagnostics',
  // mcpCatalog
  'mcpCatalog:list',
  // skillCatalog
  'skillCatalog:list',
  // agents
  'agents:build',
  'agents:resolveSkills',
  'teams:build',
  // status
  'status:get',
  'status:probe',
  // update
  'update:check',
  'update:install',
  'update:getChannel',
  'update:setChannel',
] as const

export type Channel = (typeof CHANNELS)[number]

/** Push channels: main sends, renderer subscribes. */
export const EVENT_CHANNELS = [
  'agent:event',
  'term:data',
  'menu:action',
  'update:available',
  'update:downloaded',
] as const

export type EventChannel = (typeof EVENT_CHANNELS)[number]
/**
 * The app-command vocabulary — one list for the menu bar, the command palette
 * and the tray, which all trigger the same things.
 *
 * These used to travel as bare strings on `menu:action` while the palette
 * declared its own ids separately, so the two could drift with nothing to
 * notice. Both sides now speak this union.
 */
export const APP_ACTIONS = [
  'home',
  'new-session',
  'switch-session',
  'search-sessions',
  'settings',
  'command-palette',
  'focus-input',
  'export-session',
  'create-pr',
  'toggle-plan-only',
  'stop-agent',
  'open-terminal',
  'open-review',
  'check-update',
  'reveal-logs',
  'copy-diagnostics'
] as const

export type AppAction = (typeof APP_ACTIONS)[number]

/** What travels on `menu:action`: an app command, or "focus this session". */
export type MenuMessage = AppAction | `focus-session:${string}`

/** Prefix for the "focus this session" menu message. */
export const FOCUS_SESSION = 'focus-session:'

/** Build a focus-session message. Pairs with {@link parseFocusSession}. */
export function focusSession(sessionId: string): MenuMessage {
  return `${FOCUS_SESSION}${sessionId}`
}

/** The session id in a focus message, or null if it isn't one. */
export function parseFocusSession(action: MenuMessage): string | null {
  return action.startsWith(FOCUS_SESSION) ? action.slice(FOCUS_SESSION.length) : null
}
