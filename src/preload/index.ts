import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  Attachments,
  GitHubPrDraft,
  HarnessApi,
  ModelId,
  Settings,
  TermData,
  UpdateChannel,
  UpdateInfo
} from '@shared/types'
import type { Channel, EventChannel, MenuMessage } from '@shared/channels'

// Every bridge method goes through these two, so the channel name is checked
// against the shared list at build time rather than failing at runtime with
// "no handler registered".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const invoke = (channel: Channel, ...args: unknown[]): Promise<any> =>
  ipcRenderer.invoke(channel, ...args)

/** Subscribe to a push channel; returns the unsubscribe. */
function subscribe<T>(channel: EventChannel, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: HarnessApi = {
  auth: {
    getState: () => invoke('auth:getState'),
    loginOAuth: () => invoke('auth:loginOAuth'),
    setApiKey: (key: string) => invoke('auth:setApiKey', key),
    logout: () => invoke('auth:logout'),
    probe: () => invoke('auth:probe')
  },
  sessions: {
    list: () => invoke('sessions:list'),
    create: (opts) => invoke('sessions:create', opts),
    createTeam: (teamId, cwd) => invoke('sessions:createTeam', teamId, cwd),
    load: (id) => invoke('sessions:load', id),
    delete: (id) => invoke('sessions:delete', id),
    rename: (id, title) => invoke('sessions:rename', id, title),
    setModel: (id, model: ModelId) => invoke('sessions:setModel', id, model),
    setAgent: (id, agentId) => invoke('sessions:setAgent', id, agentId),
    setEffort: (id, effort) => invoke('sessions:setEffort', id, effort),
    restoreCheckpoint: (sessionId, itemId) =>
      invoke('sessions:restoreCheckpoint', sessionId, itemId),
    fork: (sessionId, itemId) => invoke('sessions:fork', sessionId, itemId),
    export: (sessionId) => invoke('sessions:export', sessionId),
    gitStatus: (sessionId) => invoke('sessions:gitStatus', sessionId),
    search: (query, limit) => invoke('sessions:search', query, limit),
    setPlanOnly: (id, planOnly) => invoke('sessions:setPlanOnly', id, planOnly),
    turnChanges: (sessionId) => invoke('sessions:turnChanges', sessionId)
  },
  agent: {
    send: (sessionId, text, attachments?: Attachments) =>
      invoke('agent:send', sessionId, text, attachments),
    cancel: (sessionId) => invoke('agent:cancel', sessionId),
    queue: (sessionId, text) => invoke('agent:queue', sessionId, text),
    retry: (sessionId) => invoke('agent:retry', sessionId),
    editResend: (sessionId, itemId, text) =>
      invoke('agent:editResend', sessionId, itemId, text),
    isRunning: (sessionId) => invoke('agent:isRunning', sessionId),
    respondPermission: (requestId, allow, alwaysAllow, globalAllow, sessionId) =>
      invoke(
        'agent:respondPermission',
        requestId,
        allow,
        alwaysAllow,
        globalAllow,
        sessionId
      ),
    respondQuestion: (requestId, answer, sessionId) =>
      invoke('agent:respondQuestion', requestId, answer, sessionId),
    onEvent: (cb: (ev: AgentEvent) => void) => subscribe('agent:event', cb)
  },
  memory: {
    entries: (cwd?: string) => invoke('memory:entries', cwd),
    removeEntry: (target, text, cwd?: string) =>
      invoke('memory:removeEntry', target, text, cwd),
    pending: () => invoke('memory:pending'),
    resolvePending: (id, approve) => invoke('memory:resolvePending', id, approve)
  },
  skills: {
    list: () => invoke('skills:list'),
    get: (name: string) => invoke('skills:get', name),
    remove: (name: string) => invoke('skills:remove', name),
    pending: () => invoke('skills:pending'),
    resolvePending: (id, approve) => invoke('skills:resolvePending', id, approve),
    installGithub: (url: string) => invoke('skills:installGithub', url),
    importFolder: () => invoke('skills:importFolder'),
    reveal: (name: string) => invoke('skills:reveal', name),
    setCategory: (name: string, category: string) =>
      invoke('skills:setCategory', name, category)
  },
  files: {
    suggest: (sessionId, query) => invoke('files:suggest', sessionId, query)
  },
  commands: {
    list: () => invoke('commands:list'),
    resolve: (name: string, args: string) => invoke('commands:resolve', name, args),
    openFolder: () => invoke('commands:openFolder')
  },
  panels: {
    listDir: (sessionId, rel) => invoke('panels:listDir', sessionId, rel),
    readFile: (sessionId, rel) => invoke('panels:readFile', sessionId, rel)
  },
  browser: {
    workspaceUrl: (sessionId, rel) => invoke('browser:workspaceUrl', sessionId, rel),
    openExternal: (url) => invoke('browser:openExternal', url)
  },
  term: {
    open: (sessionId) => invoke('term:open', sessionId),
    run: (sessionId, command, opts) => invoke('term:run', sessionId, command, opts),
    createJob: (sessionId, name) => invoke('term:createJob', sessionId, name),
    write: (sessionId, data, jobId) => invoke('term:write', sessionId, data, jobId),
    resize: (sessionId, cols, rows, jobId) =>
      invoke('term:resize', sessionId, cols, rows, jobId),
    kill: (sessionId, jobId) => invoke('term:kill', sessionId, jobId),
    closeJob: (sessionId, jobId) => invoke('term:closeJob', sessionId, jobId),
    setActiveJob: (sessionId, jobId) => invoke('term:setActiveJob', sessionId, jobId),
    clear: (sessionId, jobId) => invoke('term:clear', sessionId, jobId),
    restart: (sessionId, jobId) => invoke('term:restart', sessionId, jobId),
    snapshot: (sessionId) => invoke('term:snapshot', sessionId),
    openExternal: (sessionId) => invoke('term:openExternal', sessionId),
    history: (sessionId) => invoke('term:history', sessionId),
    pin: (sessionId, command, name) => invoke('term:pin', sessionId, command, name),
    onData: (cb: (data: TermData) => void) => subscribe('term:data', cb)
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: Partial<Settings>) => invoke('settings:set', patch)
  },
  mcp: {
    status: () => invoke('mcp:status'),
    reconnect: () => invoke('mcp:reconnect'),
    previewInstall: (input) => invoke('mcp:previewInstall', input),
    install: (input, opts) => invoke('mcp:install', input, opts)
  },
  update: {
    check: () => invoke('update:check'),
    install: () => invoke('update:install'),
    getChannel: () => invoke('update:getChannel'),
    setChannel: (channel: UpdateChannel) => invoke('update:setChannel', channel),
    onAvailable: (cb: (info: UpdateInfo) => void) => subscribe('update:available', cb),
    onDownloaded: (cb: (info: UpdateInfo) => void) => subscribe('update:downloaded', cb)
  },
  workspace: {
    getTrust: (cwd) => invoke('workspace:getTrust', cwd),
    setTrust: (cwd, level) => invoke('workspace:setTrust', cwd, level),
    listTrusted: () => invoke('workspace:listTrusted')
  },
  audit: {
    list: (limit) => invoke('audit:list', limit),
    clear: () => invoke('audit:clear'),
    export: () => invoke('audit:export')
  },
  palette: {
    list: () => invoke('palette:list')
  },
  github: {
    repo: (sessionId) => invoke('github:repo', sessionId),
    createPr: (sessionId, draft: GitHubPrDraft) =>
      invoke('github:createPr', sessionId, draft),
    openPr: (url) => invoke('github:openPr', url)
  },
  crash: {
    list: () => invoke('crash:list'),
    reveal: () => invoke('crash:reveal'),
    copyDiagnostics: () => invoke('crash:copyDiagnostics')
  },
  mcpCatalog: {
    list: () => invoke('mcpCatalog:list')
  },
  skillCatalog: {
    list: () => invoke('skillCatalog:list')
  },
  agents: {
    build: (prompt: string) => invoke('agents:build', prompt),
    resolveSkills: (items) => invoke('agents:resolveSkills', items)
  },
  status: {
    get: () => invoke('status:get'),
    probe: () => invoke('status:probe')
  },
  onMenuAction: (cb: (action: MenuMessage) => void) => subscribe('menu:action', cb),
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  platform: process.platform,
  getVersion: () => invoke('app:version'),
  revealLogs: () => invoke('revealLogs'),
  pickFolder: () => invoke('pickFolder'),
  openExternal: (url: string) => invoke('openExternal', url)
}

contextBridge.exposeInMainWorld('harness', api)
