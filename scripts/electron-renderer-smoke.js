// Session Deck 렌더러 스모크. stub PTY로 index.html + 렌더러 번들을 띄워
// 왼쪽 세션 목록, 순환 타일, 오른쪽 현재 대상, 저장 payload를 검증한다.
//
// 실행 중인 Terminal Deck과 완전히 격리한다.
// - userData/sessionData/cache/crashDumps를 app.whenReady() 전에 임시 경로로 돌린다.
//   (기본값은 실제 앱과 같은 %APPDATA%\multi-session-manager라 Chromium 프로필이 겹친다)
// - 공유 dist/renderer.*를 건드리지 않고 임시 디렉터리에 번들과 HTML을 새로 만든다.
// - 성공·실패 모두 BrowserWindow와 임시 디렉터리를 정리한다.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const esbuild = require('esbuild');

const TEMPORARY_PREFIX = 'msm-renderer-smoke-';
const resultPath = path.join(process.cwd(), 'electron-renderer-smoke.log');
const repositoryRoot = path.join(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), TEMPORARY_PREFIX)
);
const failures = [];
const consoleErrors = [];
let smokeWindow = null;

fs.writeFileSync(resultPath, 'Renderer smoke test started.\n', 'utf8');

for (const [name, directory] of [
  ['userData', 'user-data'],
  ['sessionData', 'session-data'],
  ['cache', 'cache'],
  ['crashDumps', 'crash-dumps']
]) {
  const target = path.join(temporaryRoot, directory);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
}
app.disableHardwareAcceleration();
// 마지막 창을 정리 목적으로 닫아도 Electron 기본 동작(앱 종료)이 끼어들지 않게 한다.
// 이 리스너가 없으면 정리·보고가 끝나기 전에 프로세스가 사라진다.
app.on('window-all-closed', () => {});

function report(message) {
  fs.appendFileSync(resultPath, `${message}\n`, 'utf8');
}

// 공유 빌드 산출물을 덮어쓰지 않도록 임시 디렉터리에만 번들을 만든다.
function prepareIsolatedApp() {
  const appDirectory = path.join(temporaryRoot, 'app');
  const outputFile = path.join(appDirectory, 'dist', 'renderer.js');
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });

  const result = esbuild.buildSync({
    entryPoints: [path.join(repositoryRoot, 'src', 'renderer.js')],
    bundle: true,
    outfile: outputFile,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent'
  });
  if (result.errors.length > 0) {
    throw new Error(
      `렌더러 번들을 만들지 못했습니다: ${result.errors[0].text}`
    );
  }

  // index.html은 ./dist/renderer.css와 ./dist/renderer.js를 상대 경로로 참조한다.
  const indexPath = path.join(appDirectory, 'index.html');
  fs.copyFileSync(path.join(repositoryRoot, 'index.html'), indexPath);
  return indexPath;
}

function removeTemporaryRootOnce() {
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    return !fs.existsSync(temporaryRoot);
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Chromium 프로필 파일은 브라우저 프로세스가 살아 있는 동안 Windows에서 지울 수
// 없다. 그래서 프로세스가 끝난 직후 지우는 분리된 정리 프로세스를 남긴다.
// shell을 거치지 않고 Electron을 Node 모드로 띄워 인자 escaping 문제를 피한다.
const CLEANUP_SCRIPT = `
const fs = require('fs');
const target = process.argv[1];
let attempts = 0;
const timer = setInterval(() => {
  attempts += 1;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
  if (!fs.existsSync(target) || attempts >= 40) {
    clearInterval(timer);
  }
}, 250);
`;

function scheduleDetachedCleanup() {
  const child = spawn(process.execPath, ['-e', CLEANUP_SCRIPT, temporaryRoot], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
  child.unref();
}

// 정리 프로세스까지 죽은 경우에도 임시 디렉터리가 쌓이지 않게, 충분히 오래된
// 이전 실행 흔적을 시작할 때 함께 지운다.
function sweepStaleTemporaryRoots() {
  const staleAfterMs = 10 * 60 * 1000;
  let entries = [];
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith(TEMPORARY_PREFIX)) {
      continue;
    }
    const candidate = path.join(os.tmpdir(), entry);
    if (candidate === temporaryRoot) {
      continue;
    }
    try {
      if (Date.now() - fs.statSync(candidate).mtimeMs > staleAfterMs) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // 다른 실행이 쓰고 있을 수 있으므로 실패는 무시한다.
    }
  }
}

function closeSmokeWindow() {
  if (smokeWindow && !smokeWindow.isDestroyed()) {
    smokeWindow.destroy();
  }
  smokeWindow = null;
}

// Chromium은 세션 프로필(Cache, Code Cache, leveldb) 핸들을 브라우저 프로세스가
// 내려갈 때까지 붙잡는다. 그래서 정리는 quit 이후에 하고, 여기서 프로세스를 끝낸다.
function finishAndCleanup(exitCode) {
  app.once('quit', () => {
    let removed = !fs.existsSync(temporaryRoot);
    for (let attempt = 0; !removed && attempt < 5; attempt += 1) {
      removed = removeTemporaryRootOnce();
      if (!removed) {
        sleepSync(100);
      }
    }
    if (removed) {
      report('임시 디렉터리를 정리했습니다.');
    } else {
      scheduleDetachedCleanup();
      report(
        `임시 디렉터리는 프로세스 종료 직후 정리합니다: ${temporaryRoot}`
      );
    }
    process.exit(exitCode);
  });

  closeSmokeWindow();
  app.quit();
}

function check(name, condition, detail = '') {
  const line = `${condition ? 'ok  ' : 'FAIL'} ${name}${
    detail && !condition ? ` — ${detail}` : ''
  }`;
  report(line);
  if (!condition) {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 타일 DOM 스냅샷. pane의 reparents 카운터는 실제 DOM 이동만 셈하므로
// "이 타일 DOM은 건드리지 않았다"를 검사할 수 있다.
const READ_TILES = `[...document.querySelectorAll('#session-deck .deck-tile')].map((tile) => {
  const pane = tile.querySelector('.terminal-pane');
  const metadata = tile.querySelector('.deck-tile-metadata');
  const header = tile.querySelector('.deck-tile-header');
  const style = tile.style;
  return {
    tileId: tile.dataset.tileId,
    hidden: tile.hidden,
    focused: tile.classList.contains('focused'),
    maximized: tile.classList.contains('maximized'),
    gridRow: style.gridRow,
    gridColumn: style.gridColumn,
    tag: tile.querySelector('.deck-tile-tag').textContent,
    title: tile.querySelector('.deck-tile-title').textContent,
    shell: tile.querySelector('.deck-tile-shell').textContent,
    cwd: tile.querySelector('.deck-tile-cwd').textContent,
    description: tile.querySelector('.deck-tile-description').textContent,
    metadataHidden: metadata.hidden,
    metadataInHeaderMain: metadata.parentElement.classList.contains('deck-tile-header-main'),
    headerHeight: Math.round(header.getBoundingClientRect().height),
    titleDisabled: tile.querySelector('.deck-tile-title').disabled,
    titleLabel: tile.querySelector('.deck-tile-title').getAttribute('aria-label'),
    titleTooltip: tile.querySelector('.deck-tile-title').title,
    status: tile.querySelector('.deck-tile-status').textContent,
    blocks: tile.querySelector('.deck-tile-blocks').textContent,
    pasteText: tile.querySelector('.deck-tile-paste').textContent,
    pasteHidden: tile.querySelector('.deck-tile-paste').hidden,
    pasteDisabled: tile.querySelector('.deck-tile-paste').disabled,
    pasteLabel: tile.querySelector('.deck-tile-paste').getAttribute('aria-label'),
    clearText: tile.querySelector('.deck-tile-clear').textContent,
    clearHidden: tile.querySelector('.deck-tile-clear').hidden,
    clearDisabled: tile.querySelector('.deck-tile-clear').disabled,
    clearLabel: tile.querySelector('.deck-tile-clear').getAttribute('aria-label'),
    logText: tile.querySelector('.deck-tile-log').textContent,
    logHidden: tile.querySelector('.deck-tile-log').hidden,
    logDisabled: tile.querySelector('.deck-tile-log').disabled,
    logLabel: tile.querySelector('.deck-tile-log').getAttribute('aria-label'),
    quickActionOrder: tile.querySelector('.deck-tile-paste').nextElementSibling
      === tile.querySelector('.deck-tile-clear')
      && tile.querySelector('.deck-tile-clear').nextElementSibling
        === tile.querySelector('.deck-tile-log')
      && tile.querySelector('.deck-tile-log').nextElementSibling
        === tile.querySelectorAll('.deck-tile-button')[0]
      && tile.querySelectorAll('.deck-tile-button')[0].nextElementSibling
        === tile.querySelectorAll('.deck-tile-button')[1],
    titleInfoOrder: tile.querySelector('.deck-tile-title').nextElementSibling
      === tile.querySelector('.deck-tile-focus-mark')
      && tile.querySelector('.deck-tile-focus-mark').nextElementSibling
        === tile.querySelector('.deck-tile-status')
      && tile.querySelector('.deck-tile-status').nextElementSibling
        === tile.querySelector('.deck-tile-blocks'),
    logBeforeMaximize: tile.querySelector('.deck-tile-log').nextElementSibling
      === tile.querySelector('.deck-tile-button'),
    focusMarkHidden: tile.querySelector('.deck-tile-focus-mark').hidden,
    ariaLabel: tile.getAttribute('aria-label'),
    emptyTitle: tile.querySelector('.deck-tile-empty-title').textContent,
    emptyHint: tile.querySelector('.deck-tile-empty-hint').textContent,
    maximizeLabel: tile.querySelector('.deck-tile-button').getAttribute('aria-label'),
    maximizeDisabled: tile.querySelector('.deck-tile-button').disabled,
    blocksTitle: tile.querySelector('.deck-tile-blocks').title,
    blocksTag: tile.querySelector('.deck-tile-blocks').tagName,
    headerHeight: Number.parseFloat(getComputedStyle(tile.querySelector('.deck-tile-header')).height),
    actionFontSize: Number.parseFloat(getComputedStyle(tile.querySelector('.deck-tile-paste')).fontSize),
    actionFontWeight: Number.parseInt(getComputedStyle(tile.querySelector('.deck-tile-paste')).fontWeight, 10),
    blocksFontSize: Number.parseFloat(getComputedStyle(tile.querySelector('.deck-tile-blocks')).fontSize),
    blocksFontWeight: Number.parseInt(getComputedStyle(tile.querySelector('.deck-tile-blocks')).fontWeight, 10),
    paneSessionKey: pane ? pane.dataset.sessionKey : null,
    paneReparents: pane ? pane.dataset.reparents : null,
    paneHidden: pane ? pane.hidden : null,
    paneCount: tile.querySelectorAll('.terminal-pane').length,
    // 실제 xterm이 렌더한 줄 수 = fit 결과. 타일 크기 변화가 반영됐는지 본다.
    paneRows: pane ? pane.querySelectorAll('.xterm-rows > div').length : 0,
    bodyWidth: Math.round(
      tile.querySelector('.deck-tile-body').getBoundingClientRect().width
    ),
    bodyHeight: Math.round(
      tile.querySelector('.deck-tile-body').getBoundingClientRect().height
    ),
    computedGridRow: getComputedStyle(tile).gridRow
  };
})`;

// 오른쪽 인스펙터: 대상 표시, 접힘 상태, 활성 보기, 대상 이름이 박힌 동작 라벨.
const READ_INSPECTOR = `({
  targetName: document.querySelector('#inspector-target-name').textContent,
  targetMeta: document.querySelector('#inspector-target-meta').textContent,
  targetMetaTitle: document.querySelector('#inspector-target-meta').title,
  targetNameTitle: document.querySelector('#inspector-target-name').title,
  targetLabel: document.querySelector('.inspector-target-label').textContent,
  targetHeight: Math.round(
    document.querySelector('.inspector-target').getBoundingClientRect().height
  ),
  collapsed: document.querySelector('.work-area')
    .classList.contains('command-panel-collapsed'),
  panelDisplay: getComputedStyle(document.querySelector('#command-panel')).display,
  railHidden: document.querySelector('#command-panel-rail').hidden,
  railStatus: document.querySelector('#command-panel-rail-status').textContent,
  resizerHidden: document.querySelector('#panel-resizer').hidden,
  collapseExpanded: document.querySelector('#collapse-command-panel')
    .getAttribute('aria-expanded'),
  collapseControls: document.querySelector('#collapse-command-panel')
    .getAttribute('aria-controls'),
  expandExpanded: document.querySelector('#expand-command-panel')
    .getAttribute('aria-expanded'),
  expandLabel: document.querySelector('#expand-command-panel')
    .getAttribute('aria-label'),
  panelWidth: document.querySelector('.work-area')
    .style.getPropertyValue('--command-panel-width'),
  activeView: [...document.querySelectorAll('[role="tab"]')]
    .filter((tab) => tab.getAttribute('aria-selected') === 'true')
    .map((tab) => tab.dataset.panel).join(','),
  blocksViewHidden: document.querySelector('#blocks-panel').hidden,
  historyViewHidden: document.querySelector('#history-panel').hidden,
  clearHistory: {
    label: document.querySelector('#clear-history').getAttribute('aria-label'),
    title: document.querySelector('#clear-history').title
  },
  favoriteRun: [...document.querySelectorAll('#favorite-list .favorite-run')]
    .map((button) => ({
      text: button.textContent,
      label: button.getAttribute('aria-label'),
      title: button.title,
      disabled: button.disabled
    })),
  favoriteShortcuts: [...document.querySelectorAll('#favorite-shortcuts button')]
    .map((button) => ({
      text: button.textContent,
      label: button.getAttribute('aria-label'),
      disabled: button.disabled
    })),
  favoriteEdit: [...document.querySelectorAll('#favorite-list .utility-item-actions')]
    .map((actions) => ({
      edit: actions.children[1] ? actions.children[1].disabled : null,
      remove: actions.children[2] ? actions.children[2].disabled : null
    }))
})`;

// 명령 블록 패널: 세션별 선택 상태와 툴바 라벨.
const READ_BLOCKS = `({
  count: document.querySelector('#command-block-count').textContent,
  interactiveCopy: {
    hidden: document.querySelector('#copy-interactive-cli').hidden,
    disabled: document.querySelector('#copy-interactive-cli').disabled,
    label: document.querySelector('#copy-interactive-cli').getAttribute('aria-label')
  },
  copyAll: {
    disabled: document.querySelector('#command-block-count').disabled,
    label: document.querySelector('#command-block-count').getAttribute('aria-label')
  },
  selectedText: document.querySelector('#selected-command-block-count').textContent,
  commands: [...document.querySelectorAll('#command-block-list .command-block')]
    .map((card) => card.querySelector('.command-block-command').textContent
      .replace(/\\s+/gu, ' ').trim().slice(0, 44)),
  checked: [...document.querySelectorAll('#command-block-list .command-block')]
    .map((card) => card.querySelector('input[type="checkbox"]').checked),
  selectAll: {
    checked: document.querySelector('#select-all-command-blocks').checked,
    indeterminate: document.querySelector('#select-all-command-blocks').indeterminate,
    disabled: document.querySelector('#select-all-command-blocks').disabled
  },
  copy: {
    disabled: document.querySelector('#copy-selected-command-blocks').disabled,
    label: document.querySelector('#copy-selected-command-blocks')
      .getAttribute('aria-label')
  },
  save: {
    disabled: document.querySelector('#save-selected-command-blocks').disabled,
    label: document.querySelector('#save-selected-command-blocks')
      .getAttribute('aria-label')
  },
  remove: {
    disabled: document.querySelector('#delete-selected-command-blocks').disabled,
    label: document.querySelector('#delete-selected-command-blocks')
      .getAttribute('aria-label')
  },
  clearAll: {
    disabled: document.querySelector('#clear-command-blocks').disabled,
    label: document.querySelector('#clear-command-blocks').getAttribute('aria-label')
  }
})`;

// 현재 키보드 포커스가 어디에 있는지. xterm은 pane 안의 helper textarea를 쓴다.
const READ_FOCUS = `(() => {
  const active = document.activeElement;
  const pane = active ? active.closest('.terminal-pane') : null;
  return {
    id: active ? active.id : null,
    tag: active ? active.tagName : null,
    inTerminal: Boolean(pane),
    terminalSessionKey: pane ? pane.dataset.sessionKey : null,
    inCommandPanel: Boolean(active && active.closest('#command-panel')),
    inBlocksPanel: Boolean(
      active
      && (active.closest('#blocks-panel') || active.id === 'side-panel-tab-blocks')
    ),
    inRail: Boolean(active && active.closest('#command-panel-rail'))
  };
})()`;

const READ_PARKING = `({
  parkedKeys: [...document.querySelectorAll('#terminal-parking .terminal-pane')]
    .map((pane) => pane.dataset.sessionKey).sort(),
  parkingHidden: document.querySelector('#terminal-parking').hidden,
  totalPanes: document.querySelectorAll('.terminal-pane').length
})`;

const READ_STATE = `({
  tabStrip: Boolean(document.querySelector('#tab-strip')),
  listRole: document.querySelector('#session-list').getAttribute('role'),
  rows: [...document.querySelectorAll('#session-list .session-row')].map((row) => ({
    name: row.querySelector('.session-name').textContent,
    badge: row.querySelector('.session-status-badge').textContent,
    badgeStatus: row.querySelector('.session-status-badge').dataset.status,
    placement: row.querySelector('.session-placement').textContent,
    cwd: row.querySelector('.session-row-cwd').textContent,
    selected: row.getAttribute('aria-selected'),
    role: row.getAttribute('role'),
    label: row.getAttribute('aria-label'),
    attention: row.classList.contains('attention')
  })),
  toasts: document.querySelectorAll('#toast-container .session-toast').length,
  tileCount: document.querySelectorAll('#session-deck .deck-tile').length,
  visibleTileCount: [...document.querySelectorAll('#session-deck .deck-tile')]
    .filter((tile) => !tile.hidden).length,
  focusedTileCount: document.querySelectorAll('.deck-tile.focused').length,
  tileTag: (document.querySelector('.deck-tile.focused .deck-tile-tag')
    || { textContent: '' }).textContent,
  tileTitle: (document.querySelector('.deck-tile.focused .deck-tile-title')
    || { textContent: '' }).textContent,
  tileStatus: (document.querySelector('.deck-tile.focused .deck-tile-status')
    || { textContent: '' }).textContent,
  targetName: document.querySelector('#inspector-target-name').textContent,
  targetMeta: document.querySelector('#inspector-target-meta').textContent,
  panes: document.querySelectorAll('.terminal-pane').length,
  visiblePanes: [...document.querySelectorAll('.terminal-pane')]
    .filter((pane) => !pane.hidden).length,
  paneParent: document.querySelector('.terminal-pane')
    ? document.querySelector('.terminal-pane').parentElement.id
    : null,
  sessionCount: document.querySelector('#session-count').textContent,
  blockCount: document.querySelector('#command-block-count').textContent,
  historyCount: document.querySelector('#history-count').textContent,
  favoriteCount: document.querySelector('#favorite-count').textContent,
  favoriteShortcuts: [...document.querySelectorAll('#favorite-shortcuts button')]
    .map((button) => button.textContent),
  favoriteLeft: Math.round(document.querySelector('#favorite-shortcuts').getBoundingClientRect().left),
  toolbarWidth: Math.round(document.querySelector('.session-info').getBoundingClientRect().width),
  rotationShortcuts: [...document.querySelectorAll('#rotation-shortcuts .rotation-shortcut')]
    .map((button) => ({
      text: button.textContent,
      name: button.querySelector('.rotation-shortcut-name').textContent,
      sessionId: button.dataset.sessionId,
      pressed: button.getAttribute('aria-pressed'),
      status: button.dataset.status
    })),
  removedTopMetadata: ['workspace-display', 'shell-display', 'cwd-display', 'tab-description']
    .every((id) => !document.getElementById(id)),
  documentTitle: document.title
})`;

const READ_EDIT = `({
  editing: document.querySelector('#session-deck').classList.contains('editing'),
  status: document.querySelector('#deck-edit-status').textContent,
  statusLive: document.querySelector('#deck-edit-status').getAttribute('aria-live'),
  startHidden: document.querySelector('#start-deck-edit').hidden,
  commitHidden: document.querySelector('#commit-deck-edit').hidden,
  cancelHidden: document.querySelector('#cancel-deck-edit').hidden,
  overlayHidden: document.querySelector('#deck-grid-overlay').hidden,
  overlayCells: document.querySelectorAll('.deck-grid-cell').length,
  freeCells: [...document.querySelectorAll('.deck-grid-cell.free')]
    .map((cell) => cell.dataset.row + ',' + cell.dataset.column),
  dragHandles: [...document.querySelectorAll('.deck-tile-drag-handle')]
    .filter((handle) => !handle.hidden).length,
  resizeHandles: [...document.querySelectorAll('.deck-tile-resize-handle')]
    .filter((handle) => !handle.hidden).length,
  locks: [...document.querySelectorAll('.deck-tile-lock')]
    .filter((lock) => !lock.hidden).length,
  lockText: (document.querySelector('.deck-tile-lock') || { textContent: '' })
    .textContent,
  maximizeDisabled: [...document.querySelectorAll('.deck-tile-button')]
    .filter((button) => button.getAttribute('aria-label') || '')
    .every((button) => button.disabled),
  xtermCount: document.querySelectorAll('.terminal-pane .xterm').length,
  paneCount: document.querySelectorAll('.terminal-pane').length,
  geometry: [...document.querySelectorAll('#session-deck .deck-tile')]
    .map((tile) => tile.dataset.tileId + ':' + tile.style.gridRow + '|'
      + tile.style.gridColumn),
  tags: [...document.querySelectorAll('#session-deck .deck-tile .deck-tile-tag')]
    .map((tag) => tag.textContent)
})`;

// 합성 pointer 이벤트로 drag/resize gesture를 재현한다.
function tileGesture(tileId, handleClass, deltaColumns, deltaRows, finish) {
  return `(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="${tileId}"]');
    const handle = tile.querySelector('.${handleClass}');
    const deck = document.querySelector('#session-deck').getBoundingClientRect();
    const stepX = (deck.width - 8 + 4) / 4;
    const stepY = (deck.height - 8 + 4) / 4;
    const start = handle.getBoundingClientRect();
    const fromX = start.left + start.width / 2;
    const fromY = start.top + start.height / 2;
    const options = (x, y) => ({
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse',
      clientX: x, clientY: y
    });
    handle.dispatchEvent(new PointerEvent('pointerdown', options(fromX, fromY)));
    handle.dispatchEvent(new PointerEvent('pointermove', options(
      fromX + stepX * ${deltaColumns}, fromY + stepY * ${deltaRows}
    )));
    const preview = {
      gridRow: tile.style.gridRow,
      gridColumn: tile.style.gridColumn,
      valid: tile.classList.contains('drag-preview'),
      invalid: tile.classList.contains('drag-invalid'),
      lockText: tile.querySelector('.deck-tile-lock').textContent
    };
    ${finish === 'escape'
      ? "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));"
      : finish === 'cancel'
        ? "handle.dispatchEvent(new PointerEvent('pointercancel', options(fromX, fromY)));"
        : `handle.dispatchEvent(new PointerEvent('pointerup', options(
            fromX + stepX * ${deltaColumns}, fromY + stepY * ${deltaRows}
          )));`}
    return preview;
  })()`;
}

const READ_LIFECYCLE = `({
  newTab: {
    disabled: document.querySelector('#new-tab').disabled,
    title: document.querySelector('#new-tab').title
  },
  folderTab: {
    disabled: document.querySelector('#new-tab-with-folder').disabled,
    title: document.querySelector('#new-tab-with-folder').title
  },
  closeButtons: [...document.querySelectorAll('#session-list .session-close')]
    .map((button) => button.disabled),
  closeTitles: [...new Set(
    [...document.querySelectorAll('#session-list .session-close')]
      .map((button) => button.title)
  )],
  emptyActions: [...document.querySelectorAll('.deck-tile-empty-action')]
    .map((button) => button.disabled),
  sessionCount: document.querySelector('#session-count').textContent
})`;

// 편집 트랜잭션 경계: 세션 생성·종료 차단과 예약 저장 처리.
async function verifyDeckEditBoundaries(evaluate) {
  const beforeLifecycle = await evaluate(READ_LIFECYCLE);
  check('일반 모드에서는 세션 생성·종료 버튼이 활성이다',
    beforeLifecycle.newTab.disabled === false
    && beforeLifecycle.folderTab.disabled === false
    && beforeLifecycle.closeButtons.every((disabled) => disabled === false),
    JSON.stringify(beforeLifecycle.closeButtons));

  // 1) 편집 진입 직전에 debounce 저장을 예약해 둔다(shared setting 변경).
  const savesBeforeSetting = await evaluate('window.rendererSmoke.savedStateCount()');
  await evaluate(`(() => {
    document.querySelector('#open-settings').click();
    document.querySelector('#clear-command-blocks-on-clear-host').checked = true;
    document.querySelector('#settings-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // 150ms debounce가 끝나기 전에 곧바로 편집에 들어간다.
    document.querySelector('#start-deck-edit').click();
    return true;
  })()`);
  await wait(600);
  const savedOnEntry = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const last = states[states.length - 1];
    return {
      count: states.length,
      clearOnClearHost: last.settings.clearCommandBlocksOnClearHost,
      tiles: last.deck.tiles.map((tile) => [
        tile.id, tile.row, tile.column, tile.rowSpan, tile.columnSpan
      ].join(':'))
    };
  })()`);
  const committedTilesOnEntry = savedOnEntry.tiles;
  check('편집 진입 시 예약돼 있던 정상 변경이 committed deck과 함께 저장된다',
    savedOnEntry.count > savesBeforeSetting
    && savedOnEntry.clearOnClearHost === true
    && savedOnEntry.tiles.length > 0,
    `${savesBeforeSetting} -> ${savedOnEntry.count}`
      + ` / clearOnClearHost=${savedOnEntry.clearOnClearHost}`);

  // 2) 편집 중 세션 생성·종료 차단.
  const editingLifecycle = await evaluate(READ_LIFECYCLE);
  check('편집 중에는 새 세션·폴더에서 열기 버튼이 비활성된다',
    editingLifecycle.newTab.disabled === true
    && editingLifecycle.folderTab.disabled === true
    && editingLifecycle.newTab.title
      === '배치 편집을 완료하거나 취소한 뒤 사용할 수 있습니다.'
    && editingLifecycle.folderTab.title === editingLifecycle.newTab.title,
    JSON.stringify(editingLifecycle.newTab));
  check('편집 중에는 모든 왼쪽 행의 종료 버튼이 비활성된다',
    editingLifecycle.closeButtons.length > 0
    && editingLifecycle.closeButtons.every((disabled) => disabled === true)
    && editingLifecycle.closeTitles.every((title) =>
      title === '배치 편집을 완료하거나 취소한 뒤 사용할 수 있습니다.'),
    JSON.stringify(editingLifecycle.closeTitles));

  const beforeAttempts = await evaluate(`({
    creates: window.rendererSmoke.createSessionCalls().length,
    closes: window.rendererSmoke.closeSessionCalls().length,
    sessions: document.querySelectorAll('#session-list .session-row').length,
    keys: [...document.querySelectorAll('.terminal-pane')]
      .map((pane) => pane.dataset.sessionKey).sort()
  })`);
  // UI disabled를 우회해 직접 눌러도 IPC가 나가면 안 된다.
  await evaluate(`(() => {
    document.querySelector('#new-tab').disabled = false;
    document.querySelector('#new-tab').click();
    document.querySelector('#new-tab-with-folder').disabled = false;
    document.querySelector('#new-tab-with-folder').click();
    for (const button of document.querySelectorAll('#session-list .session-close')) {
      button.disabled = false;
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    return true;
  })()`);
  await wait(900);
  const afterAttempts = await evaluate(`({
    creates: window.rendererSmoke.createSessionCalls().length,
    closes: window.rendererSmoke.closeSessionCalls().length,
    sessions: document.querySelectorAll('#session-list .session-row').length,
    keys: [...document.querySelectorAll('.terminal-pane')]
      .map((pane) => pane.dataset.sessionKey).sort(),
    editing: document.querySelector('#session-deck').classList.contains('editing')
  })`);
  check('편집 중 버튼을 강제로 눌러도 createSession/closeSession이 호출되지 않는다',
    afterAttempts.creates === beforeAttempts.creates
    && afterAttempts.closes === beforeAttempts.closes,
    `creates ${beforeAttempts.creates}->${afterAttempts.creates},`
      + ` closes ${beforeAttempts.closes}->${afterAttempts.closes}`);
  check('편집 중 세션 수와 표시 세션 키가 그대로다',
    afterAttempts.sessions === beforeAttempts.sessions
    && JSON.stringify(afterAttempts.keys) === JSON.stringify(beforeAttempts.keys)
    && afterAttempts.editing === true,
    `${beforeAttempts.sessions} -> ${afterAttempts.sessions}`);
  check('강제 클릭 뒤에도 잠금이 다시 적용된다', await evaluate(`(() => {
    const buttons = [document.querySelector('#new-tab'),
      document.querySelector('#new-tab-with-folder'),
      ...document.querySelectorAll('#session-list .session-close')];
    return buttons.every((button) => button.disabled === true);
  })()`));
  check('draft tabs와 deck이 실제 세션과 어긋나지 않는다', await evaluate(`(() => {
    const rows = document.querySelectorAll('#session-list .session-row').length;
    const tiles = [...document.querySelectorAll('#session-deck .deck-tile')];
    return rows === ${beforeAttempts.sessions}
      && tiles.every((tile) => {
        const pane = tile.querySelector('.terminal-pane');
        return !pane || pane.dataset.sessionKey.length > 0;
      });
  })()`));

  // 3) 편집 중에는 draft가 저장되지 않는다(gesture와 beforeunload 모두).
  const savesBeforeGesture = await evaluate('window.rendererSmoke.savedStateCount()');
  await evaluate(tileGesture('r1', 'deck-tile-resize-handle', 0, -1, 'up'));
  await wait(500);
  await evaluate("window.dispatchEvent(new Event('beforeunload'))");
  await wait(400);
  const savesAfterGesture = await evaluate('window.rendererSmoke.savedStateCount()');
  const lastSaved = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck.tiles.map((tile) => [
      tile.id, tile.row, tile.column, tile.rowSpan, tile.columnSpan
    ].join(':'));
  })()`);
  check('편집 중 gesture와 beforeunload로 저장이 늘지 않는다',
    savesAfterGesture === savesBeforeGesture,
    `${savesBeforeGesture} -> ${savesAfterGesture}`);
  check('저장 payload에 draft geometry가 들어가지 않았다',
    JSON.stringify(lastSaved) === JSON.stringify(committedTilesOnEntry),
    `${JSON.stringify(committedTilesOnEntry)}\\n    -> ${JSON.stringify(lastSaved)}`);

  // 4) 취소 후 원래 활성 상태 복원과 정상 동작.
  await evaluate("document.querySelector('#cancel-deck-edit').click()");
  await wait(700);
  const afterCancelLifecycle = await evaluate(READ_LIFECYCLE);
  check('취소 후 세션 생성·종료 버튼이 다시 활성된다',
    afterCancelLifecycle.newTab.disabled === false
    && afterCancelLifecycle.folderTab.disabled === false
    && afterCancelLifecycle.closeButtons.every((disabled) => disabled === false)
    && afterCancelLifecycle.newTab.title === '직전 시작 폴더에 새 terminal',
    JSON.stringify(afterCancelLifecycle.newTab));

  const closeRequestsBefore = await evaluate(
    'window.rendererSmoke.saveRequests().length'
  );
  await evaluate(`document.querySelector('.session-name')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  check('종료 직전 inline 이름 편집기가 열려 있다',
    await evaluate("document.querySelector('.session-rename') !== null"),
    'rename input was not created');
  await evaluate(`window.rendererSmoke.prepareClose({
    requestId: 'renderer-close-smoke',
    saveEpoch: 'renderer-smoke-epoch',
    minimumRevision: 100,
    reason: 'window-close'
  })`);
  await wait(400);
  const closeProtocol = await evaluate(`(() => {
    const requests = window.rendererSmoke.saveRequests();
    const latest = requests[requests.length - 1];
    return {
      count: requests.length,
      kind: latest.kind,
      requestId: latest.requestId,
      revision: latest.revision,
      newTabDisabled: document.querySelector('#new-tab').disabled,
      inlineEditorClosed: document.querySelector('.session-rename') === null
    };
  })()`);
  check('종료 준비는 debounce를 넘는 final revision을 ACK 경로로 제출한다',
    closeProtocol.count === closeRequestsBefore + 1
    && closeProtocol.kind === 'final'
    && closeProtocol.requestId === 'renderer-close-smoke'
    && closeProtocol.revision >= 100
    && closeProtocol.newTabDisabled === true
    && closeProtocol.inlineEditorClosed === true,
    JSON.stringify(closeProtocol));
  await evaluate(`document.querySelector('.session-name')
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  check('종료 준비 중에는 공통 입력 fence가 이름 변경도 차단한다',
    await evaluate("document.querySelector('.session-rename') === null"),
    'rename input was created during close');
  await evaluate('window.rendererSmoke.cancelClose()');
  await wait(100);
  check('종료 취소 후 세션 mutation 제어가 다시 활성된다',
    await evaluate("document.querySelector('#new-tab').disabled") === false);

  const beforeReal = await evaluate(`({
    creates: window.rendererSmoke.createSessionCalls().length,
    closes: window.rendererSmoke.closeSessionCalls().length,
    rows: document.querySelectorAll('#session-list .session-row').length
  })`);
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(800);
  const afterCreate = await evaluate(`({
    creates: window.rendererSmoke.createSessionCalls().length,
    rows: document.querySelectorAll('#session-list .session-row').length
  })`);
  check('편집을 끝내면 새 세션 생성이 다시 동작한다',
    afterCreate.creates === beforeReal.creates + 1
    && afterCreate.rows === beforeReal.rows + 1,
    `${beforeReal.rows} -> ${afterCreate.rows}`);

  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    rows[rows.length - 1].querySelector('.session-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await wait(700);
  const afterClose = await evaluate(`({
    closes: window.rendererSmoke.closeSessionCalls().length,
    rows: document.querySelectorAll('#session-list .session-row').length
  })`);
  check('편집을 끝내면 세션 종료도 다시 동작한다',
    afterClose.closes === beforeReal.closes + 1
    && afterClose.rows === beforeReal.rows,
    `${afterCreate.rows} -> ${afterClose.rows}`);
}

const READ_EDIT_BUTTON = `({
  disabled: document.querySelector('#start-deck-edit').disabled,
  title: document.querySelector('#start-deck-edit').title,
  editing: document.querySelector('#session-deck').classList.contains('editing'),
  rows: document.querySelectorAll('#session-list .session-row').length
})`;

// 세션 생성·종료의 IPC await 경계와 편집 진입이 겹치는 race를 검사한다.
async function verifyLifecycleRaces(evaluate) {
  const LIFECYCLE_REASON = 'terminal 생성 또는 종료가 끝난 뒤 배치를 편집할 수 있습니다.';

  // 종료 snapshot은 이미 시작된 create가 attach와 로컬 등록을 끝낼 때까지 기다린다.
  await evaluate('window.rendererSmoke.holdCreateSession()');
  const savesBeforeCloseRace = await evaluate(
    'window.rendererSmoke.saveRequests().length'
  );
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(200);
  await evaluate(`window.rendererSmoke.prepareClose({
    requestId: 'close-during-create',
    saveEpoch: 'renderer-smoke-epoch',
    minimumRevision: 500,
    reason: 'window-close'
  })`);
  await wait(300);
  check('진행 중 create가 끝나기 전에는 final snapshot을 제출하지 않는다',
    await evaluate('window.rendererSmoke.saveRequests().length')
      === savesBeforeCloseRace,
    String(savesBeforeCloseRace));
  await evaluate('window.rendererSmoke.releaseCreateSession()');
  await wait(900);
  const closeAfterCreate = await evaluate(`(() => {
    const requests = window.rendererSmoke.saveRequests();
    const latest = requests[requests.length - 1];
    return {
      count: requests.length,
      kind: latest.kind,
      requestId: latest.requestId,
      revision: latest.revision,
      tabs: latest.state.tabs.length,
      rows: document.querySelectorAll('#session-list .session-row').length
    };
  })()`);
  check('create 완료 뒤 final snapshot에 새 세션이 포함된다',
    closeAfterCreate.count === savesBeforeCloseRace + 1
    && closeAfterCreate.kind === 'final'
    && closeAfterCreate.requestId === 'close-during-create'
    && closeAfterCreate.revision >= 500
    && closeAfterCreate.tabs === closeAfterCreate.rows,
    JSON.stringify(closeAfterCreate));
  await evaluate('window.rendererSmoke.cancelClose()');
  await wait(100);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    rows[rows.length - 1].querySelector('.session-close').click();
  })()`);
  await wait(700);

  // --- 생성 race ---
  await evaluate('window.rendererSmoke.holdCreateSession()');
  const rowsBeforeCreate = (await evaluate(READ_EDIT_BUTTON)).rows;
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(400);
  const duringCreate = await evaluate(READ_EDIT_BUTTON);
  check('createSession 대기 중에는 배치 편집 버튼이 비활성된다',
    duringCreate.disabled === true && duringCreate.title === LIFECYCLE_REASON,
    `${duringCreate.disabled} / ${duringCreate.title}`);

  await evaluate(`(() => {
    const button = document.querySelector('#start-deck-edit');
    button.disabled = false;
    button.click();
    return true;
  })()`);
  await wait(400);
  const forcedDuringCreate = await evaluate(READ_EDIT_BUTTON);
  check('강제로 눌러도 생성 대기 중에는 편집 draft가 만들어지지 않는다',
    forcedDuringCreate.editing === false
    && forcedDuringCreate.disabled === true,
    `editing=${forcedDuringCreate.editing} / disabled=${forcedDuringCreate.disabled}`);

  await evaluate('window.rendererSmoke.releaseCreateSession()');
  await wait(900);
  const afterCreate = await evaluate(READ_EDIT_BUTTON);
  check('생성과 attach가 끝나면 편집 버튼이 다시 활성된다',
    afterCreate.disabled === false
    && afterCreate.rows === rowsBeforeCreate + 1,
    `${afterCreate.disabled} / ${rowsBeforeCreate} -> ${afterCreate.rows}`);

  // 새 세션이 draft.tabs에 포함된 채로 편집·완료된다.
  await evaluate("document.querySelector('#start-deck-edit').click()");
  await wait(500);
  const newSessionKey = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const pane = document.querySelector('.terminal-pane[data-session-key]');
    void pane;
    return rows.length;
  })()`);
  void newSessionKey;
  await evaluate("document.querySelector('#commit-deck-edit').click()");
  await wait(800);
  const savedAfterCreate = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const last = states[states.length - 1];
    const keys = last.tabs.map((tab) => tab.key);
    const visible = last.deck.tiles
      .map((tile) => tile.sessionKey || tile.currentSessionKey)
      .filter(Boolean);
    return {
      tabCount: keys.length,
      uniqueKeys: new Set(keys).size,
      missing: visible.filter((key) => !keys.includes(key)),
      slots: last.tabs.map((tab) => tab.rotationSlot)
    };
  })()`);
  check('생성 직후 편집·완료해도 새 세션이 저장 tabs에 남는다',
    savedAfterCreate.tabCount === afterCreate.rows
    && savedAfterCreate.uniqueKeys === savedAfterCreate.tabCount,
    JSON.stringify(savedAfterCreate));
  check('저장된 deck이 존재하지 않는 세션을 참조하지 않는다',
    savedAfterCreate.missing.length === 0,
    JSON.stringify(savedAfterCreate.missing));

  // --- 종료 race ---
  await evaluate('window.rendererSmoke.holdCloseSession()');
  const closedKey = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const row = rows[rows.length - 1];
    const name = row.querySelector('.session-name').textContent;
    row.querySelector('.session-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return name;
  })()`);
  await wait(400);
  const duringClose = await evaluate(READ_EDIT_BUTTON);
  check('closeSession 대기 중에는 배치 편집 버튼이 비활성된다',
    duringClose.disabled === true && duringClose.title === LIFECYCLE_REASON,
    `${duringClose.disabled} / ${duringClose.title}`);

  await evaluate(`(() => {
    const button = document.querySelector('#start-deck-edit');
    button.disabled = false;
    button.click();
    return true;
  })()`);
  await wait(400);
  const forcedDuringClose = await evaluate(READ_EDIT_BUTTON);
  check('강제로 눌러도 종료 대기 중에는 편집 draft가 만들어지지 않는다',
    forcedDuringClose.editing === false
    && forcedDuringClose.disabled === true,
    `editing=${forcedDuringClose.editing} / disabled=${forcedDuringClose.disabled}`);

  await evaluate('window.rendererSmoke.releaseCloseSession()');
  await wait(900);
  const afterClose = await evaluate(READ_EDIT_BUTTON);
  check('releaseSession과 포커스 이동까지 끝난 뒤 편집 버튼이 활성된다',
    afterClose.disabled === false && afterClose.rows === afterCreate.rows - 1,
    `${afterClose.disabled} / ${afterCreate.rows} -> ${afterClose.rows}`);

  await evaluate("document.querySelector('#start-deck-edit').click()");
  await wait(500);
  const draftAfterClose = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')]
      .map((row) => row.querySelector('.session-name').textContent);
    const tiles = [...document.querySelectorAll('#session-deck .deck-tile')]
      .map((tile) => {
        const pane = tile.querySelector('.terminal-pane');
        return pane ? pane.dataset.sessionKey : null;
      });
    return {
      editing: document.querySelector('#session-deck').classList.contains('editing'),
      names: rows,
      tiles
    };
  })()`);
  check('종료된 세션이 편집 draft와 타일 어디에도 남지 않는다',
    draftAfterClose.editing === true
    && !draftAfterClose.names.includes(closedKey)
    && draftAfterClose.tiles.filter(Boolean).length
      === new Set(draftAfterClose.tiles.filter(Boolean)).size,
    `${closedKey} / ${JSON.stringify(draftAfterClose.names)}`);

  await evaluate("document.querySelector('#commit-deck-edit').click()");
  await wait(800);
  const savedAfterClose = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const last = states[states.length - 1];
    const keys = last.tabs.map((tab) => tab.key);
    const visible = last.deck.tiles
      .map((tile) => tile.sessionKey || tile.currentSessionKey)
      .filter(Boolean);
    return {
      keys,
      missing: visible.filter((key) => !keys.includes(key)),
      focused: last.deck.focusedSessionKey,
      focusVisible: visible.includes(last.deck.focusedSessionKey)
    };
  })()`);
  check('종료 후 편집·완료해도 저장 payload가 일관된다',
    savedAfterClose.missing.length === 0
    && (savedAfterClose.focused === null || savedAfterClose.focusVisible),
    JSON.stringify(savedAfterClose));

  // --- 실패한 생성 뒤에도 잠금이 풀린다 ---
  await evaluate('window.rendererSmoke.failNextCreateSession()');
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(800);
  const afterFailure = await evaluate(READ_EDIT_BUTTON);
  check('세션 생성이 실패해도 편집 버튼이 영구 비활성으로 남지 않는다',
    afterFailure.disabled === false && afterFailure.rows === afterClose.rows,
    `${afterFailure.disabled} / rows=${afterFailure.rows}`);

  // --- 생성과 종료가 겹칠 때 하나만 끝나도 잠금이 풀리지 않는다 ---
  await evaluate('window.rendererSmoke.holdCreateSession()');
  await evaluate('window.rendererSmoke.holdCloseSession()');
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(300);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const button = rows[rows.length - 1].querySelector('.session-close');
    button.disabled = false;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await wait(300);
  await evaluate('window.rendererSmoke.releaseCreateSession()');
  await wait(700);
  const betweenOverlap = await evaluate(READ_EDIT_BUTTON);
  check('생성이 끝나도 종료가 남아 있으면 편집 버튼이 계속 비활성이다',
    betweenOverlap.disabled === true, String(betweenOverlap.disabled));
  await evaluate('window.rendererSmoke.releaseCloseSession()');
  await wait(900);
  const afterOverlap = await evaluate(READ_EDIT_BUTTON);
  check('겹친 작업이 모두 끝나면 편집 버튼이 활성된다',
    afterOverlap.disabled === false, String(afterOverlap.disabled));
}

const READ_PANELS = `({
  workAreaWidth: Math.round(
    document.querySelector('.work-area').getBoundingClientRect().width
  ),
  columns: getComputedStyle(document.querySelector('.work-area'))
    .gridTemplateColumns,
  sessionWidth: Math.round(
    document.querySelector('#session-panel').getBoundingClientRect().width
  ),
  commandWidth: Math.round(
    document.querySelector('#command-panel').getBoundingClientRect().width
  ),
  deckWidth: Math.round(
    document.querySelector('#session-deck').getBoundingClientRect().width
  ),
  sessionCollapsed: document.querySelector('.work-area')
    .classList.contains('session-panel-collapsed'),
  commandCollapsed: document.querySelector('.work-area')
    .classList.contains('command-panel-collapsed'),
  sessionRailHidden: document.querySelector('#session-panel-rail').hidden,
  commandRailHidden: document.querySelector('#command-panel-rail').hidden,
  sessionRailCount: document.querySelector('#session-panel-rail-count').textContent,
  sessionCountInHeader: document.querySelector('#session-count').parentElement
    .classList.contains('session-panel-header'),
  expandedSessionCount: document.querySelector('#session-count').textContent,
  sessionResizer: {
    hidden: document.querySelector('#session-panel-resizer').hidden,
    role: document.querySelector('#session-panel-resizer').getAttribute('role'),
    orientation: document.querySelector('#session-panel-resizer')
      .getAttribute('aria-orientation'),
    min: document.querySelector('#session-panel-resizer').getAttribute('aria-valuemin'),
    max: document.querySelector('#session-panel-resizer').getAttribute('aria-valuemax'),
    now: document.querySelector('#session-panel-resizer').getAttribute('aria-valuenow'),
    label: document.querySelector('#session-panel-resizer').getAttribute('aria-label'),
    tabIndex: document.querySelector('#session-panel-resizer').tabIndex
  },
  commandResizer: {
    hidden: document.querySelector('#panel-resizer').hidden,
    min: document.querySelector('#panel-resizer').getAttribute('aria-valuemin'),
    max: document.querySelector('#panel-resizer').getAttribute('aria-valuemax'),
    now: document.querySelector('#panel-resizer').getAttribute('aria-valuenow')
  },
  expandSessionLabel: document.querySelector('#expand-session-panel')
    .getAttribute('aria-label'),
  expandCommandLabel: document.querySelector('#expand-command-panel')
    .getAttribute('aria-label'),
  collapseSessionExpanded: document.querySelector('#collapse-session-panel')
    .getAttribute('aria-expanded'),
  sessionCollapseOnOuterSide: document.querySelector('.session-panel-header').firstElementChild
    === document.querySelector('#collapse-session-panel'),
  commandCollapseOnOuterSide: document.querySelector('.inspector-target').lastElementChild
    === document.querySelector('#collapse-command-panel'),
  sessionCollapseSize: Math.round(
    document.querySelector('#collapse-session-panel').getBoundingClientRect().width
  ),
  commandCollapseSize: Math.round(
    document.querySelector('#collapse-command-panel').getBoundingClientRect().width
  ),
  horizontalOverflow: document.documentElement.scrollWidth
    > document.documentElement.clientWidth
})`;

function dragResizer(id, deltaX) {
  return `(() => {
    const resizer = document.querySelector('#${id}');
    const box = resizer.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const options = (cx) => ({
      bubbles: true, cancelable: true, pointerId: 21, pointerType: 'mouse',
      clientX: cx, clientY: y
    });
    resizer.dispatchEvent(new PointerEvent('pointerdown', options(x)));
    resizer.dispatchEvent(new PointerEvent('pointermove', options(x + ${deltaX})));
    resizer.dispatchEvent(new PointerEvent('pointerup', options(x + ${deltaX})));
    return true;
  })()`;
}

// Stage 5: 패널 폭·접기·반응형 레이아웃과 저장.
async function verifyPanelLayout(evaluate, window) {
  const initial = await evaluate(READ_PANELS);
  check('초기 세션 패널 폭과 splitter ARIA가 설정된다',
    initial.sessionWidth === 240
    && initial.sessionResizer.role === 'separator'
    && initial.sessionResizer.orientation === 'vertical'
    && initial.sessionResizer.tabIndex === 0
    && initial.sessionResizer.min === '180'
    && initial.sessionResizer.max === '420'
    && initial.sessionResizer.now === '240'
    && initial.sessionResizer.label.length > 0,
    JSON.stringify(initial.sessionResizer));
  check('오른쪽 splitter ARIA 값도 갱신된다',
    initial.commandResizer.min === '220'
    && initial.commandResizer.max === '720'
    && initial.commandResizer.now === String(initial.commandWidth),
    JSON.stringify(initial.commandResizer));
  check('가로 overflow가 없다', initial.horizontalOverflow === false);
  check('terminal 개수는 전체 상단이 아니라 펼쳐진 목록 header에 표시된다',
    initial.sessionCountInHeader === true
    && Number(initial.expandedSessionCount) > 0,
    JSON.stringify({
      inHeader: initial.sessionCountInHeader,
      count: initial.expandedSessionCount
    }));
  check('양쪽 패널 접기 버튼은 각각 바깥쪽 side에 같은 크기로 고정된다',
    initial.sessionCollapseOnOuterSide === true
    && initial.commandCollapseOnOuterSide === true
    && initial.sessionCollapseSize === 22
    && initial.commandCollapseSize === 22,
    JSON.stringify({
      sessionSide: initial.sessionCollapseOnOuterSide,
      commandSide: initial.commandCollapseOnOuterSide,
      sessionSize: initial.sessionCollapseSize,
      commandSize: initial.commandCollapseSize
    }));

  // --- 왼쪽 splitter drag ---
  const deckBeforeDrag = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  const tilesBeforeDrag = await evaluate(READ_TILES);
  await evaluate('window.rendererSmoke.clearResizeCalls()');
  await evaluate(dragResizer('session-panel-resizer', 60));
  await wait(600);
  const afterDrag = await evaluate(READ_PANELS);
  const dragResizes = await evaluate('window.rendererSmoke.resizeCalls()');
  const savedAfterDrag = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const last = states[states.length - 1];
    return {
      sessionPanelWidth: last.settings.sessionPanelWidth,
      sessionPanelCollapsed: last.settings.sessionPanelCollapsed,
      deck: JSON.stringify(last.deck)
    };
  })()`);
  const draggedWidth = afterDrag.sessionWidth;
  check('왼쪽 splitter drag가 세션 패널 폭을 넓힌다',
    draggedWidth > initial.sessionWidth
    && draggedWidth - initial.sessionWidth >= 55
    && draggedWidth - initial.sessionWidth <= 70
    && afterDrag.sessionResizer.now === String(draggedWidth),
    `${initial.sessionWidth} -> ${draggedWidth}`);
  check('drag 후 저장 payload에 sessionPanelWidth가 들어간다',
    savedAfterDrag.sessionPanelWidth === draggedWidth
    && savedAfterDrag.sessionPanelCollapsed === false,
    String(savedAfterDrag.sessionPanelWidth));
  check('패널 폭 변경이 deck 저장 내용을 바꾸지 않는다',
    savedAfterDrag.deck === deckBeforeDrag);
  check('패널 폭 변경 후 표시 terminal이 다시 fit된다',
    dragResizes.length > 0
    && dragResizes.every((call) => call.cols > 0 && call.rows > 0),
    JSON.stringify(dragResizes.slice(0, 4)));
  const tilesAfterDrag = await evaluate(READ_TILES);
  check('패널 폭 변경이 pane을 옮기지 않는다',
    JSON.stringify(tilesAfterDrag.map((tile) => tile.paneReparents))
      === JSON.stringify(tilesBeforeDrag.map((tile) => tile.paneReparents)),
    JSON.stringify(tilesAfterDrag.map((tile) => tile.paneReparents)));

  // --- 키보드 조절 ---
  await evaluate(`(() => {
    const resizer = document.querySelector('#session-panel-resizer');
    resizer.focus();
    resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    return true;
  })()`);
  await wait(300);
  const afterArrow = await evaluate(READ_PANELS);
  check('ArrowRight가 왼쪽 패널을 16px 넓힌다',
    afterArrow.sessionWidth === draggedWidth + 16,
    `${draggedWidth} -> ${afterArrow.sessionWidth}`);
  await evaluate(`(() => {
    const resizer = document.querySelector('#session-panel-resizer');
    resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    return true;
  })()`);
  await wait(300);
  check('ArrowLeft가 다시 16px 좁힌다',
    (await evaluate(READ_PANELS)).sessionWidth === draggedWidth);
  await evaluate(`(() => {
    const resizer = document.querySelector('#session-panel-resizer');
    resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    return true;
  })()`);
  await wait(300);
  check('Home이 최소 폭으로 맞춘다',
    (await evaluate(READ_PANELS)).sessionWidth === 180);
  await evaluate(`(() => {
    const resizer = document.querySelector('#session-panel-resizer');
    resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    return true;
  })()`);
  await wait(300);
  const afterEnd = await evaluate(READ_PANELS);
  check('End가 최대 폭으로 맞춘다', afterEnd.sessionWidth === 420,
    String(afterEnd.sessionWidth));
  await evaluate(`(() => {
    const resizer = document.querySelector('#session-panel-resizer');
    resizer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    return true;
  })()`);
  await wait(300);

  // --- 왼쪽 접기/펴기와 포커스 인계 ---
  const focusBefore = await evaluate(READ_INSPECTOR);
  const tilesBeforeCollapse = await evaluate(READ_TILES);
  const deckBeforeCollapse = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  await evaluate(`(() => {
    const button = document.querySelector('#collapse-session-panel');
    button.focus();
    button.click();
    return true;
  })()`);
  await wait(600);
  const collapsed = await evaluate(READ_PANELS);
  const collapsedFocus = await evaluate(READ_FOCUS);
  check('왼쪽 패널을 접으면 rail이 남고 splitter가 사라진다',
    collapsed.sessionCollapsed === true
    && collapsed.sessionRailHidden === false
    && collapsed.sessionResizer.hidden === true
    && collapsed.sessionWidth === 0,
    JSON.stringify({
      collapsed: collapsed.sessionCollapsed,
      rail: collapsed.sessionRailHidden,
      width: collapsed.sessionWidth
    }));
  check('rail에 세션 수가 표시된다',
    Number(collapsed.sessionRailCount) > 0
    && collapsed.sessionRailCount === collapsed.expandedSessionCount,
    `${collapsed.sessionRailCount} / ${collapsed.expandedSessionCount}`);
  check('접기 후 포커스가 rail의 펼치기 버튼으로 간다',
    collapsedFocus.id === 'expand-session-panel',
    JSON.stringify(collapsedFocus));
  await wait(500);
  const collapsedFocusSettled = await evaluate(READ_FOCUS);
  check('접기 후 지연 프레임에도 터미널이 포커스를 빼앗지 않는다',
    collapsedFocusSettled.id === 'expand-session-panel'
    && collapsedFocusSettled.inTerminal === false,
    JSON.stringify(collapsedFocusSettled));

  const collapsedInspector = await evaluate(READ_INSPECTOR);
  const tilesWhileCollapsed = await evaluate(READ_TILES);
  const deckWhileCollapsed = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  check('왼쪽 접기가 포커스 세션과 표시 세션을 바꾸지 않는다',
    collapsedInspector.targetName === focusBefore.targetName
    && JSON.stringify(tilesWhileCollapsed.map((tile) => tile.paneSessionKey))
      === JSON.stringify(tilesBeforeCollapse.map((tile) => tile.paneSessionKey)),
    `${focusBefore.targetName} -> ${collapsedInspector.targetName}`);
  check('왼쪽 접기가 deck 저장 내용과 pane 배치를 바꾸지 않는다',
    deckWhileCollapsed === deckBeforeCollapse
    && JSON.stringify(tilesWhileCollapsed.map((tile) => tile.paneReparents))
      === JSON.stringify(tilesBeforeCollapse.map((tile) => tile.paneReparents)));
  check('왼쪽 접힘이 shared settings에 저장된다', await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const settings = states[states.length - 1].settings;
    return settings.sessionPanelCollapsed === true
      && settings.sessionPanelWidth === 180;
  })()`));

  // 양쪽 접힘에서도 세션 선택과 입력이 동작한다.
  await evaluate("document.querySelector('#collapse-command-panel').click()");
  await wait(600);
  const bothCollapsed = await evaluate(READ_PANELS);
  check('양쪽을 접으면 deck이 남은 폭을 모두 쓴다',
    bothCollapsed.sessionCollapsed === true
    && bothCollapsed.commandCollapsed === true
    && bothCollapsed.deckWidth > initial.deckWidth
    && bothCollapsed.horizontalOverflow === false,
    `deck ${initial.deckWidth} -> ${bothCollapsed.deckWidth}`);
  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`(() => {
    const pane = document.querySelector('.deck-tile .terminal-pane');
    const data = new DataTransfer();
    data.setData('text/plain', 'echo both-collapsed\\r');
    pane.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
    return true;
  })()`);
  await wait(400);
  check('양쪽 접힘에서도 터미널 입력이 동작한다',
    (await evaluate('window.rendererSmoke.writeCalls()')).length > 0);

  await evaluate(`(() => {
    const button = document.querySelector('#expand-session-panel');
    button.focus();
    button.click();
    return true;
  })()`);
  await wait(600);
  const expandedFocus = await evaluate(READ_FOCUS);
  check('펼치기 후 포커스가 패널의 접기 버튼으로 간다',
    expandedFocus.id === 'collapse-session-panel',
    JSON.stringify(expandedFocus));
  await evaluate("document.querySelector('#expand-command-panel').click()");
  await wait(600);
  const restoredPanels = await evaluate(READ_PANELS);
  check('펼치면 저장된 선호 폭이 복원된다',
    restoredPanels.sessionCollapsed === false
    && restoredPanels.sessionWidth === 180
    && restoredPanels.commandCollapsed === false,
    `${restoredPanels.sessionWidth}`);

  // --- 창 폭별 레이아웃과 반응형 접힘 ---
  const [, contentHeight] = window.getContentSize();
  const observed = [];
  for (const width of [1600, 1100, 900, 760, 640]) {
    window.setContentSize(width, contentHeight);
    await wait(700);
    observed.push({ width, ...(await evaluate(READ_PANELS)) });
  }
  check('창 폭별로 deck 최소 폭과 overflow 없음이 유지된다',
    observed.every((entry) => entry.deckWidth >= 280 && !entry.horizontalOverflow),
    JSON.stringify(observed.map((entry) =>
      `${entry.width}:deck=${entry.deckWidth}`)));
  const narrow = observed.find((entry) => entry.width === 640);
  check('640px에서는 오른쪽 패널이 반응형으로 접힌다',
    narrow.commandCollapsed === true
    && narrow.commandRailHidden === false
    && narrow.sessionCollapsed === false,
    JSON.stringify({
      command: narrow.commandCollapsed,
      session: narrow.sessionCollapsed
    }));
  check('반응형 접힘은 rail 접근성 이름으로 알린다',
    narrow.expandCommandLabel.includes('창이 좁아'),
    narrow.expandCommandLabel);
  check('반응형 접힘이 저장된 collapsed 값을 바꾸지 않는다', await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const settings = states[states.length - 1].settings;
    return settings.commandPanelCollapsed === false
      && settings.sessionPanelCollapsed === false;
  })()`));

  // 아주 좁게 줄이면 왼쪽도 반응형으로 접힌다.
  window.setContentSize(460, contentHeight);
  await wait(700);
  const verynarrow = await evaluate(READ_PANELS);
  check('더 좁아지면 왼쪽도 반응형으로 접힌다',
    verynarrow.sessionCollapsed === true
    && verynarrow.sessionRailHidden === false
    && verynarrow.horizontalOverflow === false,
    JSON.stringify({
      session: verynarrow.sessionCollapsed,
      deck: verynarrow.deckWidth
    }));
  check('반응형 왼쪽 접힘도 저장값을 바꾸지 않는다', await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].settings.sessionPanelCollapsed === false;
  })()`));

  // 다시 넓히면 선호 폭으로 복귀한다.
  window.setContentSize(1400, contentHeight);
  await wait(900);
  const back = await evaluate(READ_PANELS);
  check('창을 다시 넓히면 선호 폭과 펼침 상태로 복귀한다',
    back.sessionCollapsed === false
    && back.commandCollapsed === false
    && back.sessionWidth === 180
    && back.commandWidth === Number(initial.commandResizer.now),
    `session=${back.sessionWidth} command=${back.commandWidth}`);

  // --- 배치 편집 중 창 크기 변경 ---
  await evaluate("document.querySelector('#start-deck-edit').click()");
  await wait(600);
  const draftBeforeResize = await evaluate(READ_TILES);
  window.setContentSize(900, contentHeight);
  await wait(800);
  const draftAfterResize = await evaluate(READ_TILES);
  check('배치 편집 중 창을 좁혀도 draft geometry가 그대로다',
    JSON.stringify(draftAfterResize.map((tile) =>
      [tile.tileId, tile.gridRow, tile.gridColumn]))
      === JSON.stringify(draftBeforeResize.map((tile) =>
        [tile.tileId, tile.gridRow, tile.gridColumn])),
    JSON.stringify(draftAfterResize.map((tile) => tile.gridRow)));
  await evaluate("document.querySelector('#cancel-deck-edit').click()");
  await wait(600);
  window.setContentSize(1400, contentHeight);
  await wait(700);
}

// closeSession IPC가 reject돼도 로컬 상태가 일관되게 남는지 검사한다.
async function verifyCloseFailure(evaluate) {
  await evaluate(`(() => {
    window.__unhandledRejections = 0;
    window.addEventListener('unhandledrejection', () => {
      window.__unhandledRejections += 1;
    });
    return true;
  })()`);

  // 이 검사 전용 세션을 하나 만든다. 종료 실패 시 그대로 유지되어야 한다.
  const rowsBefore = await evaluate(
    "document.querySelectorAll('#session-list .session-row').length"
  );
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(900);
  const target = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const row = rows[rows.length - 1];
    const name = row.querySelector('.session-name').textContent;
    const pane = [...document.querySelectorAll('.terminal-pane')]
      .find((item) => item.getAttribute('aria-label').startsWith(name));
    return {
      rows: rows.length,
      name,
      key: pane ? pane.dataset.sessionKey : null,
      inDeck: [...document.querySelectorAll('#session-deck .deck-tile .terminal-pane')]
        .some((item) => item.dataset.sessionKey === (pane ? pane.dataset.sessionKey : ''))
    };
  })()`);
  check('종료 실패 검사 대상 세션이 실제로 존재한다',
    target.rows === rowsBefore + 1 && Boolean(target.key),
    JSON.stringify(target));

  // 다음 closeSession을 rejected promise로 만든다.
  const closesBefore = await evaluate(
    'window.rendererSmoke.closeSessionCalls().length'
  );
  await evaluate('window.rendererSmoke.failNextCloseSession()');
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    rows[rows.length - 1].querySelector('.session-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`);
  await wait(1200);

  const afterFailure = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')]
      .map((row) => row.querySelector('.session-name').textContent);
    const paneKeys = [...document.querySelectorAll('.terminal-pane')]
      .map((pane) => pane.dataset.sessionKey);
    const states = window.rendererSmoke.savedStates();
    const saved = states[states.length - 1];
    const savedKeys = saved.tabs.map((tab) => tab.key);
    const referenced = saved.deck.tiles
      .map((tile) => tile.sessionKey || tile.currentSessionKey)
      .filter(Boolean);
    return {
      rows,
      paneKeys,
      closes: window.rendererSmoke.closeSessionCalls().length,
      startDisabled: document.querySelector('#start-deck-edit').disabled,
      editing: document.querySelector('#session-deck').classList.contains('editing'),
      savedKeys,
      dangling: referenced.filter((key) => !savedKeys.includes(key)),
      focused: saved.deck.focusedSessionKey,
      focusVisible: saved.deck.focusedSessionKey === null
        || referenced.includes(saved.deck.focusedSessionKey),
      tileCount: saved.deck.tiles.length,
      unhandled: window.__unhandledRejections
    };
  })()`);

  check('실패 경로가 실제로 closeSession을 호출했다',
    afterFailure.closes === closesBefore + 1,
    `${closesBefore} -> ${afterFailure.closes}`);
  check('IPC reject 후에도 lifecycle 잠금이 풀리고 편집 버튼이 활성된다',
    afterFailure.startDisabled === false && afterFailure.editing === false,
    `disabled=${afterFailure.startDisabled}`);
  check('IPC reject 후 종료되지 않은 세션이 목록과 pane에 유지된다',
    afterFailure.rows.includes(target.name)
    && afterFailure.paneKeys.includes(target.key)
    && afterFailure.rows.length === rowsBefore + 1,
    `${JSON.stringify(afterFailure.rows)} / ${JSON.stringify(afterFailure.paneKeys)}`);
  check('IPC reject 후 deck에 dangling session key가 없다',
    afterFailure.dangling.length === 0
    && afterFailure.savedKeys.includes(target.key),
    JSON.stringify(afterFailure.dangling));
  check('IPC reject 후 포커스가 표시 중인 세션이거나 없음이다',
    afterFailure.focusVisible === true,
    `${afterFailure.focused}`);
  check('IPC reject가 unhandled rejection을 만들지 않는다',
    afterFailure.unhandled === 0, String(afterFailure.unhandled));

  // 실패 뒤에도 배치 편집 진입·완료가 정상 동작한다.
  await evaluate("document.querySelector('#start-deck-edit').click()");
  await wait(500);
  const editingAfterFailure = await evaluate(
    "document.querySelector('#session-deck').classList.contains('editing')"
  );
  await evaluate("document.querySelector('#commit-deck-edit').click()");
  await wait(800);
  const committedAfterFailure = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const saved = states[states.length - 1];
    const keys = saved.tabs.map((tab) => tab.key);
    const referenced = saved.deck.tiles
      .map((tile) => tile.sessionKey || tile.currentSessionKey)
      .filter(Boolean);
    return {
      editing: document.querySelector('#session-deck').classList.contains('editing'),
      hasRetained: keys.includes('${target.key}')
        || referenced.includes('${target.key}'),
      dangling: referenced.filter((key) => !keys.includes(key)),
      unhandled: window.__unhandledRejections
    };
  })()`);
  check('IPC reject 후에도 배치 편집 진입과 완료가 가능하다',
    editingAfterFailure === true && committedAfterFailure.editing === false,
    `${editingAfterFailure} -> ${committedAfterFailure.editing}`);
  check('완료 저장 payload에도 종료 실패 세션이 유지되고 dangling key가 없다',
    committedAfterFailure.hasRetained === true
    && committedAfterFailure.dangling.length === 0
    && committedAfterFailure.unhandled === 0,
    JSON.stringify(committedAfterFailure));

  // kill-timeout 뒤 늦게 온 close-requested exit는 main과 같은 시점에 UI에서도 정리한다.
  await evaluate(`window.rendererSmoke.emitExit(
    window.rendererSmoke.closeSessionCalls().at(-1),
    true
  )`);
  await wait(700);
  check('늦은 PTY exit가 종료 요청 세션을 UI와 저장 상태에서 함께 제거한다',
    await evaluate(`(() => {
      const panes = [...document.querySelectorAll('.terminal-pane')]
        .map((item) => item.dataset.sessionKey);
      const states = window.rendererSmoke.savedStates();
      const keys = states[states.length - 1].tabs.map((tab) => tab.key);
      return !panes.includes(${JSON.stringify(target.key)})
        && !keys.includes(${JSON.stringify(target.key)});
    })()`),
    target.key);
}

async function verifyDeckEditing(evaluate) {
  // 편집 진입 시 최대화가 해제되는지 보기 위해 먼저 한 타일을 최대화해 둔다.
  await evaluate(`document.querySelector('.deck-tile[data-tile-id="p1"] .deck-tile-button')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await wait(500);

  const beforeEdit = await evaluate(READ_EDIT);
  const deckBeforeEdit = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  const tilesBeforeEdit = await evaluate(READ_TILES);

  // --- 편집 진입 ---
  await evaluate("document.querySelector('#start-deck-edit').click()");
  await wait(600);
  const editing = await evaluate(READ_EDIT);
  const editingTiles = await evaluate(READ_TILES);
  // 저장 기준선은 편집에 들어온 뒤에 잡는다.
  const savesBeforeEdit = await evaluate('window.rendererSmoke.savedStateCount()');
  check('배치 편집에 들어가면 4×4 grid overlay가 보인다',
    editing.editing === true
    && editing.overlayHidden === false
    && editing.overlayCells === 16,
    `${editing.editing} / cells=${editing.overlayCells}`);
  check('모든 타일에 이동·크기 handle이 표시된다',
    editing.dragHandles === 4 && editing.resizeHandles === 4,
    `${editing.dragHandles} / ${editing.resizeHandles}`);
  check('편집 진입 시 최대화가 해제되고 최대화 버튼이 비활성된다',
    editingTiles.every((tile) => !tile.hidden && !tile.maximized)
    && editingTiles.every((tile) => tile.maximizeDisabled === true),
    JSON.stringify(editingTiles.map((tile) => tile.maximized)));
  check('배치 편집 중에는 처음 폴더·붙여넣기·cls가 비활성된다',
    editingTiles.filter((tile) => !tile.pasteHidden)
      .every((tile) => tile.titleDisabled && tile.pasteDisabled && tile.clearDisabled),
    JSON.stringify(editingTiles));
  check('터미널 입력 잠금 overlay가 표시된다',
    editing.locks === 4
    && editing.lockText === '배치 편집 중에는 터미널 입력이 잠깁니다.',
    `${editing.locks} / ${editing.lockText}`);
  check('편집 상태가 live region으로 안내된다',
    editing.status.includes('배치 편집 중')
    && editing.statusLive === 'polite'
    && editing.startHidden === true
    && editing.commitHidden === false
    && editing.cancelHidden === false,
    `${editing.status} / ${editing.statusLive}`);
  check('편집 진입이 Terminal을 다시 만들지 않는다',
    editing.xtermCount === beforeEdit.xtermCount
    && editing.paneCount === beforeEdit.paneCount,
    `${beforeEdit.xtermCount} -> ${editing.xtermCount}`);

  // --- 입력 잠금 ---
  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`(() => {
    const pane = document.querySelector('.terminal-pane[data-session-key="key-rot-e"]');
    const data = new DataTransfer();
    data.setData('text/plain', 'echo locked\\r');
    pane.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
    const textarea = pane.querySelector('.xterm-helper-textarea');
    if (textarea) {
      textarea.focus();
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    }
    document.querySelector('#favorite-list .favorite-run').click();
    document.querySelector('#favorite-list .utility-item')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const history = document.querySelector('#history-list .history-item');
    if (history) {
      history.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
    const block = document.querySelector('#command-block-list .command-block');
    if (block) {
      block.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    }
  })()`);
  await wait(500);
  const lockedWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('편집 중에는 붙여넣기·즐겨찾기·히스토리·블록 실행이 write를 만들지 않는다',
    lockedWrites.length === 0, JSON.stringify(lockedWrites));

  const blocksBeforeOutput = await evaluate(READ_BLOCKS);
  await evaluate(`(() => {
    const sessionId = document.querySelector(
      '.terminal-pane[data-session-key="key-rot-d"]'
    ).dataset.sessionId;
    window.rendererSmoke.emitCommandBlock(
      sessionId, 'Write-Output "편집 중 출력"', '편집 중 출력'
    );
  })()`);
  await wait(600);
  const editTilesAfterOutput = await evaluate(READ_TILES);
  check('편집 중에도 PTY 출력과 블록 수집은 계속된다',
    Number(editTilesAfterOutput.find((tile) => tile.tileId === 'r2')
      .blocks.replace('블록 ', '')) > 0,
    editTilesAfterOutput.find((tile) => tile.tileId === 'r2').blocks);
  void blocksBeforeOutput;

  // --- 타일 제거로 빈 공간 만들기 ---
  const closesBeforeRemove = await evaluate(
    'window.rendererSmoke.closeSessionCalls().length'
  );
  const rowsBeforeRemove = (await evaluate(READ_STATE)).rows.length;
  await evaluate(`(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="p2"]');
    tile.querySelectorAll('.deck-tile-button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const items = [...tile.querySelectorAll('.deck-tile-menu-item')];
    items.find((item) => item.textContent.includes('배치에서 타일 제거')).click();
  })()`);
  await wait(500);
  const afterRemove = await evaluate(READ_EDIT);
  const afterRemoveState = await evaluate(READ_STATE);
  check('배치에서 타일을 제거하면 그 자리가 빈 칸이 된다',
    afterRemove.freeCells.length === 4
    && afterRemove.freeCells.includes('0,2'),
    JSON.stringify(afterRemove.freeCells));
  check('타일 제거가 세션과 목록·히스토리를 유지한다',
    afterRemoveState.rows.length === rowsBeforeRemove
    && afterRemoveState.rows.some((row) => row.name === '고정 베타'),
    String(afterRemoveState.rows.length));
  check('타일 제거는 closeSession을 호출하지 않는다',
    await evaluate('window.rendererSmoke.closeSessionCalls().length')
      === closesBeforeRemove);
  check('제거된 고정 세션은 숨은 순환 세션이 된다',
    afterRemoveState.rows.find((row) => row.name === '고정 베타')
      .placement.includes('숨김'),
    afterRemoveState.rows.find((row) => row.name === '고정 베타').placement);

  // --- 이동 ---
  const validMove = await evaluate(tileGesture('r2', 'deck-tile-drag-handle', 0, -2, 'up'));
  await wait(400);
  const afterMove = await evaluate(READ_EDIT);
  check('유효한 이동은 preview가 정상 강조된다',
    validMove.valid === true && validMove.invalid === false,
    JSON.stringify(validMove));
  check('유효한 이동이 cell 단위로 snap되어 commit된다',
    afterMove.geometry.includes('r2:1 / span 2|3 / span 2'),
    JSON.stringify(afterMove.geometry));

  const overlapMove = await evaluate(tileGesture('r2', 'deck-tile-drag-handle', -2, 0, 'up'));
  await wait(400);
  const afterOverlap = await evaluate(READ_EDIT);
  check('겹치는 이동은 danger preview를 보여준다',
    overlapMove.invalid === true
    && overlapMove.lockText.includes('배치할 수 없음'),
    JSON.stringify(overlapMove));
  check('겹치는 이동은 commit되지 않고 원래 자리로 돌아온다',
    afterOverlap.geometry.includes('r2:1 / span 2|3 / span 2'),
    JSON.stringify(afterOverlap.geometry));

  const outOfBounds = await evaluate(tileGesture('r2', 'deck-tile-drag-handle', 2, 0, 'up'));
  await wait(400);
  const afterBounds = await evaluate(READ_EDIT);
  check('격자 밖 이동도 거부되고 원래 자리로 돌아온다',
    outOfBounds.invalid === true
    && afterBounds.geometry.includes('r2:1 / span 2|3 / span 2'),
    JSON.stringify(afterBounds.geometry));

  await evaluate(tileGesture('r2', 'deck-tile-drag-handle', 0, 2, 'escape'));
  await wait(400);
  const afterEscape = await evaluate(READ_EDIT);
  check('gesture 중 Escape는 그 gesture만 취소한다',
    afterEscape.editing === true
    && afterEscape.geometry.includes('r2:1 / span 2|3 / span 2'),
    `${afterEscape.editing} / ${JSON.stringify(afterEscape.geometry)}`);

  await evaluate(tileGesture('r2', 'deck-tile-drag-handle', 0, 2, 'cancel'));
  await wait(400);
  const afterPointerCancel = await evaluate(READ_EDIT);
  check('pointercancel도 그 gesture만 취소한다',
    afterPointerCancel.editing === true
    && afterPointerCancel.geometry.includes('r2:1 / span 2|3 / span 2'),
    JSON.stringify(afterPointerCancel.geometry));

  // --- resize ---
  const validResize = await evaluate(
    tileGesture('r2', 'deck-tile-resize-handle', -1, 0, 'up')
  );
  await wait(400);
  const afterResize = await evaluate(READ_EDIT);
  check('resize는 시작 위치를 고정하고 크기만 줄인다',
    validResize.valid === true
    && afterResize.geometry.includes('r2:1 / span 2|3 / span 1'),
    JSON.stringify(afterResize.geometry));

  // p1(0,0,2×2) 오른쪽에는 r2가 있어 한 칸만 넓혀도 겹친다.
  const overlapResize = await evaluate(
    tileGesture('p1', 'deck-tile-resize-handle', 1, 0, 'up')
  );
  await wait(400);
  const afterOverlapResize = await evaluate(READ_EDIT);
  check('겹치는 resize는 거부되고 원래 크기로 돌아온다',
    overlapResize.invalid === true
    && afterOverlapResize.geometry.includes('p1:1 / span 2|1 / span 2'),
    `${JSON.stringify(overlapResize)} / ${JSON.stringify(afterOverlapResize.geometry)}`);

  check('gesture 동안 저장이 일어나지 않는다',
    await evaluate('window.rendererSmoke.savedStateCount()') === savesBeforeEdit,
    `${savesBeforeEdit} -> ${await evaluate('window.rendererSmoke.savedStateCount()')}`);

  // --- 타일 추가 ---
  const freeForRotating = afterOverlapResize.freeCells[0].split(',');
  await evaluate(`document.querySelector('.deck-grid-cell.free[data-row="${freeForRotating[0]}"][data-column="${freeForRotating[1]}"]').click()`);
  await wait(400);
  const dialogState = await evaluate(`({
    open: document.querySelector('#add-tile-dialog').open,
    pickerHidden: document.querySelector('#add-tile-session-picker').hidden,
    confirmDisabled: document.querySelector('#confirm-add-tile').disabled
  })`);
  check('빈 cell을 누르면 타일 추가 dialog가 열린다',
    dialogState.open === true && dialogState.pickerHidden === true,
    JSON.stringify(dialogState));
  await evaluate("document.querySelector('#confirm-add-tile').click()");
  await wait(500);
  const afterAddRotating = await evaluate(READ_EDIT);
  check('빈 cell에 순환 타일이 추가된다',
    afterAddRotating.tags.filter((tag) => tag.startsWith('순환')).length === 3
    && afterAddRotating.tags.includes('순환3'),
    JSON.stringify(afterAddRotating.tags));

  // --- 고정 타일 추가 ---
  const remainingFree = afterAddRotating.freeCells[0];
  if (remainingFree) {
    const [freeRow, freeColumn] = remainingFree.split(',');
    await evaluate(`document.querySelector('.deck-grid-cell.free[data-row="${freeRow}"][data-column="${freeColumn}"]').click()`);
    await wait(400);
    const pinnedDialog = await evaluate(`(() => {
      const form = document.querySelector('#add-tile-form');
      form.elements['add-tile-kind'].value = 'pinned';
      form.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        pickerHidden: document.querySelector('#add-tile-session-picker').hidden,
        options: [...document.querySelector('#add-tile-session').options]
          .map((option) => option.value),
        confirmDisabled: document.querySelector('#confirm-add-tile').disabled
      };
    })()`);
    check('고정 칸 추가는 세션 선택을 요구한다',
      pinnedDialog.pickerHidden === false
      && pinnedDialog.options.length > 0
      && pinnedDialog.confirmDisabled === false,
      JSON.stringify(pinnedDialog));
    await evaluate(`(() => {
      document.querySelector('#add-tile-session').value = 'key-pinned-b';
      document.querySelector('#confirm-add-tile').click();
    })()`);
    await wait(500);
    const afterAddPinned = await evaluate(READ_EDIT);
    const afterAddPinnedTiles = await evaluate(READ_TILES);
    check('고정 칸 추가가 선택한 세션을 고정한다',
      afterAddPinnedTiles.some((tile) =>
        tile.paneSessionKey === 'key-pinned-b' && tile.tag.startsWith('고정')),
      JSON.stringify(afterAddPinnedTiles.map((tile) =>
        `${tile.tag}:${tile.paneSessionKey}`)));
    check('한 세션이 두 타일에 표시되지 않는다',
      new Set(afterAddPinnedTiles.map((tile) => tile.paneSessionKey)
        .filter(Boolean)).size
        === afterAddPinnedTiles.filter((tile) => tile.paneSessionKey).length,
      JSON.stringify(afterAddPinnedTiles.map((tile) => tile.paneSessionKey)));
    void afterAddPinned;
  }

  // --- 변환 ---
  await evaluate(`(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="r1"]');
    tile.querySelectorAll('.deck-tile-button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...tile.querySelectorAll('.deck-tile-menu-item')]
      .find((item) => item.textContent.includes('고정으로')).click();
  })()`);
  await wait(500);
  const afterToPinned = await evaluate(READ_TILES);
  check('순환 → 고정 변환이 같은 타일에서 이루어진다',
    afterToPinned.find((tile) => tile.tileId === 'r1').tag.startsWith('고정'),
    afterToPinned.find((tile) => tile.tileId === 'r1').tag);

  await evaluate(`(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="r1"]');
    tile.querySelectorAll('.deck-tile-button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...tile.querySelectorAll('.deck-tile-menu-item')]
      .find((item) => item.textContent.includes('순환으로')).click();
  })()`);
  await wait(500);
  const afterToRotating = await evaluate(READ_TILES);
  check('고정 → 순환 변환도 같은 타일에서 이루어진다',
    afterToRotating.find((tile) => tile.tileId === 'r1').tag.startsWith('순환'),
    afterToRotating.find((tile) => tile.tileId === 'r1').tag);

  // --- 마지막 순환 타일 제거 거부 ---
  const rotatingIds = afterToRotating
    .filter((tile) => tile.tag.startsWith('순환'))
    .map((tile) => tile.tileId);
  for (const tileId of rotatingIds.slice(1)) {
    await evaluate(`(() => {
      const tile = document.querySelector('.deck-tile[data-tile-id="${tileId}"]');
      tile.querySelectorAll('.deck-tile-button')[1]
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      [...tile.querySelectorAll('.deck-tile-menu-item')]
        .find((item) => item.textContent.includes('배치에서 타일 제거')).click();
    })()`);
    await wait(350);
  }
  const beforeLastRemoval = await evaluate(READ_EDIT);
  await evaluate(`(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="${rotatingIds[0]}"]');
    tile.querySelectorAll('.deck-tile-button')[1]
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    [...tile.querySelectorAll('.deck-tile-menu-item')]
      .find((item) => item.textContent.includes('배치에서 타일 제거')).click();
  })()`);
  await wait(400);
  const afterLastRemoval = await evaluate(READ_EDIT);
  check('마지막 순환 타일 제거는 거부된다',
    afterLastRemoval.tags.filter((tag) => tag.startsWith('순환')).length === 1
    && afterLastRemoval.status.includes('마지막 순환 타일'),
    `${JSON.stringify(afterLastRemoval.tags)} / ${afterLastRemoval.status}`);
  void beforeLastRemoval;

  // --- 취소 ---
  await evaluate("document.querySelector('#cancel-deck-edit').click()");
  await wait(700);
  const afterCancel = await evaluate(READ_EDIT);
  const tilesAfterCancel = await evaluate(READ_TILES);
  const deckAfterCancel = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  check('취소하면 편집 모드가 끝나고 overlay와 handle이 사라진다',
    afterCancel.editing === false
    && afterCancel.overlayHidden === true
    && afterCancel.dragHandles === 0
    && afterCancel.resizeHandles === 0
    && afterCancel.locks === 0,
    JSON.stringify(afterCancel));
  const describeTiles = (tiles) => JSON.stringify(tiles
    .map((tile) => [tile.tileId, tile.tag, tile.gridRow, tile.gridColumn,
      tile.paneSessionKey])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  check('취소하면 원래 배치가 그대로 복원된다',
    describeTiles(tilesAfterCancel) === describeTiles(tilesBeforeEdit),
    `${describeTiles(tilesBeforeEdit)}
    -> ${describeTiles(tilesAfterCancel)}`);
  check('취소 후 타일 DOM 순서가 모델 순서와 같다',
    JSON.stringify(tilesAfterCancel.map((tile) => tile.tileId))
      === JSON.stringify(['p1', 'p2', 'r1', 'r2']),
    JSON.stringify(tilesAfterCancel.map((tile) => tile.tileId)));
  check('취소는 저장하지 않는다', deckAfterCancel === deckBeforeEdit,
    `${deckBeforeEdit}\n    -> ${deckAfterCancel}`);
  check('취소 후 Terminal이 다시 만들어지지 않았다',
    afterCancel.xtermCount === beforeEdit.xtermCount,
    `${beforeEdit.xtermCount} -> ${afterCancel.xtermCount}`);

  // 편집이 끝나면 입력이 복구된다.
  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`(() => {
    const pane = document.querySelector('.terminal-pane[data-session-key="key-rot-e"]');
    const data = new DataTransfer();
    data.setData('text/plain', 'echo unlocked\\r');
    pane.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true
    }));
  })()`);
  await wait(400);
  check('편집을 끝내면 터미널 입력이 복구된다',
    (await evaluate('window.rendererSmoke.writeCalls()')).length > 0);

  // --- 완료 ---
  await evaluate('window.rendererSmoke.clearResizeCalls()');
  const savesBeforeCommit = await evaluate('window.rendererSmoke.savedStateCount()');
  await evaluate("document.querySelector('#start-deck-edit').click()");
  await wait(500);
  await evaluate(tileGesture('r2', 'deck-tile-resize-handle', -1, 0, 'up'));
  await wait(400);
  await evaluate("document.querySelector('#commit-deck-edit').click()");
  await wait(800);
  const afterCommit = await evaluate(READ_EDIT);
  const committedDeck = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck;
  })()`);
  const commitResizes = await evaluate('window.rendererSmoke.resizeCalls()');
  const focusAfterCommit = await evaluate(READ_FOCUS);
  check('완료하면 편집 모드가 끝나고 조작부가 사라진다',
    afterCommit.editing === false
    && afterCommit.dragHandles === 0
    && afterCommit.locks === 0
    && afterCommit.startHidden === false,
    JSON.stringify(afterCommit));
  check('완료한 배치가 저장된다',
    committedDeck.tiles.find((tile) => tile.id === 'r2').columnSpan === 1,
    JSON.stringify(committedDeck.tiles.map((tile) =>
      `${tile.id}:${tile.rowSpan}x${tile.columnSpan}`)));
  check('완료 시 저장은 한 번만 예약된다',
    await evaluate('window.rendererSmoke.savedStateCount()')
      === savesBeforeCommit + 1,
    `${savesBeforeCommit} -> ${await evaluate('window.rendererSmoke.savedStateCount()')}`);
  check('완료 후 표시 terminal이 다시 fit된다',
    commitResizes.length > 0
    && commitResizes.every((call) => call.cols > 0 && call.rows > 0),
    JSON.stringify(commitResizes));
  check('완료 후 터미널로 포커스가 돌아온다',
    focusAfterCommit.inTerminal === true, JSON.stringify(focusAfterCommit));
  check('저장된 배치를 다시 정규화해도 동일하다', await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const deck = states[states.length - 1].deck;
    const ids = deck.tiles.map((tile) => tile.id);
    const rotation = deck.tiles.filter((tile) => tile.kind === 'rotating')
      .map((tile) => tile.rotationIndex);
    return new Set(ids).size === ids.length
      && new Set(rotation).size === rotation.length
      && rotation.length >= 1;
  })()`));
}

async function verify(window) {
  const evaluate = async (code) => {
    try {
      return await window.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error(
        `${error.message}\nRenderer smoke expression: ${String(code).slice(0, 500)}`
      );
    }
  };

  // 작업 공간 선택 모달은 사용자 조작으로만 닫힌다.
  await wait(700);
  const workspaceElevation = await evaluate(`({
    badge: document.querySelector('.workspace-elevation')?.textContent || '',
    clone: [...document.querySelectorAll('.workspace-card-actions button')]
      .some((button) => button.textContent === '복제'),
    option: document.querySelector('#workspace-elevation').type,
    runtimeBadge: document.querySelector('#workspace-elevation-badge').textContent
  })`);
  check('관리자 작업 공간이 선택 목록에서 구분되고 권한 설정을 바꿀 수 있다',
    workspaceElevation.badge === '요청: 관리자'
    && workspaceElevation.clone === true
    && workspaceElevation.option === 'checkbox'
    && workspaceElevation.runtimeBadge === '앱 권한: 일반',
    JSON.stringify(workspaceElevation));
  const workspaceCloneEditor = await evaluate(`(() => {
    [...document.querySelectorAll('.workspace-card-actions button')]
      .find((button) => button.textContent === '복제')?.click();
    return {
      title: document.querySelector('#workspace-editor-title').textContent,
      sourceId: document.querySelector('#workspace-source-id').value,
      name: document.querySelector('#workspace-name').value,
      noteHidden: document.querySelector('#workspace-clone-note').hidden,
      note: document.querySelector('#workspace-clone-note').textContent.trim()
    };
  })()`);
  check('작업 공간 복제 편집기는 원본을 표시하고 복제 제외 항목을 안내한다',
    workspaceCloneEditor.title === '작업 공간 복제'
    && workspaceCloneEditor.sourceId === 'admin-workspace'
    && workspaceCloneEditor.name === '관리 작업 공간 복사본'
    && workspaceCloneEditor.noteHidden === false
    && workspaceCloneEditor.note.includes('명령 히스토리'),
    JSON.stringify(workspaceCloneEditor));
  await evaluate("document.querySelector('#cancel-workspace-edit').click()");
  await evaluate("document.querySelector('#open-ephemeral-workspace').click()");
  await wait(2000);

  const restored = await evaluate(READ_STATE);
  const tiles = await evaluate(READ_TILES);
  const parking = await evaluate(READ_PARKING);
  check('상단 탭 strip이 없다', !restored.tabStrip);
  check('왼쪽 목록이 listbox/option 구조다',
    restored.listRole === 'listbox'
    && restored.rows.every((row) => row.role === 'option'));
  check('저장된 세션 5개가 복원된다', restored.rows.length === 5,
    JSON.stringify(restored.rows.map((row) => row.name)));
  check('즐겨찾기가 복원되고 상단에는 등록 순서대로 최대 세 개만 표시된다',
    restored.favoriteCount === '4'
    && JSON.stringify(restored.favoriteShortcuts) === JSON.stringify(['빌드', '테스트', '상태']),
    `${restored.favoriteCount} / ${JSON.stringify(restored.favoriteShortcuts)}`);
  check('상단 명령 즐겨찾기가 오른쪽 동작 영역에 정렬된다',
    restored.favoriteLeft > restored.toolbarWidth / 2,
    `${restored.favoriteLeft} / ${restored.toolbarWidth}`);
  check('기존 상단의 작업공간·PowerShell·경로·terminal 설명 DOM이 제거된다',
    restored.removedTopMetadata === true);
  check('작업공간 이름과 설명이 프로그램 창 제목에 표시된다',
    restored.documentTitle === '스모크 작업 공간 — 렌더러 동작 검증 — Terminal Deck',
    restored.documentTitle);
  check('상단 순환 바로 가기는 고정 terminal을 제외하고 등록 순서를 유지한다',
    JSON.stringify(restored.rotationShortcuts.map((item) => item.name))
      === JSON.stringify(['순환 감마', '순환 델타', '순환 엡실론'])
    && restored.rotationShortcuts.filter((item) => item.pressed === 'true').length === 1
    && restored.rotationShortcuts[0].pressed === 'true',
    JSON.stringify(restored.rotationShortcuts));

  // --- 다중 타일 렌더링 ---
  check('저장된 고정 2 + 순환 2가 4개 타일로 렌더된다',
    tiles.length === 4 && restored.visibleTileCount === 4,
    `${tiles.length} / ${restored.visibleTileCount}`);
  check('타일 id가 저장된 배치와 같다',
    JSON.stringify(tiles.map((tile) => tile.tileId))
      === JSON.stringify(['p1', 'p2', 'r1', 'r2']),
    JSON.stringify(tiles.map((tile) => tile.tileId)));
  check('타일 geometry가 CSS Grid에 반영된다',
    JSON.stringify(tiles.map((tile) => `${tile.gridRow}|${tile.gridColumn}`))
      === JSON.stringify([
        '1 / span 2|1 / span 2',
        '1 / span 2|3 / span 2',
        '3 / span 2|1 / span 2',
        '3 / span 2|3 / span 2'
      ]),
    JSON.stringify(tiles.map((tile) => `${tile.gridRow}|${tile.gridColumn}`)));
  check('타일 태그가 고정N/순환N을 쓴다',
    JSON.stringify(tiles.map((tile) => tile.tag))
      === JSON.stringify(['고정1', '고정2', '순환1', '순환2']),
    JSON.stringify(tiles.map((tile) => tile.tag)));
  const placementMenu = await evaluate(`(() => {
    const row = document.querySelector('#session-list .session-row');
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80
    }));
    const menu = document.querySelector('.session-context-menu');
    return {
      hidden: menu.hidden,
      selectCount: document.querySelectorAll('.session-placement-select').length,
      items: [...menu.querySelectorAll('.session-context-menu-item')]
        .map((item) => item.textContent),
      checked: [...menu.querySelectorAll('.session-context-menu-item')]
        .map((item) => item.getAttribute('aria-checked'))
    };
  })()`);
  check('terminal 행 우클릭 메뉴에서 모든 순환/고정 칸을 선택할 수 있다',
    placementMenu.hidden === false
    && placementMenu.selectCount === 0
    && JSON.stringify(placementMenu.items)
      === JSON.stringify(['고정1', '고정2', '순환1', '순환2'])
    && JSON.stringify(placementMenu.checked)
      === JSON.stringify(['true', 'false', 'false', 'false']),
    JSON.stringify(placementMenu));
  await evaluate(
    "document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))"
  );
  check('4개 타일에 서로 다른 pane이 동시에 표시된다',
    tiles.every((tile) => tile.paneCount === 1 && tile.paneHidden === false)
    && new Set(tiles.map((tile) => tile.paneSessionKey)).size === 4,
    JSON.stringify(tiles.map((tile) => tile.paneSessionKey)));
  check('pane 하나가 둘 이상의 타일에 붙지 않는다',
    parking.totalPanes === 5
    && tiles.reduce((sum, tile) => sum + tile.paneCount, 0) === 4,
    `total=${parking.totalPanes}`);
  check('타일에 없는 숨은 세션 pane은 주차 영역에 있고 숨겨진다',
    JSON.stringify(parking.parkedKeys) === JSON.stringify(['key-rot-e'])
    && parking.parkingHidden === true,
    JSON.stringify(parking.parkedKeys));
  check('각 타일이 실제 폭을 가진다',
    tiles.every((tile) => tile.bodyWidth > 0),
    JSON.stringify(tiles.map((tile) => tile.bodyWidth)));
  check('타일 header에 상태와 블록 수가 표시된다',
    tiles.every((tile) => tile.status.length > 0)
    && tiles.every((tile) => /^블록 [0-9]+$/u.test(tile.blocks)),
    JSON.stringify(tiles.map((tile) => `${tile.status}/${tile.blocks}`)));
  check('표시 중인 각 타일 header에 PowerShell·실행 경로·설명이 표시된다',
    tiles.every((tile) => tile.metadataHidden === false)
    && tiles.every((tile) => tile.shell === 'PowerShell 7')
    && tiles[0].cwd === 'D:\\work\\alpha'
    && tiles[0].description === '고정 세션'
    && tiles[1].description === '설명 추가…',
    JSON.stringify(tiles.map((tile) => [tile.shell, tile.cwd, tile.description])));
  check('타일 제목과 PowerShell·경로·설명은 한 줄 header에 표시된다',
    tiles.every((tile) => tile.metadataInHeaderMain && tile.headerHeight === 26),
    JSON.stringify(tiles.map((tile) => [tile.metadataInHeaderMain, tile.headerHeight])));

  // --- 표시와 포커스 분리 ---
  check('표시 세션은 여러 개지만 포커스 타일은 하나다',
    restored.focusedTileCount === 1, String(restored.focusedTileCount));
  check('저장된 focusedSessionKey가 포커스된다',
    restored.rows[2].selected === 'true'
    && restored.rows.filter((row) => row.selected === 'true').length === 1,
    JSON.stringify(restored.rows.map((row) => row.selected)));
  check('포커스 타일에만 현재 대상 표시가 뜬다',
    tiles.filter((tile) => !tile.focusMarkHidden).length === 1
    && tiles.find((tile) => tile.tileId === 'r1').focusMarkHidden === false,
    JSON.stringify(tiles.map((tile) => tile.focusMarkHidden)));
  check('포커스 타일 접근성 이름에 현재 대상이 들어간다',
    tiles.find((tile) => tile.tileId === 'r1').ariaLabel.includes('현재 대상')
    && tiles.filter((tile) => tile.ariaLabel.includes('현재 대상')).length === 1,
    JSON.stringify(tiles.map((tile) => tile.ariaLabel)));
  check('고정 세션은 고정 태그를 쓴다',
    restored.rows[0].placement.startsWith('고정1')
    && restored.rows[1].placement.startsWith('고정2'),
    JSON.stringify(restored.rows.map((row) => row.placement)));
  check('표시 중인 세션은 숨김 태그가 아니고 숨은 세션만 숨김이다',
    restored.rows.slice(0, 4).every((row) => !row.placement.includes('숨김'))
    && restored.rows[4].placement === '순환1 · 숨김',
    JSON.stringify(restored.rows.map((row) => row.placement)));
  check('왼쪽 선택·포커스 타일·오른쪽 대상이 같은 세션을 가리킨다',
    restored.tileTag === '순환1'
    && restored.tileTitle === '순환 감마'
    && restored.targetName === '순환 감마'
    && restored.targetMeta.startsWith('순환1')
    && restored.rows[2].name === '순환 감마',
    `${restored.tileTag} / ${restored.tileTitle} / ${restored.targetName}`);
  const compactInspector = await evaluate(READ_INSPECTOR);
  check('도구 패널 현재 대상 정보가 한 줄의 작은 높이로 표시된다',
    compactInspector.targetLabel === '대상'
    && compactInspector.targetHeight <= 34
    && compactInspector.targetMeta === '순환1 · 입력 대기',
    JSON.stringify(compactInspector));

  // 저장된 다중 타일 배치가 배치 편집 없이 그대로 저장되는지.
  const persistence = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return {
      saved: states[states.length - 1],
      persistedDeck: window.rendererSmoke.persistedDeck()
    };
  })()`);
  const saved = persistence.saved;
  const persisted = persistence.persistedDeck;
  check('저장 payload version이 3이다', saved.version === 3, String(saved.version));
  check('배치 편집 없이 열고 저장하면 tiles가 그대로다',
    JSON.stringify(saved.deck.tiles) === JSON.stringify(persisted.tiles),
    JSON.stringify(saved.deck.tiles));
  check('고정 타일과 geometry가 유지된다',
    saved.deck.tiles.filter((tile) => tile.kind === 'pinned').length === 2
    && saved.deck.tiles.every((tile) =>
      tile.rowSpan === 2 && tile.columnSpan === 2),
    JSON.stringify(saved.deck.tiles.map((tile) => tile.kind)));
  check('저장된 focusedSessionKey가 유지된다',
    saved.deck.focusedSessionKey === 'key-rot-c',
    String(saved.deck.focusedSessionKey));
  check('rotationSlot이 저장된 값을 유지한다',
    JSON.stringify(saved.tabs.map((tab) => tab.rotationSlot))
      === JSON.stringify([null, null, 1, 2, 1]),
    JSON.stringify(saved.tabs.map((tab) => tab.rotationSlot)));
  check('세션 키와 히스토리가 유지된다',
    saved.tabs[0].key === 'key-pinned-a'
    && saved.tabs[0].history.length === 1);

  // 고정 세션 클릭: 어떤 타일도 교체하지 않고 포커스만 옮긴다.
  await evaluate(`document.querySelectorAll('#session-list .session-row')[0]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(300);
  const pinnedFocused = await evaluate(READ_STATE);
  const pinnedTiles = await evaluate(READ_TILES);
  const afterPinnedClick = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck;
  })()`);
  check('고정 세션이 포커스된다', pinnedFocused.rows[0].selected === 'true',
    JSON.stringify(pinnedFocused.rows.map((row) => row.selected)));
  check('고정 세션 클릭이 순환 타일 currentSessionKey를 바꾸지 않는다',
    afterPinnedClick.tiles.find((tile) => tile.id === 'r1')
      .currentSessionKey === 'key-rot-c'
    && afterPinnedClick.tiles.find((tile) => tile.id === 'r2')
      .currentSessionKey === 'key-rot-d',
    JSON.stringify(afterPinnedClick.tiles));
  check('고정 세션 클릭이 어떤 pane도 옮기지 않는다',
    JSON.stringify(pinnedTiles.map((tile) => tile.paneReparents))
      === JSON.stringify(tiles.map((tile) => tile.paneReparents)),
    JSON.stringify(pinnedTiles.map((tile) => tile.paneReparents)));
  check('포커스 타일이 고정1 타일로 옮겨간다',
    pinnedTiles.find((tile) => tile.tileId === 'p1').focused === true
    && pinnedTiles.filter((tile) => tile.focused).length === 1,
    JSON.stringify(pinnedTiles.map((tile) => tile.focused)));
  check('타일 태그가 고정1로 바뀐다', pinnedFocused.tileTag === '고정1',
    pinnedFocused.tileTag);
  check('현재 대상도 고정1을 표시한다',
    pinnedFocused.targetMeta.startsWith('고정1'), pinnedFocused.targetMeta);

  // 상단에서 옮겨온 타일별 설명을 같은 자리에서 편집하고 저장한다.
  const tileDescriptionEdited = await evaluate(`(() => {
    const description = document.querySelector(
      '.deck-tile[data-tile-id="p1"] .deck-tile-description'
    );
    description.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = document.querySelector(
      '.deck-tile[data-tile-id="p1"] .deck-tile-description-edit'
    );
    if (!input) { return false; }
    input.value = '타일에서 수정한 설명';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await wait(350);
  const descriptionSaved = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const saved = states[states.length - 1];
    return {
      tile: document.querySelector(
        '.deck-tile[data-tile-id="p1"] .deck-tile-description'
      ).textContent,
      saved: saved.tabs.find((tab) => tab.key === 'key-pinned-a').description
    };
  })()`);
  check('타일 header의 terminal 설명을 더블클릭해 편집하고 저장할 수 있다',
    tileDescriptionEdited === true
    && descriptionSaved.tile === '타일에서 수정한 설명'
    && descriptionSaved.saved === '타일에서 수정한 설명',
    JSON.stringify(descriptionSaved));

  // 포커스된 세션에서 명령이 끝나면 완료 상태와 주의 강조가 남는다.
  // session-1 = key-pinned-a(지금 포커스된 고정 세션).
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-1', 'Write-Output \"완료 표시\"', '완료 표시 출력')"
  );
  await wait(600);
  const completedState = await evaluate(READ_STATE);
  const completedTiles = await evaluate(READ_TILES);
  const deckBeforeReclick = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  check('포커스 세션의 명령이 끝나면 완료 상태와 주의 강조가 남는다',
    completedState.rows[0].badgeStatus === 'complete'
    && completedState.rows[0].attention === true
    && completedTiles.find((tile) => tile.tileId === 'p1').status === '명령 종료',
    `${completedState.rows[0].badgeStatus} / attention=${completedState.rows[0].attention}`
      + ` / ${completedTiles.find((tile) => tile.tileId === 'p1').status}`);
  const attentionCenter = await evaluate(`(() => {
    const trigger = document.querySelector('#open-attention-center');
    trigger.click();
    const rows = [...document.querySelectorAll('.attention-center-item')];
    const result = {
      trigger: trigger.textContent,
      open: document.querySelector('#attention-center-dialog').open,
      rows: rows.map((row) => row.textContent),
      kinds: rows.map((row) => row.querySelector('.attention-center-kind').dataset.kind)
    };
    document.querySelector('#close-attention-center').click();
    return result;
  })()`);
  check('Attention Center가 확인하지 않은 완료 결과를 목록으로 보여준다',
    attentionCenter.trigger === '확인 1'
    && attentionCenter.open === true
    && attentionCenter.rows.some((text) => text.includes('고정 알파'))
    && attentionCenter.kinds.includes('complete'),
    JSON.stringify(attentionCenter));

  // 같은 행을 다시 클릭: 상태·주의만 정리하고 배치와 DOM은 그대로여야 한다.
  await evaluate(`document.querySelectorAll('#session-list .session-row')[0]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(350);
  const reclicked = await evaluate(READ_TILES);
  const reclickedState = await evaluate(READ_STATE);
  const deckAfterReclick = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  check('재클릭이 완료 상태를 입력 대기로 되돌린다',
    reclickedState.rows[0].badgeStatus === 'ready'
    && reclickedState.rows[0].badge.includes('입력 대기'),
    `${reclickedState.rows[0].badgeStatus} / ${reclickedState.rows[0].badge}`);
  check('재클릭이 주의 강조를 해제한다',
    reclickedState.rows[0].attention === false,
    String(reclickedState.rows[0].attention));
  check('재클릭 후 타일 header 상태도 입력 대기로 갱신된다',
    reclicked.find((tile) => tile.tileId === 'p1').status === '입력 대기',
    reclicked.find((tile) => tile.tileId === 'p1').status);
  check('재클릭 후 완료 toast가 남지 않는다', reclickedState.toasts === 0,
    String(reclickedState.toasts));
  check('재클릭이 deck과 currentSessionKey를 바꾸지 않는다',
    deckAfterReclick === deckBeforeReclick,
    `${deckBeforeReclick}\n    -> ${deckAfterReclick}`);
  check('재클릭이 pane을 옮기지 않는다',
    JSON.stringify(reclicked.map((tile) => tile.paneReparents))
      === JSON.stringify(completedTiles.map((tile) => tile.paneReparents)),
    JSON.stringify(reclicked.map((tile) => tile.paneReparents)));

  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-1', 'throw \"실패\"', '실패 출력', 1)"
  );
  await wait(300);
  const failedState = await evaluate(READ_STATE);
  check('nonzero OSC D는 명령 종료가 아니라 실패 attention을 만든다',
    failedState.rows[0].badgeStatus === 'failed'
    && failedState.rows[0].badge.includes('실패')
    && failedState.rows[0].attention === true,
    JSON.stringify(failedState.rows[0]));
  const acknowledgedFailure = await evaluate(`(() => {
    document.querySelector('#open-attention-center').click();
    document.querySelector('#acknowledge-all-attention').click();
    return {
      count: document.querySelector('#open-attention-center').textContent,
      badge: document.querySelector('#session-list .session-row .session-status-badge')
        .dataset.status,
      empty: document.querySelector('#attention-center-empty').hidden
    };
  })()`);
  check('Attention Center의 모두 확인이 실패 알림을 해제한다',
    acknowledgedFailure.count === '확인 0'
    && acknowledgedFailure.badge === 'ready'
    && acknowledgedFailure.empty === false,
    JSON.stringify(acknowledgedFailure));
  await evaluate("document.querySelector('#close-attention-center').click()");
  await evaluate(`document.querySelectorAll('#session-list .session-row')[0]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(150);
  check('재클릭 후에도 타일 배치와 표시 세션이 그대로다',
    JSON.stringify(reclicked.map((tile) => [
      tile.tileId, tile.paneSessionKey, tile.focused,
      tile.gridRow, tile.gridColumn
    ])) === JSON.stringify(completedTiles.map((tile) => [
      tile.tileId, tile.paneSessionKey, tile.focused,
      tile.gridRow, tile.gridColumn
    ])),
    JSON.stringify(reclicked.map((tile) => tile.paneSessionKey)));

  // terminal 목록을 접은 상태에서도 상단 버튼으로 순환1 세션을 교체할 수 있어야 한다.
  await evaluate(`(() => {
    const description = document.querySelector(
      '.deck-tile[data-tile-id="p1"] .deck-tile-description'
    );
    description.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    document.querySelector('.deck-tile-description-edit').value = 'blur 뒤에도 전환';
    // Hosted Windows may lack desktop focus; explicitly simulate the blur event.
    document.querySelector('.deck-tile-description-edit')
      .dispatchEvent(new FocusEvent('blur'));
    document.querySelector('#collapse-session-panel').click();
    const shortcut = [...document.querySelectorAll('.rotation-shortcut')]
      .find((button) => button.querySelector('.rotation-shortcut-name').textContent === '순환 엡실론');
    shortcut.click();
  })()`);
  await wait(350);
  const swapped = await evaluate(READ_TILES);
  const swappedState = await evaluate(READ_STATE);
  const swappedParking = await evaluate(READ_PARKING);
  const swappedDeck = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck;
  })()`);
  check('순환1 타일이 새 세션으로 교체된다',
    swapped.find((tile) => tile.tileId === 'r1').paneSessionKey === 'key-rot-e'
    && swappedDeck.tiles.find((tile) => tile.id === 'r1')
      .currentSessionKey === 'key-rot-e',
    swapped.find((tile) => tile.tileId === 'r1').paneSessionKey);
  check('왼쪽 목록을 접어도 상단 순환 버튼이 표시 대상과 포커스를 함께 바꾼다',
    await evaluate("document.querySelector('.work-area').classList.contains('session-panel-collapsed')")
    && swappedState.targetName === '순환 엡실론'
    && swappedState.rotationShortcuts.find((item) => item.name === '순환 엡실론')
      .pressed === 'true',
    JSON.stringify(swappedState.rotationShortcuts));
  check('타일 설명 편집 blur가 발생해도 이어진 순환 버튼 클릭을 잃지 않는다',
    swapped.find((tile) => tile.tileId === 'p1').description === 'blur 뒤에도 전환'
    && swappedState.targetName === '순환 엡실론');
  check('교체된 기존 세션 pane이 주차 영역으로 이동한다',
    swappedParking.parkedKeys.includes('key-rot-c')
    && swappedParking.parkingHidden === true,
    JSON.stringify(swappedParking.parkedKeys));
  check('순환1 교체가 순환2와 고정 타일 DOM을 바꾸지 않는다',
    ['p1', 'p2', 'r2'].every((tileId) => {
      const before = pinnedTiles.find((tile) => tile.tileId === tileId);
      const after = swapped.find((tile) => tile.tileId === tileId);
      return before.paneSessionKey === after.paneSessionKey
        && before.paneReparents === after.paneReparents
        && before.gridRow === after.gridRow
        && before.gridColumn === after.gridColumn;
    }),
    JSON.stringify(swapped.map((tile) => `${tile.tileId}:${tile.paneSessionKey}:${tile.paneReparents}`)));
  check('여전히 pane 하나가 한 타일에만 붙어 있다',
    swapped.every((tile) => tile.paneCount === 1)
    && new Set(swapped.map((tile) => tile.paneSessionKey)).size === 4,
    JSON.stringify(swapped.map((tile) => tile.paneSessionKey)));

  // 원래 순환1 세션과 펼침 상태로 되돌려 이후 검사를 단순하게 유지한다.
  await evaluate(`(() => {
    const shortcut = [...document.querySelectorAll('.rotation-shortcut')]
      .find((button) => button.querySelector('.rotation-shortcut-name').textContent === '순환 감마');
    shortcut.click();
    document.querySelector('#expand-session-panel').click();
  })()`);
  await wait(350);

  // PTY 종료 표시가 세 곳에서 일치하는지.
  await evaluate('window.rendererSmoke.emitExit("session-4")');
  await wait(300);
  const exited = await evaluate(READ_STATE);
  check('종료된 세션 badge가 종료됨이다',
    exited.rows[3].badge.includes('종료됨')
    && exited.rows[3].badgeStatus === 'exited',
    `${exited.rows[3].badge} / ${exited.rows[3].badgeStatus}`);
  const exitedTiles = await evaluate(READ_TILES);
  check('종료된 세션이 표시된 타일 header도 종료됨이다',
    exitedTiles.find((tile) => tile.paneSessionKey === 'key-rot-d').status
      === '종료됨',
    exitedTiles.find((tile) => tile.paneSessionKey === 'key-rot-d').status);
  check('접근성 이름에도 종료됨이 들어간다',
    exited.rows[3].label.includes('종료됨'), exited.rows[3].label);
  check('종료 상태 변화가 포커스를 훔치지 않는다',
    exited.rows[3].selected === 'false'
    && exited.rows.filter((row) => row.selected === 'true').length === 1,
    JSON.stringify(exited.rows.map((row) => row.selected)));
  const restartBefore = await evaluate(`({
    creates: window.rendererSmoke.createSessionCalls().length,
    closes: window.rendererSmoke.closeSessionCalls().length
  })`);
  const exitedAttention = await evaluate(`(() => {
    document.querySelector('#open-attention-center').click();
    const row = [...document.querySelectorAll('.attention-center-item')]
      .find((item) => item.textContent.includes('순환 델타'));
    const result = {
      found: Boolean(row),
      kind: row?.querySelector('.attention-center-kind')?.dataset.kind,
      restart: row?.querySelector('.attention-center-restart')?.textContent
    };
    row?.querySelector('.attention-center-restart')?.click();
    return result;
  })()`);
  await wait(900);
  const restartedSession = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#session-list .session-row')]
      .find((item) => item.querySelector('.session-name').textContent === '순환 델타');
    const tile = [...document.querySelectorAll('.deck-tile')]
      .find((item) => item.querySelector('.deck-tile-title').textContent === '순환 델타');
    return {
      creates: window.rendererSmoke.createSessionCalls().length,
      closes: window.rendererSmoke.closeSessionCalls().length,
      createOptions: window.rendererSmoke.createSessionCalls().at(-1),
      badge: row?.querySelector('.session-status-badge')?.dataset.status,
      restartHidden: row?.querySelector('.session-restart')?.hidden,
      tileKey: tile?.querySelector('.terminal-pane')?.dataset.sessionKey,
      centerCount: document.querySelector('#open-attention-center').textContent
    };
  })()`);
  check('Attention Center가 종료 세션에 다시 시작 동작을 제공한다',
    exitedAttention.found === true
    && exitedAttention.kind === 'exited'
    && exitedAttention.restart === '다시 시작',
    JSON.stringify(exitedAttention));
  check('종료 세션 재시작은 같은 이름·폴더·shell로 새 PTY를 만든다',
    restartedSession.creates === restartBefore.creates + 1
    && restartedSession.closes === restartBefore.closes + 1
    && restartedSession.createOptions.name === '순환 델타'
    && restartedSession.createOptions.cwd === 'D:\\work\\delta'
    && restartedSession.createOptions.shellKind === 'pwsh',
    JSON.stringify(restartedSession));
  check('재시작 뒤 기존 layoutKey와 타일은 유지되고 종료 표시가 해제된다',
    restartedSession.badge === 'ready'
    && restartedSession.restartHidden === true
    && restartedSession.tileKey === 'key-rot-d'
    && restartedSession.centerCount === '확인 0',
    JSON.stringify(restartedSession));
  await evaluate("document.querySelector('#close-attention-center').click()");

  // --- 숨은 세션의 출력과 명령 블록 수집 ---
  const hiddenBefore = await evaluate(READ_STATE);
  // session-5 = key-rot-e(숨은 세션). 출력과 OSC 133 블록을 흘려보낸다.
  await evaluate(
    "window.rendererSmoke.emitOutput('session-5', '숨은 세션 출력 A\\r\\n')"
  );
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-5', 'Write-Output \"숨은 블록\"', '숨은 블록 출력')"
  );
  await wait(500);
  const hiddenCollected = await evaluate(READ_STATE);
  const hiddenTiles = await evaluate(READ_TILES);
  check('숨은 세션 출력이 포커스를 훔치지 않는다',
    hiddenCollected.targetName === hiddenBefore.targetName
    && JSON.stringify(hiddenCollected.rows.map((row) => row.selected))
      === JSON.stringify(hiddenBefore.rows.map((row) => row.selected)),
    `${hiddenBefore.targetName} -> ${hiddenCollected.targetName}`);
  check('숨은 세션 출력이 타일 배치를 바꾸지 않는다',
    JSON.stringify(hiddenTiles.map((tile) => tile.paneSessionKey))
      === JSON.stringify(pinnedTiles.map((tile) => tile.paneSessionKey)),
    JSON.stringify(hiddenTiles.map((tile) => tile.paneSessionKey)));
  check('오른쪽 블록 패널은 포커스 세션 것만 보여준다',
    hiddenCollected.blockCount === hiddenBefore.blockCount,
    `${hiddenBefore.blockCount} -> ${hiddenCollected.blockCount}`);

  // 숨은 세션을 표시해 그동안의 출력과 블록이 남아 있는지 확인한다.
  await evaluate(`document.querySelectorAll('#session-list .session-row')[4]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(500);
  const revealed = await evaluate(READ_STATE);
  const revealedScreen = await evaluate(`(() => {
    const pane = document.querySelector('.terminal-pane[data-session-key="key-rot-e"]');
    return {
      screen: pane.querySelector('.xterm-rows').innerText,
      tileId: pane.dataset.tileId,
      hidden: pane.hidden,
      width: Math.round(pane.getBoundingClientRect().width)
    };
  })()`);
  check('숨은 세션도 명령 블록을 계속 수집했다',
    Number.parseInt(revealed.blockCount.match(/\d+/u)?.[0] || '0', 10) >= 1,
    revealed.blockCount);
  check('숨은 세션도 히스토리를 계속 수집했다',
    Number(revealed.historyCount) >= 1, revealed.historyCount);
  check('다시 표시하면 그동안의 출력이 그대로 보인다',
    revealedScreen.screen.includes('숨은 세션 출력 A')
    && revealedScreen.screen.includes('숨은 블록 출력'),
    revealedScreen.screen.replace(/\\s+/gu, ' ').slice(0, 160));
  check('다시 표시된 pane이 순환1 타일에 붙고 실제 폭을 가진다',
    revealedScreen.tileId === 'r1'
    && revealedScreen.hidden === false
    && revealedScreen.width > 0,
    `${revealedScreen.tileId} / ${revealedScreen.width}`);

  // --- 타일 body / header 클릭으로 포커스 ---
  await evaluate(`document.querySelector('.deck-tile[data-tile-id="r2"] .deck-tile-body')
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await wait(300);
  const bodyClicked = await evaluate(READ_STATE);
  const bodyClickedTiles = await evaluate(READ_TILES);
  check('타일 body 클릭이 그 타일의 세션을 포커스한다',
    bodyClicked.targetName === '순환 델타'
    && bodyClickedTiles.find((tile) => tile.tileId === 'r2').focused === true
    && bodyClickedTiles.filter((tile) => tile.focused).length === 1,
    bodyClicked.targetName);
  check('타일 body 클릭 시 왼쪽 선택과 오른쪽 대상이 일치한다',
    bodyClicked.rows[3].selected === 'true'
    && bodyClicked.rows.filter((row) => row.selected === 'true').length === 1,
    JSON.stringify(bodyClicked.rows.map((row) => row.selected)));

  await evaluate(`document.querySelector('.deck-tile[data-tile-id="p2"] .deck-tile-header')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await wait(300);
  const headerClicked = await evaluate(READ_STATE);
  const headerClickedTiles = await evaluate(READ_TILES);
  check('타일 header 클릭이 그 타일의 세션을 포커스한다',
    headerClicked.targetName === '고정 베타'
    && headerClickedTiles.find((tile) => tile.tileId === 'p2').focused === true,
    headerClicked.targetName);
  check('header 클릭도 배치를 바꾸지 않는다',
    JSON.stringify(headerClickedTiles.map((tile) => tile.paneSessionKey))
      === JSON.stringify(bodyClickedTiles.map((tile) => tile.paneSessionKey)),
    JSON.stringify(headerClickedTiles.map((tile) => tile.paneSessionKey)));

  // --- 최대화와 복원 ---
  const beforeMaximize = await evaluate(READ_TILES);
  await evaluate('window.rendererSmoke.clearResizeCalls()');
  await evaluate(`document.querySelector('.deck-tile[data-tile-id="r1"] .deck-tile-button')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await wait(500);
  const maximized = await evaluate(READ_TILES);
  const maximizedState = await evaluate(READ_STATE);
  const maximizeResizes = await evaluate('window.rendererSmoke.resizeCalls()');
  const maximizedSaved = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck;
  })()`);
  check('최대화하면 타일 하나만 보인다',
    maximized.filter((tile) => !tile.hidden).length === 1
    && maximized.find((tile) => tile.tileId === 'r1').hidden === false
    && maximized.find((tile) => tile.tileId === 'r1').maximized === true,
    JSON.stringify(maximized.map((tile) => `${tile.tileId}:${tile.hidden}`)));
  check('최대화된 타일이 deck 전체로 넓어지고 xterm이 다시 fit된다',
    maximizedState.visibleTileCount === 1
    && maximized.find((tile) => tile.tileId === 'r1').bodyWidth
      > beforeMaximize.find((tile) => tile.tileId === 'r1').bodyWidth
    && maximized.find((tile) => tile.tileId === 'r1').paneRows
      > beforeMaximize.find((tile) => tile.tileId === 'r1').paneRows,
    `width ${beforeMaximize.find((tile) => tile.tileId === 'r1').bodyWidth}`
      + `->${maximized.find((tile) => tile.tileId === 'r1').bodyWidth}, `
      + `rows ${beforeMaximize.find((tile) => tile.tileId === 'r1').paneRows}`
      + `->${maximized.find((tile) => tile.tileId === 'r1').paneRows}`);
  check('최대화된 타일의 세션이 포커스된다',
    maximizedState.targetName === '순환 엡실론', maximizedState.targetName);
  check('최대화 후 커진 terminal의 PTY resize가 전송된다',
    maximizeResizes.some((call) => call.sessionId === 'session-5'
      && call.cols > 0 && call.rows > 0),
    JSON.stringify(maximizeResizes));
  check('최대화 상태는 저장되지 않는다',
    !('maximizedTileId' in maximizedSaved)
    && JSON.stringify(maximizedSaved.tiles.map((tile) => tile.id))
      === JSON.stringify(['p1', 'p2', 'r1', 'r2']),
    JSON.stringify(Object.keys(maximizedSaved)));
  check('최대화는 pane을 옮기지 않는다(Terminal 재생성 없음)',
    maximized.find((tile) => tile.tileId === 'r1').paneReparents
      === beforeMaximize.find((tile) => tile.tileId === 'r1').paneReparents,
    `${beforeMaximize.find((tile) => tile.tileId === 'r1').paneReparents}`
      + ` -> ${maximized.find((tile) => tile.tileId === 'r1').paneReparents}`);
  check('최대화 중에도 숨은 타일의 pane은 그 타일에 남아 있다',
    maximized.filter((tile) => tile.paneCount === 1).length === 4,
    JSON.stringify(maximized.map((tile) => tile.paneCount)));

  // 최대화로 가려진 세션은 주차된 세션(숨김)과 구분해 `가려짐`으로 표기한다.
  check('최대화 중 가려진 세션은 가려짐, 주차 세션은 숨김으로 표기된다',
    maximizedState.rows[0].placement === '고정1 · 가려짐'
    && maximizedState.rows[1].placement === '고정2 · 가려짐'
    && maximizedState.rows[3].placement === '순환2 · 가려짐'
    && maximizedState.rows[4].placement === '순환1'
    && maximizedState.rows[2].placement === '순환1 · 숨김',
    JSON.stringify(maximizedState.rows.map((row) => row.placement)));
  check('가려짐 상태가 접근성 이름에도 반영된다',
    maximizedState.rows[0].label.includes('가려짐')
    && maximizedState.rows[2].label.includes('숨김'),
    JSON.stringify(maximizedState.rows.map((row) => row.label)));

  // 가려진 세션의 완료는 toast를 띄우지 않는다(모델상 표시 중이므로).
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-1', 'Write-Output \"가려진 완료\"', '가려진 완료 출력')"
  );
  await wait(600);
  const coveredComplete = await evaluate(READ_STATE);
  check('최대화로 가려진 세션의 완료는 toast를 띄우지 않는다',
    coveredComplete.toasts === 0, String(coveredComplete.toasts));
  check('가려진 세션의 완료가 포커스를 훔치지 않는다',
    coveredComplete.targetName === '순환 엡실론', coveredComplete.targetName);

  await evaluate('window.rendererSmoke.clearResizeCalls()');
  await evaluate(`document.querySelector('.deck-tile[data-tile-id="r1"] .deck-tile-button')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await wait(500);
  const restoredTiles = await evaluate(READ_TILES);
  const restoreResizes = await evaluate('window.rendererSmoke.resizeCalls()');
  check('복원하면 원래 타일 배치가 돌아온다',
    restoredTiles.length === 4
    && restoredTiles.every((tile) => !tile.hidden && !tile.maximized)
    && JSON.stringify(restoredTiles.map((tile) => `${tile.gridRow}|${tile.gridColumn}`))
      === JSON.stringify(tiles.map((tile) => `${tile.gridRow}|${tile.gridColumn}`)),
    JSON.stringify(restoredTiles.map((tile) => `${tile.tileId}:${tile.hidden}`)));
  check('복원 후 표시 세션이 정확히 돌아온다',
    JSON.stringify(restoredTiles.map((tile) => tile.paneSessionKey))
      === JSON.stringify([
        'key-pinned-a', 'key-pinned-b', 'key-rot-e', 'key-rot-d'
      ]),
    JSON.stringify(restoredTiles.map((tile) => tile.paneSessionKey)));
  check('복원 후 모든 표시 terminal이 원래 크기로 다시 fit된다',
    restoredTiles.every((tile) => tile.paneRows > 0)
    && JSON.stringify(restoredTiles.map((tile) => tile.paneRows))
      === JSON.stringify(beforeMaximize.map((tile) => tile.paneRows)),
    `${JSON.stringify(beforeMaximize.map((tile) => tile.paneRows))}`
      + ` -> ${JSON.stringify(restoredTiles.map((tile) => tile.paneRows))}`);
  check('복원 후 크기가 되돌아간 terminal의 PTY resize가 전송된다',
    restoreResizes.some((call) => call.sessionId === 'session-5'
      && call.cols > 0 && call.rows > 0),
    JSON.stringify(restoreResizes));
  check('숨은 pane에 0 크기 resize를 보내지 않는다',
    [...maximizeResizes, ...restoreResizes]
      .every((call) => call.cols > 0 && call.rows > 0),
    JSON.stringify([...maximizeResizes, ...restoreResizes]));
  const restoredRows = await evaluate(READ_STATE);
  check('복원하면 가려짐 표기가 사라진다',
    restoredRows.rows.every((row) => !row.placement.includes('가려짐'))
    && restoredRows.rows[2].placement === '순환1 · 숨김',
    JSON.stringify(restoredRows.rows.map((row) => row.placement)));

  // --- Stage 3: 완료 toast 정책 ---
  // 표시 중인 비포커스 세션의 완료는 toast를 띄우지 않는다.
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-2', 'Write-Output \"표시중 완료\"', '표시중 완료 출력')"
  );
  await wait(600);
  const visibleComplete = await evaluate(READ_STATE);
  const visibleCompleteTiles = await evaluate(READ_TILES);
  check('표시 중인 비포커스 세션의 완료는 toast를 띄우지 않는다',
    visibleComplete.toasts === 0, String(visibleComplete.toasts));
  check('표시 중 세션의 완료는 타일 header와 왼쪽 주의 표시로만 알린다',
    visibleCompleteTiles.find((tile) => tile.tileId === 'p2').status === '명령 종료'
    && visibleComplete.rows[1].attention === true,
    `${visibleCompleteTiles.find((tile) => tile.tileId === 'p2').status}`
      + ` / attention=${visibleComplete.rows[1].attention}`);
  check('표시 중 세션의 완료가 포커스를 훔치지 않는다',
    visibleComplete.targetName === '순환 엡실론', visibleComplete.targetName);

  // 주차된 숨은 세션의 완료는 toast를 띄운다.
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-3', 'Write-Output \"주차 완료\"', '주차 완료 출력')"
  );
  await wait(600);
  const parkedComplete = await evaluate(READ_STATE);
  check('주차된 숨은 세션의 완료는 toast를 띄운다',
    parkedComplete.toasts === 1, String(parkedComplete.toasts));
  check('주차 세션 toast도 포커스를 바꾸지 않는다',
    parkedComplete.targetName === '순환 엡실론', parkedComplete.targetName);
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-3', 'throw \"주차 실패\"', '주차 실패 출력', 1)"
  );
  await wait(300);
  const parkedFailureToast = await evaluate(
    "document.querySelector('.session-toast-text')?.textContent || ''"
  );
  check('주차된 실패 세션의 toast가 명령 종료로 오인되지 않는다',
    parkedFailureToast.includes('실패') && !parkedFailureToast.includes('명령 종료'),
    parkedFailureToast);

  // --- Stage 3: 오른쪽 대상 표현 ---
  const inspector = await evaluate(READ_INSPECTOR);
  check('target header는 이름·배치·상태만 간략히 표시하고 cwd는 툴팁에 둔다',
    inspector.targetName === '순환 엡실론'
    && inspector.targetMeta.startsWith('순환1 · ')
    && /명령 실행 중|출력 대기|명령 종료|입력 대기|종료됨/u.test(inspector.targetMeta)
    && !inspector.targetMeta.includes('D:\\work\\epsilon')
    && inspector.targetMetaTitle.includes('D:\\work\\epsilon'),
    `${inspector.targetName} / ${inspector.targetMeta}`);
  check('target header에 cwd tooltip이 있다',
    inspector.targetNameTitle.includes('D:\\work\\epsilon'),
    inspector.targetNameTitle);
  check('왼쪽 선택·포커스 타일·오른쪽 target이 같은 세션을 가리킨다',
    parkedComplete.rows[4].selected === 'true'
    && parkedComplete.tileTitle === '순환 엡실론'
    && inspector.targetName === '순환 엡실론',
    `${parkedComplete.tileTitle} / ${inspector.targetName}`);

  // --- Stage 3: 세션별 블록 선택 보존 ---
  // session-1(고정 알파)에 블록을 늘려 A/B 비교가 되게 한다.
  for (const index of [2, 3]) {
    await evaluate(
      `window.rendererSmoke.emitCommandBlock('session-1', 'Write-Output "A${index}"', 'A${index} 출력')`
    );
    await wait(350);
  }
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-5', 'Write-Output \"B2\"', 'B2 출력')"
  );
  await wait(500);

  // --- Stage 3: 타일 header 블록 정보 ---
  await evaluate("document.querySelector('#side-panel-tab-history').click()");
  await evaluate('window.rendererSmoke.clearResizeCalls()');
  await evaluate('document.querySelector(\'#collapse-command-panel\').click()');
  await wait(400);
  const beforeBlockInfo = await evaluate(READ_INSPECTOR);
  const tilesBeforeBlockInfo = await evaluate(READ_TILES);
  const deckBeforeBlockInfo = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck.tiles);
  })()`);
  check('접힘 상태에서 히스토리 보기가 활성인 상태로 시작한다',
    beforeBlockInfo.collapsed === true
    && beforeBlockInfo.activeView === 'history',
    `${beforeBlockInfo.collapsed} / ${beforeBlockInfo.activeView}`);

  await evaluate(`document.querySelector('.deck-tile[data-tile-id="p1"] .deck-tile-blocks')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await wait(500);
  const afterBlockInfo = await evaluate(READ_INSPECTOR);
  const tilesAfterBlockInfo = await evaluate(READ_TILES);
  const deckAfterBlockInfo = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck.tiles);
  })()`);
  check('블록 정보는 header 포커스 외에 패널을 열거나 보기를 바꾸지 않는다',
    afterBlockInfo.targetName === '고정 알파'
    && afterBlockInfo.collapsed === true
    && afterBlockInfo.activeView === 'history',
    JSON.stringify(afterBlockInfo));
  check('블록은 클릭 버튼이 아닌 정보 텍스트로 표시된다',
    tilesAfterBlockInfo.find((tile) => tile.tileId === 'p1').blocksTag === 'SPAN'
    && tilesAfterBlockInfo.find((tile) => tile.tileId === 'p1').blocks === '블록 5'
    && tilesAfterBlockInfo.find((tile) => tile.tileId === 'p1').blocksTitle
      === '고정 알파의 명령 블록 5개',
    JSON.stringify(tilesAfterBlockInfo.find((tile) => tile.tileId === 'p1')));
  check('블록 정보를 눌러도 currentSessionKey와 pane 배치를 바꾸지 않는다',
    deckAfterBlockInfo === deckBeforeBlockInfo
    && JSON.stringify(tilesAfterBlockInfo.map((tile) =>
      [tile.tileId, tile.paneSessionKey, tile.paneReparents]))
      === JSON.stringify(tilesBeforeBlockInfo.map((tile) =>
        [tile.tileId, tile.paneSessionKey, tile.paneReparents])),
    JSON.stringify(tilesAfterBlockInfo.map((tile) => tile.paneSessionKey)));
  check('블록이 0개인 세션도 단순 정보로 표시된다', await evaluate(`(() => {
    const info = document.querySelector(
      '.deck-tile[data-tile-id="r2"] .deck-tile-blocks'
    );
    return info.textContent === '블록 0' && info.tagName === 'SPAN' && info.tabIndex < 0;
  })()`));

  await evaluate("document.querySelector('#expand-command-panel').click()");
  await wait(300);
  await evaluate("document.querySelector('#side-panel-tab-blocks').click()");
  await wait(300);
  const visibleBlocks = await evaluate(READ_BLOCKS);
  check('블록 탭을 직접 열면 그 세션의 블록만 렌더한다',
    visibleBlocks.count === '전체 복사 · 5'
    && visibleBlocks.commands.length === 5
    && visibleBlocks.commands.every((text) => !text.includes('B2')),
    JSON.stringify(visibleBlocks.commands));
  check('전체 복사 버튼이 대상 세션과 블록 수를 표시한다',
    visibleBlocks.copyAll.disabled === false
    && visibleBlocks.copyAll.label === '고정 알파의 명령 블록 5개 전체 복사',
    JSON.stringify(visibleBlocks.copyAll));
  await evaluate('window.rendererSmoke.clearClipboardWrites()');
  await evaluate("document.querySelector('#command-block-count').click()");
  await wait(200);
  const copiedAllBlocks = await evaluate('window.rendererSmoke.clipboardWrites()');
  check('전체 복사 버튼은 선택 상태와 무관하게 모든 블록을 실행 순서대로 복사한다',
    copiedAllBlocks.length === 1
    && copiedAllBlocks[0].split('\n\n----------------\n\n').length === 5
    && copiedAllBlocks[0].includes('A2')
    && copiedAllBlocks[0].includes('A3'),
    JSON.stringify(copiedAllBlocks));
  // 세션 A(고정 알파)에서 블록 2개 선택.
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#command-block-list .command-block')];
    for (const index of [0, 2]) {
      const box = cards[index].querySelector('input[type="checkbox"]');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await wait(300);
  const selectionA = await evaluate(READ_BLOCKS);
  check('세션 A에서 두 블록을 선택하면 개수와 툴바가 갱신된다',
    selectionA.selectedText === '2개 선택'
    && JSON.stringify(selectionA.checked) === JSON.stringify([true, false, true, false, false])
    && selectionA.copy.disabled === false
    && selectionA.selectAll.indeterminate === true,
    `${selectionA.selectedText} / ${JSON.stringify(selectionA.checked)}`);
  check('블록 툴바 라벨에 대상 세션 이름과 선택 개수가 들어간다',
    selectionA.copy.label === '고정 알파의 선택한 명령 블록 2개 복사'
    && selectionA.remove.label === '고정 알파의 선택한 명령 블록 2개 삭제'
    && selectionA.clearAll.label === '고정 알파의 명령 블록 전체 지우기',
    `${selectionA.copy.label} / ${selectionA.clearAll.label}`);

  // 세션 B(순환 엡실론)로 이동해 다른 블록 선택.
  await evaluate(`document.querySelector('.deck-tile[data-tile-id="r1"] .deck-tile-header')
    .dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await wait(400);
  const emptySelectionB = await evaluate(READ_BLOCKS);
  check('다른 세션으로 옮기면 그 세션의 선택 상태만 보인다',
    emptySelectionB.count === '전체 복사 · 2'
    && emptySelectionB.selectedText === '0개 선택'
    && emptySelectionB.checked.every((value) => value === false),
    `${emptySelectionB.count} / ${emptySelectionB.selectedText}`);
  await evaluate(`(() => {
    const card = document.querySelectorAll('#command-block-list .command-block')[0];
    const box = card.querySelector('input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await wait(300);
  const selectionB = await evaluate(READ_BLOCKS);
  check('세션 B의 선택은 세션 A와 섞이지 않는다',
    selectionB.selectedText === '1개 선택'
    && JSON.stringify(selectionB.checked) === JSON.stringify([true, false]),
    `${selectionB.selectedText} / ${JSON.stringify(selectionB.checked)}`);

  // 왕복 후 각 선택이 복원되는지.
  await evaluate(`document.querySelectorAll('#session-list .session-row')[0]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(400);
  const restoredSelectionA = await evaluate(READ_BLOCKS);
  check('세션 A로 돌아오면 원래 선택이 복원된다',
    restoredSelectionA.selectedText === '2개 선택'
    && JSON.stringify(restoredSelectionA.checked)
      === JSON.stringify([true, false, true, false, false]),
    `${restoredSelectionA.selectedText} / ${JSON.stringify(restoredSelectionA.checked)}`);
  await evaluate(`document.querySelectorAll('#session-list .session-row')[4]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(400);
  const restoredSelectionB = await evaluate(READ_BLOCKS);
  check('세션 B로 돌아오면 세션 B 선택이 복원된다',
    restoredSelectionB.selectedText === '1개 선택'
    && JSON.stringify(restoredSelectionB.checked) === JSON.stringify([true, false]),
    `${restoredSelectionB.selectedText} / ${JSON.stringify(restoredSelectionB.checked)}`);

  // 선택 삭제 후 선택 집합이 정리되는지, 다른 세션 선택은 그대로인지.
  await evaluate(
    "document.querySelector('#delete-selected-command-blocks').click()"
  );
  await wait(400);
  const afterDelete = await evaluate(READ_BLOCKS);
  check('삭제된 블록 id는 선택 집합에서 제거된다',
    afterDelete.count === '전체 복사 · 1'
    && afterDelete.selectedText === '0개 선택'
    && afterDelete.remove.disabled === true
    && afterDelete.selectAll.checked === false
    && afterDelete.selectAll.indeterminate === false,
    `${afterDelete.count} / ${afterDelete.selectedText}`);
  await evaluate(`document.querySelectorAll('#session-list .session-row')[0]
    .dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))`);
  await wait(400);
  const selectionAAfterDelete = await evaluate(READ_BLOCKS);
  check('다른 세션의 삭제가 세션 A 선택을 건드리지 않는다',
    selectionAAfterDelete.selectedText === '2개 선택',
    selectionAAfterDelete.selectedText);

  // --- Stage 3: 즐겨찾기 실행 대상 ---
  const favoriteTarget = await evaluate(READ_INSPECTOR);
  check('즐겨찾기 실행 버튼에 대상 세션 이름이 표시된다',
    favoriteTarget.favoriteRun[0].text === '고정 알파에서 실행'
    && favoriteTarget.favoriteRun[0].label === '고정 알파에서 실행'
    && favoriteTarget.favoriteRun[0].disabled === false,
    JSON.stringify(favoriteTarget.favoriteRun[0]));
  check('상단 즐겨찾기 바로 가기는 이름을 유지하고 현재 대상에 연결된다',
    favoriteTarget.favoriteShortcuts[0].text === '빌드'
    && favoriteTarget.favoriteShortcuts[0].label === '빌드: 고정 알파에서 실행'
    && favoriteTarget.favoriteShortcuts[0].disabled === false,
    JSON.stringify(favoriteTarget.favoriteShortcuts[0]));
  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate("document.querySelector('#favorite-shortcuts button').click()");
  await wait(200);
  const shortcutWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('상단 즐겨찾기 바로 가기가 해당 명령을 현재 대상에서 실행한다',
    shortcutWrites.length === 1
    && shortcutWrites[0].sessionId === 'session-1'
    && shortcutWrites[0].data.includes('npm run build'),
    JSON.stringify(shortcutWrites));
  check('히스토리 작업 라벨에 대상 세션 이름이 들어간다',
    favoriteTarget.clearHistory.label === '고정 알파의 명령 히스토리 전체 지우기',
    favoriteTarget.clearHistory.label);
  const tileLogs = await evaluate(READ_TILES);
  const alphaTileLog = tileLogs.find((tile) => tile.tileId === 'p1');
  check('타일 빠른 입력과 로그 복사 버튼은 요청한 순서로 최대화 버튼 왼쪽에 있다',
    alphaTileLog.quickActionOrder === true
    && alphaTileLog.logHidden === false
    && alphaTileLog.logDisabled === false
    && alphaTileLog.logBeforeMaximize === true
    && alphaTileLog.pasteLabel === '고정 알파에 클립보드 내용만 붙여넣기'
    && alphaTileLog.clearLabel === '고정 알파에서 cls 실행'
    && alphaTileLog.logLabel === '고정 알파의 전체 터미널 로그 복사',
    JSON.stringify(alphaTileLog));
  check('현재 대상·상태·블록 정보는 타일 제목 바로 옆에 이어진다',
    alphaTileLog.titleInfoOrder === true,
    JSON.stringify(alphaTileLog));
  check('타일 세션 이름은 처음 등록 경로로 이동하는 동작을 안내한다',
    alphaTileLog.titleDisabled === false
    && alphaTileLog.titleLabel === '고정 알파: 처음 등록한 폴더로 이동'
    && alphaTileLog.titleTooltip.includes('D:\\registered\\alpha'),
    JSON.stringify(alphaTileLog));
  check('타일 정보와 동작 글자는 제목보다 두껍거나 크게 보이지 않는다',
    alphaTileLog.headerHeight >= 26
    && alphaTileLog.actionFontSize === 10
    && alphaTileLog.actionFontWeight <= 500
    && alphaTileLog.blocksFontSize === 10
    && alphaTileLog.blocksFontWeight <= 500,
    JSON.stringify(alphaTileLog));
  const controlReadability = await evaluate(`(() => {
    const quick = getComputedStyle(document.querySelector('#start-deck-edit'));
    const tab = getComputedStyle(document.querySelector('#side-panel-tab-blocks'));
    return {
      quickFontSize: Number.parseFloat(quick.fontSize),
      quickFontWeight: Number.parseInt(quick.fontWeight, 10),
      tabFontSize: Number.parseFloat(tab.fontSize),
      tabFontWeight: Number.parseInt(tab.fontWeight, 10)
    };
  })()`);
  check('배치 편집·설정과 블록 탭 글자는 과도한 bold 없이 표시된다',
    controlReadability.quickFontSize === 10
    && controlReadability.quickFontWeight <= 500
    && controlReadability.tabFontSize === 11
    && controlReadability.tabFontWeight <= 500,
    JSON.stringify(controlReadability));

  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`document.querySelector(
    '.deck-tile[data-tile-id="p1"] .deck-tile-title'
  ).click()`);
  await wait(200);
  const homeWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('세션 이름은 등록 당시 경로로 Set-Location하고 Enter를 보낸다',
    homeWrites.length === 1
    && homeWrites[0].sessionId === 'session-1'
    && homeWrites[0].data.includes(
      "Set-Location -LiteralPath 'D:\\registered\\alpha'"
    )
    && homeWrites[0].data.endsWith('\r'),
    JSON.stringify(homeWrites));
  const persistedInitialCwd = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const state = states[states.length - 1];
    return state.tabs.find((tab) => tab.key === 'key-pinned-a').initialCwd;
  })()`);
  check('처음 등록 경로는 현재 cwd와 별도로 저장된다',
    persistedInitialCwd === 'D:\\registered\\alpha',
    persistedInitialCwd);

  await evaluate("window.rendererSmoke.setClipboardText('clipboard paste smoke')");
  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`document.querySelector(
    '.deck-tile[data-tile-id="p1"] .deck-tile-paste'
  ).click()`);
  await wait(300);
  const tilePasteWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('타일 붙여넣기는 실행 없이 한 번만 해당 타일 PTY로 보낸다',
    tilePasteWrites.length === 1
    && tilePasteWrites[0].sessionId === 'session-1'
    && tilePasteWrites[0].data.includes('clipboard paste smoke')
    && !tilePasteWrites[0].data.endsWith('\r'),
    JSON.stringify(tilePasteWrites));

  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="p1"]');
    tile.querySelector('.deck-tile-button[aria-label="타일 메뉴"]').click();
    [...tile.querySelectorAll('.deck-tile-menu-item')]
      .find((button) => button.textContent === '붙여넣고 실행').click();
  })()`);
  await wait(300);
  const tilePasteRunWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('타일 붙여넣고 실행은 내용과 Enter를 한 번의 write로 보낸다',
    tilePasteRunWrites.length === 1
    && tilePasteRunWrites[0].sessionId === 'session-1'
    && tilePasteRunWrites[0].data.includes('clipboard paste smoke')
    && tilePasteRunWrites[0].data.endsWith('\r'),
    JSON.stringify(tilePasteRunWrites));

  await evaluate("window.rendererSmoke.setClipboardText('cls\\ngit status --porcelain -u --\\ngit show --stat HEAD')");
  await evaluate('window.rendererSmoke.clearWriteCalls()');
  const multilineDirectResult = await evaluate(`(() => {
    document.querySelector('.deck-tile[data-tile-id="p1"] .deck-tile-paste').click();
    return new Promise((resolve) => setTimeout(() => resolve({
      open: document.querySelector('#paste-confirm-dialog').open,
      writes: window.rendererSmoke.writeCalls().length,
      label: document.querySelector('.deck-tile[data-tile-id="p1"] .deck-tile-paste')
        .textContent
    }), 50));
  })()`);
  check('직접 붙여넣기는 위험한 여러 줄을 실행하지 않고 확인 메뉴를 안내한다',
    multilineDirectResult.open === false
    && multilineDirectResult.writes === 0
    && multilineDirectResult.label.includes('확인 후'),
    JSON.stringify(multilineDirectResult));
  const multilinePastePrompt = await evaluate(`(() => {
    const tile = document.querySelector('.deck-tile[data-tile-id="p1"]');
    tile.querySelector('.deck-tile-button[aria-label="타일 메뉴"]').click();
    [...tile.querySelectorAll('.deck-tile-menu-item')]
      .find((button) => button.textContent === '확인 후 붙여넣기').click();
    return new Promise((resolve) => setTimeout(() => resolve({
      open: document.querySelector('#paste-confirm-dialog').open,
      title: document.querySelector('#paste-confirm-title').textContent,
      reason: document.querySelector('#paste-confirm-reason').textContent,
      target: document.querySelector('#paste-confirm-target').textContent,
      preview: document.querySelector('#paste-confirm-preview').textContent
    }), 50));
  })()`);
  check('확인 후 붙여넣기는 여러 줄 실행 가능성을 명확히 표시한다',
    multilinePastePrompt.open === true
    && multilinePastePrompt.title === '붙여넣기 확인'
    && multilinePastePrompt.reason.includes('즉시 실행')
    && multilinePastePrompt.target === '대상: 고정 알파'
    && multilinePastePrompt.preview.startsWith('cls\n')
    && !multilinePastePrompt.preview.includes('고정 알파'),
    JSON.stringify(multilinePastePrompt));
  await evaluate("document.querySelector('#confirm-paste').click()");
  await wait(250);
  const multilinePasteWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('확인한 여러 줄 붙여넣기는 제목 없이 클립보드 내용만 전달한다',
    multilinePasteWrites.length === 1
    && multilinePasteWrites[0].data === 'cls\rgit status --porcelain -u --\rgit show --stat HEAD',
    JSON.stringify(multilinePasteWrites));

  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate(`document.querySelector(
    '.deck-tile[data-tile-id="p1"] .deck-tile-clear'
  ).click()`);
  await wait(200);
  const tileClearWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('타일 cls는 PowerShell prompt를 비운 뒤 해당 타일에서 실행된다',
    tileClearWrites.length === 1
    && tileClearWrites[0].sessionId === 'session-1'
    && tileClearWrites[0].data.endsWith('cls\r'),
    JSON.stringify(tileClearWrites));
  check('타일 cls를 누르면 해당 세션의 기존 명령 블록이 즉시 초기화된다',
    (await evaluate(READ_BLOCKS)).count === '전체 복사 · 0',
    JSON.stringify(await evaluate(READ_BLOCKS)));
  await evaluate(
    "window.rendererSmoke.emitCommandBlock('session-1', 'cls', '')"
  );
  await wait(200);
  check('버튼으로 실행한 cls 자체도 새 명령 블록으로 남지 않는다',
    (await evaluate(READ_BLOCKS)).count === '전체 복사 · 0',
    JSON.stringify(await evaluate(READ_BLOCKS)));

  // 이후 패널 접기/펴기 검증은 기존 선택 상태 계약을 계속 검사하므로 fixture를 복원한다.
  for (const index of [0, 1, 2, 3]) {
    await evaluate(
      `window.rendererSmoke.emitCommandBlock('session-1', 'Write-Output "R${index}"', 'R${index} 출력')`
    );
    await wait(150);
  }
  await evaluate(`(() => {
    const cards = [...document.querySelectorAll('#command-block-list .command-block')];
    for (const index of [0, 2]) {
      const box = cards[index].querySelector('input[type="checkbox"]');
      box.checked = true;
      box.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  await wait(200);

  await evaluate('window.rendererSmoke.clearClipboardWrites()');
  await evaluate(`document.querySelector(
    '.deck-tile[data-tile-id="p1"] .deck-tile-log'
  ).click()`);
  await wait(200);
  const copiedFullLogs = await evaluate('window.rendererSmoke.clipboardWrites()');
  check('타일 로그 복사 버튼은 그 타일 terminal의 전체 버퍼를 복사한다',
    copiedFullLogs.length === 1
    && copiedFullLogs[0].includes('완료 표시 출력'),
    JSON.stringify(copiedFullLogs));

  const quickSwitcherOpened = await evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, code: 'KeyP', key: 'P', ctrlKey: true, shiftKey: true
    }));
    const input = document.querySelector('#quick-switcher-search');
    input.value = 'work epsilon';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const items = [...document.querySelectorAll('.quick-switcher-item')];
    const result = {
      open: document.querySelector('#quick-switcher-dialog').open,
      horizontalOverflow: document.querySelector('#quick-switcher-dialog').scrollWidth
        > document.querySelector('#quick-switcher-dialog').clientWidth,
      count: items.length,
      names: items.map((item) => item.querySelector('strong').textContent),
      selected: items.filter((item) => item.classList.contains('selected')).length
    };
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return result;
  })()`);
  await wait(350);
  const quickSwitched = await evaluate(READ_STATE);
  check('Ctrl+Shift+P Quick Switcher가 여러 검색어로 세션을 찾는다',
    quickSwitcherOpened.open === true
    && quickSwitcherOpened.count === 1
    && quickSwitcherOpened.names[0] === '순환 엡실론'
    && quickSwitcherOpened.selected === 1,
    JSON.stringify(quickSwitcherOpened));
  check('Quick Switcher에 가로 스크롤이 생기지 않는다',
    quickSwitcherOpened.horizontalOverflow === false,
    JSON.stringify(quickSwitcherOpened));
  check('Quick Switcher의 Enter가 숨은 순환 세션을 표시하고 포커스한다',
    quickSwitched.targetName === '순환 엡실론'
    && quickSwitched.rows[4].selected === 'true',
    JSON.stringify(quickSwitched.rows.map((row) => row.selected)));
  await evaluate(`(() => {
    document.querySelector('#open-quick-switcher').click();
    const input = document.querySelector('#quick-switcher-search');
    input.value = '고정 알파';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await wait(350);
  check('상단 세션 찾기 버튼으로도 Quick Switcher를 열고 원래 세션으로 복귀한다',
    (await evaluate(READ_STATE)).targetName === '고정 알파');

  await evaluate(`window.rendererSmoke.emitInteractiveCliStart(
    'session-1', 'codex', 'Codex response snapshot'
  )`);
  await wait(400);
  const interactiveBlocks = await evaluate(READ_BLOCKS);
  check('Codex 실행 중에는 CLI 응답 복사 버튼만 표시된다',
    interactiveBlocks.interactiveCopy.hidden === false
    && interactiveBlocks.interactiveCopy.disabled === false
    && interactiveBlocks.interactiveCopy.label === '고정 알파의 현재 CLI 응답 복사'
    && interactiveBlocks.count === '전체 복사 · 4',
    JSON.stringify(interactiveBlocks));
  await evaluate('window.rendererSmoke.clearClipboardWrites()');
  await evaluate("document.querySelector('#copy-interactive-cli').click()");
  await wait(200);
  const copiedCliResponse = await evaluate('window.rendererSmoke.clipboardWrites()');
  check('CLI 응답 복사는 Codex 시작 이후의 렌더링된 출력을 복사한다',
    copiedCliResponse.length === 1
    && copiedCliResponse[0].includes('Codex response snapshot'),
    JSON.stringify(copiedCliResponse));
  await evaluate("window.rendererSmoke.emitInteractiveCliEnd('session-1')");
  await wait(200);
  check('Codex 종료 후 CLI 응답 복사 버튼이 다시 숨겨진다',
    (await evaluate(READ_BLOCKS)).interactiveCopy.hidden === true,
    JSON.stringify(await evaluate(READ_BLOCKS)));

  await evaluate('window.rendererSmoke.clearWriteCalls()');
  await evaluate('window.rendererSmoke.emitExit("session-1")');
  await wait(400);
  const exitedTarget = await evaluate(READ_INSPECTOR);
  check('종료된 세션에서는 즐겨찾기 실행 버튼이 비활성된다',
    exitedTarget.favoriteRun[0].disabled === true
    && exitedTarget.favoriteRun[0].title.includes('종료된 terminal')
    && exitedTarget.favoriteShortcuts[0].disabled === true,
    JSON.stringify(exitedTarget.favoriteRun[0]));
  check('종료된 세션에서도 즐겨찾기 수정·삭제는 가능하다',
    exitedTarget.favoriteEdit[0].edit === false
    && exitedTarget.favoriteEdit[0].remove === false,
    JSON.stringify(exitedTarget.favoriteEdit[0]));
  const exitedAlphaTile = (await evaluate(READ_TILES))
    .find((tile) => tile.tileId === 'p1');
  check('종료된 세션에서도 전체 로그 복사는 허용된다',
    exitedAlphaTile.logDisabled === false,
    JSON.stringify(exitedAlphaTile));
  check('종료된 세션에서는 처음 폴더·붙여넣기·cls가 비활성된다',
    exitedAlphaTile.titleDisabled === true
    && exitedAlphaTile.pasteDisabled === true
    && exitedAlphaTile.clearDisabled === true,
    JSON.stringify(exitedAlphaTile));

  await evaluate(`(() => {
    document.querySelector('#favorite-list .favorite-run').click();
    document.querySelector('#favorite-list .utility-item')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await wait(400);
  const exitedWrites = await evaluate('window.rendererSmoke.writeCalls()');
  check('종료된 세션에서는 버튼·더블클릭 모두 write를 보내지 않는다',
    exitedWrites.length === 0, JSON.stringify(exitedWrites));

  // --- Stage 3: 패널 접기/펴기 ---
  const beforeCollapse = await evaluate(READ_INSPECTOR);
  const tilesBeforeCollapse = await evaluate(READ_TILES);
  const deckBeforeCollapse = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  await evaluate('window.rendererSmoke.clearResizeCalls()');
  await evaluate("document.querySelector('#collapse-command-panel').click()");
  await wait(600);
  const collapsed = await evaluate(READ_INSPECTOR);
  const tilesCollapsed = await evaluate(READ_TILES);
  const collapseResizes = await evaluate('window.rendererSmoke.resizeCalls()');
  const deckAfterCollapse = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck);
  })()`);
  check('접으면 패널이 숨고 rail과 다시 열기 버튼이 남는다',
    collapsed.collapsed === true
    && collapsed.panelDisplay === 'none'
    && collapsed.railHidden === false
    && collapsed.resizerHidden === true
    && collapsed.expandLabel === 'terminal 도구 패널 펼치기',
    `${collapsed.panelDisplay} / rail=${collapsed.railHidden}`);
  check('접기 버튼이 aria-expanded와 aria-controls를 갱신한다',
    collapsed.collapseExpanded === 'false'
    && collapsed.expandExpanded === 'false'
    && collapsed.collapseControls === 'command-panel',
    `${collapsed.collapseExpanded} / ${collapsed.collapseControls}`);
  check('rail이 현재 대상을 최소한으로 표시한다',
    collapsed.railStatus.includes('고정 알파'), collapsed.railStatus);
  check('접은 뒤 표시 terminal이 넓어진 deck에 다시 fit된다',
    tilesCollapsed.every((tile) =>
      tile.bodyWidth > tilesBeforeCollapse
        .find((before) => before.tileId === tile.tileId).bodyWidth)
    && collapseResizes.length > 0,
    JSON.stringify(tilesCollapsed.map((tile) => tile.bodyWidth)));
  check('접기 resize에 0 크기가 없다',
    collapseResizes.every((call) => call.cols > 0 && call.rows > 0),
    JSON.stringify(collapseResizes));
  check('접기가 deck과 포커스, pane 배치를 바꾸지 않는다',
    deckAfterCollapse === deckBeforeCollapse
    && collapsed.targetName === beforeCollapse.targetName
    && JSON.stringify(tilesCollapsed.map((tile) =>
      [tile.tileId, tile.paneSessionKey, tile.paneReparents]))
      === JSON.stringify(tilesBeforeCollapse.map((tile) =>
        [tile.tileId, tile.paneSessionKey, tile.paneReparents])),
    JSON.stringify(tilesCollapsed.map((tile) => tile.paneReparents)));
  check('접힘 상태가 shared settings에 저장된다', await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    const settings = states[states.length - 1].settings;
    return settings.commandPanelCollapsed === true
      && settings.commandPanelWidth > 0;
  })()`));

  await evaluate('window.rendererSmoke.clearResizeCalls()');
  await evaluate("document.querySelector('#expand-command-panel').click()");
  await wait(600);
  const expanded = await evaluate(READ_INSPECTOR);
  const expandedBlocks = await evaluate(READ_BLOCKS);
  const expandResizes = await evaluate('window.rendererSmoke.resizeCalls()');
  check('다시 펼치면 패널과 기존 폭이 복원된다',
    expanded.collapsed === false
    && expanded.panelDisplay !== 'none'
    && expanded.railHidden === true
    && expanded.panelWidth === beforeCollapse.panelWidth
    && expanded.collapseExpanded === 'true',
    `${expanded.panelWidth} vs ${beforeCollapse.panelWidth}`);
  check('펼친 뒤에도 활성 보기가 유지된다',
    expanded.activeView === beforeCollapse.activeView,
    `${beforeCollapse.activeView} -> ${expanded.activeView}`);
  check('펼친 뒤에도 블록 선택이 유지된다',
    expandedBlocks.selectedText === '2개 선택',
    expandedBlocks.selectedText);
  check('펼치기 resize에도 0 크기가 없다',
    expandResizes.every((call) => call.cols > 0 && call.rows > 0)
    && expandResizes.length > 0,
    JSON.stringify(expandResizes));
  check('펼침 상태도 shared settings에 저장된다', await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].settings.commandPanelCollapsed === false;
  })()`));

  // --- Stage 3: 키보드 포커스 인계 ---
  // 버튼을 focus한 뒤 활성화하는 것은 키보드(Enter/Space) 활성화와 같은 경로다.
  const focusBaseline = await evaluate(READ_INSPECTOR);
  const tilesBeforeFocusChecks = await evaluate(READ_TILES);
  const deckBeforeFocusChecks = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck.tiles);
  })()`);

  await evaluate(`(() => {
    const button = document.querySelector('#collapse-command-panel');
    button.focus();
    button.click();
  })()`);
  await wait(500);
  const focusAfterCollapse = await evaluate(READ_FOCUS);
  check('접기를 키보드로 활성화하면 rail의 펼치기 버튼으로 포커스가 넘어간다',
    focusAfterCollapse.id === 'expand-command-panel'
    && focusAfterCollapse.inRail === true,
    JSON.stringify(focusAfterCollapse));
  await wait(400);
  const focusAfterCollapseSettled = await evaluate(READ_FOCUS);
  check('접기 후 지연 프레임에도 터미널이 포커스를 빼앗지 않는다',
    focusAfterCollapseSettled.id === 'expand-command-panel'
    && focusAfterCollapseSettled.inTerminal === false,
    JSON.stringify(focusAfterCollapseSettled));

  await evaluate(`(() => {
    const button = document.querySelector('#expand-command-panel');
    button.focus();
    button.click();
  })()`);
  await wait(500);
  const focusAfterExpand = await evaluate(READ_FOCUS);
  check('펼치기를 활성화하면 패널의 접기 버튼으로 포커스가 넘어간다',
    focusAfterExpand.id === 'collapse-command-panel'
    && focusAfterExpand.inCommandPanel === true,
    JSON.stringify(focusAfterExpand));
  await wait(400);
  const focusAfterExpandSettled = await evaluate(READ_FOCUS);
  check('펼치기 후 지연 프레임에도 터미널이 포커스를 빼앗지 않는다',
    focusAfterExpandSettled.id === 'collapse-command-panel'
    && focusAfterExpandSettled.inTerminal === false,
    JSON.stringify(focusAfterExpandSettled));

  const focusBeforeBlockInfo = await evaluate(READ_FOCUS);
  const blockInfoFocus = await evaluate(`(() => {
    const info = document.querySelector(
      '.deck-tile[data-tile-id="r1"] .deck-tile-blocks'
    );
    info.focus();
    return { tag: info.tagName, tabIndex: info.tabIndex };
  })()`);
  const focusAfterBlockInfo = await evaluate(READ_FOCUS);
  check('블록 정보는 키보드 포커스를 받지 않는다',
    blockInfoFocus.tag === 'SPAN'
    && blockInfoFocus.tabIndex < 0
    && focusAfterBlockInfo.id === focusBeforeBlockInfo.id,
    `${JSON.stringify(blockInfoFocus)} / ${JSON.stringify(focusAfterBlockInfo)}`);

  // 일반 타일 body 클릭은 여전히 터미널을 focus 한다.
  await evaluate(`document.querySelector('.deck-tile[data-tile-id="p2"] .deck-tile-body')
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await wait(500);
  const focusAfterBodyClick = await evaluate(READ_FOCUS);
  check('일반 타일 body 클릭은 여전히 xterm을 focus 한다',
    focusAfterBodyClick.inTerminal === true
    && focusAfterBodyClick.terminalSessionKey === 'key-pinned-b',
    JSON.stringify(focusAfterBodyClick));

  const tilesAfterFocusChecks = await evaluate(READ_TILES);
  const deckAfterFocusChecks = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return JSON.stringify(states[states.length - 1].deck.tiles);
  })()`);
  const inspectorAfterFocusChecks = await evaluate(READ_INSPECTOR);
  check('포커스 인계 과정에서 deck·currentSessionKey·pane 배치가 불변이다',
    deckAfterFocusChecks === deckBeforeFocusChecks
    && JSON.stringify(tilesAfterFocusChecks.map((tile) =>
      [tile.tileId, tile.paneSessionKey, tile.paneReparents]))
      === JSON.stringify(tilesBeforeFocusChecks.map((tile) =>
        [tile.tileId, tile.paneSessionKey, tile.paneReparents])),
    JSON.stringify(tilesAfterFocusChecks.map((tile) => tile.paneSessionKey)));
  check('포커스 인계 과정에서 패널 폭이 불변이다',
    inspectorAfterFocusChecks.panelWidth === focusBaseline.panelWidth
    && inspectorAfterFocusChecks.collapsed === false,
    `${focusBaseline.panelWidth} -> ${inspectorAfterFocusChecks.panelWidth}`);

  // --- Stage 4: 배치 편집 ---
  await verifyDeckEditing(evaluate);
  await verifyDeckEditBoundaries(evaluate);
  await verifyLifecycleRaces(evaluate);
  await verifyCloseFailure(evaluate);
  await verifyPanelLayout(evaluate, smokeWindow);

  // 새 세션과 폴더에서 열기.
  await evaluate("document.querySelector('#new-tab').click()");
  await wait(500);
  await evaluate("document.querySelector('#new-tab-with-folder').click()");
  await wait(600);
  const added = await evaluate(READ_STATE);
  check('새 세션 2개가 추가된다', added.rows.length === 7,
    String(added.rows.length));
  check('새 세션은 가장 낮은 순환 번호를 받는다',
    added.rows[5].placement.startsWith('순환1')
    && added.rows[6].placement === '순환1',
    JSON.stringify(added.rows.slice(5).map((row) => row.placement)));
  check('선택한 폴더가 새 세션 cwd가 된다', added.rows[6].cwd === 'D:\\chosen',
    added.rows[6].cwd);
  check('세션 수 표시가 7이다', added.sessionCount === '7', added.sessionCount);

  // 이름 변경.
  const renameOpened = await evaluate(`(() => {
    const row = document.querySelectorAll('#session-list .session-row')[6];
    row.querySelector('.session-name')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = row.querySelector('input.session-rename');
    if (!input) { return false; }
    input.value = '이름 변경됨';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  })()`);
  await wait(300);
  const renamed = await evaluate(READ_STATE);
  check('이름 변경 입력이 열린다', renameOpened === true);
  check('terminal 이름 변경은 목록·타일·현재 대상에 반영되고 창 제목은 작업공간을 유지한다',
    renamed.rows[6].name === '이름 변경됨'
    && renamed.tileTitle === '이름 변경됨'
    && renamed.targetName === '이름 변경됨'
    && renamed.documentTitle === '스모크 작업 공간 — 렌더러 동작 검증 — Terminal Deck',
    `${renamed.rows[6].name} / ${renamed.tileTitle} / ${renamed.targetName} / ${renamed.documentTitle}`);

  // --- 종료 유형별 전이 ---
  // 1) 숨은 세션 종료: 타일과 포커스가 그대로여야 한다.
  const beforeHiddenClose = await evaluate(READ_TILES);
  const hiddenCloseTarget = (await evaluate(READ_STATE)).targetName;
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    // 순환 감마는 현재 어느 타일에도 없는 숨은 세션이다.
    const row = rows.find((item) =>
      item.querySelector('.session-name').textContent === '순환 감마');
    row.querySelector('.session-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await wait(450);
  const afterHiddenClose = await evaluate(READ_STATE);
  const afterHiddenCloseTiles = await evaluate(READ_TILES);
  check('숨은 세션 종료 후 세션 수만 줄어든다',
    afterHiddenClose.rows.length === 6, String(afterHiddenClose.rows.length));
  check('숨은 세션 종료가 타일과 포커스를 바꾸지 않는다',
    afterHiddenClose.targetName === hiddenCloseTarget
    && JSON.stringify(afterHiddenCloseTiles.map((tile) => [
      tile.tileId, tile.paneSessionKey, tile.paneReparents
    ])) === JSON.stringify(beforeHiddenClose.map((tile) => [
      tile.tileId, tile.paneSessionKey, tile.paneReparents
    ])),
    `${hiddenCloseTarget} -> ${afterHiddenClose.targetName}`);

  // 2) 표시 중인 순환 세션 종료: 타일은 남고 표시만 비워진다.
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const row = rows.find((item) =>
      item.querySelector('.session-name').textContent === '순환 델타');
    row.querySelector('.session-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await wait(450);
  const afterRotatingClose = await evaluate(READ_TILES);
  const rotatingCloseDeck = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck;
  })()`);
  check('순환 세션 종료는 타일을 남기고 표시만 비운다',
    afterRotatingClose.length === 4
    && afterRotatingClose.find((tile) => tile.tileId === 'r2')
      .paneSessionKey === null
    && rotatingCloseDeck.tiles.find((tile) => tile.id === 'r2')
      .currentSessionKey === null,
    JSON.stringify(afterRotatingClose.map((tile) => tile.paneSessionKey)));
  check('빈 순환 타일에 안내 문구가 표시된다',
    afterRotatingClose.find((tile) => tile.tileId === 'r2').emptyTitle
      === '세션을 선택하세요'
    && afterRotatingClose.find((tile) => tile.tileId === 'r2').emptyHint
      === '왼쪽 목록에서 순환2 세션을 선택하세요.',
    JSON.stringify(afterRotatingClose.find((tile) => tile.tileId === 'r2')));
  check('빈 타일의 최대화 버튼은 비활성된다',
    afterRotatingClose.find((tile) => tile.tileId === 'r2')
      .maximizeDisabled === true);

  // 3) 포커스된 고정 세션 종료: 고정 타일이 제거되고 포커스가 이동한다.
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const row = rows.find((item) =>
      item.querySelector('.session-name').textContent === '고정 베타');
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  })()`);
  await wait(300);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#session-list .session-row')];
    const row = rows.find((item) =>
      item.querySelector('.session-name').textContent === '고정 베타');
    row.querySelector('.session-close')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`);
  await wait(500);
  const afterPinnedClose = await evaluate(READ_STATE);
  const afterPinnedCloseTiles = await evaluate(READ_TILES);
  const pinnedCloseDeck = await evaluate(`(() => {
    const states = window.rendererSmoke.savedStates();
    return states[states.length - 1].deck;
  })()`);
  check('고정 세션 종료는 그 고정 타일을 제거한다',
    afterPinnedCloseTiles.length === 3
    && !afterPinnedCloseTiles.some((tile) => tile.tileId === 'p2')
    && pinnedCloseDeck.tiles.length === 3,
    JSON.stringify(afterPinnedCloseTiles.map((tile) => tile.tileId)));
  check('남은 고정 타일과 순환 타일의 기하는 유지된다',
    JSON.stringify(afterPinnedCloseTiles.map((tile) =>
      `${tile.tileId}:${tile.gridRow}|${tile.gridColumn}`))
      === JSON.stringify(afterRotatingClose
        .filter((tile) => tile.tileId !== 'p2')
        .map((tile) => `${tile.tileId}:${tile.gridRow}|${tile.gridColumn}`)),
    JSON.stringify(afterPinnedCloseTiles.map((tile) =>
      `${tile.tileId}:${tile.gridRow}|${tile.gridColumn}`)));
  check('포커스 세션 종료 후 표시 중인 다른 세션이 포커스된다',
    afterPinnedCloseTiles.filter((tile) => tile.focused).length === 1
    && afterPinnedClose.rows.filter((row) => row.selected === 'true').length === 1
    && afterPinnedClose.targetName === afterPinnedClose.tileTitle,
    `${afterPinnedClose.targetName} / ${afterPinnedClose.tileTitle}`);

  // 모든 세션 종료.
  await evaluate(`(() => {
    for (const row of [...document.querySelectorAll('#session-list .session-row')]) {
      row.querySelector('.session-close')
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  })()`);
  await wait(1000);
  const emptiedTiles = await evaluate(READ_TILES);
  const emptiedParking = await evaluate(READ_PARKING);
  const emptied = await evaluate(`({
    rows: document.querySelectorAll('#session-list .session-row').length,
    listEmptyHidden: document.querySelector('#session-list-empty').hidden,
    targetName: document.querySelector('#inspector-target-name').textContent,
    targetMeta: document.querySelector('#inspector-target-meta').textContent,
    hasSaveSelection: Boolean(document.querySelector('#save-selection')),
    deck: (() => {
      const states = window.rendererSmoke.savedStates();
      return states[states.length - 1].deck;
    })()
  })`);
  check('세션이 모두 사라진다', emptied.rows === 0, String(emptied.rows));
  check('세션이 없어도 최소 하나의 빈 순환 타일이 남는다',
    emptiedTiles.length >= 1
    && emptiedTiles.every((tile) => tile.paneSessionKey === null)
    && emptied.deck.tiles.some((tile) => tile.kind === 'rotating')
    && emptied.deck.focusedSessionKey === null,
    JSON.stringify(emptiedTiles.map((tile) => tile.tileId)));
  check('빈 타일에 안내 문구와 새 세션 버튼이 보인다',
    emptiedTiles.some((tile) => tile.emptyTitle === '세션을 선택하세요'),
    JSON.stringify(emptiedTiles.map((tile) => tile.emptyTitle)));
  check('세션이 사라지면 남은 pane도 없다',
    emptiedParking.totalPanes === 0, String(emptiedParking.totalPanes));
  check('목록에 빈 안내가 표시된다', emptied.listEmptyHidden === false);
  check('현재 대상이 대상 없음이 되고 이유를 표시한다',
    emptied.targetName === '대상 없음' && emptied.targetMeta.length > 0,
    `${emptied.targetName} / ${emptied.targetMeta}`);
  check('선택 저장 버튼은 없고 빈 타일에는 로그 복사 버튼이 숨겨진다',
    emptied.hasSaveSelection === false
    && emptiedTiles.every((tile) => tile.titleDisabled === true)
    && emptiedTiles.every((tile) => tile.pasteHidden === true)
    && emptiedTiles.every((tile) => tile.clearHidden === true)
    && emptiedTiles.every((tile) => tile.logHidden === true));

  check('렌더러 콘솔 오류가 없다', consoleErrors.length === 0,
    consoleErrors.join(' | '));
}

app.whenReady().then(async () => {
  report(`격리 디렉터리: ${temporaryRoot}`);
  sweepStaleTemporaryRoots();
  try {
    const indexPath = prepareIsolatedApp();
    // 렌더러는 §6.1대로 requestAnimationFrame에서 fit한다. 숨은 창은 Chromium이
    // 프레임 생성을 멈춰 rAF 콜백이 오지 않으므로, 창을 실제로 띄워 검증한다.
    smokeWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      show: true,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'renderer-smoke-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });

    smokeWindow.webContents.on('console-message', (event) => {
      if (event.level === 'error' || event.level === 'warning') {
        consoleErrors.push(
          `${event.level}: ${event.message}`
          + ` @${event.sourceId || '?'}:${event.lineNumber || '?'}`
        );
      }
    });

    await smokeWindow.loadFile(indexPath);
    await verify(smokeWindow);
  } catch (error) {
    failures.push(`harness error: ${error.stack || error.message}`);
  }

  const message = failures.length === 0
    ? 'Session Deck renderer smoke test passed.'
    : `Renderer smoke test failed (${failures.length}):\n- ${failures.join('\n- ')}`;
  report(message);
  if (failures.length === 0) {
    console.log(message);
  } else {
    console.error(message);
  }
  finishAndCleanup(failures.length === 0 ? 0 : 1);
}).catch((error) => {
  report(`Renderer smoke setup failed: ${error.stack || error.message}`);
  console.error(error);
  finishAndCleanup(1);
});
