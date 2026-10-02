// 렌더러 스모크용 stub API. PTY 없이 세션 생명주기와 작업공간 복원만 흉내내어
// 왼쪽 목록·타일·현재 대상·저장 payload를 검증할 수 있게 한다.
const { contextBridge } = require('electron');

const savedStates = [];
const saveRequests = [];
const resizeCalls = [];
const writeCalls = [];
const clipboardWrites = [];
let clipboardText = 'renderer smoke clipboard';
const closeSessionCalls = [];
const createSessionCalls = [];
const prepareCloseListeners = [];
const closeCancelledListeners = [];
let sequence = 0;

// 고정 2개 + 순환 2개를 가진 저장된 배치. Stage 1 화면은 한 타일만 렌더하지만
// 이 배치는 저장·복원 사이에 손실 없이 유지되어야 한다.
const restoredTabs = [
  {
    key: 'key-pinned-a',
    name: '고정 알파',
    cwd: 'D:\\work\\alpha',
    initialCwd: 'D:\\registered\\alpha',
    description: '고정 세션',
    shellKind: 'pwsh',
    history: [{ command: 'git status', timestamp: 1 }],
    rotationSlot: null
  },
  {
    key: 'key-pinned-b',
    name: '고정 베타',
    cwd: 'D:\\work\\beta',
    description: '',
    shellKind: 'pwsh',
    history: [],
    rotationSlot: null
  },
  {
    key: 'key-rot-c',
    name: '순환 감마',
    cwd: 'D:\\work\\gamma',
    description: '',
    shellKind: 'pwsh',
    history: [],
    rotationSlot: 1
  },
  {
    key: 'key-rot-d',
    name: '순환 델타',
    cwd: 'D:\\work\\delta',
    description: '',
    shellKind: 'pwsh',
    history: [],
    rotationSlot: 2
  },
  // 어느 타일에도 표시되지 않는 숨은 순환1 세션.
  {
    key: 'key-rot-e',
    name: '순환 엡실론',
    cwd: 'D:\\work\\epsilon',
    description: '',
    shellKind: 'pwsh',
    history: [],
    rotationSlot: 1
  }
];

const restoredDeck = {
  version: 1,
  rows: 4,
  columns: 4,
  focusedSessionKey: 'key-rot-c',
  tiles: [
    {
      id: 'p1',
      kind: 'pinned',
      sessionKey: 'key-pinned-a',
      row: 0,
      column: 0,
      rowSpan: 2,
      columnSpan: 2
    },
    {
      id: 'p2',
      kind: 'pinned',
      sessionKey: 'key-pinned-b',
      row: 0,
      column: 2,
      rowSpan: 2,
      columnSpan: 2
    },
    {
      id: 'r1',
      kind: 'rotating',
      rotationIndex: 1,
      currentSessionKey: 'key-rot-c',
      row: 2,
      column: 0,
      rowSpan: 2,
      columnSpan: 2
    },
    {
      id: 'r2',
      kind: 'rotating',
      rotationIndex: 2,
      currentSessionKey: 'key-rot-d',
      row: 2,
      column: 2,
      rowSpan: 2,
      columnSpan: 2
    }
  ]
};

const exitListeners = [];
const outputListeners = [];

// createSession/closeSession을 원하는 시점까지 pending으로 붙잡아 실제 await
// 경계를 검사할 수 있게 한다.
const gates = { create: null, close: null };
let failNextCreate = false;
let failNextClose = false;

function passGate(name) {
  const gate = gates[name];
  if (!gate) {
    return Promise.resolve();
  }
  return new Promise((resolve) => gate.waiters.push(resolve));
}

function holdGate(name) {
  gates[name] = { waiters: [] };
}

function releaseGate(name) {
  const gate = gates[name];
  gates[name] = null;
  for (const resolve of gate ? gate.waiters : []) {
    resolve();
  }
}

contextBridge.exposeInMainWorld('terminalApi', {
  getRuntimeInfo: async () => ({
    elevation: 'standard',
    elevated: false,
    startupWorkspaceId: null
  }),
  discoverProviders: async () => [],
  getGitContext: async () => null,
  getDiagnostics: async () => ({
    elevation: 'standard', sessionCount: sequence, providers: [], git: null
  }),
  createSession: async (options) => {
    createSessionCalls.push(options);
    await passGate('create');
    if (failNextCreate) {
      failNextCreate = false;
      return null;
    }
    sequence += 1;
    return {
      id: `session-${sequence}`,
      name: options?.name || `PowerShell ${sequence}`,
      cwd: options?.cwd || 'D:\\default',
      initialCwd: options?.initialCwd || options?.cwd || 'D:\\default',
      shellKind: options?.shellKind || 'pwsh',
      shellLabel: 'PowerShell 7',
      elevated: false,
      shellIntegrationNonce: `nonce-${sequence}`
    };
  },
  attachSession: async () => '',
  closeSession: async (sessionId) => {
    closeSessionCalls.push(sessionId);
    await passGate('close');
    if (failNextClose) {
      failNextClose = false;
      // 실제 rejected promise를 만든다(false 반환과 구분).
      throw new Error('closeSession IPC 실패(스모크 주입)');
    }
    return { ok: true, status: 'pty-exit-observed' };
  },
  terminateSession: async () => ({ ok: true, status: 'pty-exit-observed' }),
  write: (sessionId, data) => {
    writeCalls.push({ sessionId, data });
  },
  resize: (sessionId, cols, rows) => {
    resizeCalls.push({ sessionId, cols, rows });
  },
  updateCwd: () => {},
  onOutput: (callback) => {
    outputListeners.push(callback);
    return () => {};
  },
  onExit: (callback) => {
    exitListeners.push(callback);
    return () => {};
  },
  chooseDirectory: async () => 'D:\\chosen',
  chooseShellExecutable: async () => '',
  readClipboard: async () => clipboardText,
  writeClipboard: async (text) => {
    clipboardWrites.push(text);
    return true;
  },
  saveCommandBlock: async () => ({ saved: true }),
  saveTextFile: async () => ({ saved: true }),
  listWorkspaces: async () => [{
    id: 'admin-workspace',
    name: '관리 작업 공간',
    description: '관리자 권한 표시 검증',
    elevation: 'administrator',
    lastUsedAt: 1,
    tabCount: 0,
    tabNames: [],
    running: false
  }],
  createWorkspace: async () => null,
  cloneWorkspace: async () => null,
  updateWorkspace: async () => null,
  deleteWorkspace: async () => ({ deleted: true }),
  openWorkspace: async () => ({
    opened: true,
    saveEpoch: 'renderer-smoke-epoch',
    workspace: {
      id: 'workspace-smoke',
      name: '스모크 작업 공간',
      description: '렌더러 동작 검증'
    },
    state: {
      version: 3,
      settings: {},
      favorites: [
        { id: 'f1', name: '빌드', command: 'npm run build' },
        { id: 'f2', name: '테스트', command: 'npm test' },
        { id: 'f3', name: '상태', command: 'git status' },
        { id: 'f4', name: '네 번째', command: 'Get-Date' }
      ],
      tabs: restoredTabs,
      activeTabIndex: 2,
      deck: restoredDeck
    }
  }),
  saveState: async (request) => {
    saveRequests.push(request);
    savedStates.push(request.state);
    return {
      ok: true,
      saved: true,
      saveEpoch: request.saveEpoch,
      revision: request.revision,
      committedRevision: request.revision,
      requestId: request.requestId,
      persistenceScope: 'workspace'
    };
  },
  reportFinalStateUnavailable: async () => true,
  onPrepareClose: (callback) => {
    prepareCloseListeners.push(callback);
    return () => {};
  },
  onCloseCancelled: (callback) => {
    closeCancelledListeners.push(callback);
    return () => {};
  }
});

contextBridge.exposeInMainWorld('rendererSmoke', {
  savedStates: () => savedStates,
  saveRequests: () => saveRequests,
  prepareClose: (payload) => {
    for (const listener of prepareCloseListeners) {
      listener(payload);
    }
  },
  cancelClose: () => {
    for (const listener of closeCancelledListeners) {
      listener({});
    }
  },
  persistedDeck: () => restoredDeck,
  persistedTabs: () => restoredTabs,
  resizeCalls: () => resizeCalls,
  clearResizeCalls: () => {
    resizeCalls.length = 0;
  },
  writeCalls: () => writeCalls,
  clearWriteCalls: () => {
    writeCalls.length = 0;
  },
  clipboardWrites: () => clipboardWrites,
  clearClipboardWrites: () => {
    clipboardWrites.length = 0;
  },
  setClipboardText: (text) => {
    clipboardText = typeof text === 'string' ? text : '';
  },
  closeSessionCalls: () => closeSessionCalls,
  createSessionCalls: () => createSessionCalls,
  holdCreateSession: () => holdGate('create'),
  releaseCreateSession: () => releaseGate('create'),
  holdCloseSession: () => holdGate('close'),
  releaseCloseSession: () => releaseGate('close'),
  failNextCreateSession: () => {
    failNextCreate = true;
  },
  failNextCloseSession: () => {
    failNextClose = true;
  },
  savedStateCount: () => savedStates.length,
  emitExit: (sessionId, closeRequested = false) => {
    for (const listener of exitListeners) {
      listener({ sessionId, exitCode: 0, closeRequested });
    }
  },
  // 숨은 세션에도 출력을 흘려보내 수집이 계속되는지 확인한다.
  emitOutput: (sessionId, data) => {
    for (const listener of outputListeners) {
      listener({ sessionId, data });
    }
  },
  // 대화형 CLI는 PowerShell prompt가 돌아오기 전까지 실행 중인 상태를 유지한다.
  emitInteractiveCliStart: (sessionId, command, output) => {
    const nonce = `nonce-${sessionId.replace('session-', '')}`;
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    const osc = (payload) => `\u001b]133;${payload}\u0007`;
    for (const listener of outputListeners) {
      listener({
        sessionId,
        data: [
          osc(`A;${nonce}`),
          osc(`B;${nonce}`),
          osc(`E;${nonce};${encoded}`),
          `${command}\r\n`,
          osc(`C;${nonce}`),
          `${output}\r\n`
        ].join('')
      });
    }
  },
  emitInteractiveCliEnd: (sessionId) => {
    const nonce = `nonce-${sessionId.replace('session-', '')}`;
    const data = `\u001b]133;D;${nonce};0\u0007`;
    for (const listener of outputListeners) {
      listener({ sessionId, data });
    }
  },
  // 실제 PowerShell 없이 OSC 133 명령 블록 경로를 태운다.
  emitCommandBlock: (sessionId, command, output, exitCode = 0) => {
    const nonce = `nonce-${sessionId.replace('session-', '')}`;
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    const osc = (payload) => `\u001b]133;${payload}\u0007`;
    for (const listener of outputListeners) {
      listener({
        sessionId,
        data: [
          osc(`A;${nonce}`),
          osc(`B;${nonce}`),
          osc(`E;${nonce};${encoded}`),
          `${command}\r\n`,
          osc(`C;${nonce}`),
          `${output}\r\n`,
          osc(`D;${nonce};${exitCode}`),
          osc(`A;${nonce}`),
          osc(`B;${nonce}`)
        ].join('')
      });
    }
  }
});
