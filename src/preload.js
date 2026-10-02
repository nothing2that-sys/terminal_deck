const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('terminalApi', {
  getRuntimeInfo: () => ipcRenderer.invoke('app:runtime'),
  discoverProviders: () => ipcRenderer.invoke('provider:discover'),
  getGitContext: (cwd) => ipcRenderer.invoke('git:context', cwd),
  getDiagnostics: (cwd) => ipcRenderer.invoke('app:diagnostics', cwd),
  createSession: (options) => ipcRenderer.invoke('session:create', options),
  attachSession: (sessionId) => ipcRenderer.invoke('session:attach', sessionId),
  closeSession: (sessionId) => ipcRenderer.invoke('session:close', sessionId),
  terminateSession: (sessionId) => ipcRenderer.invoke('session:terminate', sessionId),
  write: (sessionId, data) => {
    ipcRenderer.send('session:input', { sessionId, data });
  },
  resize: (sessionId, cols, rows) => {
    ipcRenderer.send('session:resize', { sessionId, cols, rows });
  },
  updateCwd: (sessionId, cwd) => {
    ipcRenderer.send('session:cwd', { sessionId, cwd });
  },
  onOutput: (callback) => subscribe('session:output', callback),
  onExit: (callback) => subscribe('session:exit', callback),
  onSessionError: (callback) => subscribe('session:error', callback),
  chooseDirectory: () => ipcRenderer.invoke('directory:choose'),
  chooseShellExecutable: () => ipcRenderer.invoke('shell:choose'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read-text'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write-text', text),
  saveCommandBlock: (options) =>
    ipcRenderer.invoke('command-block:save', options),
  saveTextFile: (options) => ipcRenderer.invoke('text-file:save', options),
  listWorkspaces: () => ipcRenderer.invoke('workspace:list'),
  createWorkspace: (input) => ipcRenderer.invoke('workspace:create', input),
  cloneWorkspace: (sourceWorkspaceId, input) =>
    ipcRenderer.invoke('workspace:clone', sourceWorkspaceId, input),
  updateWorkspace: (workspaceId, input) =>
    ipcRenderer.invoke('workspace:update', workspaceId, input),
  deleteWorkspace: (workspaceId) =>
    ipcRenderer.invoke('workspace:delete', workspaceId),
  openWorkspace: (options) =>
    ipcRenderer.invoke('workspace:open', options),
  saveState: (request) => ipcRenderer.invoke('state:save', request),
  reportFinalStateUnavailable: (payload) =>
    ipcRenderer.invoke('lifecycle:final-not-ready', payload),
  onPrepareClose: (callback) => subscribe('lifecycle:prepare-close', callback),
  onCloseCancelled: (callback) => subscribe('lifecycle:close-cancelled', callback)
});
