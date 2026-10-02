const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_HISTORY_PER_TAB,
  loadStateFile,
  normalizeState,
  saveStateFile
} = require('../src/state-store');

test('state normalization preserves only supported persistent fields', () => {
  const state = normalizeState({
    settings: {
      idleSeconds: 90,
      shellPath: 'C:\\Tools\\pwsh.exe',
      inactiveSessionNotifications: false,
      clearCommandBlocksOnClearHost: true,
      commandPanelWidth: 487.6
    },
    favorites: [{ id: 'f1', name: '테스트', command: 'Get-Date' }],
    tabs: [{
      key: 't1',
      name: '작업',
      cwd: 'D:\\work',
      initialCwd: 'D:\\registered',
      description: '백엔드 빌드 세션',
      shellKind: 'pwsh',
      output: 'must not persist',
      history: [{ command: 'git status', timestamp: 123 }]
    }],
    activeTabIndex: 50
  });

  assert.equal(state.settings.idleSeconds, 60);
  assert.equal(state.settings.shellPath, 'C:\\Tools\\pwsh.exe');
  assert.equal(state.settings.inactiveSessionNotifications, false);
  assert.equal(state.settings.clearCommandBlocksOnClearHost, true);
  assert.equal(state.settings.commandPanelWidth, 488);
  assert.equal(state.activeTabIndex, 0);
  assert.deepEqual(state.favorites[0], {
    id: 'f1',
    name: '테스트',
    command: 'Get-Date'
  });
  assert.equal('output' in state.tabs[0], false);
  assert.equal(state.tabs[0].description, '백엔드 빌드 세션');
  assert.equal(state.tabs[0].initialCwd, 'D:\\registered');
  assert.deepEqual(state.tabs[0].history, [
    { command: 'git status', timestamp: 123 }
  ]);
});

test('history is capped to the newest entries', () => {
  const history = Array.from(
    { length: MAX_HISTORY_PER_TAB + 5 },
    (_, index) => ({ command: `command-${index}`, timestamp: index })
  );
  const state = normalizeState({ tabs: [{ history }] });
  assert.equal(state.tabs[0].history.length, MAX_HISTORY_PER_TAB);
  assert.equal(state.tabs[0].history[0].command, 'command-5');
});

test('clearing command blocks with Clear-Host is opt-in', () => {
  assert.equal(
    normalizeState(null).settings.clearCommandBlocksOnClearHost,
    false
  );
  assert.equal(
    normalizeState({
      settings: { clearCommandBlocksOnClearHost: 'true' }
    }).settings.clearCommandBlocksOnClearHost,
    false
  );
});

test('command panel width uses a safe persisted range', () => {
  assert.equal(normalizeState(null).settings.commandPanelWidth, 340);
  assert.equal(
    normalizeState({ settings: { commandPanelWidth: 100 } })
      .settings.commandPanelWidth,
    220
  );
  assert.equal(
    normalizeState({ settings: { commandPanelWidth: 900 } })
      .settings.commandPanelWidth,
    720
  );
});

test('provider metadata를 담는 state 형식은 version 3이다', () => {
  assert.equal(normalizeState(null).version, 3);
  assert.equal(normalizeState({ version: 2, tabs: [] }).version, 3);
});

test('provider metadata는 허용 필드만 보존한다', () => {
  const state = normalizeState({
    version: 3,
    tabs: [{
      key: 'a',
      provider: {
        kind: 'claude', sessionId: 's1', cliVersion: '2.1.0',
        lastSeenAt: 42, prompt: 'secret', output: 'secret'
      }
    }]
  });
  assert.deepEqual(state.tabs[0].provider, {
    kind: 'claude', sessionId: 's1', cliVersion: '2.1.0', lastSeenAt: 42
  });
  assert.throws(
    () => normalizeState({ version: 4 }),
    { code: 'ERR_UNSUPPORTED_STATE_VERSION' }
  );
});

test('deck 없는 상태는 전체 크기 순환1 타일로 승격된다', () => {
  const state = normalizeState({
    tabs: [{ key: 'a', name: 'A' }, { key: 'b', name: 'B' }],
    activeTabIndex: 1
  });

  assert.equal(state.deck.tiles.length, 1);
  assert.equal(state.deck.tiles[0].kind, 'rotating');
  assert.equal(state.deck.tiles[0].rotationIndex, 1);
  assert.equal(state.deck.tiles[0].currentSessionKey, 'b');
  assert.equal(state.deck.focusedSessionKey, 'b');
  assert.deepEqual(state.tabs.map((tab) => tab.rotationSlot), [1, 1]);
});

test('저장된 deck과 rotationSlot이 정규화되어 보존된다', () => {
  const state = normalizeState({
    tabs: [
      { key: 'a', name: 'A', rotationSlot: 9 },
      { key: 'b', name: 'B', rotationSlot: 2 }
    ],
    activeTabIndex: 0,
    deck: {
      version: 1,
      rows: 4,
      columns: 4,
      focusedSessionKey: 'b',
      tiles: [
        {
          id: 'p1',
          kind: 'pinned',
          sessionKey: 'a',
          row: 0,
          column: 0,
          rowSpan: 4,
          columnSpan: 2
        },
        {
          id: 'r2',
          kind: 'rotating',
          rotationIndex: 2,
          currentSessionKey: 'b',
          row: 0,
          column: 2,
          rowSpan: 4,
          columnSpan: 2,
          pane: 'must not persist'
        }
      ]
    }
  });

  assert.deepEqual(state.deck.tiles.map((tile) => tile.id), ['p1', 'r2']);
  assert.equal('pane' in state.deck.tiles[1], false);
  assert.equal(state.deck.focusedSessionKey, 'b');
  assert.equal(state.tabs[0].rotationSlot, null);
  assert.equal(state.tabs[1].rotationSlot, 2);
  assert.deepEqual(normalizeState(state).deck, state.deck);
});

test('오른쪽 패널 접힘은 boolean만 인정하고 폭을 건드리지 않는다', () => {
  assert.equal(normalizeState(null).settings.commandPanelCollapsed, false);
  assert.equal(
    normalizeState({ settings: { commandPanelCollapsed: true } })
      .settings.commandPanelCollapsed,
    true
  );
  for (const invalid of ['true', 1, {}, [], null]) {
    assert.equal(
      normalizeState({ settings: { commandPanelCollapsed: invalid } })
        .settings.commandPanelCollapsed,
      false,
      `${JSON.stringify(invalid)}는 false로 정규화되어야 합니다.`
    );
  }

  // 접혀 있어도 기존 폭과 다른 설정은 그대로 유지된다.
  const collapsed = normalizeState({
    settings: {
      commandPanelCollapsed: true,
      commandPanelWidth: 500,
      idleSeconds: 7,
      shellPath: 'C:\\pwsh.exe',
      inactiveSessionNotifications: false,
      clearCommandBlocksOnClearHost: true
    }
  });
  assert.equal(collapsed.settings.commandPanelWidth, 500);
  assert.deepEqual(Object.keys(collapsed.settings).sort(), [
    'clearCommandBlocksOnClearHost',
    'commandPanelCollapsed',
    'commandPanelWidth',
    'idleSeconds',
    'inactiveSessionNotifications',
    'sessionPanelCollapsed',
    'sessionPanelWidth',
    'shellPath'
  ]);
  assert.equal(collapsed.settings.idleSeconds, 7);
  assert.equal(collapsed.settings.shellPath, 'C:\\pwsh.exe');
  assert.equal(collapsed.settings.inactiveSessionNotifications, false);
  assert.equal(collapsed.settings.clearCommandBlocksOnClearHost, true);
});

test('세션 패널 폭·접힘도 boolean/범위로 정규화된다', () => {
  const defaults = normalizeState(null).settings;
  assert.equal(defaults.sessionPanelWidth, 240);
  assert.equal(defaults.sessionPanelCollapsed, false);

  assert.equal(
    normalizeState({ settings: { sessionPanelWidth: 9999 } })
      .settings.sessionPanelWidth,
    420
  );
  assert.equal(
    normalizeState({ settings: { sessionPanelWidth: 10 } })
      .settings.sessionPanelWidth,
    180
  );
  assert.equal(
    normalizeState({ settings: { sessionPanelWidth: 263.6 } })
      .settings.sessionPanelWidth,
    264
  );
  for (const invalid of ['true', 1, {}, [], null]) {
    assert.equal(
      normalizeState({ settings: { sessionPanelCollapsed: invalid } })
        .settings.sessionPanelCollapsed,
      false,
      `${JSON.stringify(invalid)}는 false여야 합니다.`
    );
  }

  // 접혀 있어도 저장된 폭은 지워지지 않고, 다른 설정도 함께 보존된다.
  const collapsed = normalizeState({
    settings: {
      sessionPanelCollapsed: true,
      sessionPanelWidth: 320,
      commandPanelCollapsed: true,
      commandPanelWidth: 500,
      idleSeconds: 9
    }
  }).settings;
  assert.equal(collapsed.sessionPanelCollapsed, true);
  assert.equal(collapsed.sessionPanelWidth, 320);
  assert.equal(collapsed.commandPanelCollapsed, true);
  assert.equal(collapsed.commandPanelWidth, 500);
  assert.equal(collapsed.idleSeconds, 9);
  assert.deepEqual(Object.keys(collapsed).sort(), [
    'clearCommandBlocksOnClearHost',
    'commandPanelCollapsed',
    'commandPanelWidth',
    'idleSeconds',
    'inactiveSessionNotifications',
    'sessionPanelCollapsed',
    'sessionPanelWidth',
    'shellPath'
  ]);
});

test('기존 상태 파일은 새 패널 필드를 기본값으로 승격한다', () => {
  const legacy = normalizeState({
    version: 1,
    settings: { idleSeconds: 5, commandPanelWidth: 400 },
    tabs: [{ key: 'a', name: 'A' }]
  });

  assert.equal(legacy.settings.sessionPanelWidth, 240);
  assert.equal(legacy.settings.sessionPanelCollapsed, false);
  assert.equal(legacy.settings.commandPanelWidth, 400);
  assert.equal(legacy.tabs.length, 1);
});

test('state file round-trips as UTF-8 JSON and missing files use defaults', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-state-'));
  const filePath = path.join(directory, 'state.json');

  assert.deepEqual(loadStateFile(filePath).tabs, []);
  saveStateFile(filePath, {
    favorites: [{ id: '한글', name: '빌드', command: 'npm run build' }],
    tabs: [{ key: '탭', name: '검사', cwd: 'D:\\검사', history: [] }]
  });

  const loaded = loadStateFile(filePath);
  assert.equal(loaded.favorites[0].name, '빌드');
  assert.equal(loaded.tabs[0].cwd, 'D:\\검사');
  assert.equal(loaded.tabs[0].initialCwd, 'D:\\검사');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('invalid JSON falls back to a clean state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-state-'));
  const filePath = path.join(directory, 'state.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');
  assert.deepEqual(loadStateFile(filePath), normalizeState(null));
  fs.rmSync(directory, { recursive: true, force: true });
});
