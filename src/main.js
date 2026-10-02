const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  screen,
  shell,
  utilityProcess
} = require('electron');
const pty = require('node-pty');
const { resolvePowerShell } = require('./shell');
const {
  buildPowerShellArguments,
  createShellIntegrationNonce,
  shellIntegrationPath
} = require('./shell-integration');
const { normalizeTerminalSize } = require('./terminal-policy');
const { StateSaveQueue } = require('./state-save-queue');
const { WorkspaceSaveService } = require('./workspace-save-service');
const { ElevatedPtyBrokerClient } = require('./elevated-pty-client');
const {
  initializePtyLifecycle,
  markPtyExited,
  requestPtyClose,
  shouldRemoveAfterPtyExit
} = require('./pty-lifecycle');
const { terminatePtyTree } = require('./pty-tree');
const { buildPtyEnvironment } = require('./pty-environment');
const {
  loadWindowPlacement,
  resolveWindowPlacement,
  saveWindowPlacement
} = require('./window-placement');
const {
  getShortcutCommand,
  getSquirrelEvent
} = require('./squirrel-shortcuts');
const {
  acquireWorkspaceLock,
  cloneWorkspace,
  createWorkspace,
  deleteWorkspace,
  initializeWorkspaceStore,
  listWorkspaces,
  loadEphemeralWorkspace,
  loadWorkspace,
  releaseWorkspaceLock,
  updateWorkspace
} = require('./workspace-store');
const {
  APP_USER_MODEL_ID,
  shortcutDetails,
  startMenuShortcutPath
} = require('./windows-integration');
const {
  detectProcessElevation,
  launchWithElevation
} = require('./windows-elevation');
const { discoverProvider, queryGitContext } = require('./runtime-inspection');

const MAX_PENDING_OUTPUT = 1024 * 1024;
const DEFAULT_WINDOW_SIZE = { width: 1100, height: 720 };
const MINIMUM_WINDOW_SIZE = { width: 640, height: 420 };
const FINAL_STATE_TIMEOUT_MS = 5_000;
const sessions = new Map();
const closedSessionResults = new Map();

let mainWindow = null;
let sessionSequence = 0;
let lastStartDirectory = process.cwd();
let stateDirectory = null;
let activeWorkspaceId = null;
let activeWorkspaceIsEphemeral = false;
let activeWorkspaceLock = null;
let activeSharedSnapshot = null;
let windowPlacementSaveTimer = null;
let processElevation = 'unknown';
let startupWorkspaceId = null;
let activeWorkspaceElevation = 'standard';
let elevatedBrokerClient = null;
let activeSaveQueue = null;
let activeSaveEpoch = null;
let workspaceSaveService = null;
let closeInFlight = null;
let allowWindowClose = false;
let allowAppQuit = false;
let resourcesFinalized = false;
const pendingFinalSaves = new Map();

function appClosePreparing() {
  return Boolean(closeInFlight) || activeSaveQueue?.phase === 'closing';
}

function launchSquirrelCommand(command) {
  if (!command) {
    return;
  }

  try {
    const child = spawn(command.executablePath, command.args, {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    console.error(`바로가기 작업을 시작하지 못했습니다: ${error.message}`);
  }
}

async function handleSquirrelLifecycle() {
  const eventName = getSquirrelEvent();
  if (!eventName) {
    return false;
  }

  let createShortcuts = false;
  if (['--squirrel-install', '--squirrel-updated'].includes(eventName)) {
    await app.whenReady();
    const preferencePath = path.join(
      app.getPath('appData'),
      'multi-session-manager',
      'shortcut-preference.json'
    );
    let savedPreference = null;
    try {
      const value = JSON.parse(fs.readFileSync(preferencePath, 'utf8'));
      if (typeof value?.createShortcuts === 'boolean') {
        savedPreference = value.createShortcuts;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`바로가기 설정을 읽지 못했습니다: ${error.message}`);
      }
    }

    const shouldAsk =
      eventName === '--squirrel-install' || savedPreference === null;
    if (shouldAsk) {
      const result = await dialog.showMessageBox({
        type: 'question',
        title: 'Terminal Deck 설치',
        message: '바탕화면과 시작 메뉴에 바로가기를 만들까요?',
        detail: '예를 선택하면 두 위치에 바로가기가 생성됩니다.',
        buttons: ['예', '아니오'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      });
      createShortcuts = result.response === 0;
      try {
        fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
        fs.writeFileSync(
          preferencePath,
          `${JSON.stringify({ createShortcuts }, null, 2)}\n`,
          'utf8'
        );
      } catch (error) {
        console.warn(`바로가기 설정을 저장하지 못했습니다: ${error.message}`);
      }
    } else {
      createShortcuts = savedPreference;
    }
  }

  launchSquirrelCommand(
    getShortcutCommand(eventName, process.execPath, createShortcuts)
  );
  setTimeout(() => app.quit(), 1000);
  return true;
}

function isMainWindowSender(event) {
  return Boolean(
    mainWindow
      && !mainWindow.isDestroyed()
      && event.sender === mainWindow.webContents
  );
}

function isExistingDirectory(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function chooseStartDirectory(requestedDirectory) {
  if (isExistingDirectory(requestedDirectory)) {
    return path.resolve(requestedDirectory);
  }

  if (isExistingDirectory(lastStartDirectory)) {
    return path.resolve(lastStartDirectory);
  }

  const homeDirectory = app.getPath('home');
  if (isExistingDirectory(homeDirectory)) {
    return homeDirectory;
  }

  return process.cwd();
}

function appendPendingOutput(session, data) {
  session.pendingOutput += data;
  if (session.pendingOutput.length > MAX_PENDING_OUTPUT) {
    session.pendingOutput = session.pendingOutput.slice(-MAX_PENDING_OUTPUT);
  }
}

function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function saveUtf8Text(options) {
  const safeName =
    typeof options.defaultName === 'string'
      ? options.defaultName.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_')
      : 'terminal-output.txt';
  const result = await dialog.showSaveDialog(mainWindow, {
    title:
      typeof options.title === 'string'
        ? options.title.slice(0, 120)
        : '텍스트 저장',
    defaultPath: safeName || 'terminal-output.txt',
    filters: [{ name: '텍스트 파일', extensions: ['txt'] }]
  });

  if (result.canceled || !result.filePath) {
    return { saved: false, canceled: true };
  }

  await fs.promises.writeFile(result.filePath, options.text, 'utf8');
  return { saved: true, filePath: result.filePath };
}

function getElevatedBrokerClient() {
  elevatedBrokerClient ||= new ElevatedPtyBrokerClient({
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    cwd: process.cwd()
  });
  return elevatedBrokerClient;
}

async function createSession(options = {}) {
  const useElevatedBroker = options.elevated === true
    || activeWorkspaceElevation === 'administrator';
  const shell = resolvePowerShell({
    preferredKind: options.shellKind,
    explicitPath: useElevatedBroker ? undefined : options.shellPath
  });
  const cwd = chooseStartDirectory(options.cwd);
  const initialCwd = typeof options.initialCwd === 'string' && options.initialCwd
    ? path.resolve(options.initialCwd)
    : cwd;
  const id = randomUUID();
  const shellIntegrationNonce = createShellIntegrationNonce();
  const sequence = ++sessionSequence;
  const session = {
    id,
    name:
      typeof options.name === 'string' && options.name.trim()
        ? options.name.trim().slice(0, 120)
        : `PowerShell ${sequence}`,
    cwd,
    initialCwd,
    shell,
    shellIntegrationNonce,
    pty: null,
    attached: false,
    pendingOutput: ''
  };

  let terminalProcess;
  try {
    const shellArguments = buildPowerShellArguments(
      shellIntegrationPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath
      })
    );
    const environment = buildPtyEnvironment({
      MULTI_SESSION_MANAGER_OSC_NONCE: shellIntegrationNonce
    });
    terminalProcess = useElevatedBroker
      ? await getElevatedBrokerClient().createPty({
          sessionId: id,
          shellKind: shell.kind,
          nonce: shellIntegrationNonce,
          cols: 120,
          rows: 30,
          cwd
        })
      : pty.spawn(shell.executable, shellArguments, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: environment
      });
  } catch (error) {
    const spawnError = new Error(
      `PowerShell PTY를 시작하지 못했습니다: ${error.message}`
    );
    spawnError.code = error.code || 'ERR_PTY_SPAWN';
    throw spawnError;
  }

  session.pty = terminalProcess;
  if (useElevatedBroker && terminalProcess.shellKind) {
    session.shell = {
      ...session.shell,
      kind: terminalProcess.shellKind,
      label: terminalProcess.shellLabel || session.shell.label
    };
  }
  initializePtyLifecycle(session);
  sessions.set(id, session);
  lastStartDirectory = cwd;

  terminalProcess.onData((data) => {
    const currentSession = sessions.get(id);
    if (!currentSession) {
      return;
    }

    if (!currentSession.attached) {
      appendPendingOutput(currentSession, data);
      return;
    }

    emitToRenderer('session:output', { sessionId: id, data });
  });

  terminalProcess.onExit(({ exitCode }) => {
    const currentSession = sessions.get(id);
    if (!currentSession || currentSession.pty !== terminalProcess) {
      return;
    }

    const closeRequested = currentSession.lifecycle === 'closing';
    const removeAfterExit = shouldRemoveAfterPtyExit(currentSession);
    markPtyExited(currentSession, { exitCode });
    const data =
      `\r\n\u001b[33m[PowerShell session exited with code ${exitCode}]\u001b[0m\r\n`;

    if (currentSession.attached) {
      emitToRenderer('session:output', { sessionId: id, data });
    } else {
      appendPendingOutput(currentSession, data);
    }

    emitToRenderer('session:exit', {
      sessionId: id,
      exitCode,
      closeRequested: removeAfterExit
    });
    if (removeAfterExit) {
      sessions.delete(id);
      rememberClosedSession(id, {
        ok: true,
        status: 'pty-exit-observed',
        exitCode
      });
    }
  });
  terminalProcess.onOperationError?.((error) => {
    emitToRenderer('session:error', {
      sessionId: id,
      code: error.code || 'ERR_ELEVATED_PTY_OPERATION',
      message: error.message
    });
  });

  return {
    id: session.id,
    name: session.name,
    cwd: session.cwd,
    initialCwd: session.initialCwd,
    shellKind: session.shell.kind,
    shellLabel: session.shell.label,
    elevated: useElevatedBroker || processElevation === 'administrator',
    shellIntegrationNonce: session.shellIntegrationNonce
  };
}

function rememberClosedSession(sessionId, result) {
  closedSessionResults.delete(sessionId);
  closedSessionResults.set(sessionId, result);
  while (closedSessionResults.size > 100) {
    closedSessionResults.delete(closedSessionResults.keys().next().value);
  }
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return closedSessionResults.get(sessionId) || {
      ok: false,
      status: 'not-found'
    };
  }

  session.retainAfterTermination = false;
  const result = await requestPtyClose(session, { terminate: terminatePtyTree });
  if (result.ok) {
    sessions.delete(sessionId);
    rememberClosedSession(sessionId, result);
  }
  return result;
}

async function terminateSessionProcess(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return { ok: false, status: 'not-found' };
  }

  session.retainAfterTermination = true;
  const result = await requestPtyClose(session, { terminate: terminatePtyTree });
  if (!result.ok && session.lifecycle === 'running') {
    session.retainAfterTermination = false;
  }
  return result;
}

async function closeAllSessions() {
  return Promise.all(
    [...sessions.keys()].map((sessionId) => closeSession(sessionId))
  );
}

async function persistActiveState(state, { revision } = {}) {
  if (
    !stateDirectory
    || (activeWorkspaceId === null && !activeWorkspaceIsEphemeral)
  ) {
    const error = new Error('저장할 활성 작업 공간이 없습니다.');
    error.code = 'ERR_NO_ACTIVE_WORKSPACE';
    throw error;
  }
  const saveSettings =
    JSON.stringify(state?.settings) !==
    JSON.stringify(activeSharedSnapshot?.settings);
  const saveFavorites =
    JSON.stringify(state?.favorites) !==
    JSON.stringify(activeSharedSnapshot?.favorites);
  workspaceSaveService ||= new WorkspaceSaveService(utilityProcess.fork);
  const operationId = `${activeSaveEpoch}-${revision}`;
  const saved = await workspaceSaveService.save({
    baseDirectory: stateDirectory,
    workspaceId: activeWorkspaceId,
    state,
    options: {
      saveSettings,
      saveFavorites,
      previousShared: activeSharedSnapshot,
      operationId
    }
  });
  try {
    await workspaceSaveService.acknowledge({
      baseDirectory: stateDirectory,
      operationId
    });
  } catch (error) {
    console.warn(`상태 저장 receipt를 정리하지 못했습니다: ${error.message}`);
  }
  activeSharedSnapshot = {
    settings: saved.settings,
    favorites: saved.favorites
  };
}

function beginActiveSaveQueue() {
  activeSaveEpoch = randomUUID();
  activeSaveQueue = new StateSaveQueue(
    async (state, metadata) => persistActiveState(state, metadata),
    { epoch: activeSaveEpoch }
  );
  return activeSaveEpoch;
}

function registerIpcHandlers() {
  ipcMain.handle('lifecycle:final-not-ready', (event, payload = {}) => {
    if (!isMainWindowSender(event) || typeof payload.requestId !== 'string') {
      return false;
    }
    const error = new Error(
      payload.reason === 'restoring'
        ? '작업 공간 복원이 끝나지 않아 최종 상태를 만들 수 없습니다.'
        : 'renderer가 최종 상태를 만들 수 없습니다.'
    );
    error.code = 'ERR_FINAL_STATE_NOT_READY';
    pendingFinalSaves.get(payload.requestId)?.reject(error);
    return true;
  });
  ipcMain.handle('app:runtime', (event) => {
    if (!isMainWindowSender(event)) {
      return null;
    }
    return {
      elevated: processElevation === 'administrator',
      elevation: processElevation,
      startupWorkspaceId
    };
  });
  ipcMain.handle('provider:discover', async (event) => {
    if (!isMainWindowSender(event)) return null;
    return Promise.all(['claude', 'codex'].map(discoverProvider));
  });
  ipcMain.handle('git:context', async (event, cwd) => {
    if (!isMainWindowSender(event)) return null;
    return queryGitContext(cwd);
  });
  ipcMain.handle('app:diagnostics', async (event, cwd) => {
    if (!isMainWindowSender(event)) return null;
    return {
      generatedAt: new Date().toISOString(),
      elevation: processElevation,
      workspace: activeWorkspaceId || (activeWorkspaceIsEphemeral ? 'ephemeral' : null),
      sessionCount: sessions.size,
      providers: await Promise.all(['claude', 'codex'].map(discoverProvider)),
      git: await queryGitContext(cwd)
    };
  });
  ipcMain.handle('session:create', (event, options = {}) => {
    if (!isMainWindowSender(event) || appClosePreparing()) {
      return null;
    }

    return createSession(options);
  });

  ipcMain.handle('session:attach', (event, sessionId) => {
    if (!isMainWindowSender(event)) {
      return '';
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return '';
    }

    session.attached = true;
    const pendingOutput = session.pendingOutput;
    session.pendingOutput = '';
    return pendingOutput;
  });

  ipcMain.on('session:input', (event, { sessionId, data } = {}) => {
    const session = sessions.get(sessionId);
    if (
      isMainWindowSender(event)
      && !appClosePreparing()
      && session?.pty
      && typeof data === 'string'
    ) {
      session.pty.write(data);
    }
  });

  ipcMain.on('session:resize', (event, { sessionId, cols, rows } = {}) => {
    if (!isMainWindowSender(event) || appClosePreparing()) {
      return;
    }

    const session = sessions.get(sessionId);
    const size = normalizeTerminalSize({ cols, rows });
    if (session?.pty && size) {
      session.pty.resize(size.cols, size.rows);
    }
  });

  ipcMain.on('session:cwd', (event, { sessionId, cwd } = {}) => {
    if (
      !isMainWindowSender(event)
      || appClosePreparing()
      || !isExistingDirectory(cwd)
    ) {
      return;
    }

    const session = sessions.get(sessionId);
    if (session) {
      session.cwd = path.resolve(cwd);
      lastStartDirectory = session.cwd;
    }
  });

  ipcMain.handle('session:close', (event, sessionId) => {
    if (!isMainWindowSender(event)) {
      return false;
    }
    if (appClosePreparing()) {
      return { ok: false, status: 'app-closing' };
    }

    return closeSession(sessionId);
  });
  ipcMain.handle('session:terminate', (event, sessionId) => {
    if (!isMainWindowSender(event)) {
      return { ok: false, status: 'invalid-sender' };
    }
    if (appClosePreparing()) {
      return { ok: false, status: 'app-closing' };
    }
    return terminateSessionProcess(sessionId);
  });

  ipcMain.handle('directory:choose', async (event) => {
    if (!isMainWindowSender(event)) {
      return null;
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: '새 PowerShell 탭의 시작 폴더 선택',
      defaultPath: chooseStartDirectory(lastStartDirectory),
      properties: ['openDirectory', 'createDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('shell:choose', async (event) => {
    if (!isMainWindowSender(event)) {
      return null;
    }

    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'PowerShell 실행 파일 선택',
      properties: ['openFile'],
      filters: [{ name: 'PowerShell', extensions: ['exe'] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const selectedPath = result.filePaths[0];
    return /^(pwsh|powershell)\.exe$/iu.test(path.basename(selectedPath))
      ? selectedPath
      : null;
  });

  ipcMain.handle('clipboard:write-text', (event, text) => {
    if (!isMainWindowSender(event) || typeof text !== 'string') {
      return false;
    }

    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('clipboard:read-text', (event) => {
    if (!isMainWindowSender(event)) {
      return '';
    }

    return clipboard.readText();
  });

  ipcMain.handle('command-block:save', async (event, options = {}) => {
    if (
      !isMainWindowSender(event)
      || typeof options.text !== 'string'
      || options.text.length > 10 * 1024 * 1024
    ) {
      return { saved: false };
    }

    return saveUtf8Text({
      ...options,
      title: '명령 블록 저장'
    });
  });

  ipcMain.handle('text-file:save', async (event, options = {}) => {
    if (
      !isMainWindowSender(event)
      || typeof options.text !== 'string'
      || options.text.length > 50 * 1024 * 1024
    ) {
      return { saved: false };
    }

    return saveUtf8Text(options);
  });

  ipcMain.handle('workspace:list', (event) => {
    if (!isMainWindowSender(event) || !stateDirectory) {
      return [];
    }
    return listWorkspaces(stateDirectory);
  });

  ipcMain.handle('workspace:create', (event, input = {}) => {
    if (!isMainWindowSender(event) || !stateDirectory) {
      return null;
    }
    return createWorkspace(stateDirectory, input);
  });

  ipcMain.handle('workspace:clone', (event, sourceWorkspaceId, input = {}) => {
    if (
      !isMainWindowSender(event)
      || !stateDirectory
      || typeof sourceWorkspaceId !== 'string'
    ) {
      return null;
    }
    return cloneWorkspace(stateDirectory, sourceWorkspaceId, input);
  });

  ipcMain.handle('workspace:update', (event, workspaceId, input = {}) => {
    if (
      !isMainWindowSender(event)
      || !stateDirectory
      || typeof workspaceId !== 'string'
    ) {
      return null;
    }
    return updateWorkspace(stateDirectory, workspaceId, input);
  });

  ipcMain.handle('workspace:delete', (event, workspaceId) => {
    if (
      !isMainWindowSender(event)
      || !stateDirectory
      || typeof workspaceId !== 'string'
    ) {
      return { deleted: false, reason: 'invalid' };
    }
    return deleteWorkspace(stateDirectory, workspaceId);
  });

  ipcMain.handle('workspace:open', async (event, options = {}) => {
    if (!isMainWindowSender(event) || !stateDirectory) {
      return { opened: false, reason: 'invalid' };
    }
    if (
      activeWorkspaceId !== null
      || activeWorkspaceIsEphemeral
      || activeWorkspaceLock
    ) {
      return { opened: false, reason: 'already-selected' };
    }

    if (options.ephemeral === true) {
      activeWorkspaceIsEphemeral = true;
      activeWorkspaceElevation = options.elevated === true
        ? 'administrator'
        : 'standard';
      const loaded = loadEphemeralWorkspace(stateDirectory);
      activeSharedSnapshot = {
        settings: loaded.state.settings,
        favorites: loaded.state.favorites
      };
      return {
        opened: true,
        saveEpoch: beginActiveSaveQueue(),
        ...loaded
      };
    }

    if (typeof options.workspaceId !== 'string') {
      return { opened: false, reason: 'invalid' };
    }

    const workspace = listWorkspaces(stateDirectory)
      .find((item) => item.id === options.workspaceId);
    if (!workspace) {
      return { opened: false, reason: 'missing' };
    }
    if (workspace.running) {
      return { opened: false, reason: 'running' };
    }
    const lock = acquireWorkspaceLock(
      stateDirectory,
      options.workspaceId
    );
    if (!lock) {
      return { opened: false, reason: 'running' };
    }

    let loaded;
    try {
      loaded = loadWorkspace(stateDirectory, options.workspaceId);
    } catch (error) {
      releaseWorkspaceLock(lock);
      return {
        opened: false,
        reason: 'load-failed',
        error: { code: error.code || 'ERR_WORKSPACE_LOAD', message: error.message }
      };
    }
    if (!loaded) {
      releaseWorkspaceLock(lock);
      return { opened: false, reason: 'missing' };
    }

    activeWorkspaceId = options.workspaceId;
    activeWorkspaceElevation = loaded.workspace.elevation;
    activeWorkspaceLock = lock;
    activeSharedSnapshot = {
      settings: loaded.state.settings,
      favorites: loaded.state.favorites
    };
    restoreWorkspaceWindowPlacement(activeWorkspaceId);
    return {
      opened: true,
      saveEpoch: beginActiveSaveQueue(),
      ...loaded
    };
  });

  ipcMain.handle('state:save', async (event, request = {}) => {
    if (
      !isMainWindowSender(event)
      || !activeSaveQueue
    ) {
      const error = new Error('상태 저장 요청을 받을 수 없습니다.');
      error.code = 'ERR_SAVE_UNAVAILABLE';
      throw error;
    }

    try {
      if (
        request.kind === 'final'
        && (
          typeof request.requestId !== 'string'
          || !pendingFinalSaves.has(request.requestId)
        )
      ) {
        const error = new Error('요청하지 않은 final state입니다.');
        error.code = 'ERR_FINAL_SAVE_NOT_REQUESTED';
        throw error;
      }
      const result = await activeSaveQueue.enqueue(request);
      if (request.kind === 'final' && typeof request.requestId === 'string') {
        pendingFinalSaves.get(request.requestId)?.resolve(result);
      }
      return {
        ...result,
        persistenceScope: activeWorkspaceIsEphemeral
          ? 'shared-only'
          : 'workspace'
      };
    } catch (error) {
      if (request.kind === 'final' && typeof request.requestId === 'string') {
        pendingFinalSaves.get(request.requestId)?.reject(error);
      }
      throw error;
    }
  });
}

function windowPlacementPath(workspaceId) {
  const fileName = `${encodeURIComponent(workspaceId)}.json`;
  return path.join(stateDirectory, 'window-placements', fileName);
}

function restoreWorkspaceWindowPlacement(workspaceId) {
  const workspacePlacementPath = windowPlacementPath(workspaceId);
  const savedPlacement = loadWindowPlacement(
    fs.existsSync(workspacePlacementPath)
      ? workspacePlacementPath
      : path.join(stateDirectory, 'window-placement.json')
  );
  const placement = resolveWindowPlacement(
    savedPlacement,
    screen.getAllDisplays().map((display) => display.workArea),
    MINIMUM_WINDOW_SIZE
  );
  if (!placement || !mainWindow || mainWindow.isDestroyed()) {
    return false;
  }

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  }
  mainWindow.setBounds(placement.bounds);
  if (placement.maximized) {
    mainWindow.maximize();
  }
  return true;
}

function saveActiveWorkspaceWindowPlacement() {
  if (
    !activeWorkspaceId
    || !mainWindow
    || mainWindow.isDestroyed()
  ) {
    return false;
  }

  try {
    saveWindowPlacement(windowPlacementPath(activeWorkspaceId), {
      bounds: mainWindow.getNormalBounds(),
      maximized: mainWindow.isMaximized()
    });
    return true;
  } catch (error) {
    console.warn(`창 배치를 저장하지 못했습니다: ${error.message}`);
    return false;
  }
}

function scheduleWindowPlacementSave() {
  clearTimeout(windowPlacementSaveTimer);
  windowPlacementSaveTimer = setTimeout(() => {
    windowPlacementSaveTimer = null;
    saveActiveWorkspaceWindowPlacement();
  }, 300);
}

function flushWindowPlacementSave() {
  clearTimeout(windowPlacementSaveTimer);
  windowPlacementSaveTimer = null;
  return saveActiveWorkspaceWindowPlacement();
}

function requestFinalSnapshot(reason) {
  if (!activeSaveQueue || !mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve(null);
  }
  const requestId = randomUUID();
  const closeState = activeSaveQueue.beginClose();
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timeout);
      pendingFinalSaves.delete(requestId);
      callback(value);
    };
    const timeout = setTimeout(() => {
      const error = new Error('최종 상태 저장 응답 시간이 초과됐습니다.');
      error.code = 'ERR_FINAL_SAVE_TIMEOUT';
      finish(reject, error);
    }, FINAL_STATE_TIMEOUT_MS);
    pendingFinalSaves.set(requestId, {
      resolve: (value) => finish(resolve, value),
      reject: (error) => finish(reject, error)
    });
    mainWindow.webContents.send('lifecycle:prepare-close', {
      requestId,
      reason,
      ...closeState
    });
  });
}

async function chooseSaveFailureAction(error) {
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '마지막 상태를 저장하지 못했습니다',
    message: '마지막 작업 상태의 저장 완료를 확인하지 못했습니다.',
    detail: error?.message || '알 수 없는 저장 오류입니다.',
    buttons: ['다시 시도', '저장 확인 없이 종료', '취소'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  });
  return ['retry', 'exit-without-save', 'cancel'][result.response] || 'cancel';
}

async function choosePtyCleanupAction(results) {
  const failures = results.filter((result) => !result.ok);
  if (failures.length === 0) {
    return 'complete';
  }
  const detail = failures
    .map((result) => result.status)
    .join(', ');
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '일부 terminal 종료를 확인하지 못했습니다',
    message: `${failures.length}개 PTY의 종료를 확인하지 못했습니다.`,
    detail: `${detail}\n확인은 PTY endpoint 기준이며 descendant 전체 종료 증명은 아닙니다.`,
    buttons: ['종료 다시 시도', '확인 없이 앱 종료'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  return response.response === 0 ? 'retry' : 'exit-anyway';
}

async function finalizeAppResources() {
  if (resourcesFinalized) {
    return true;
  }
  while (true) {
    const results = await closeAllSessions();
    const action = await choosePtyCleanupAction(results);
    if (action === 'retry') {
      continue;
    }
    break;
  }
  resourcesFinalized = true;
  await elevatedBrokerClient?.close();
  elevatedBrokerClient = null;
  await workspaceSaveService?.terminate();
  if (activeWorkspaceLock && !releaseWorkspaceLock(activeWorkspaceLock)) {
    console.error('종료 중 작업 공간 잠금을 해제하지 못했습니다.');
  }
  activeWorkspaceLock = null;
  return true;
}

async function runCloseSequence(reason) {
  while (activeSaveQueue) {
    try {
      const finalResult = await requestFinalSnapshot(reason);
      if (finalResult) {
        activeSaveQueue.seal(finalResult.committedRevision);
      }
      break;
    } catch (error) {
      if (error?.code === 'ERR_FINAL_SAVE_TIMEOUT') {
        await workspaceSaveService?.terminate();
      }
      const action = await chooseSaveFailureAction(error);
      if (action === 'retry') {
        activeSaveQueue.cancelClose();
        continue;
      }
      if (action === 'cancel') {
        activeSaveQueue.cancelClose();
        emitToRenderer('lifecycle:close-cancelled', {});
        return false;
      }
      break;
    }
  }

  await finalizeAppResources();
  allowWindowClose = true;
  allowAppQuit = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  } else {
    app.quit();
  }
  return true;
}

function requestAppClose(reason) {
  if (!closeInFlight) {
    closeInFlight = runCloseSequence(reason).finally(() => {
      if (!allowAppQuit) {
        closeInFlight = null;
      }
    });
  }
  return closeInFlight;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...DEFAULT_WINDOW_SIZE,
    minWidth: MINIMUM_WINDOW_SIZE.width,
    minHeight: MINIMUM_WINDOW_SIZE.height,
    backgroundColor: '#111418',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('move', scheduleWindowPlacementSave);
  mainWindow.on('resize', scheduleWindowPlacementSave);
  mainWindow.on('maximize', scheduleWindowPlacementSave);
  mainWindow.on('unmaximize', scheduleWindowPlacementSave);
  mainWindow.on('close', (event) => {
    flushWindowPlacementSave();
    if (!allowWindowClose) {
      event.preventDefault();
      void requestAppClose('window-close');
    }
  });
  mainWindow.on('closed', () => {
    clearTimeout(windowPlacementSaveTimer);
    windowPlacementSaveTimer = null;
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));
}

function repairWindowsStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return;
  }

  const shortcutPath = startMenuShortcutPath(app.getPath('appData'));
  try {
    fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
    const written = shell.writeShortcutLink(
      shortcutPath,
      'replace',
      shortcutDetails(process.execPath, fs.existsSync)
    );
    if (!written) {
      console.warn('Terminal Deck 시작 메뉴 바로가기를 복구하지 못했습니다.');
    }
  } catch (error) {
    console.warn(`Terminal Deck 시작 메뉴 바로가기를 복구하지 못했습니다: ${error.message}`);
  }
}

async function startApplication() {
  if (await handleSquirrelLifecycle()) {
    return;
  }

  await app.whenReady();
  app.setAppUserModelId(APP_USER_MODEL_ID);
  processElevation = detectProcessElevation();
  if (processElevation === 'administrator') {
    const launched = await launchWithElevation({
      elevated: false,
      executablePath: process.execPath,
      args: app.isPackaged ? [] : [app.getAppPath()],
      cwd: app.isPackaged ? path.dirname(process.execPath) : process.cwd()
    });
    if (!launched) {
      throw new Error('관리자 앱에서 standard state owner를 시작하지 못했습니다.');
    }
    allowAppQuit = true;
    allowWindowClose = true;
    app.quit();
    return;
  }
  repairWindowsStartMenuShortcut();
  stateDirectory = path.join(
    app.getPath('appData'),
    'multi-session-manager'
  );
  initializeWorkspaceStore(stateDirectory);
  registerIpcHandlers();
  createWindow();
}

startApplication().catch((error) => {
  console.error(`앱을 시작하지 못했습니다: ${error.stack || error.message}`);
  allowAppQuit = true;
  app.quit();
});

app.on('before-quit', (event) => {
  if (!allowAppQuit) {
    event.preventDefault();
    void requestAppClose('app-quit');
  }
});
app.on('window-all-closed', () => {
  if (allowAppQuit) {
    app.quit();
  }
});
