const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const {
  DEFAULT_IDLE_SECONDS,
  normalizeIdleSeconds,
  remainingIdleDelay
} = require('./activity-policy');
const {
  MAX_COMMAND_BLOCKS,
  extractBufferText,
  extractFullBufferText,
  extractInteractiveCliText,
  formatCommandBlock,
  formatCommandBlocks,
  isInteractiveCliCommand,
  isPowerShellClearHostCommand,
  parseOsc133
} = require('./command-blocks');
const {
  buildCommandExecutionInput,
  buildSetLocationCommand,
  moveHistoryCursor
} = require('./command-history');
const {
  createTerminalStatus,
  reduceTerminalStatus,
  terminalStatusView
} = require('./terminal-status');
const { getTerminalShortcutAction } = require('./terminal-policy');
const {
  MAX_COMMAND_PANEL_WIDTH,
  MAX_SESSION_PANEL_WIDTH,
  MIN_COMMAND_PANEL_WIDTH,
  MIN_SESSION_PANEL_WIDTH,
  PANEL_RAIL_WIDTH,
  PANEL_RESIZER_WIDTH,
  fitPanelLayout,
  normalizeCommandPanelWidth,
  normalizeSessionPanelWidth
} = require('./panel-layout');
const {
  DECK_COLUMNS,
  DECK_ROWS,
  createDefaultDeck,
  normalizeRotationSlot,
  resolveDeckState
} = require('./deck-layout');
const {
  addPinnedTile,
  addRotatingTile,
  assignSessionToTile,
  beginDeckEdit,
  cancelDeckEdit,
  convertTileToPinned,
  convertTileToRotating,
  finalizeDeckEdit,
  moveTile,
  removeTileFromDeck,
  resizeTile
} = require('./deck-editor');
const {
  displaySession,
  displayedSessionKey,
  lowestRotationIndex,
  nextFocusKey,
  pinnedTileOrder,
  releaseSession,
  restoreFocusKey,
  sessionPlacementLabel
} = require('./deck-session');
const { providerKindFromCommand } = require('./provider-adapter');
const { rotationColor } = require('./rotation-palette');
const { analyzePaste, encodeTerminalInput } = require('./input-safety');
const { mergeLiveAndUnrestoredTabs } = require('./restore-policy');
const {
  matchesSearchQuery,
  nextSelectionIndex,
  relativeTimeLabel,
  sortAttentionEntries
} = require('./session-productivity');
require('@xterm/xterm/css/xterm.css');
require('./styles.css');

const sessionPanel = document.querySelector('#session-panel');
const sessionPanelRail = document.querySelector('#session-panel-rail');
const sessionPanelRailCount = document.querySelector(
  '#session-panel-rail-count'
);
const sessionPanelRailStatus = document.querySelector(
  '#session-panel-rail-status'
);
const collapseSessionPanelButton = document.querySelector(
  '#collapse-session-panel'
);
const expandSessionPanelButton = document.querySelector(
  '#expand-session-panel'
);
const sessionPanelResizer = document.querySelector('#session-panel-resizer');
const sessionList = document.querySelector('#session-list');
const sessionListEmpty = document.querySelector('#session-list-empty');
const sessionSearch = document.querySelector('#session-search');
const sessionGroup = document.querySelector('#session-group');
const sessionDeck = document.querySelector('#session-deck');
const deckGridOverlay = document.querySelector('#deck-grid-overlay');
const terminalParking = document.querySelector('#terminal-parking');
const deckEditStatus = document.querySelector('#deck-edit-status');
const stateSaveStatus = document.querySelector('#state-save-status');
const nextCompleteButton = document.querySelector('#next-complete');
const nextFailedButton = document.querySelector('#next-failed');
const openAttentionCenterButton = document.querySelector(
  '#open-attention-center'
);
const attentionCenterDialog = document.querySelector(
  '#attention-center-dialog'
);
const attentionCenterList = document.querySelector('#attention-center-list');
const attentionCenterEmpty = document.querySelector('#attention-center-empty');
const acknowledgeAllAttentionButton = document.querySelector(
  '#acknowledge-all-attention'
);
const closeAttentionCenterButton = document.querySelector(
  '#close-attention-center'
);
const openQuickSwitcherButton = document.querySelector('#open-quick-switcher');
const quickSwitcherDialog = document.querySelector('#quick-switcher-dialog');
const quickSwitcherSearch = document.querySelector('#quick-switcher-search');
const quickSwitcherList = document.querySelector('#quick-switcher-list');
const quickSwitcherEmpty = document.querySelector('#quick-switcher-empty');
const closeQuickSwitcherButton = document.querySelector(
  '#close-quick-switcher'
);
const startDeckEditButton = document.querySelector('#start-deck-edit');
const commitDeckEditButton = document.querySelector('#commit-deck-edit');
const cancelDeckEditButton = document.querySelector('#cancel-deck-edit');
const addTileDialog = document.querySelector('#add-tile-dialog');
const addTileForm = document.querySelector('#add-tile-form');
const addTileCell = document.querySelector('#add-tile-cell');
const addTileSessionPicker = document.querySelector('#add-tile-session-picker');
const addTileSessionSelect = document.querySelector('#add-tile-session');
const addTileSessionEmpty = document.querySelector('#add-tile-session-empty');
const confirmAddTileButton = document.querySelector('#confirm-add-tile');
const cancelAddTileButton = document.querySelector('#cancel-add-tile');
const inspectorTargetName = document.querySelector('#inspector-target-name');
const inspectorTargetMeta = document.querySelector('#inspector-target-meta');
const commandPanelRail = document.querySelector('#command-panel-rail');
const commandPanelRailStatus = document.querySelector(
  '#command-panel-rail-status'
);
const collapseCommandPanelButton = document.querySelector(
  '#collapse-command-panel'
);
const expandCommandPanelButton = document.querySelector(
  '#expand-command-panel'
);
const workArea = document.querySelector('.work-area');
const panelResizer = document.querySelector('#panel-resizer');
const workspaceDialog = document.querySelector('#workspace-dialog');
const workspaceList = document.querySelector('#workspace-list');
const workspaceEmpty = document.querySelector('#workspace-empty');
const workspaceEditor = document.querySelector('#workspace-editor');
const workspaceEditorTitle = document.querySelector(
  '#workspace-editor-title'
);
const workspaceIdInput = document.querySelector('#workspace-id');
const workspaceSourceIdInput = document.querySelector('#workspace-source-id');
const workspaceCloneNote = document.querySelector('#workspace-clone-note');
const workspaceNameInput = document.querySelector('#workspace-name');
const workspaceDescriptionInput = document.querySelector(
  '#workspace-description'
);
const workspaceElevationInput = document.querySelector('#workspace-elevation');
const cancelWorkspaceEditButton = document.querySelector(
  '#cancel-workspace-edit'
);
const newWorkspaceButton = document.querySelector('#new-workspace');
const openEphemeralWorkspaceButton = document.querySelector(
  '#open-ephemeral-workspace'
);
const workspaceElevationBadge = document.querySelector(
  '#workspace-elevation-badge'
);
const rotationShortcuts = document.querySelector('#rotation-shortcuts');
const favoriteShortcuts = document.querySelector('#favorite-shortcuts');
const newTabButton = document.querySelector('#new-tab');
const folderTabButton = document.querySelector('#new-tab-with-folder');
const sessionCount = document.querySelector('#session-count');
const idleSecondsInput = document.querySelector('#idle-seconds');
const commandBlockCount = document.querySelector('#command-block-count');
const copyInteractiveCliButton = document.querySelector(
  '#copy-interactive-cli'
);
const commandBlockNotice = document.querySelector('#command-block-notice');
const commandBlockList = document.querySelector('#command-block-list');
const clearCommandBlocksButton = document.querySelector('#clear-command-blocks');
const selectAllCommandBlocks = document.querySelector(
  '#select-all-command-blocks'
);
const selectedCommandBlockCount = document.querySelector(
  '#selected-command-block-count'
);
const copySelectedCommandBlocksButton = document.querySelector(
  '#copy-selected-command-blocks'
);
const saveSelectedCommandBlocksButton = document.querySelector(
  '#save-selected-command-blocks'
);
const deleteSelectedCommandBlocksButton = document.querySelector(
  '#delete-selected-command-blocks'
);
const sidePanelButtons = [...document.querySelectorAll('[data-panel]')];
const blocksTabButton = document.querySelector('#side-panel-tab-blocks');
const sidePanelViews = {
  blocks: document.querySelector('#blocks-panel'),
  history: document.querySelector('#history-panel')
};
const favoriteCount = document.querySelector('#favorite-count');
const favoriteList = document.querySelector('#favorite-list');
const addFavoriteButton = document.querySelector('#add-favorite');
const historyCount = document.querySelector('#history-count');
const historyList = document.querySelector('#history-list');
const clearHistoryButton = document.querySelector('#clear-history');
const favoriteDialog = document.querySelector('#favorite-dialog');
const favoriteForm = document.querySelector('#favorite-form');
const favoriteDialogTitle = document.querySelector('#favorite-dialog-title');
const favoriteIdInput = document.querySelector('#favorite-id');
const favoriteNameInput = document.querySelector('#favorite-name');
const favoriteCommandInput = document.querySelector('#favorite-command');
const cancelFavoriteButton = document.querySelector('#cancel-favorite');
const openSettingsButton = document.querySelector('#open-settings');
const openDiagnosticsButton = document.querySelector('#open-diagnostics');
const diagnosticsDialog = document.querySelector('#diagnostics-dialog');
const diagnosticsSummary = document.querySelector('#diagnostics-summary');
const diagnosticsOutput = document.querySelector('#diagnostics-output');
const copyDiagnosticsButton = document.querySelector('#copy-diagnostics');
const closeDiagnosticsButton = document.querySelector('#close-diagnostics');
const topbarMore = document.querySelector('#topbar-more');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsForm = document.querySelector('#settings-form');
const shellPathInput = document.querySelector('#shell-path');
const chooseShellPathButton = document.querySelector('#choose-shell-path');
const resetShellPathButton = document.querySelector('#reset-shell-path');
const inactiveSessionNotificationsInput = document.querySelector(
  '#inactive-session-notifications'
);
const clearCommandBlocksOnClearHostInput = document.querySelector(
  '#clear-command-blocks-on-clear-host'
);
const cancelSettingsButton = document.querySelector('#cancel-settings');
const toastContainer = document.querySelector('#toast-container');
const pasteConfirmDialog = document.querySelector('#paste-confirm-dialog');
const pasteConfirmTitle = document.querySelector('#paste-confirm-title');
const pasteConfirmReason = document.querySelector('#paste-confirm-reason');
const pasteConfirmTarget = document.querySelector('#paste-confirm-target');
const pasteConfirmPreview = document.querySelector('#paste-confirm-preview');
const confirmPasteButton = document.querySelector('#confirm-paste');
const sessionPlacementMenu = document.createElement('div');
sessionPlacementMenu.className = 'session-context-menu';
sessionPlacementMenu.hidden = true;
sessionPlacementMenu.setAttribute('role', 'menu');
sessionPlacementMenu.setAttribute('aria-label', 'terminal 배치 지정');
document.body.append(sessionPlacementMenu);

function formatDiagnostics(diagnostics) {
  const providers = Array.isArray(diagnostics?.providers) ? diagnostics.providers : [];
  const providerLines = providers.map((provider) => provider.available
    ? `${provider.kind}: ${provider.version || '버전 확인 불가'}\n${provider.path || ''}`
    : `${provider.kind}: 사용할 수 없음 (${provider.error || '미탐지'})`
  );
  const git = diagnostics?.git;
  const gitLine = git?.status === 'ok'
    ? [
        git.detached ? `detached @ ${git.branch}` : git.branch,
        `변경 ${git.changedCount || 0}개`,
        `staged ${git.stagedCount || 0} · unstaged ${git.unstagedCount || 0}`,
        `untracked ${git.untrackedCount || 0} · conflict ${git.conflictedCount || 0}`,
        Number.isInteger(git.ahead) ? `ahead ${git.ahead} · behind ${git.behind}` : '',
        git.root || ''
      ].filter(Boolean).join('\n')
    : {
        'not-repository': 'Git 저장소 아님',
        unavailable: 'Git 실행 파일을 찾지 못함',
        invalid: '조회할 폴더가 없음',
        error: 'Git 조회 실패'
      }[git?.status] || 'Git 조회 결과 없음';
  return [
    `권한\n${diagnostics?.elevation === 'administrator' ? '관리자' : '표준 사용자'}`,
    `작업 공간\n${diagnostics?.workspace || '임시 작업 공간'} · 세션 ${diagnostics?.sessionCount ?? 0}개`,
    `CLI\n${providerLines.join('\n\n') || '조회 결과 없음'}`,
    `Git\n${gitLine}`
  ];
}

openDiagnosticsButton.addEventListener('click', async () => {
  topbarMore.removeAttribute('open');
  diagnosticsSummary.replaceChildren();
  diagnosticsSummary.textContent = '조회 중…';
  diagnosticsOutput.textContent = '';
  diagnosticsDialog.showModal();
  try {
    const diagnostics = await window.terminalApi.getDiagnostics(
      focusedSession()?.cwd || ''
    );
    diagnosticsOutput.textContent = JSON.stringify(diagnostics, null, 2);
    diagnosticsSummary.replaceChildren(...formatDiagnostics(diagnostics).map((text) => {
      const card = document.createElement('section');
      card.textContent = text;
      return card;
    }));
  } catch (error) {
    const message = `진단 실패: ${error.message}`;
    diagnosticsSummary.textContent = message;
    diagnosticsOutput.textContent = message;
  }
});
closeDiagnosticsButton.addEventListener('click', () => diagnosticsDialog.close());
copyDiagnosticsButton.addEventListener('click', async () => {
  await window.terminalApi.writeClipboard(diagnosticsOutput.textContent);
  setTemporaryButtonLabel(copyDiagnosticsButton, '복사됨');
});

const STATE_VERSION = 3;
// styles.css의 .session-deck padding/gap과 맞춘다.
const DECK_GRID_PADDING = 4;
const DECK_GRID_GAP = 4;
const TERMINAL_LOCK_MESSAGE = '배치 편집 중에는 터미널 입력이 잠깁니다.';
const EDIT_LOCK_REASON = '배치 편집을 완료하거나 취소한 뒤 사용할 수 있습니다.';
const SESSION_LIFECYCLE_REASON =
  'terminal 생성 또는 종료가 끝난 뒤 배치를 편집할 수 있습니다.';
const APP_CLOSING_REASON = '앱 종료를 준비하고 있습니다.';
const GIT_CONTEXT_STALE_MS = 2 * 60 * 1000;

const sessions = new Map();
// PTY 복원에 실패한 탭을 즉시 저장에서 삭제하지 않는다. 다음 시작에서
// 다시 복원할 수 있도록 메타데이터를 상태에 계속 포함한다.
let unrestoredTabs = [];
let sessionIndexSortTimer = null;
// tileId -> 타일 DOM view. deck 모델과 1:1로 유지한다.
const tileViews = new Map();
const pendingFitSessionIds = new Set();
// 타일 body의 실제 크기가 바뀔 때만 그 타일의 표시 세션을 fit한다.
const tileBodyResizeObserver = new ResizeObserver((entries) => {
  for (const entry of entries) {
    const { tileId } = entry.target.dataset;
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (session) {
      scheduleFit(session);
    }
  }
});
// 최대화는 런타임 UI 상태다. 저장하지 않는다.
let maximizedTileId = null;
let isFinishingDescriptionEdit = false;
// 오른쪽 패널의 접힘 여부와 활성 보기는 런타임 상태다. 접힘만 shared settings에
// 저장하고, 활성 보기는 이번 Stage에서 저장하지 않는다.
let commandPanelCollapsed = false;
let activeSidePanel = 'blocks';
// 예약된 terminal.focus를 무효화하기 위한 토큰. UI로 DOM 포커스를 옮길 때 올려서
// 다음 프레임에 터미널이 포커스를 다시 빼앗지 못하게 한다.
let terminalFocusRequest = 0;
// 배치 편집 트랜잭션. null이면 일반 모드다. draft는 committed deck과 분리된
// 사본이며, 편집 중에는 저장하지 않는다.
let deckEdit = null;
// 진행 중인 drag/resize gesture.
let tileGesture = null;
// 진행 중인 세션 생명주기 작업(생성/종료) 토큰. 생성과 종료가 겹쳐도 하나가
// 끝났다고 잠금이 풀리지 않도록 boolean 대신 Set으로 센다.
const sessionLifecycleOperations = new Set();
const sessionLifecycleIdleWaiters = new Set();
let sessionLifecycleSequence = 0;
let favorites = [];
let configuredShellPath = '';
let inactiveSessionNotifications = true;
let clearCommandBlocksOnClearHost = false;
// 사용자가 저장한 선호 폭. 화면에 실제 적용되는 폭은 effectivePanelLayout에 있다.
let commandPanelWidth = normalizeCommandPanelWidth();
let sessionPanelWidth = normalizeSessionPanelWidth();
let sessionPanelCollapsed = false;
let effectivePanelLayout = null;
let focusedSessionId = null;
let deckLayout = createDefaultDeck();
let resizeFrame = null;
let idleTimeoutMs = DEFAULT_IDLE_SECONDS * 1000;
let stateSaveTimer = null;
let stateSaveRevision = 0;
let stateSaveTail = Promise.resolve();
let failedSaveRevision = 0;
let activeSaveEpoch = null;
let isClosing = false;
let isRestoringState = true;
let currentWorkspace = null;
let resolveWorkspaceSelection = null;
let quickSwitcherSelection = 0;

// close snapshot을 만든 뒤에는 화면에 보이는 persisted state가 더 바뀌지 않도록
// 모든 사용자 입력을 capture 단계에서 막는다. main의 저장 실패 dialog에서 취소하면
// isClosing을 해제하므로 기존 입력 경로가 그대로 복구된다.
for (const eventName of [
  'beforeinput',
  'change',
  'click',
  'dblclick',
  'input',
  'keydown',
  'pointerdown',
  'submit'
]) {
  document.addEventListener(eventName, (event) => {
    if (!isClosing) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
let runtimeInfo = { elevation: 'unknown', startupWorkspaceId: null };

function formatWorkspaceTime(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return '사용 기록 없음';
  }
  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(new Date(timestamp));
}

function updateWorkspaceDisplay() {
  const appLabel = {
    administrator: '관리자',
    standard: '일반',
    unknown: '확인 불가'
  }[runtimeInfo.elevation] || '확인 불가';
  const terminalElevation = currentWorkspace?.elevation === 'administrator'
    ? 'administrator'
    : currentWorkspace
      ? 'standard'
      : null;
  const terminalLabel = terminalElevation === 'administrator' ? '관리자' : '일반';
  workspaceElevationBadge.hidden = false;
  workspaceElevationBadge.textContent = terminalElevation
    ? `터미널 권한: ${terminalLabel}`
    : `앱 권한: ${appLabel}`;
  workspaceElevationBadge.title = terminalElevation
    ? `터미널은 ${terminalLabel} 권한으로 실행됩니다. Terminal Deck state owner 앱은 ${appLabel} 권한입니다.`
    : runtimeInfo.elevation === 'unknown'
      ? 'Windows integrity level을 확인하지 못했습니다.'
      : `Terminal Deck state owner 앱은 ${appLabel} 권한입니다.`;
  document.body.classList.toggle(
    'elevated',
    terminalElevation === 'administrator'
  );
  document.title = applicationTitle();
}

function applicationTitle() {
  return [
    currentWorkspace?.name,
    currentWorkspace?.description,
    'Terminal Deck'
  ].filter(Boolean).join(' — ');
}

function closeWorkspaceEditor() {
  workspaceEditor.hidden = true;
  workspaceCloneNote.hidden = true;
  workspaceIdInput.value = '';
  workspaceSourceIdInput.value = '';
  workspaceNameInput.value = '';
  workspaceDescriptionInput.value = '';
  workspaceElevationInput.checked = false;
}

function openWorkspaceEditor(workspaceMetadata = null) {
  workspaceEditor.hidden = false;
  workspaceCloneNote.hidden = true;
  workspaceEditorTitle.textContent = workspaceMetadata
    ? '작업 공간 수정'
    : '새 작업 공간';
  workspaceIdInput.value = workspaceMetadata?.id || '';
  workspaceSourceIdInput.value = '';
  workspaceNameInput.value = workspaceMetadata?.name || '';
  workspaceDescriptionInput.value =
    workspaceMetadata?.description || '';
  workspaceElevationInput.checked =
    workspaceMetadata?.elevation === 'administrator';
  workspaceNameInput.focus();
  workspaceNameInput.select();
}

function openWorkspaceCloneEditor(workspaceMetadata) {
  workspaceEditor.hidden = false;
  workspaceCloneNote.hidden = false;
  workspaceEditorTitle.textContent = '작업 공간 복제';
  workspaceIdInput.value = '';
  workspaceSourceIdInput.value = workspaceMetadata.id;
  workspaceNameInput.value = `${workspaceMetadata.name} 복사본`;
  workspaceDescriptionInput.value = workspaceMetadata.description || '';
  workspaceElevationInput.checked =
    workspaceMetadata.elevation === 'administrator';
  workspaceNameInput.focus();
  workspaceNameInput.select();
}

async function selectWorkspace(options) {
  const result = await window.terminalApi.openWorkspace(options);
  if (!result?.opened) {
    if (result?.reason === 'running') {
      window.alert('이 작업 공간은 다른 프로그램 창에서 실행 중입니다.');
      await refreshWorkspaceList();
    } else if (result?.reason === 'restarting') {
      return false;
    } else if (result?.reason === 'elevation-canceled') {
      window.alert('권한 변경이 취소되어 작업 공간을 열지 않았습니다.');
    } else if (result?.reason === 'load-failed') {
      const code = result.error?.code || 'ERR_WORKSPACE_LOAD';
      const message = result.error?.message || '알 수 없는 로드 오류입니다.';
      window.alert(`작업 공간을 열지 못했습니다.\n\n${code}: ${message}`);
    } else {
      window.alert('작업 공간을 열지 못했습니다.');
    }
    if (!workspaceDialog.open) {
      workspaceDialog.showModal();
    }
    return false;
  }

  currentWorkspace = result.workspace;
  activeSaveEpoch = result.saveEpoch;
  updateWorkspaceDisplay();
  if (workspaceDialog.open) {
    workspaceDialog.close();
  }
  const resolve = resolveWorkspaceSelection;
  resolveWorkspaceSelection = null;
  resolve?.(result.state);
  return true;
}

function createWorkspaceCard(metadata) {
  const card = document.createElement('article');
  card.className = 'workspace-card';

  const main = document.createElement('div');
  main.className = 'workspace-card-main';
  main.tabIndex = metadata.running ? -1 : 0;

  const titleRow = document.createElement('div');
  titleRow.className = 'workspace-card-title-row';
  const title = document.createElement('strong');
  title.className = 'workspace-card-title';
  title.textContent = metadata.name;
  titleRow.append(title);
  const elevation = document.createElement('span');
  elevation.className = 'workspace-elevation';
  elevation.textContent = metadata.elevation === 'administrator'
    ? '요청: 관리자'
    : '요청: 일반';
  elevation.title = metadata.elevation === 'administrator'
    ? 'terminal은 UAC 승인 후 관리자 broker에서 실행됩니다.'
    : 'terminal은 일반 권한으로 실행됩니다.';
  titleRow.append(elevation);
  if (metadata.running) {
    const running = document.createElement('span');
    running.className = 'workspace-running';
    running.textContent = '실행 중';
    titleRow.append(running);
  }

  const description = document.createElement('p');
  description.className = 'workspace-card-description';
  description.textContent = metadata.description || '설명이 없습니다.';
  description.title = metadata.description || '';
  if (!metadata.description) {
    description.classList.add('empty');
  }

  const meta = document.createElement('div');
  meta.className = 'workspace-card-meta';
  const recent = document.createElement('span');
  recent.textContent = `최근 사용: ${formatWorkspaceTime(metadata.lastUsedAt)}`;
  const tabs = document.createElement('span');
  const tabSummary = metadata.tabNames?.length > 0
    ? ` · ${metadata.tabNames.slice(0, 3).join(', ')}`
    : '';
  tabs.textContent = `세션 ${metadata.tabCount || 0}개${tabSummary}`;
  meta.append(recent, tabs);
  if (metadata.lastCwd) {
    const cwd = document.createElement('span');
    cwd.textContent = metadata.lastCwd;
    cwd.title = metadata.lastCwd;
    meta.append(cwd);
  }

  main.append(titleRow, description, meta);
  const open = () => {
    if (!metadata.running) {
      void selectWorkspace({ workspaceId: metadata.id });
    }
  };
  main.addEventListener('dblclick', open);
  main.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  const actions = document.createElement('div');
  actions.className = 'workspace-card-actions';
  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.textContent = metadata.running ? '사용 중' : '열기';
  openButton.disabled = metadata.running;
  openButton.addEventListener('click', open);

  const editButton = document.createElement('button');
  editButton.type = 'button';
  editButton.textContent = '수정';
  editButton.disabled = metadata.running;
  editButton.addEventListener('click', () => openWorkspaceEditor(metadata));

  const cloneButton = document.createElement('button');
  cloneButton.type = 'button';
  cloneButton.textContent = '복제';
  cloneButton.title = metadata.running
    ? '현재까지 저장된 세션 구성과 배치를 복제합니다.'
    : '세션 구성과 배치를 복제합니다.';
  cloneButton.addEventListener('click', () => openWorkspaceCloneEditor(metadata));

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'workspace-delete';
  deleteButton.textContent = '삭제';
  deleteButton.disabled = metadata.running;
  deleteButton.addEventListener('click', async () => {
    if (
      !window.confirm(
        `"${metadata.name}" 작업 공간과 terminal 히스토리를 삭제할까요?\n즐겨찾기와 공용 설정은 삭제되지 않습니다.`
      )
    ) {
      return;
    }
    const result = await window.terminalApi.deleteWorkspace(metadata.id);
    if (!result?.deleted) {
      window.alert(
        result?.reason === 'running'
          ? '실행 중인 작업 공간은 삭제할 수 없습니다.'
          : '작업 공간을 삭제하지 못했습니다.'
      );
    }
    await refreshWorkspaceList();
  });

  actions.append(openButton, editButton, cloneButton, deleteButton);
  card.append(main, actions);
  return card;
}

async function refreshWorkspaceList() {
  const workspaces = await window.terminalApi.listWorkspaces();
  workspaceList.replaceChildren(
    ...workspaces.map(createWorkspaceCard)
  );
  workspaceEmpty.hidden = workspaces.length > 0;
}

async function chooseWorkspace() {
  runtimeInfo = await window.terminalApi.getRuntimeInfo()
    || { elevation: 'unknown', startupWorkspaceId: null };
  updateWorkspaceDisplay();
  await refreshWorkspaceList();
  return new Promise((resolve) => {
    resolveWorkspaceSelection = resolve;
    if (runtimeInfo.startupWorkspaceId) {
      void selectWorkspace({ workspaceId: runtimeInfo.startupWorkspaceId });
    } else {
      workspaceDialog.showModal();
    }
  });
}

function focusedSession() {
  return sessions.get(focusedSessionId) || null;
}

function currentRotationSlot() {
  return lowestRotationIndex(deckLayout);
}

// 세 가지 표시 상태를 구분한다.
// - visible: 실제로 보이는 타일에 붙어 있다.
// - covered: 타일에 붙어 있지만 다른 타일 최대화로 잠시 가려졌다(모델상 표시 중,
//   pane도 주차되지 않았다).
// - parked: 어느 타일에도 붙어 있지 않아 주차 영역에 있다.
function sessionVisibility(session) {
  if (!session.displayedTileId) {
    return 'parked';
  }
  return maximizedTileId !== null && maximizedTileId !== session.displayedTileId
    ? 'covered'
    : 'visible';
}

function placementLabel(session) {
  return sessionPlacementLabel(
    deckLayout,
    session.layoutKey,
    session.rotationSlot
  );
}

function sessionByKey(sessionKey) {
  if (!sessionKey) {
    return null;
  }

  for (const session of sessions.values()) {
    if (session.layoutKey === sessionKey) {
      return session;
    }
  }
  return null;
}

// 최대화는 타일 하나만 deck 전체에 임시로 보여주는 런타임 상태다. 다른 타일의
// pane은 그 자리에 그대로 두고 타일만 숨기므로, 복원하면 배치와 표시 세션이
// 정확히 돌아온다. 다른 세션의 PTY는 계속 실행된다.
function toggleTileMaximize(tileId) {
  const tile = deckLayout.tiles.find((item) => item.id === tileId);
  const session = tile ? sessionForTile(tile) : null;
  if (!tile || !session) {
    return;
  }

  maximizedTileId = maximizedTileId === tileId ? null : tileId;
  if (maximizedTileId !== null) {
    focusSession(session.id);
  }
  renderDeck();
  // 숨겨졌던 타일이 다시 보이면 크기가 달라지므로 표시 세션을 모두 다시 fit한다.
  for (const other of sessions.values()) {
    if (other.displayedTileId) {
      other.needsFit = true;
      scheduleFit(other);
    }
  }
}

// --- 배치 편집 트랜잭션 ---
// 편집 중에는 draft deck을 deckLayout에 올려 화면에 미리 보여주고, 커밋된 배치는
// deckEdit.draft.snapshot에 보관한다. 편집 중에는 저장하지 않는다.

function isEditingDeck() {
  return deckEdit !== null;
}

function editableTabs() {
  return [...sessions.values()].map((session) => ({
    key: session.layoutKey,
    rotationSlot: session.rotationSlot
  }));
}

function applyRotationSlotsToSessions(tabs) {
  for (const tab of tabs) {
    const session = sessionByKey(tab.key);
    if (session) {
      session.rotationSlot = tab.rotationSlot ?? null;
      applySessionRotationIdentity(session);
    }
  }
  renderRotationShortcuts();
}

function applyRotationIdentity(element, slot) {
  const color = rotationColor(normalizeRotationSlot(slot));
  if (!color) {
    delete element.dataset.rotationSlot;
    element.style.removeProperty('--rotation-color');
    return;
  }
  element.dataset.rotationSlot = String(slot);
  element.style.setProperty('--rotation-color', color);
}

function applySessionRotationIdentity(session) {
  applyRotationIdentity(session.listRow, session.rotationSlot);
}

function announceDeckEdit(message) {
  deckEditStatus.textContent = message;
  if (message) {
    showToastMessage(message);
  }
}

// 세션 생성·종료는 IPC await를 사이에 두고 sessions와 deck을 여러 단계로 바꾼다.
// 그 도중에 배치 편집에 들어가면 draft가 반쪽 상태를 snapshot하게 되므로,
// 작업 시작부터 모든 deck/session 반영이 끝날 때까지 편집 진입을 막는다.
function beginSessionLifecycle(label) {
  sessionLifecycleSequence += 1;
  const token = `${label}-${sessionLifecycleSequence}`;
  sessionLifecycleOperations.add(token);
  updateSessionLifecycleControls();
  return token;
}

function endSessionLifecycle(token) {
  sessionLifecycleOperations.delete(token);
  updateSessionLifecycleControls();
  if (sessionLifecycleOperations.size === 0) {
    for (const resolve of sessionLifecycleIdleWaiters) {
      resolve();
    }
    sessionLifecycleIdleWaiters.clear();
  }
}

function isSessionLifecycleInFlight() {
  return sessionLifecycleOperations.size > 0;
}

function waitForSessionLifecycleIdle() {
  if (!isSessionLifecycleInFlight()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => sessionLifecycleIdleWaiters.add(resolve));
}

// 편집 중에는 세션 생성·종료를 막는다. draft가 실제 sessions와 어긋나면
// 완료 시 존재하지 않는 세션을 참조한 배치가 저장될 수 있다.
function updateSessionLifecycleControls() {
  const editing = isEditingDeck();
  const lifecycleBusy = isSessionLifecycleInFlight();

  startDeckEditButton.disabled = lifecycleBusy || isClosing;
  startDeckEditButton.title = isClosing
    ? APP_CLOSING_REASON
    : (lifecycleBusy
      ? SESSION_LIFECYCLE_REASON
      : '4×4 격자에서 타일 배치를 편집합니다.');

  for (const button of [newTabButton, folderTabButton]) {
    button.disabled = editing || lifecycleBusy || isClosing;
    button.title = isClosing
      ? APP_CLOSING_REASON
      : (editing
      ? EDIT_LOCK_REASON
      : (button === newTabButton ? '직전 시작 폴더에 새 terminal' : '폴더를 선택해 새 terminal'));
  }
  for (const session of sessions.values()) {
    session.close.disabled = editing || isClosing;
    session.close.title = isClosing
      ? APP_CLOSING_REASON
      : (editing
      ? EDIT_LOCK_REASON
      : 'terminal 삭제 (실행 중이면 PowerShell 프로세스도 종료합니다)');
    session.restart.disabled = !session.exited
      || session.restarting
      || editing
      || isClosing;
  }
  for (const view of tileViews.values()) {
    view.emptyAction.disabled = editing;
    view.emptyAction.title = editing ? EDIT_LOCK_REASON : '';
  }
}

function updateDeckEditChrome() {
  const editing = isEditingDeck();
  startDeckEditButton.hidden = editing;
  commitDeckEditButton.hidden = !editing;
  cancelDeckEditButton.hidden = !editing;
  updateSessionLifecycleControls();
  sessionDeck.classList.toggle('editing', editing);
  deckGridOverlay.hidden = !editing;
  document.body.classList.toggle('deck-editing', editing);
  deckEditStatus.textContent = editing
    ? '배치 편집 중 — 터미널 입력이 잠깁니다.'
    : '';
}

function beginDeckEditMode() {
  if (isClosing) {
    showToastMessage(APP_CLOSING_REASON);
    updateSessionLifecycleControls();
    return;
  }
  if (isEditingDeck()) {
    return;
  }

  // 생성/종료가 IPC await 중이면 sessions와 deck이 아직 서로 맞지 않는다.
  // 버튼이 강제로 활성화됐더라도 draft를 만들지 않는다.
  if (isSessionLifecycleInFlight()) {
    announceDeckEdit(SESSION_LIFECYCLE_REASON);
    updateSessionLifecycleControls();
    return;
  }

  // 편집 직전에 예약돼 있던 저장(이름 변경, 설정 등)을 먼저 흘려보낸다. 이 시점에는
  // deckEdit가 아직 없으므로 draft가 아닌 현재 committed deck이 저장된다.
  // 이걸 하지 않으면 편집 중 타이머가 깨어나 flushStateSave가 그냥 return하면서
  // 편집 전에 끝난 정상 변경이 사라진다.
  if (stateSaveTimer !== null) {
    void flushStateSave().catch(() => {});
  }

  // 최대화는 편집 진입 시 해제한다.
  const restoreMaximizedTileId = maximizedTileId;
  maximizedTileId = null;
  deckEdit = {
    draft: beginDeckEdit(deckLayout, editableTabs()),
    committedDeck: deckLayout,
    focusedSessionId,
    restoreMaximizedTileId
  };
  deckLayout = deckEdit.draft.deck;
  updateDeckEditChrome();
  renderDeck();
  scheduleVisibleFits();
  announceDeckEdit('배치 편집 중 — 터미널 입력이 잠깁니다.');
}

// 편집 전이 결과를 draft와 화면에 반영한다. 실패하면 이유만 알리고 원본을 유지한다.
function applyDeckEditResult(result) {
  if (!result.ok) {
    announceDeckEdit(result.reason);
    return false;
  }

  deckEdit.draft = {
    ...deckEdit.draft,
    deck: result.deck,
    tabs: result.tabs
  };
  deckLayout = result.deck;
  applyRotationSlotsToSessions(result.tabs);
  syncFocusToDeck();
  renderDeck();
  scheduleVisibleFits();
  for (const warning of result.warnings || []) {
    announceDeckEdit(warning);
  }
  return true;
}

// deck의 focusedSessionKey를 런타임 포커스와 맞춘다.
function syncFocusToDeck() {
  const session = sessionByKey(deckLayout.focusedSessionKey);
  focusedSessionId = session ? session.id : null;
}

function commitDeckEditMode() {
  if (!isEditingDeck()) {
    return;
  }

  const result = finalizeDeckEdit(deckEdit.draft);
  if (!result.ok) {
    // 저장하지 않고 편집 모드도 벗어나지 않는다.
    announceDeckEdit(`배치를 저장할 수 없습니다: ${result.reason}`);
    return;
  }

  deckEdit = null;
  deckLayout = result.deck;
  applyRotationSlotsToSessions(result.tabs);
  syncFocusToDeck();
  updateDeckEditChrome();
  renderDeck();
  scheduleVisibleFits();
  restoreTerminalFocus();
  scheduleStateSave();
}

function cancelDeckEditMode() {
  if (!isEditingDeck()) {
    return;
  }

  const restored = cancelDeckEdit(deckEdit.draft);
  const previousFocusId = deckEdit.focusedSessionId;
  const restoreMaximizedTileId = deckEdit.restoreMaximizedTileId;
  deckEdit = null;
  deckLayout = restored.deck;
  applyRotationSlotsToSessions(restored.tabs);
  focusedSessionId = sessions.has(previousFocusId) ? previousFocusId : null;
  if (!focusedSessionId) {
    syncFocusToDeck();
  }
  maximizedTileId = restoreMaximizedTileId;
  updateDeckEditChrome();
  renderDeck();
  scheduleVisibleFits();
  restoreTerminalFocus();
}

function restoreTerminalFocus() {
  const session = focusedSession();
  if (!session || session.isRenaming) {
    return;
  }

  const request = ++terminalFocusRequest;
  requestAnimationFrame(() => {
    if (request === terminalFocusRequest && sessions.has(session.id)) {
      session.terminal.focus();
    }
  });
}

// --- drag / resize gesture ---

function deckCellStep() {
  const bounds = sessionDeck.getBoundingClientRect();
  return {
    x: Math.max(1, (bounds.width - DECK_GRID_PADDING * 2 + DECK_GRID_GAP)
      / DECK_COLUMNS),
    y: Math.max(1, (bounds.height - DECK_GRID_PADDING * 2 + DECK_GRID_GAP)
      / DECK_ROWS)
  };
}

function previewGeometry(gesture, event) {
  const step = deckCellStep();
  const deltaColumn = Math.round((event.clientX - gesture.startX) / step.x);
  const deltaRow = Math.round((event.clientY - gesture.startY) / step.y);
  const start = gesture.startGeometry;

  if (gesture.kind === 'move') {
    return {
      row: start.row + deltaRow,
      column: start.column + deltaColumn,
      rowSpan: start.rowSpan,
      columnSpan: start.columnSpan
    };
  }
  return {
    row: start.row,
    column: start.column,
    rowSpan: Math.max(1, start.rowSpan + deltaRow),
    columnSpan: Math.max(1, start.columnSpan + deltaColumn)
  };
}

function renderGesturePreview(gesture, geometry, validation) {
  const view = tileViews.get(gesture.tileId);
  if (!view) {
    return;
  }

  view.element.style.gridRow =
    `${Math.max(1, geometry.row + 1)} / span ${geometry.rowSpan}`;
  view.element.style.gridColumn =
    `${Math.max(1, geometry.column + 1)} / span ${geometry.columnSpan}`;
  view.element.classList.toggle('drag-preview', validation.ok);
  view.element.classList.toggle('drag-invalid', !validation.ok);
  view.lock.textContent = validation.ok
    ? TERMINAL_LOCK_MESSAGE
    : `배치할 수 없음 — ${validation.reason}`;
}

function evaluateGesture(gesture, geometry) {
  return gesture.kind === 'move'
    ? moveTile(deckEdit.draft, gesture.tileId, geometry)
    : resizeTile(deckEdit.draft, gesture.tileId, geometry);
}

function endTileGesture(commit) {
  if (!tileGesture) {
    return;
  }

  const gesture = tileGesture;
  tileGesture = null;
  const view = tileViews.get(gesture.tileId);
  view?.element.classList.remove('drag-preview', 'drag-invalid');
  if (view) {
    view.lock.textContent = TERMINAL_LOCK_MESSAGE;
  }

  if (commit && gesture.lastResult?.ok) {
    applyDeckEditResult(gesture.lastResult);
    return;
  }

  if (commit && gesture.lastResult) {
    announceDeckEdit(`배치할 수 없음 — ${gesture.lastResult.reason}`);
  }
  // gesture 시작 geometry로 되돌린다.
  renderDeck();
}

function startTileGesture(kind, tileId, event, handle) {
  if (!isEditingDeck()) {
    return;
  }

  const tile = deckLayout.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // 이미 놓친 pointer거나 합성 이벤트면 capture 없이 진행한다.
  }
  tileGesture = {
    kind,
    tileId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startGeometry: {
      row: tile.row,
      column: tile.column,
      rowSpan: tile.rowSpan,
      columnSpan: tile.columnSpan
    },
    lastResult: null
  };
}

function moveTileGesture(event) {
  if (!tileGesture || tileGesture.pointerId !== event.pointerId) {
    return;
  }

  const geometry = previewGeometry(tileGesture, event);
  const result = evaluateGesture(tileGesture, geometry);
  tileGesture.lastResult = result;
  renderGesturePreview(tileGesture, geometry, result);
}

// 최대화된 타일이 사라지거나 비게 되면 최대화를 해제한다.
function ensureMaximizeIsValid() {
  if (maximizedTileId === null) {
    return;
  }

  const tile = deckLayout.tiles.find((item) => item.id === maximizedTileId);
  if (!tile || !sessionForTile(tile)) {
    maximizedTileId = null;
  }
}

function serializeState() {
  const orderedSessions = [...sessions.values()];
  const liveTabs = orderedSessions.map((session) => ({
    key: session.layoutKey,
    name: session.name,
    cwd: session.cwd,
    initialCwd: session.initialCwd,
    description: session.description,
    shellKind: session.shellKind,
    history: session.history,
    rotationSlot: session.rotationSlot,
    provider: session.provider
  }));
  const { tabs, deck } = resolveDeckState({
    tabs: mergeLiveAndUnrestoredTabs(liveTabs, unrestoredTabs),
    activeTabIndex: Math.max(
      0,
      orderedSessions.findIndex((session) => session.id === focusedSessionId)
    ),
    deck: deckLayout
  });

  return {
    version: STATE_VERSION,
    settings: {
      idleSeconds: idleTimeoutMs / 1000,
      shellPath: configuredShellPath,
      inactiveSessionNotifications,
      clearCommandBlocksOnClearHost,
      commandPanelWidth,
      commandPanelCollapsed,
      sessionPanelWidth,
      sessionPanelCollapsed
    },
    favorites: favorites.map(({ id, name, command }) => ({
      id,
      name,
      command
    })),
    tabs,
    activeTabIndex: Math.max(
      0,
      orderedSessions.findIndex((session) => session.id === focusedSessionId)
    ),
    deck
  };
}

function flushStateSave({ force = false, finalRequestId = null } = {}) {
  // 배치 편집 중에는 draft를 저장하지 않는다. 완료 시 한 번만 저장한다.
  if (!force && (isRestoringState || isEditingDeck())) {
    return Promise.resolve({ skipped: true });
  }

  if (stateSaveTimer !== null) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  const request = {
    saveEpoch: activeSaveEpoch,
    revision: ++stateSaveRevision,
    state: serializeState(),
    kind: finalRequestId ? 'final' : 'normal',
    requestId: finalRequestId
  };
  const operation = stateSaveTail.then(
    () => window.terminalApi.saveState(request)
  );
  operation.then(() => {
    if (request.revision >= failedSaveRevision) {
      failedSaveRevision = 0;
      stateSaveStatus.hidden = true;
      stateSaveStatus.textContent = '';
    }
  }).catch((error) => {
    failedSaveRevision = Math.max(failedSaveRevision, request.revision);
    stateSaveStatus.hidden = false;
    stateSaveStatus.textContent = '상태 저장 실패 — 다음 변경에서 다시 시도합니다.';
    console.error(`상태 저장 요청이 실패했습니다: ${error.message}`);
  });
  stateSaveTail = operation.catch(() => {});
  return operation;
}

function scheduleStateSave() {
  if (isRestoringState || isEditingDeck() || isClosing) {
    return;
  }

  if (stateSaveTimer !== null) {
    clearTimeout(stateSaveTimer);
  }
  stateSaveTimer = setTimeout(() => {
    void flushStateSave().catch(() => {});
  }, 150);
}

// 세션 패널 너비는 CSS가 결정하므로 실제 값을 재서 deck에 남는 폭을 계산한다.
// 양쪽 패널과 최소 deck 너비를 함께 계산하는 순수 함수 정리는 Stage 5 몫이다.
// 양쪽 패널·splitter·rail·deck 폭을 한 번에 계산해 적용하는 유일한 경로다.
// ResizeObserver, splitter drag, 접기/펴기가 모두 이 함수를 통과한다.
function applyPanelLayout() {
  const layout = fitPanelLayout({
    containerWidth: workArea.getBoundingClientRect().width,
    preferredSessionWidth: sessionPanelWidth,
    preferredCommandWidth: commandPanelWidth,
    sessionCollapsed: sessionPanelCollapsed,
    commandCollapsed: commandPanelCollapsed
  });
  effectivePanelLayout = layout;

  const style = workArea.style;
  style.setProperty(
    '--session-rail-width',
    layout.sessionCollapsed ? `${PANEL_RAIL_WIDTH}px` : '0px'
  );
  style.setProperty(
    '--session-panel-width',
    layout.sessionCollapsed ? '0px' : `${layout.sessionWidth}px`
  );
  style.setProperty(
    '--session-resizer-width',
    layout.sessionCollapsed ? '0px' : `${PANEL_RESIZER_WIDTH}px`
  );
  style.setProperty(
    '--command-resizer-width',
    layout.commandCollapsed ? '0px' : `${PANEL_RESIZER_WIDTH}px`
  );
  style.setProperty(
    '--command-panel-width',
    layout.commandCollapsed ? '0px' : `${layout.commandWidth}px`
  );
  style.setProperty(
    '--command-rail-width',
    layout.commandCollapsed ? `${PANEL_RAIL_WIDTH}px` : '0px'
  );

  workArea.classList.toggle('session-panel-collapsed', layout.sessionCollapsed);
  workArea.classList.toggle('command-panel-collapsed', layout.commandCollapsed);
  sessionPanelRail.hidden = !layout.sessionCollapsed;
  commandPanelRail.hidden = !layout.commandCollapsed;
  sessionPanelResizer.hidden = layout.sessionCollapsed;
  panelResizer.hidden = layout.commandCollapsed;

  updateResizerAria(
    sessionPanelResizer,
    layout.sessionWidth,
    MIN_SESSION_PANEL_WIDTH,
    MAX_SESSION_PANEL_WIDTH
  );
  updateResizerAria(
    panelResizer,
    layout.commandWidth,
    MIN_COMMAND_PANEL_WIDTH,
    MAX_COMMAND_PANEL_WIDTH
  );
  updatePanelCollapseControls(layout);
  return layout;
}

function updateResizerAria(resizer, value, minimum, maximum) {
  resizer.setAttribute('aria-valuemin', String(minimum));
  resizer.setAttribute('aria-valuemax', String(maximum));
  resizer.setAttribute('aria-valuenow', String(value));
  resizer.setAttribute('aria-valuetext', `${value}픽셀`);
}

// 접기/펴기 버튼과 rail의 라벨. 창이 좁아 임시로 접힌 경우를 구분해 알린다.
function updatePanelCollapseControls(layout) {
  const narrowNotice = ' (창이 좁아 임시로 접혔습니다)';

  collapseSessionPanelButton.setAttribute(
    'aria-expanded',
    String(!layout.sessionCollapsed)
  );
  collapseSessionPanelButton.setAttribute('aria-label', 'terminal 목록 패널 접기');
  collapseSessionPanelButton.title = 'terminal 목록 패널 접기';
  expandSessionPanelButton.setAttribute(
    'aria-expanded',
    String(!layout.sessionCollapsed)
  );
  const sessionExpandLabel = layout.sessionResponsiveCollapsed
    ? `terminal 목록 패널 펼치기${narrowNotice}`
    : 'terminal 목록 패널 펼치기';
  expandSessionPanelButton.setAttribute('aria-label', sessionExpandLabel);
  expandSessionPanelButton.title = sessionExpandLabel;

  collapseCommandPanelButton.setAttribute(
    'aria-expanded',
    String(!layout.commandCollapsed)
  );
  collapseCommandPanelButton.setAttribute('aria-label', 'terminal 도구 패널 접기');
  collapseCommandPanelButton.title = 'terminal 도구 패널 접기';
  expandCommandPanelButton.setAttribute(
    'aria-expanded',
    String(!layout.commandCollapsed)
  );
  const commandExpandLabel = layout.commandResponsiveCollapsed
    ? `terminal 도구 패널 펼치기${narrowNotice}`
    : 'terminal 도구 패널 펼치기';
  expandCommandPanelButton.setAttribute('aria-label', commandExpandLabel);
  expandCommandPanelButton.title = commandExpandLabel;

  const session = focusedSession();
  commandPanelRailStatus.textContent = session
    ? `${session.name} · ${statusLabel(session)}`
    : '대상 없음';
  commandPanelRailStatus.title = commandPanelRailStatus.textContent;

  sessionPanelRailCount.textContent = String(sessions.size);
  const attention = sessionsNeedingAttention('all').length;
  sessionPanelRailStatus.textContent = attention > 0
    ? `terminal ${sessions.size} · 확인 ${attention}`
    : `terminal ${sessions.size}`;
  sessionPanelRailStatus.title = sessionPanelRailStatus.textContent;
  sessionPanelRailCount.setAttribute(
    'aria-label',
    `열린 terminal ${sessions.size}개`
  );
}

function setSessionPanelWidth(width, persist = false) {
  sessionPanelWidth = normalizeSessionPanelWidth(width);
  applyPanelLayout();
  scheduleVisibleFits();
  if (persist) {
    scheduleStateSave();
  }
}

function setCommandPanelWidth(width, persist = false) {
  commandPanelWidth = normalizeCommandPanelWidth(width);
  applyPanelLayout();
  scheduleVisibleFits();
  if (persist) {
    scheduleStateSave();
  }
}

// 활성 보기는 런타임 상태다. 포커스 전환이나 패널 접기/펴기로 바뀌지 않고,
// 사용자가 탭을 누르거나 타일의 블록 바로가기를 눌렀을 때만 바뀐다.
function switchSidePanel(panelName) {
  activeSidePanel = panelName in sidePanelViews ? panelName : 'blocks';
  for (const button of sidePanelButtons) {
    const isActive = button.dataset.panel === activeSidePanel;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  }
  for (const [name, view] of Object.entries(sidePanelViews)) {
    view.hidden = name !== activeSidePanel;
  }

  if (activeSidePanel === 'history') {
    renderHistory();
  } else {
    renderCommandBlocks();
  }
}

// 접기/펴기는 CSS/layout 상태만 바꾼다. 패널 내용을 다시 만들지 않고, deck 모델과
// 포커스 세션, pane 배치도 건드리지 않는다. 저장된 폭은 그대로 둔다.
function setCommandPanelCollapsed(collapsed, persist = true) {
  const next = collapsed === true;
  if (commandPanelCollapsed === next) {
    applyPanelLayout();
    return;
  }

  commandPanelCollapsed = next;
  applyPanelLayout();
  scheduleVisibleFits();
  if (persist) {
    scheduleStateSave();
  }
}

function setSessionPanelCollapsed(collapsed, persist = true) {
  const next = collapsed === true;
  if (sessionPanelCollapsed === next) {
    applyPanelLayout();
    return;
  }

  sessionPanelCollapsed = next;
  applyPanelLayout();
  scheduleVisibleFits();
  if (persist) {
    scheduleStateSave();
  }
}

function fullSessionLog(session) {
  const normalText = extractFullBufferText(session.terminal.buffer.normal);
  if (
    session.terminal.buffer.active !== session.terminal.buffer.alternate
  ) {
    return normalText;
  }

  const alternateText = extractFullBufferText(
    session.terminal.buffer.alternate
  );
  if (!alternateText) {
    return normalText;
  }

  const separator = '----- 현재 전체화면 CLI 화면 -----';
  return normalText
    ? `${normalText}\n\n${separator}\n\n${alternateText}`
    : alternateText;
}

// 세션 종료는 이벤트 핸들러에서 호출되므로 rejected promise가 남지 않게 감싼다.
function requestSessionRemoval(sessionId) {
  removeSession(sessionId).catch((error) => {
    showToastMessage(`terminal을 정리하지 못했습니다: ${error.message}`);
  });
}

// 세션에 묶이지 않은 짧은 안내(배치 편집 거부 이유 등).
function showToastMessage(message) {
  const toast = document.createElement('div');
  toast.className = 'session-toast';
  const text = document.createElement('span');
  text.className = 'session-toast-text';
  text.textContent = message;
  toast.append(text);
  toastContainer.append(toast);
  setTimeout(() => toast.remove(), 4000);
}

function clearSessionToast(session) {
  if (session.toastTimer !== null) {
    clearTimeout(session.toastTimer);
    session.toastTimer = null;
  }
  session.toast?.remove();
  session.toast = null;
}

// 완료 toast는 주차된 숨은 세션에만 띄운다. 화면에 이미 보이는 세션은
// 비포커스여도(그리고 최대화로 잠시 가려졌어도) 타일 header 상태와 왼쪽 주의
// 표시만으로 충분하다. toast는 포커스를 훔치지 않는다.
function showIdleToast(session) {
  if (
    !inactiveSessionNotifications
    || session.exited
    || sessionVisibility(session) !== 'parked'
  ) {
    return;
  }

  clearSessionToast(session);
  const toast = document.createElement('div');
  toast.className = 'session-toast';

  const text = document.createElement('span');
  text.className = 'session-toast-text';
  text.textContent = `${session.name} — ${statusLabel(session)}`;

  const view = document.createElement('button');
  view.type = 'button';
  view.textContent = '보기';
  view.addEventListener('click', () => {
    focusSession(session.id);
    clearSessionToast(session);
  });

  toast.append(text, view);
  toastContainer.append(toast);
  session.toast = toast;
  session.toastTimer = setTimeout(() => clearSessionToast(session), 5000);
}

// 실행 차단은 버튼 UI뿐 아니라 이 진입점에서도 막는다. 대상이 없거나 종료된
// 세션이면 terminalApi.write를 호출하지 않는다.
function executeCommand(session, command) {
  if (!canRunCommands(session) || typeof command !== 'string') {
    return false;
  }

  window.terminalApi.write(
    session.id,
    buildCommandExecutionInput(command, session.atPowerShellPrompt)
  );
  focusSession(session.id);
  return true;
}

function createUtilityButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    action();
  });
  return button;
}

function openFavoriteDialog(favorite = null) {
  favoriteDialogTitle.textContent = favorite
    ? '즐겨찾기 수정'
    : '즐겨찾기 등록';
  favoriteIdInput.value = favorite?.id || '';
  favoriteNameInput.value = favorite?.name || '';
  favoriteCommandInput.value = favorite?.command || '';
  favoriteDialog.showModal();
  favoriteNameInput.focus();
}

function renderFavorites() {
  favoriteList.replaceChildren();
  favoriteCount.textContent = String(favorites.length);
  renderFavoriteShortcuts();

  if (favorites.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'utility-empty';
    empty.textContent = '등록된 즐겨찾기가 없습니다.';
    favoriteList.append(empty);
    return;
  }

  for (const favorite of favorites) {
    const item = document.createElement('article');
    item.className = 'utility-item';
    const isExpanded = favorite.expanded === true;
    item.classList.toggle('expanded', isExpanded);

    const header = document.createElement('div');
    header.className = 'favorite-item-header';

    const title = document.createElement('strong');
    title.className = 'utility-item-title';
    title.textContent = favorite.name;

    const toggle = createUtilityButton(
      isExpanded ? '접기' : '펼치기',
      () => {
        favorite.expanded = !isExpanded;
        renderFavorites();
      }
    );
    toggle.classList.add('favorite-toggle');
    header.append(title, toggle);

    const details = document.createElement('div');
    details.className = 'favorite-item-details';
    details.hidden = !isExpanded;

    const command = document.createElement('pre');
    command.className = 'utility-item-command';
    command.textContent = favorite.command;

    const runButton = createUtilityButton('실행', () =>
      executeCommand(focusedSession(), favorite.command)
    );
    runButton.classList.add('favorite-run');

    const actions = document.createElement('div');
    actions.className = 'utility-item-actions';
    actions.addEventListener('dblclick', (event) => event.stopPropagation());
    actions.append(
      runButton,
      createUtilityButton('수정', () => openFavoriteDialog(favorite)),
      createUtilityButton('삭제', () => {
        if (!window.confirm(`"${favorite.name}" 즐겨찾기를 삭제할까요?`)) {
          return;
        }
        favorites = favorites.filter((item) => item.id !== favorite.id);
        renderFavorites();
        scheduleStateSave();
      })
    );

    item.addEventListener('dblclick', () => {
      if (!isExpanded) {
        executeCommand(focusedSession(), favorite.command);
      }
    });
    details.append(command, actions);
    item.append(header, details);
    favoriteList.append(item);
  }

  updateFavoriteRunTargets();
}

// 등록 순서를 유지하되 상단 오른쪽에는 앞의 세 개만 바로 가기로 노출한다.
function renderFavoriteShortcuts() {
  favoriteShortcuts.replaceChildren();
  for (const favorite of favorites.slice(0, 3)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'favorite-shortcut';
    button.textContent = favorite.name;
    button.dataset.favoriteName = favorite.name;
    button.addEventListener('click', () =>
      executeCommand(focusedSession(), favorite.command)
    );
    favoriteShortcuts.append(button);
  }
}

// 왼쪽 terminal 목록을 접어도 순환 세션을 바로 표시할 수 있게, 고정 세션을
// 제외한 세션만 등록 순서대로 노출한다. 클릭은 왼쪽 목록과 같은 focusSession
// 경로를 사용하므로 표시 타일 선택과 저장 규칙을 따로 만들지 않는다.
function renderRotationShortcuts() {
  const rotating = [...sessions.values()].filter(
    (session) => normalizeRotationSlot(session.rotationSlot) !== null
  );
  rotationShortcuts.hidden = rotating.length === 0;
  if (rotating.length === 0) {
    rotationShortcuts.replaceChildren();
    return;
  }

  let label = rotationShortcuts.querySelector('.rotation-shortcuts-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'rotation-shortcuts-label';
    label.textContent = '순환';
    rotationShortcuts.prepend(label);
  }

  const existing = new Map(
    [...rotationShortcuts.querySelectorAll('.rotation-shortcut')]
      .map((button) => [button.dataset.sessionId, button])
  );
  const liveSessionIds = new Set();

  for (const session of rotating) {
    liveSessionIds.add(session.id);
    let button = existing.get(session.id);
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'rotation-shortcut';
      const status = document.createElement('span');
      status.className = 'rotation-shortcut-status';
      status.setAttribute('aria-hidden', 'true');
      const identity = document.createElement('span');
      identity.className = 'rotation-shortcut-identity';
      const name = document.createElement('span');
      name.className = 'rotation-shortcut-name';
      button.append(identity, status, name);
      button.addEventListener('click', () => focusSession(button.dataset.sessionId));
    }

    button.dataset.sessionId = session.id;
    applyRotationIdentity(button, session.rotationSlot);
    button.dataset.status = statusKind(session);
    button.setAttribute('aria-pressed', String(session.id === focusedSessionId));
    button.disabled = isEditingDeck() && !session.displayedTileId;
    const name = button.querySelector('.rotation-shortcut-name');
    name.textContent = session.name;
    button.querySelector('.rotation-shortcut-identity').textContent =
      `R${session.rotationSlot}`;

    const details = [
      `${placementLabel(session)} · ${statusLabel(session)}`,
      shellDisplayLabel(session),
      session.cwd,
      session.description
    ].filter(Boolean).join('\n');
    button.title = details;
    button.setAttribute(
      'aria-label',
      `순환 ${session.rotationSlot}, ${session.name}: ${placementLabel(session)}에 표시하고 포커스`
    );
    rotationShortcuts.append(button);
  }

  for (const [sessionId, button] of existing) {
    if (!liveSessionIds.has(sessionId)) {
      button.remove();
    }
  }
}

function formatHistoryTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const isToday =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return isToday
    ? time
    : `${pad(date.getMonth() + 1)}.${pad(date.getDate())} ${time}`;
}

function renderHistory() {
  const session = focusedSession();
  const history = session?.history || [];
  historyList.replaceChildren();
  historyCount.textContent = String(history.length);
  clearHistoryButton.disabled = history.length === 0;

  if (history.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'utility-empty';
    empty.textContent = '이 terminal에서 실행한 명령이 없습니다.';
    historyList.append(empty);
    return;
  }

  for (const entry of [...history].reverse()) {
    const item = document.createElement('article');
    item.className = 'utility-item history-item';
    item.title = `${entry.command}\n\n더블클릭하여 다시 실행`;

    const command = document.createElement('span');
    command.className = 'history-item-command';
    command.textContent = entry.command.replace(/\r\n|\r|\n/gu, ' ↵ ');
    const time = document.createElement('span');
    time.className = 'utility-item-time';
    time.textContent = formatHistoryTime(entry.timestamp);
    const copy = createUtilityButton('복사', () => {
      void window.terminalApi.writeClipboard(entry.command).then(() => {
        setTemporaryButtonLabel(copy, '완료');
      });
    });
    copy.classList.add('history-run');
    copy.addEventListener('dblclick', (event) => event.stopPropagation());
    const run = createUtilityButton('실행', () =>
      executeCommand(session, entry.command)
    );
    run.classList.add('history-run');
    run.addEventListener('dblclick', (event) => event.stopPropagation());

    item.addEventListener('dblclick', () =>
      executeCommand(session, entry.command)
    );
    item.append(command, time, copy, run);
    historyList.append(item);
  }
}

function appendHistory(session, command) {
  if (!command.trim()) {
    return;
  }

  session.history.push({
    command,
    timestamp: Date.now()
  });
  if (session.history.length > 500) {
    session.history.splice(0, session.history.length - 500);
  }
  session.historyCursor = session.history.length;
  if (session.id === focusedSessionId) {
    renderHistory();
  }
  scheduleStateSave();
}

function recallHistory(session, direction) {
  if (isEditingDeck() || !session.atPowerShellPrompt) {
    return false;
  }

  if (session.history.length === 0) {
    window.terminalApi.write(session.id, '\x07');
    return true;
  }

  const selection = moveHistoryCursor(
    session.history,
    session.historyCursor,
    direction
  );
  session.historyCursor = selection.cursor;
  const { command } = selection;
  window.terminalApi.write(session.id, '\x07');
  if (command) {
    session.isRecallingHistory = true;
    session.terminal.paste(command);
  }
  return true;
}

function setTemporaryButtonLabel(button, label) {
  const originalLabel = button.textContent;
  const refreshesCommandBlocks = Boolean(
    button.closest('#command-block-toolbar') || button.id === 'command-block-count'
  );
  button.textContent = label;
  button.disabled = true;
  setTimeout(() => {
    if (button.isConnected) {
      button.textContent = originalLabel;
      button.disabled = false;
      if (refreshesCommandBlocks) {
        renderCommandBlocks();
      }
    }
  }, 1000);
}

function createCommandBlockButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => void action(button));
  return button;
}

function defaultBlockFileName(block) {
  const timestamp = new Date(block.completedAt)
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/u, '');
  return `command-block-${timestamp}.txt`;
}

function selectedBlocks(session) {
  return session.commandBlocks.filter((block) =>
    session.selectedCommandBlockIds.has(block.id)
  );
}

// 사라진 block id는 그 세션의 선택 집합에서도 정리한다(삭제, Clear-Host,
// 최대 개수 초과로 밀려난 경우). 선택 상태는 세션별이며 디스크에 저장하지 않는다.
function pruneSelectedBlockIds(session) {
  if (session.selectedCommandBlockIds.size === 0) {
    return;
  }

  const liveIds = new Set(session.commandBlocks.map((block) => block.id));
  for (const id of [...session.selectedCommandBlockIds]) {
    if (!liveIds.has(id)) {
      session.selectedCommandBlockIds.delete(id);
    }
  }
}

// 명령 블록 툴바의 대상 세션 이름과 선택 개수를 버튼 이름에 반영한다.
function updateCommandBlockActionTargets(session, selectedCount) {
  const name = session?.name;
  const actions = [
    [copySelectedCommandBlocksButton, '복사'],
    [saveSelectedCommandBlocksButton, '저장'],
    [deleteSelectedCommandBlocksButton, '삭제']
  ];
  for (const [button, verb] of actions) {
    const label = name
      ? `${name}의 선택한 명령 블록 ${selectedCount}개 ${verb}`
      : `선택한 명령 블록 ${verb}`;
    button.setAttribute('aria-label', label);
    button.title = name
      ? (selectedCount > 0 ? label : '선택한 명령 블록이 없습니다.')
      : NO_TARGET_REASON;
  }

  const clearLabel = name
    ? `${name}의 명령 블록 전체 지우기`
    : '명령 블록 전체 지우기';
  clearCommandBlocksButton.setAttribute('aria-label', clearLabel);
  clearCommandBlocksButton.title = name ? clearLabel : NO_TARGET_REASON;
  const copyAllLabel = name
    ? `${name}의 명령 블록 ${session.commandBlocks.length}개 전체 복사`
    : '명령 블록 전체 복사';
  commandBlockCount.setAttribute('aria-label', copyAllLabel);
  commandBlockCount.title = name ? copyAllLabel : NO_TARGET_REASON;
  selectAllCommandBlocks.setAttribute(
    'aria-label',
    name ? `${name}의 명령 블록 전체 선택` : '명령 블록 전체 선택'
  );
}

function defaultSelectedBlocksFileName() {
  const timestamp = new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/u, '');
  return `command-blocks-${timestamp}.txt`;
}

// 블록 보기는 항상 포커스 세션 것만 렌더한다. 선택 개수·전체 선택·툴바 버튼도
// 모두 그 세션 기준이며, 세션별 선택 집합은 서로 섞이지 않는다.
function renderCommandBlocks() {
  const session = focusedSession();
  commandBlockList.replaceChildren();
  if (session) {
    pruneSelectedBlockIds(session);
  }
  commandBlockCount.textContent = `전체 복사 · ${session?.commandBlocks.length || 0}`;
  const selected = session ? selectedBlocks(session) : [];
  const hasBlocks = Boolean(session?.commandBlocks.length);
  const allSelected =
    hasBlocks && selected.length === session.commandBlocks.length;
  selectAllCommandBlocks.disabled = !hasBlocks;
  selectAllCommandBlocks.checked = allSelected;
  selectAllCommandBlocks.indeterminate =
    hasBlocks && selected.length > 0 && !allSelected;
  selectedCommandBlockCount.textContent = `${selected.length}개 선택`;
  clearCommandBlocksButton.disabled = !hasBlocks;
  commandBlockCount.disabled = !hasBlocks;
  copySelectedCommandBlocksButton.disabled = selected.length === 0;
  saveSelectedCommandBlocksButton.disabled = selected.length === 0;
  deleteSelectedCommandBlocksButton.disabled = selected.length === 0;
  updateCommandBlockActionTargets(session, selected.length);
  const interactiveCliActive = session?.interactiveCliActive === true;
  copyInteractiveCliButton.hidden = !interactiveCliActive;
  copyInteractiveCliButton.disabled = !interactiveCliActive;
  copyInteractiveCliButton.title = interactiveCliActive
    ? `${session.name}에 현재 표시되거나 보관된 CLI 응답 복사`
    : '';
  copyInteractiveCliButton.setAttribute(
    'aria-label',
    interactiveCliActive
      ? `${session.name}의 현재 CLI 응답 복사`
      : '현재 CLI 응답 복사'
  );

  if (!session) {
    commandBlockNotice.hidden = false;
    commandBlockNotice.textContent = '열린 PowerShell terminal이 없습니다.';
    return;
  }

  if (session.interactiveCliActive) {
    commandBlockNotice.hidden = false;
    commandBlockNotice.textContent =
      'Claude/Codex CLI 안에서는 명령 블록을 만들지 않습니다. '
      + 'CLI 응답 복사는 현재 화면 또는 CLI 시작 이후 버퍼를 복사합니다.';
  } else if (session.commandBlocks.length === 0) {
    commandBlockNotice.hidden = false;
    commandBlockNotice.textContent =
      'PowerShell 명령을 실행하면 명령과 출력이 블록으로 표시됩니다.';
  } else {
    commandBlockNotice.hidden = true;
  }

  for (const block of [...session.commandBlocks].reverse()) {
    const card = document.createElement('article');
    card.className = 'command-block';
    card.classList.toggle('expanded', block.expanded);

    const command = document.createElement('div');
    command.className = 'command-block-command';

    const selector = document.createElement('input');
    selector.type = 'checkbox';
    selector.checked = session.selectedCommandBlockIds.has(block.id);
    selector.setAttribute('aria-label', `${block.command} 블록 선택`);
    selector.addEventListener('change', () => {
      if (selector.checked) {
        session.selectedCommandBlockIds.add(block.id);
      } else {
        session.selectedCommandBlockIds.delete(block.id);
      }
      renderCommandBlocks();
    });

    const commandText = document.createElement('span');
    commandText.className = 'command-block-command-text';
    commandText.textContent = `> ${block.command}`;

    const toggle = createCommandBlockButton(
      block.expanded ? '접기' : '펼치기',
      async () => {
        block.expanded = !block.expanded;
        renderCommandBlocks();
      }
    );
    toggle.classList.add('command-block-toggle');
    command.append(selector, commandText, toggle);

    const details = document.createElement('div');
    details.className = 'command-block-details';
    details.hidden = !block.expanded;

    const output = document.createElement('pre');
    output.className = 'command-block-output';
    output.textContent = block.output;

    const actions = document.createElement('div');
    actions.className = 'command-block-actions';
    actions.append(
      createCommandBlockButton('출력 복사', async (button) => {
        await window.terminalApi.writeClipboard(block.output);
        setTemporaryButtonLabel(button, '복사됨');
      }),
      createCommandBlockButton('블록 복사', async (button) => {
        await window.terminalApi.writeClipboard(formatCommandBlock(block));
        setTemporaryButtonLabel(button, '복사됨');
      }),
      createCommandBlockButton('파일 저장', async (button) => {
        const result = await window.terminalApi.saveCommandBlock({
          defaultName: defaultBlockFileName(block),
          text: formatCommandBlock(block)
        });
        if (result?.saved) {
          setTemporaryButtonLabel(button, '저장됨');
        }
      })
    );

    details.append(output, actions);
    card.append(command, details);
    commandBlockList.append(card);
  }
}

function updateEmptyState() {
  sessionCount.textContent = String(sessions.size);
  openQuickSwitcherButton.disabled = sessions.size === 0;
  applySessionIndexView();
  renderAttentionNavigation();
  renderDeck();
  renderCommandBlocks();
}

// PTY가 끝난 세션은 running/complete/idle 대신 종료됨으로 표시한다. 왼쪽 목록
// badge, 타일 header, 오른쪽 현재 대상이 모두 이 값을 쓴다.
function statusKind(session) {
  if (session.restarting) return 'restarting';
  return terminalStatusView(session.statusState).kind;
}

function statusLabel(session) {
  if (session.restarting) return '다시 시작 중';
  return terminalStatusView(session.statusState).label;
}

function privilegeLabel(session) {
  return session?.elevated ? '관리자' : '';
}

function shellDisplayLabel(session) {
  return [session?.shellLabel, privilegeLabel(session)].filter(Boolean).join(' · ');
}

function updateStatusDisplay(session) {
  const badges = {
    running: '🟢 명령 실행 중',
    quiet: '◌ 출력 대기',
    complete: '✓ 명령 종료',
    failed: '⚠ 명령 실패',
    ready: '⚪ 입력 대기',
    exited: '⛔ 종료됨',
    restarting: '↻ 다시 시작 중'
  };
  const kind = statusKind(session);
  session.statusBadge.textContent = badges[kind] || badges.ready;
  session.statusBadge.dataset.status = kind;
  session.statusBadge.dataset.source = session.statusState.source;
  const now = Date.now();
  const detail = session.commandInProgress
    ? `실행 ${Math.max(0, Math.floor((now - session.statusState.commandStartedAt) / 1000))}초 · 마지막 출력 ${Math.max(0, Math.floor((now - session.statusState.lastOutputAt) / 1000))}초 전`
    : '';
  session.statusBadge.title = [
    '상태 출처: Generic terminal (OSC 133)',
    session.providerHint
      ? `${session.providerHint} CLI 감지 · provider 구조화 상태는 연결되지 않음`
      : '',
    detail
  ].filter(Boolean).join('\n');
  refreshSessionSurfaces(session);
  renderAttentionNavigation();
  if (quickSwitcherDialog.open) renderQuickSwitcher();
}

function sessionsNeedingAttention(kind) {
  return [...sessions.values()].filter((session) => {
    const terminalKind = terminalStatusView(session.statusState).kind;
    if (kind === 'all') {
      return !session.restarting && (
        terminalKind === 'complete'
        || terminalKind === 'failed'
        || (terminalKind === 'exited' && !session.exitAcknowledged)
      );
    }
    return !session.restarting && terminalKind === kind;
  });
}

function attentionEntries() {
  return sortAttentionEntries(sessionsNeedingAttention('all').map((session) => {
    const kind = terminalStatusView(session.statusState).kind;
    const latestBlock = session.commandBlocks.at(-1);
    return {
      session,
      kind,
      name: session.name,
      occurredAt: kind === 'exited'
        ? session.exitedAt || session.lastActivityAt
        : session.statusState.completedAt,
      detail: latestBlock?.command
        || session.pendingCommand
        || (kind === 'exited' ? 'terminal 프로세스 종료' : statusLabel(session))
    };
  }));
}

function renderAttentionCenter() {
  const entries = attentionEntries();
  const labels = { failed: '실패', exited: '종료', complete: '완료' };
  const items = entries.map((entry) => {
    const row = document.createElement('div');
    row.className = 'attention-center-item';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'attention-center-main';
    const title = document.createElement('span');
    title.className = 'attention-center-title';
    const kind = document.createElement('span');
    kind.className = 'attention-center-kind';
    kind.dataset.kind = entry.kind;
    kind.textContent = labels[entry.kind] || entry.kind;
    const name = document.createElement('strong');
    name.textContent = entry.name;
    title.append(kind, name);
    const detail = document.createElement('span');
    detail.className = 'attention-center-detail';
    detail.textContent = [
      entry.detail,
      placementLabel(entry.session),
      relativeTimeLabel(entry.occurredAt)
    ].filter(Boolean).join(' · ');
    main.append(title, detail);
    main.addEventListener('click', () => {
      attentionCenterDialog.close();
      focusSession(entry.session.id);
    });
    row.append(main);
    if (entry.kind === 'exited') {
      const restart = document.createElement('button');
      restart.type = 'button';
      restart.className = 'attention-center-restart';
      restart.textContent = entry.session.restarting ? '시작 중…' : '다시 시작';
      restart.disabled = entry.session.restarting || isClosing || isEditingDeck();
      restart.addEventListener('click', () => {
        void restartSession(entry.session.id);
      });
      row.append(restart);
    }
    return row;
  });
  attentionCenterList.replaceChildren(...items);
  attentionCenterEmpty.hidden = entries.length > 0;
  acknowledgeAllAttentionButton.disabled = entries.length === 0;
}

function renderAttentionNavigation() {
  const all = sessionsNeedingAttention('all');
  openAttentionCenterButton.textContent = `확인 ${all.length}`;
  openAttentionCenterButton.disabled = all.length === 0;
  for (const [button, kind, label] of [
    [nextCompleteButton, 'complete', '완료'],
    [nextFailedButton, 'failed', '실패']
  ]) {
    const matches = sessionsNeedingAttention(kind);
    button.textContent = `${label} ${matches.length}`;
    button.disabled = matches.length === 0;
    button.title = `${label} 결과를 확인하지 않은 다음 세션`;
  }
  renderAttentionCenter();
}

function focusNextAttention(kind) {
  const matches = sessionsNeedingAttention(kind);
  if (matches.length === 0) return;
  const current = matches.findIndex((session) => session.id === focusedSessionId);
  focusSession(matches[(current + 1) % matches.length].id);
}

nextCompleteButton.addEventListener('click', () => focusNextAttention('complete'));
nextFailedButton.addEventListener('click', () => focusNextAttention('failed'));
openAttentionCenterButton.addEventListener('click', () => {
  renderAttentionCenter();
  if (!attentionCenterDialog.open) attentionCenterDialog.showModal();
});
closeAttentionCenterButton.addEventListener('click', () => {
  attentionCenterDialog.close();
});
acknowledgeAllAttentionButton.addEventListener('click', () => {
  for (const { session } of attentionEntries()) acknowledgeSession(session);
  renderAttentionNavigation();
});

function applyStatusEvent(session, event) {
  session.statusState = reduceTerminalStatus(session.statusState, event);
  session.commandInProgress = session.statusState.commandInProgress;
  session.lastOutputAt = session.statusState.lastOutputAt;
}

// 한 세션의 표시면(왼쪽 행, 표시 중인 타일 header, 포커스면 오른쪽 대상)을 갱신한다.
// 상태 변화나 출력만으로 포커스나 배치가 바뀌지는 않는다.
function refreshSessionSurfaces(session) {
  if (!sessions.has(session.id)) {
    return;
  }

  updateSessionRow(session);
  if (session.displayedTileId) {
    const tile = deckLayout.tiles.find(
      (item) => item.id === session.displayedTileId
    );
    if (tile) {
      updateTileView(tile);
    }
  }
  if (session.id === focusedSessionId) {
    renderInspectorTarget();
  }
  renderRotationShortcuts();
}

function clearAttention(session) {
  if (session.attentionTimer !== null) {
    clearTimeout(session.attentionTimer);
    session.attentionTimer = null;
  }

  session.listRow.classList.remove('attention');
}

function emphasizeIdleTransition(session) {
  clearAttention(session);
  session.listRow.classList.add('attention');
}

function transitionToIdle(session) {
  session.idleTimer = null;
  if (!session.commandInProgress || session.statusState.activity === 'quiet') {
    return;
  }
  applyStatusEvent(session, { type: 'SILENCE_TIMEOUT', now: Date.now() });
  updateStatusDisplay(session);
}

function scheduleIdleTransition(session) {
  if (!session.commandInProgress) {
    return;
  }

  if (session.idleTimer !== null) {
    clearTimeout(session.idleTimer);
  }

  const delay = remainingIdleDelay(
    session.lastOutputAt,
    Date.now(),
    idleTimeoutMs
  );

  if (delay === 0) {
    transitionToIdle(session);
    return;
  }

  updateStatusDisplay(session);

  session.idleTimer = setTimeout(() => transitionToIdle(session), delay);
}

function recordOutputActivity(session) {
  session.lastActivityAt = Date.now();
  if (sessionGroup?.value === 'recent' && sessionIndexSortTimer === null) {
    sessionIndexSortTimer = setTimeout(() => {
      sessionIndexSortTimer = null;
      if (sessions.size > 0) applySessionIndexView();
    }, 250);
  }
  if (!session.commandInProgress) {
    return;
  }

  const previousKind = statusKind(session);
  applyStatusEvent(session, { type: 'OUTPUT', now: Date.now() });
  if (previousKind !== statusKind(session)) {
    clearAttention(session);
    updateStatusDisplay(session);
  }
  scheduleIdleTransition(session);
}

// 표시 중인(= 보이는 타일에 붙어 있는) 세션만 fit한다. 숨은 세션은 마지막 PTY
// 크기를 유지하고, 크기가 0인 pane에는 resize를 보내지 않는다.
function fitSession(session) {
  if (!session || !session.displayedTileId) {
    return;
  }

  const bounds = session.pane.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return;
  }

  session.fitAddon.fit();
  const { cols, rows } = session.terminal;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    return;
  }
  // cols/rows가 실제로 바뀐 경우에만 main process로 보낸다.
  if (session.ptyCols === cols && session.ptyRows === rows) {
    return;
  }

  session.ptyCols = cols;
  session.ptyRows = rows;
  window.terminalApi.resize(session.id, cols, rows);
}

// 세션별로 모아 한 프레임에 한 번만 fit한다(resize 이벤트 폭주 방지).
function scheduleFit(session) {
  if (!session) {
    return;
  }

  pendingFitSessionIds.add(session.id);
  if (resizeFrame !== null) {
    return;
  }
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    const pending = [...pendingFitSessionIds];
    pendingFitSessionIds.clear();
    for (const sessionId of pending) {
      fitSession(sessions.get(sessionId));
    }
  });
}

function scheduleVisibleFits() {
  for (const session of sessions.values()) {
    if (session.displayedTileId) {
      scheduleFit(session);
    }
  }
}

// 예약된 terminal.focus를 취소한다.
function cancelTerminalFocus() {
  terminalFocusRequest += 1;
}

// 레이아웃이 반영된 다음 프레임에 UI 요소로 포커스를 넘긴다. 같은 프레임에
// 예약돼 있던 terminal.focus는 무효화한다.
function focusAfterLayout(element) {
  cancelTerminalFocus();
  requestAnimationFrame(() => {
    if (element.isConnected && element.offsetParent !== null) {
      element.focus();
    }
  });
}

// 사용자가 세션을 확인했다는 표시. 주의 강조와 완료 알림을 정리한다.
// 배치나 pane은 건드리지 않는다.
function acknowledgeSession(session) {
  clearAttention(session);
  clearSessionToast(session);
  if (session.statusState.lifecycle === 'exited') {
    session.exitAcknowledged = true;
  } else {
    applyStatusEvent(session, { type: 'FOCUS', now: Date.now() });
  }
  updateStatusDisplay(session);
}

// 포커스만 옮긴다. 표시 세션 집합은 deck 모델이 결정한다.
// options.focusTerminal이 false면 논리적 포커스만 옮기고 키보드 포커스는
// 호출부가 원하는 UI 요소에 남겨 둔다(예: 타일의 블록 바로가기).
function focusSession(sessionId, options = {}) {
  const nextSession = sessions.get(sessionId);
  if (!nextSession) {
    return;
  }

  const focusTerminal = options.focusTerminal !== false;
  if (!focusTerminal) {
    cancelTerminalFocus();
  }

  // 배치 편집 중에는 배치를 클릭으로 바꾸지 않는다. 표시 중인 세션 사이에서만
  // 대상을 옮겨 오른쪽 패널로 상태를 확인할 수 있게 한다.
  if (isEditingDeck()) {
    if (!nextSession.displayedTileId) {
      announceDeckEdit('배치 편집 중에는 표시 중인 terminal만 선택할 수 있습니다.');
      return;
    }
    focusedSessionId = sessionId;
    deckLayout.focusedSessionKey = nextSession.layoutKey;
    deckEdit.draft.deck.focusedSessionKey = nextSession.layoutKey;
    renderDeck();
    renderCommandBlocks();
    renderHistory();
    return;
  }

  // 이미 표시·포커스된 세션 재클릭: 주의 강조·완료 상태만 정리하고 배치와 DOM은
  // 그대로 둔다. displaySession/renderDeck/pane 이동/deck 변경을 하지 않는다.
  if (focusedSessionId === sessionId && nextSession.displayedTileId) {
    acknowledgeSession(nextSession);
    if (focusTerminal && !nextSession.isRenaming) {
      nextSession.terminal.focus();
    }
    return;
  }

  focusedSessionId = sessionId;
  deckLayout = displaySession(
    deckLayout,
    nextSession.layoutKey,
    nextSession.rotationSlot
  );
  renderDeck();

  acknowledgeSession(nextSession);
  renderCommandBlocks();
  renderHistory();
  scheduleStateSave();

  // 이 예약은 그 사이에 UI가 포커스를 가져가면(토큰 증가) 취소된다.
  const request = ++terminalFocusRequest;
  requestAnimationFrame(() => {
    if (
      focusTerminal
      && request === terminalFocusRequest
      && !nextSession.isRenaming
      && sessions.has(nextSession.id)
    ) {
      nextSession.terminal.focus();
    }
  });
}

// input.replaceWith()는 포커스가 옮겨지면서 blur를 동기적으로 발생시키고, blur
// 리스너가 이 함수를 다시 부른다. 재진입을 막지 않으면 두 번째 호출이 이미 떼어낸
// 노드를 다시 교체하려다 NotFoundError를 던진다.
function finishRename(session, input, commit) {
  if (!input.isConnected || session.isFinishingRename) {
    return;
  }
  session.isFinishingRename = true;

  if (commit) {
    const nextName = input.value.trim();
    if (nextName) {
      session.name = nextName;
      scheduleStateSave();
    }
  }

  session.label.textContent = session.name;
  input.replaceWith(session.label);
  session.isRenaming = false;
  session.isFinishingRename = false;
  session.pane.setAttribute('aria-label', `${session.name} 터미널`);
  refreshSessionSurfaces(session);
  if (session.id === focusedSessionId) {
    session.terminal.focus();
  }
}

function beginRename(session) {
  if (!session.label.isConnected) {
    return;
  }

  const input = document.createElement('input');
  input.className = 'session-rename';
  input.type = 'text';
  input.value = session.name;
  input.setAttribute('aria-label', 'terminal 이름');
  session.isRenaming = true;
  session.label.replaceWith(input);
  input.focus();
  input.select();

  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('blur', () => finishRename(session, input, true));
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finishRename(session, input, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishRename(session, input, false);
    }
  });
}

// finishRename과 같은 재진입 문제가 있어 같은 방식으로 막는다.
function finishDescriptionEdit(
  session,
  input,
  description,
  commit,
  restoreTerminalFocus = false
) {
  if (!input.isConnected || isFinishingDescriptionEdit) {
    return;
  }
  isFinishingDescriptionEdit = true;

  if (commit) {
    session.description = input.value.trim().slice(0, 300);
    scheduleStateSave();
    updateSessionRow(session);
  }
  description.textContent = session.description || '설명 추가…';
  input.replaceWith(description);
  isFinishingDescriptionEdit = false;
  refreshSessionSurfaces(session);
  if (restoreTerminalFocus) {
    session.terminal.focus();
  }
}

function beginDescriptionEdit(session, description) {
  if (!session || !description.isConnected) {
    return;
  }

  const input = document.createElement('input');
  input.className = 'description-edit deck-tile-description-edit';
  input.type = 'text';
  input.maxLength = 300;
  input.value = session.description;
  input.setAttribute('aria-label', `${session.name} terminal 설명`);
  description.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('click', (event) => event.stopPropagation());

  input.addEventListener('blur', () =>
    finishDescriptionEdit(session, input, description, true)
  );
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finishDescriptionEdit(session, input, description, true, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishDescriptionEdit(session, input, description, false, true);
    }
  });
}

function commitActiveInlineEditorForClose() {
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement
    && (
      active.classList.contains('session-rename')
      || active.classList.contains('description-edit')
    )
  ) {
    active.blur();
  }
}

function createSessionRowElement(metadata) {
  const listRow = document.createElement('div');
  listRow.className = 'session-row';
  listRow.setAttribute('role', 'option');
  listRow.setAttribute('aria-selected', 'false');
  listRow.tabIndex = 0;

  const main = document.createElement('div');
  main.className = 'session-row-main';

  const statusBadge = document.createElement('span');
  statusBadge.className = 'session-status-badge';

  const label = document.createElement('span');
  label.className = 'session-name';
  label.textContent = metadata.name;
  label.title = '더블클릭하여 terminal 이름 변경';

  const placement = document.createElement('span');
  placement.className = 'session-placement';

  const git = document.createElement('span');
  git.className = 'session-git';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'session-close';
  close.textContent = '×';
  close.title = 'terminal 삭제 (실행 중이면 PowerShell 프로세스도 종료)';
  close.setAttribute('aria-label', 'terminal 삭제');

  const restart = document.createElement('button');
  restart.type = 'button';
  restart.className = 'session-restart';
  restart.textContent = '↻';
  restart.hidden = true;
  restart.title = '종료된 terminal 다시 시작';
  restart.setAttribute('aria-label', '종료된 terminal 다시 시작');

  main.append(statusBadge, label, placement, git, restart, close);

  const meta = document.createElement('div');
  meta.className = 'session-row-meta';
  const cwd = document.createElement('span');
  cwd.className = 'session-row-cwd';
  meta.append(cwd);

  listRow.append(main, meta);
  return {
    listRow,
    label,
    close,
    restart,
    statusBadge,
    placement,
    git,
    cwd
  };
}

function placementTileForSession(session) {
  return deckLayout.tiles.find((tile) =>
    tile.kind === 'pinned' && tile.sessionKey === session.layoutKey)
    || deckLayout.tiles.find((tile) =>
      tile.kind === 'rotating'
      && tile.rotationIndex === normalizeRotationSlot(session.rotationSlot))
    || deckLayout.tiles.find((tile) => tile.kind === 'rotating')
    || null;
}

// 배치 태그와 cwd, 포커스 표시를 갱신한다. 색만으로 포커스를 표현하지 않도록
// aria-selected와 이름 앞의 `현재 · ` 접두사를 함께 쓴다.
const VISIBILITY_SUFFIX = {
  visible: '',
  covered: ' · 가려짐',
  parked: ' · 숨김'
};

const VISIBILITY_LABEL = {
  visible: '표시 중',
  covered: '가려짐',
  parked: '숨김'
};

function gitContextIsStale(context, now = Date.now()) {
  return context?.status === 'ok'
    && Number.isFinite(context.checkedAt)
    && now - context.checkedAt > GIT_CONTEXT_STALE_MS;
}

function gitContextCompactLabel(session) {
  const context = session.gitContext;
  if (session.gitRefreshState === 'loading' && !context) return 'Git 조회 중';
  if (!context) return '';
  if (context.status !== 'ok') {
    return {
      'not-repository': 'Git 아님',
      unavailable: 'Git 없음',
      invalid: 'Git 경로 없음',
      error: 'Git 오류'
    }[context.status] || '';
  }
  const parts = [context.detached ? `@${context.branch}` : context.branch];
  if (Number.isInteger(context.ahead) && context.ahead > 0) parts.push(`↑${context.ahead}`);
  if (Number.isInteger(context.behind) && context.behind > 0) parts.push(`↓${context.behind}`);
  if (context.stagedCount > 0) parts.push(`S${context.stagedCount}`);
  const workingCount = (context.unstagedCount || 0) + (context.untrackedCount || 0);
  if (workingCount > 0) parts.push(`U${workingCount}`);
  if (context.conflictedCount > 0) parts.push(`!${context.conflictedCount}`);
  if (gitContextIsStale(context)) parts.push('오래됨');
  if (session.gitRefreshState === 'loading') parts.push('갱신 중');
  return parts.filter(Boolean).join(' · ');
}

function gitContextDetails(session) {
  const context = session.gitContext;
  if (session.gitRefreshState === 'loading' && !context) return ['Git 조회 중'];
  if (!context) return [];
  if (context.status !== 'ok') return [gitContextCompactLabel(session)];
  return [
    context.detached ? `Git: detached @ ${context.branch}` : `Git: ${context.branch}`,
    `변경 ${context.changedCount || 0}개 · staged ${context.stagedCount || 0} · unstaged ${context.unstagedCount || 0} · untracked ${context.untrackedCount || 0}`,
    context.conflictedCount > 0 ? `충돌 ${context.conflictedCount}개` : '',
    Number.isInteger(context.ahead)
      ? `upstream: ahead ${context.ahead} · behind ${context.behind}`
      : 'upstream: 없음',
    gitContextIsStale(context) ? 'Git 정보가 2분 이상 지났습니다.' : '',
    context.root || ''
  ].filter(Boolean);
}

function updateSessionRow(session) {
  const isFocused = session.id === focusedSessionId;
  const placement = placementLabel(session);
  const gitLabel = gitContextCompactLabel(session);
  // 최대화로 가려진 세션은 주차된 세션과 구분한다.
  const visibility = sessionVisibility(session);
  session.listRow.classList.toggle('focused', isFocused);
  session.listRow.setAttribute('aria-selected', String(isFocused));
  session.placementLabel.textContent =
    `${placement}${session.elevated ? ' · 관리자' : ''}`
    + VISIBILITY_SUFFIX[visibility];
  session.gitLabel.textContent = gitLabel;
  session.gitLabel.hidden = !gitLabel;
  session.cwdLabel.textContent = session.cwd || '';
  session.restart.hidden = !session.exited;
  session.restart.disabled = !session.exited
    || session.restarting
    || isClosing
    || isEditingDeck();
  session.restart.title = session.restarting
    ? 'terminal을 다시 시작하는 중입니다.'
    : '동일한 이름·폴더·배치로 새 terminal 시작';
  applySessionRotationIdentity(session);
  session.listRow.title = [
    session.name,
    session.exited ? '종료됨' : '',
    privilegeLabel(session),
    session.description,
    session.cwd,
    ...gitContextDetails(session),
    '우클릭: 배치 지정'
  ].filter(Boolean).join('\n');
  // 표시·포커스·종료 상태를 색만으로 알리지 않도록 접근성 이름에도 넣는다.
  session.listRow.setAttribute(
    'aria-label',
    [
      session.name,
      isFocused ? '현재 대상' : VISIBILITY_LABEL[visibility],
      session.exited ? '종료됨' : ''
    ].filter(Boolean).join(' · ')
  );
  applySessionIndexView();
}

async function refreshGitContext(session) {
  const sequence = (session.gitRequestSequence || 0) + 1;
  session.gitRequestSequence = sequence;
  session.gitRefreshState = 'loading';
  updateSessionRow(session);
  let context;
  try {
    context = await window.terminalApi.getGitContext(session.cwd);
  } catch {
    context = { status: 'error', checkedAt: Date.now() };
  }
  if (!sessions.has(session.id) || session.gitRequestSequence !== sequence) {
    return;
  }
  session.gitContext = context;
  session.gitRefreshState = 'idle';
  updateSessionRow(session);
  if (session.gitStaleTimer !== null) clearTimeout(session.gitStaleTimer);
  session.gitStaleTimer = context?.status === 'ok'
    ? setTimeout(() => {
        session.gitStaleTimer = null;
        if (sessions.has(session.id) && session.gitContext === context) {
          updateSessionRow(session);
        }
      }, GIT_CONTEXT_STALE_MS + 50)
    : null;
}

function scheduleGitContextRefresh(session) {
  if (session.gitRefreshTimer !== null) {
    clearTimeout(session.gitRefreshTimer);
  }
  session.gitRefreshTimer = setTimeout(() => {
    session.gitRefreshTimer = null;
    if (sessions.has(session.id)) void refreshGitContext(session);
  }, 500);
}

function sessionSearchableText(session) {
  return [
    session.name,
    session.cwd,
    session.initialCwd,
    session.description,
    session.providerHint,
    session.gitContext?.branch,
    gitContextCompactLabel(session),
    session.gitContext?.dirty ? 'dirty 변경 있음' : '',
    session.gitContext?.status,
    statusLabel(session),
    statusKind(session),
    normalizeRotationSlot(session.rotationSlot)
      ? `순환 ${session.rotationSlot}`
      : '고정'
  ].filter(Boolean).join(' ');
}

function applySessionIndexView() {
  const query = sessionSearch?.value || '';
  const ordered = [...sessions.values()];
  if (sessionGroup?.value === 'rotation') {
    ordered.sort((left, right) =>
      (normalizeRotationSlot(left.rotationSlot) ?? 999)
      - (normalizeRotationSlot(right.rotationSlot) ?? 999)
    );
  } else if (sessionGroup?.value === 'recent') {
    ordered.sort((left, right) =>
      (right.lastActivityAt || 0) - (left.lastActivityAt || 0)
    );
  }
  for (const session of ordered) {
    session.listRow.hidden = !matchesSearchQuery(
      sessionSearchableText(session),
      query
    );
    sessionList.append(session.listRow);
  }
  if (sessionListEmpty) {
    const visibleCount = ordered.filter((session) => !session.listRow.hidden).length;
    sessionListEmpty.hidden = sessions.size > 0 && visibleCount > 0;
    sessionListEmpty.textContent = sessions.size > 0 && visibleCount === 0
      ? '검색 결과가 없습니다.'
      : '아직 terminal이 없습니다. ＋로 새 terminal을 여세요.';
  }
}

sessionSearch?.addEventListener('input', applySessionIndexView);
sessionGroup?.addEventListener('change', applySessionIndexView);

function quickSwitcherCandidates() {
  const query = quickSwitcherSearch.value;
  return [...sessions.values()]
    .filter((session) => matchesSearchQuery(sessionSearchableText(session), query))
    .sort((left, right) => {
      if (left.id === focusedSessionId) return -1;
      if (right.id === focusedSessionId) return 1;
      return (right.lastActivityAt || 0) - (left.lastActivityAt || 0);
    });
}

function renderQuickSwitcher() {
  const candidates = quickSwitcherCandidates();
  quickSwitcherSelection = candidates.length === 0
    ? -1
    : Math.min(Math.max(quickSwitcherSelection, 0), candidates.length - 1);
  quickSwitcherList.replaceChildren(...candidates.map((session, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'quick-switcher-item';
    item.classList.toggle('selected', index === quickSwitcherSelection);
    item.dataset.sessionId = session.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === quickSwitcherSelection));
    const title = document.createElement('span');
    title.className = 'quick-switcher-title';
    const name = document.createElement('strong');
    name.textContent = session.name;
    const status = document.createElement('span');
    status.textContent = statusLabel(session);
    title.append(name, status);
    const detail = document.createElement('span');
    detail.className = 'quick-switcher-detail';
    detail.textContent = [
      placementLabel(session),
      session.cwd,
      gitContextCompactLabel(session),
      VISIBILITY_LABEL[sessionVisibility(session)]
    ].filter(Boolean).join(' · ');
    item.append(title, detail);
    item.addEventListener('mousemove', () => {
      if (quickSwitcherSelection !== index) {
        quickSwitcherSelection = index;
        renderQuickSwitcher();
      }
    });
    item.addEventListener('click', () => {
      quickSwitcherDialog.close();
      focusSession(session.id);
    });
    return item;
  }));
  quickSwitcherEmpty.hidden = candidates.length > 0;
  const selected = quickSwitcherList.querySelector('.selected');
  selected?.scrollIntoView({ block: 'nearest' });
  return candidates;
}

function openQuickSwitcher() {
  const otherDialog = document.querySelector('dialog[open]');
  if ((otherDialog && otherDialog !== quickSwitcherDialog) || isClosing) return;
  if (quickSwitcherDialog.open) {
    quickSwitcherDialog.close();
    return;
  }
  quickSwitcherSearch.value = '';
  quickSwitcherSelection = 0;
  renderQuickSwitcher();
  quickSwitcherDialog.showModal();
  quickSwitcherSearch.focus();
}

function activateQuickSwitcherSelection() {
  const session = quickSwitcherCandidates()[quickSwitcherSelection];
  if (!session) return;
  quickSwitcherDialog.close();
  focusSession(session.id);
}

openQuickSwitcherButton.addEventListener('click', openQuickSwitcher);
closeQuickSwitcherButton.addEventListener('click', () => quickSwitcherDialog.close());
quickSwitcherSearch.addEventListener('input', () => {
  quickSwitcherSelection = 0;
  renderQuickSwitcher();
});
quickSwitcherSearch.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    quickSwitcherSelection = nextSelectionIndex(
      quickSwitcherSelection,
      event.key === 'ArrowDown' ? 1 : -1,
      quickSwitcherCandidates().length
    );
    renderQuickSwitcher();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    activateQuickSwitcherSelection();
  }
});

function updateSessionListEmptyState() {
  applySessionIndexView();
}

const NO_TARGET_REASON = '표시 중인 terminal이 없습니다. 왼쪽 목록에서 terminal을 '
  + '선택하거나 새로 여세요.';
const EXITED_REASON = '종료된 terminal에서는 실행할 수 없습니다.';

// 새 명령을 만드는 모든 경로가 지나는 중앙 관문. 배치 편집 중에는 항상 막는다.
function canRunCommands(session) {
  return Boolean(session) && !session.exited && !isEditingDeck() && !isClosing;
}

// 오른쪽 공용 인스펙터의 대상은 항상 포커스 세션 하나다. 타일별 인스펙터는 없다.
function renderInspectorTarget() {
  const session = focusedSession();
  inspectorTargetName.textContent = session ? session.name : '대상 없음';
  inspectorTargetName.title = session ? `${session.name}\n${session.cwd}` : '';
  inspectorTargetMeta.textContent = session
    ? `${placementLabel(session)} · ${statusLabel(session)}`
    : NO_TARGET_REASON;
  inspectorTargetMeta.title = session
    ? `${placementLabel(session)} · ${statusLabel(session)}\n${session.cwd}`
    : inspectorTargetMeta.textContent;
  applyPanelLayout();
  updateFavoriteRunTargets();
  updateHistoryActionTarget();
}

function applySessionPlacement(session, tileId) {
  if (isEditingDeck() || isSessionLifecycleInFlight()) {
    return;
  }

  const draft = beginDeckEdit(deckLayout, editableTabs());
  const result = assignSessionToTile(draft, session.layoutKey, tileId);
  if (!result.ok) {
    showToastMessage(result.reason);
    return;
  }

  deckLayout = result.deck;
  applyRotationSlotsToSessions(result.tabs);
  syncFocusToDeck();
  renderDeck();
  renderCommandBlocks();
  renderHistory();
  scheduleVisibleFits();
  scheduleStateSave();
}

// 즐겨찾기는 작업공간 공용이고 실행 대상만 포커스 세션이다. 대상 이름과 비활성
// 이유를 버튼에 직접 반영한다. 수정·삭제는 대상이 없어도 계속 가능하다.
function updateFavoriteRunTargets() {
  const session = focusedSession();
  const runnable = canRunCommands(session);
  const reason = session ? EXITED_REASON : NO_TARGET_REASON;
  const label = runnable ? `${session.name}에서 실행` : '실행';

  for (const button of favoriteList.querySelectorAll('.favorite-run')) {
    button.disabled = !runnable;
    button.textContent = runnable ? label : '실행';
    button.title = runnable ? label : reason;
    button.setAttribute('aria-label', runnable ? label : `실행 불가: ${reason}`);
  }
  for (const item of favoriteList.querySelectorAll('.utility-item')) {
    if (item.classList.contains('expanded')) {
      item.title = '';
    } else {
      item.title = runnable
        ? `더블클릭하여 ${session.name}에서 실행`
        : `실행 불가: ${reason}`;
    }
  }
  for (const button of favoriteShortcuts.querySelectorAll('.favorite-shortcut')) {
    const favoriteName = button.dataset.favoriteName || button.textContent;
    const shortcutLabel = runnable
      ? `${favoriteName}: ${session.name}에서 실행`
      : `${favoriteName} 실행 불가: ${reason}`;
    button.disabled = !runnable;
    button.title = shortcutLabel;
    button.setAttribute('aria-label', shortcutLabel);
  }
}

function updateHistoryActionTarget() {
  const session = focusedSession();
  const label = session
    ? `${session.name}의 명령 히스토리 전체 지우기`
    : '명령 히스토리 전체 지우기';
  clearHistoryButton.title = session ? label : NO_TARGET_REASON;
  clearHistoryButton.setAttribute('aria-label', label);
}

function tileLabel(tile) {
  return tile.kind === 'pinned'
    ? `고정${pinnedTileOrder(deckLayout, tile.id)}`
    : `순환${tile.rotationIndex}`;
}

function sessionForTile(tile) {
  return sessionByKey(displayedSessionKey(deckLayout, tile.id));
}

function closeTileMenus() {
  for (const view of tileViews.values()) {
    view.menu.hidden = true;
    view.menuButton.setAttribute('aria-expanded', 'false');
  }
  sessionPlacementMenu.hidden = true;
  sessionPlacementMenu.replaceChildren();
}

function openSessionPlacementMenu(session, position = {}) {
  if (isEditingDeck()) {
    announceDeckEdit(EDIT_LOCK_REASON);
    return;
  }
  if (isSessionLifecycleInFlight()) {
    showToastMessage(SESSION_LIFECYCLE_REASON);
    return;
  }

  closeTileMenus();
  const selectedTile = placementTileForSession(session);
  const title = document.createElement('span');
  title.className = 'session-context-menu-title';
  title.textContent = `${session.name} 배치 지정`;

  const items = deckLayout.tiles.map((tile) => {
    const item = createTileMenuItem(tileLabel(tile), () => {
      applySessionPlacement(session, tile.id);
    });
    const selected = tile.id === selectedTile?.id;
    item.classList.add('session-context-menu-item');
    item.classList.toggle('selected', selected);
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(selected));
    return item;
  });
  sessionPlacementMenu.replaceChildren(title, ...items);
  sessionPlacementMenu.hidden = false;

  const anchor = position.anchor || session.listRow.getBoundingClientRect();
  const requestedLeft = Number.isFinite(position.x) ? position.x : anchor.right;
  const requestedTop = Number.isFinite(position.y) ? position.y : anchor.top;
  const bounds = sessionPlacementMenu.getBoundingClientRect();
  sessionPlacementMenu.style.left = `${Math.max(
    4,
    Math.min(requestedLeft, window.innerWidth - bounds.width - 4)
  )}px`;
  sessionPlacementMenu.style.top = `${Math.max(
    4,
    Math.min(requestedTop, window.innerHeight - bounds.height - 4)
  )}px`;

  (items.find((item) => item.classList.contains('selected')) || items[0])
    ?.focus();
}

function createTileMenuItem(label, action) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'deck-tile-menu-item';
  item.textContent = label;
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    closeTileMenus();
    action();
  });
  return item;
}

function createTileView(tileId) {
  const element = document.createElement('section');
  element.className = 'deck-tile';
  element.dataset.tileId = tileId;
  element.setAttribute('role', 'group');

  const header = document.createElement('header');
  header.className = 'deck-tile-header';
  const headerMain = document.createElement('div');
  headerMain.className = 'deck-tile-header-main';

  const tag = document.createElement('span');
  tag.className = 'deck-tile-tag';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'deck-tile-title';
  const focusMark = document.createElement('span');
  focusMark.className = 'deck-tile-focus-mark';
  focusMark.textContent = '현재 대상';
  const status = document.createElement('span');
  status.className = 'deck-tile-status';
  const blocks = document.createElement('span');
  blocks.className = 'deck-tile-blocks';

  const pasteButton = document.createElement('button');
  pasteButton.type = 'button';
  pasteButton.className = 'deck-tile-action deck-tile-paste';
  pasteButton.textContent = '붙여넣기';

  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'deck-tile-action deck-tile-clear';
  clearButton.textContent = 'CLS';

  const logButton = document.createElement('button');
  logButton.type = 'button';
  logButton.className = 'deck-tile-action deck-tile-log';
  logButton.textContent = '로그 복사';

  const maximizeButton = document.createElement('button');
  maximizeButton.type = 'button';
  maximizeButton.className = 'deck-tile-button';
  maximizeButton.textContent = '⛶';

  const menuButton = document.createElement('button');
  menuButton.type = 'button';
  menuButton.className = 'deck-tile-button';
  menuButton.textContent = '⋯';
  menuButton.setAttribute('aria-label', '타일 메뉴');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.title = '타일 메뉴';

  const menu = document.createElement('div');
  menu.className = 'deck-tile-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const metadata = document.createElement('div');
  metadata.className = 'deck-tile-metadata';
  const shell = document.createElement('span');
  shell.className = 'deck-tile-shell';
  const cwd = document.createElement('span');
  cwd.className = 'deck-tile-cwd';
  const description = document.createElement('span');
  description.className = 'deck-tile-description';
  description.title = '더블클릭하여 terminal 설명 편집';
  metadata.append(shell, cwd, description);
  headerMain.append(
    tag,
    title,
    focusMark,
    status,
    blocks,
    metadata,
    pasteButton,
    clearButton,
    logButton,
    maximizeButton,
    menuButton,
    menu
  );
  header.append(headerMain);

  const body = document.createElement('div');
  body.className = 'deck-tile-body';
  body.dataset.tileId = tileId;

  // 배치 편집 전용 조작부. 터미널 body 전체를 drag handle로 쓰지 않는다.
  const dragHandle = document.createElement('button');
  dragHandle.type = 'button';
  dragHandle.className = 'deck-tile-drag-handle';
  dragHandle.textContent = '⠿ 이동';
  dragHandle.hidden = true;
  const resizeHandle = document.createElement('button');
  resizeHandle.type = 'button';
  resizeHandle.className = 'deck-tile-resize-handle';
  resizeHandle.textContent = '◢';
  resizeHandle.hidden = true;

  const lock = document.createElement('div');
  lock.className = 'deck-tile-lock';
  lock.textContent = TERMINAL_LOCK_MESSAGE;
  lock.hidden = true;

  const empty = document.createElement('div');
  empty.className = 'deck-tile-empty';
  const emptyTitle = document.createElement('p');
  emptyTitle.className = 'deck-tile-empty-title';
  const emptyHint = document.createElement('p');
  emptyHint.className = 'deck-tile-empty-hint';
  const emptyAction = document.createElement('button');
  emptyAction.type = 'button';
  emptyAction.className = 'deck-tile-empty-action';
  emptyAction.textContent = '새 terminal 열기';
  emptyAction.hidden = true;
  emptyAction.addEventListener('click', (event) => {
    event.stopPropagation();
    void addSession();
  });
  empty.append(emptyTitle, emptyHint, emptyAction);
  body.append(empty, lock);

  element.append(header, body, dragHandle, resizeHandle);

  const view = {
    tileId,
    element,
    headerMain,
    tag,
    title,
    focusMark,
    status,
    blocks,
    pasteButton,
    clearButton,
    logButton,
    maximizeButton,
    menuButton,
    menu,
    metadata,
    shell,
    cwd,
    description,
    body,
    emptyTitle,
    emptyHint,
    emptyAction,
    dragHandle,
    resizeHandle,
    lock
  };

  for (const [handle, kind] of [[dragHandle, 'move'], [resizeHandle, 'resize']]) {
    handle.addEventListener('pointerdown', (event) => {
      startTileGesture(kind, tileId, event, handle);
    });
    handle.addEventListener('pointermove', moveTileGesture);
    handle.addEventListener('pointerup', (event) => {
      if (tileGesture?.pointerId === event.pointerId) {
        endTileGesture(true);
      }
    });
    handle.addEventListener('pointercancel', () => endTileGesture(false));
    handle.addEventListener('click', (event) => event.stopPropagation());
  }

  // 타일 header/body 클릭은 그 타일의 표시 세션을 포커스한다.
  const focusTileSession = () => {
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (session) {
      focusSession(session.id);
    }
  };
  header.addEventListener('click', focusTileSession);
  body.addEventListener('mousedown', focusTileSession);
  // xterm이 키보드 포커스를 받을 때도 포커스 세션을 맞춘다.
  body.addEventListener('focusin', focusTileSession);

  description.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (session) {
      focusSession(session.id, { focusTerminal: false });
      beginDescriptionEdit(session, description);
    }
  });

  title.addEventListener('click', (event) => {
    event.stopPropagation();
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (!canRunCommands(session) || !session.atPowerShellPrompt) {
      return;
    }
    executeCommand(session, buildSetLocationCommand(session.initialCwd));
  });

  async function pasteFromClipboard(mode, sourceButton = null, confirm = false) {
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (!canRunCommands(session)) {
      return;
    }
    const target = { sessionId: session.id, layoutKey: session.layoutKey, tileId };
    const reportResult = (label) => {
      if (sourceButton) {
        setTemporaryButtonLabel(sourceButton, label);
      } else if (label !== '실행함') {
        showToastMessage(`${session.name}: ${label}`);
      }
    };

    try {
      const text = await window.terminalApi.readClipboard();
      const currentTile = deckLayout.tiles.find((item) => item.id === tileId);
      const currentSession = currentTile ? sessionForTile(currentTile) : null;
      const unchanged = currentSession?.id === target.sessionId
        && currentSession.layoutKey === target.layoutKey;
      if (!text || !unchanged || !canRunCommands(currentSession)) {
        reportResult(text ? '대상 변경됨' : '비어 있음');
        return;
      }
      const analysis = analyzePaste(text);
      if (analysis.unsafeControlCharacters || analysis.tooLong) {
        reportResult(analysis.tooLong ? '64KB 초과' : '제어 문자 포함');
        return;
      }
      const bracketedPaste = currentSession.terminal.modes?.bracketedPasteMode === true;
      const requiresConfirmedPath = analysis.reasons.includes('dangerous-pattern')
        || analysis.multiline && !bracketedPaste;
      if (!confirm && requiresConfirmedPath) {
        reportResult('확인 후 붙여넣기 사용');
        return;
      }
      const needsConfirmation = confirm;
      if (needsConfirmation) {
        pasteConfirmTitle.textContent = mode === 'execute'
          ? '붙여넣고 실행 확인'
          : '붙여넣기 확인';
        confirmPasteButton.textContent = mode === 'execute'
          ? '확인 후 실행'
          : '확인 후 붙여넣기';
        pasteConfirmReason.textContent = analysis.multiline && mode === 'insert'
          ? '현재 PowerShell에서는 여러 줄을 붙여넣으면 마지막 줄 이전 명령이 즉시 실행될 수 있습니다. 대상과 내용을 확인하세요.'
          : analysis.reasons.includes('dangerous-pattern')
            ? '위험하거나 여러 줄인 명령입니다. 대상과 내용을 확인하세요.'
            : '대상과 붙여넣을 내용을 확인하세요.';
        pasteConfirmTarget.textContent = `대상: ${currentSession.name}`;
        pasteConfirmPreview.textContent = analysis.preview;
        pasteConfirmDialog.returnValue = 'cancel';
        pasteConfirmDialog.showModal();
        await new Promise((resolve) => pasteConfirmDialog.addEventListener(
          'close', resolve, { once: true }
        ));
        if (pasteConfirmDialog.returnValue !== 'confirm') {
          return;
        }
      }
      const latestTile = deckLayout.tiles.find((item) => item.id === target.tileId);
      const latestSession = latestTile ? sessionForTile(latestTile) : null;
      if (
        latestSession?.id !== target.sessionId
        || latestSession.layoutKey !== target.layoutKey
        || !canRunCommands(latestSession)
      ) {
        reportResult('대상 변경됨');
        return;
      }
      const payload = encodeTerminalInput(text, {
        mode,
        bracketedPaste: latestSession.terminal.modes?.bracketedPasteMode === true,
        allowMultiline: analysis.multiline && confirm
      });
      if (!payload) {
        reportResult('입력 차단');
        return;
      }
      window.terminalApi.write(latestSession.id, payload);
      focusSession(currentSession.id);
      reportResult(mode === 'execute' ? '실행함' : '붙여넣음');
    } catch {
      reportResult('실패');
    }
  }

  pasteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    void pasteFromClipboard('insert', pasteButton);
  });

  function clearTileSession() {
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (!canRunCommands(session) || !session.atPowerShellPrompt) {
      return;
    }

    session.clearBlocksForNextClearHost = true;
    session.commandBlocks = [];
    session.selectedCommandBlockIds.clear();
    refreshSessionSurfaces(session);
    if (session.id === focusedSessionId) {
      renderCommandBlocks();
    }
    if (!executeCommand(session, 'cls')) {
      session.clearBlocksForNextClearHost = false;
    }
  }

  clearButton.addEventListener('click', (event) => {
    event.stopPropagation();
    clearTileSession();
  });

  async function copyTileLog(sourceButton = null) {
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (!session) {
      return;
    }

    await window.terminalApi.writeClipboard(fullSessionLog(session));
    if (sourceButton) setTemporaryButtonLabel(sourceButton, '복사됨');
  }

  logButton.addEventListener('click', async (event) => {
    event.stopPropagation();
    await copyTileLog(logButton);
  });

  maximizeButton.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTileMaximize(tileId);
  });
  menuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const willOpen = menu.hidden;
    closeTileMenus();
    if (!willOpen) {
      return;
    }
    const tile = deckLayout.tiles.find((item) => item.id === tileId);
    const session = tile ? sessionForTile(tile) : null;
    if (isEditingDeck()) {
      // 편집 중에는 배치 동작만 제공한다. 세션 종료는 숨긴다.
      menu.replaceChildren(
        tile?.kind === 'rotating'
          ? createTileMenuItem('이 타일을 고정으로 바꾸기', () => {
              applyDeckEditResult(convertTileToPinned(deckEdit.draft, tileId));
            })
          : createTileMenuItem('이 타일을 순환으로 바꾸기', () => {
              applyDeckEditResult(convertTileToRotating(deckEdit.draft, tileId));
            }),
        createTileMenuItem('배치에서 타일 제거 — terminal 유지', () => {
          applyDeckEditResult(removeTileFromDeck(deckEdit.draft, tileId));
        })
      );
    } else {
      const pasteItem = createTileMenuItem('붙여넣기', () => {
        void pasteFromClipboard('insert');
      });
      pasteItem.disabled = !canRunCommands(session);
      const pasteRunItem = createTileMenuItem('붙여넣고 실행', () => {
        void pasteFromClipboard('execute');
      });
      pasteRunItem.disabled = !canRunCommands(session);
      const confirmPasteItem = createTileMenuItem('확인 후 붙여넣기', () => {
        void pasteFromClipboard('insert', null, true);
      });
      confirmPasteItem.disabled = !canRunCommands(session);
      const confirmPasteRunItem = createTileMenuItem('확인 후 붙여넣고 실행', () => {
        void pasteFromClipboard('execute', null, true);
      });
      confirmPasteRunItem.disabled = !canRunCommands(session);
      const clearItem = createTileMenuItem('CLS', clearTileSession);
      clearItem.disabled = !canRunCommands(session) || !session?.atPowerShellPrompt;
      const copyLogItem = createTileMenuItem('로그 복사', () => {
        void copyTileLog();
      });
      copyLogItem.disabled = !session;
      const maximizeItem = createTileMenuItem(
        maximizedTileId === tileId ? '최대화 해제' : '최대화',
        () => toggleTileMaximize(tileId)
      );
      maximizeItem.disabled = !session;
      const focusItem = createTileMenuItem('이 terminal 포커스', () => {
        if (session) {
          focusSession(session.id);
        }
      });
      focusItem.disabled = !session;
      const restartItem = createTileMenuItem(
        session?.restarting ? 'terminal 다시 시작 중…' : 'terminal 다시 시작',
        () => {
          if (session) void restartSession(session.id);
        }
      );
      restartItem.hidden = !session?.exited;
      restartItem.disabled = !session?.exited || session.restarting;
      const terminateItem = createTileMenuItem(
        'PowerShell 프로세스만 종료',
        () => {
          if (session) void terminateSessionProcess(session.id);
        }
      );
      terminateItem.hidden = !session || session.exited;
      terminateItem.disabled = !session || session.exited;
      const closeItem = createTileMenuItem(
        session?.exited ? '종료된 terminal 삭제' : 'terminal 삭제 — 프로세스도 종료',
        () => {
        if (session) {
          requestSessionRemoval(session.id);
        }
        }
      );
      closeItem.disabled = !session;
      menu.replaceChildren(
        pasteItem,
        pasteRunItem,
        confirmPasteItem,
        confirmPasteRunItem,
        clearItem,
        copyLogItem,
        maximizeItem,
        focusItem,
        restartItem,
        terminateItem,
        closeItem
      );
    }
    menu.hidden = false;
    menuButton.setAttribute('aria-expanded', 'true');
  });

  tileViews.set(tileId, view);
  return view;
}

function updateTileView(tile) {
  const view = tileViews.get(tile.id) || createTileView(tile.id);
  const session = sessionForTile(tile);
  const placement = tileLabel(tile);
  const isFocused = Boolean(session) && session.id === focusedSessionId;
  const isMaximized = maximizedTileId === tile.id;

  view.element.style.gridRow = `${tile.row + 1} / span ${tile.rowSpan}`;
  view.element.style.gridColumn = `${tile.column + 1} / span ${tile.columnSpan}`;
  view.element.classList.toggle('focused', isFocused);
  view.element.classList.toggle('maximized', isMaximized);
  view.element.hidden = maximizedTileId !== null && !isMaximized;
  applyRotationIdentity(
    view.element,
    tile.kind === 'rotating' ? tile.rotationIndex : null
  );

  view.tag.textContent = `${placement}${session?.elevated ? ' · 관리자' : ''}`;
  view.title.textContent = session ? session.name : '세션을 선택하세요';
  view.metadata.hidden = !session;
  view.shell.textContent = session ? shellDisplayLabel(session) : '';
  view.shell.title = session ? shellDisplayLabel(session) : '';
  view.cwd.textContent = session?.cwd || '';
  view.cwd.title = session?.cwd || '';
  view.description.textContent = session
    ? session.description || '설명 추가…'
    : '';
  view.description.title = session
    ? `${session.description || '설명 없음'}\n더블클릭하여 terminal 설명 편집`
    : '';
  view.focusMark.hidden = !isFocused;
  view.status.textContent = session ? statusLabel(session) : '';
  view.status.dataset.status = session ? statusKind(session) : '';
  const blockCount = session ? session.commandBlocks.length : 0;
  view.blocks.textContent = session ? `블록 ${blockCount}` : '';
  view.blocks.hidden = !session;
  if (session) {
    view.blocks.title = `${session.name}의 명령 블록 ${blockCount}개`;
  }

  const runnable = canRunCommands(session);
  view.title.disabled = !runnable || !session.atPowerShellPrompt;
  if (session) {
    const homeLabel = `${session.name}: 처음 등록한 폴더로 이동`;
    view.title.setAttribute('aria-label', homeLabel);
    view.title.title = runnable && session.atPowerShellPrompt
      ? `${homeLabel}\n${session.initialCwd}`
      : 'PowerShell 입력 대기 상태에서만 처음 폴더로 이동할 수 있습니다.';
  } else {
    view.title.removeAttribute('aria-label');
    view.title.title = '표시할 세션을 선택하세요.';
  }
  view.pasteButton.hidden = !session;
  view.pasteButton.disabled = !runnable;
  view.clearButton.hidden = !session;
  view.clearButton.disabled = !runnable || !session.atPowerShellPrompt;
  if (session) {
    const pasteLabel = `${session.name}에 클립보드 내용만 붙여넣기`;
    view.pasteButton.setAttribute('aria-label', pasteLabel);
    view.pasteButton.title = runnable
      ? pasteLabel
      : session.exited
        ? '종료된 terminal에는 붙여넣을 수 없습니다.'
        : EDIT_LOCK_REASON;
    const clearLabel = `${session.name}에서 cls 실행`;
    view.clearButton.setAttribute('aria-label', clearLabel);
    view.clearButton.title = !runnable
      ? session.exited
        ? '종료된 terminal에서는 cls를 실행할 수 없습니다.'
        : EDIT_LOCK_REASON
      : session.atPowerShellPrompt
        ? clearLabel
        : 'PowerShell 입력 대기 상태에서만 cls를 실행할 수 있습니다.';
  }

  view.logButton.hidden = !session;
  view.logButton.disabled = !session;
  if (session) {
    const logLabel = `${session.name}의 전체 터미널 로그 복사`;
    view.logButton.setAttribute('aria-label', logLabel);
    view.logButton.title = logLabel;
  }

  // 편집 중에는 조작부를 드러내고 터미널 입력을 잠근다.
  const editing = isEditingDeck();
  view.element.classList.toggle('editing', editing);
  view.dragHandle.hidden = !editing;
  view.resizeHandle.hidden = !editing;
  view.lock.hidden = !editing;
  view.dragHandle.setAttribute('aria-label', `${placement} 타일 이동`);
  view.dragHandle.title = `${placement} 타일 이동`;
  view.resizeHandle.setAttribute('aria-label', `${placement} 타일 크기 변경`);
  view.resizeHandle.title = `${placement} 타일 크기 변경`;

  view.maximizeButton.disabled = !session || editing;
  view.maximizeButton.setAttribute(
    'aria-label',
    isMaximized ? '타일 복원' : '타일 최대화'
  );
  view.maximizeButton.title = isMaximized ? '타일 복원' : '타일 최대화';
  view.maximizeButton.textContent = isMaximized ? '⤡' : '⛶';

  view.emptyTitle.textContent = session ? '' : '세션을 선택하세요';
  view.emptyHint.textContent = session
    ? ''
    : `왼쪽 목록에서 ${placement} 세션을 선택하세요.`;
  view.emptyTitle.hidden = Boolean(session);
  view.emptyHint.hidden = Boolean(session);
  view.emptyAction.hidden = Boolean(session) || sessions.size > 0;

  // 색만으로 포커스를 표현하지 않도록 접근성 이름에 종류·이름·현재 대상을 담는다.
  view.element.setAttribute('aria-label', [
    placement,
    session ? session.name : '빈 타일',
    session ? statusLabel(session) : '',
    session ? privilegeLabel(session) : '',
    session ? shellDisplayLabel(session) : '',
    session?.cwd,
    session?.description,
    isFocused ? '현재 대상' : ''
  ].filter(Boolean).join(' · '));
  return view;
}

// 세션 pane을 표시 타일 body로 옮기거나 주차 영역으로 되돌린다.
// Terminal.open()은 세션 생성 시 한 번만 호출하며 여기서는 DOM만 이동한다.
function placeSessionPane(session, tileId) {
  const container = tileId
    ? tileViews.get(tileId)?.body || terminalParking
    : terminalParking;
  const nextTileId = container === terminalParking ? null : tileId;

  if (session.pane.parentElement !== container) {
    container.append(session.pane);
    session.reparentCount += 1;
    session.pane.dataset.reparents = String(session.reparentCount);
  }

  const wasParked = !session.displayedTileId;
  session.displayedTileId = nextTileId;
  session.pane.hidden = nextTileId === null;
  session.pane.dataset.tileId = nextTileId || '';

  // 숨어 있던 세션이 다시 표시되면 반드시 fit한다.
  if (nextTileId && (wasParked || session.needsFit)) {
    session.needsFit = false;
    scheduleFit(session);
  }
}

// 편집 중 빈 cell을 클릭할 수 있게 4×4 overlay를 그린다.
function renderDeckGridOverlay() {
  if (!isEditingDeck()) {
    deckGridOverlay.replaceChildren();
    return;
  }

  const occupied = new Set();
  for (const tile of deckLayout.tiles) {
    for (let row = tile.row; row < tile.row + tile.rowSpan; row += 1) {
      for (
        let column = tile.column;
        column < tile.column + tile.columnSpan;
        column += 1
      ) {
        occupied.add(`${row}:${column}`);
      }
    }
  }

  const cells = [];
  for (let row = 0; row < DECK_ROWS; row += 1) {
    for (let column = 0; column < DECK_COLUMNS; column += 1) {
      const isFree = !occupied.has(`${row}:${column}`);
      const cell = document.createElement(isFree ? 'button' : 'div');
      cell.className = `deck-grid-cell ${isFree ? 'free' : 'occupied'}`;
      cell.dataset.row = String(row);
      cell.dataset.column = String(column);
      if (isFree) {
        cell.type = 'button';
        cell.setAttribute(
          'aria-label',
          `${row + 1}행 ${column + 1}열 빈 칸에 타일 추가`
        );
        cell.title = '빈 칸에 타일 추가';
        cell.addEventListener('click', (event) => {
          event.stopPropagation();
          openAddTileDialog(row, column);
        });
      }
      cells.push(cell);
    }
  }
  deckGridOverlay.replaceChildren(...cells);
}

// deck 모델을 화면에 반영한다. 모델을 바꾸지 않고 DOM만 맞춘다.
function renderDeck() {
  ensureMaximizeIsValid();
  const liveTileIds = new Set();
  for (const tile of deckLayout.tiles) {
    liveTileIds.add(tile.id);
    const isNewView = !tileViews.has(tile.id);
    const view = updateTileView(tile);
    if (view.element.parentElement !== sessionDeck) {
      sessionDeck.append(view.element);
    }
    if (isNewView) {
      tileBodyResizeObserver.observe(view.body);
    }
  }

  // 사라진 타일의 view는 제거한다(그 안의 pane은 아래에서 주차로 이동한다).
  for (const [tileId, view] of [...tileViews.entries()]) {
    if (!liveTileIds.has(tileId)) {
      for (const session of sessions.values()) {
        if (session.pane.parentElement === view.body) {
          placeSessionPane(session, null);
        }
      }
      tileBodyResizeObserver.unobserve(view.body);
      view.element.remove();
      tileViews.delete(tileId);
    }
  }

  // 타일 DOM 순서를 모델 순서와 맞춘다(제거 후 다시 만들어진 타일이 끝으로 밀리면
  // 탭 순서와 화면 낭독 순서가 모델과 어긋난다). 실제로 다를 때만 옮긴다.
  const orderedElements = deckLayout.tiles
    .map((tile) => tileViews.get(tile.id)?.element)
    .filter(Boolean);
  const currentElements = [...sessionDeck.children]
    .filter((element) => element.classList.contains('deck-tile'));
  if (orderedElements.some((element, index) => currentElements[index] !== element)) {
    for (const element of orderedElements) {
      sessionDeck.append(element);
    }
  }

  const tileIdBySessionKey = new Map();
  for (const tile of deckLayout.tiles) {
    const sessionKey = displayedSessionKey(deckLayout, tile.id);
    if (sessionKey) {
      tileIdBySessionKey.set(sessionKey, tile.id);
    }
  }

  for (const session of sessions.values()) {
    placeSessionPane(session, tileIdBySessionKey.get(session.layoutKey) || null);
    updateSessionRow(session);
  }

  renderDeckGridOverlay();
  updateSessionLifecycleControls();
  renderInspectorTarget();
  renderRotationShortcuts();
}

// 빈 cell 클릭 → 타일 추가 dialog. 고정 칸은 아직 고정되지 않은 세션이 필요하다.
function openAddTileDialog(row, column) {
  if (!isEditingDeck()) {
    return;
  }

  const pinnedKeys = new Set(
    deckLayout.tiles
      .filter((tile) => tile.kind === 'pinned')
      .map((tile) => tile.sessionKey)
  );
  const eligible = [...sessions.values()]
    .filter((session) => !pinnedKeys.has(session.layoutKey));

  addTileCell.textContent = `${row + 1}행 ${column + 1}열 빈 칸에 타일을 추가합니다.`;
  addTileDialog.dataset.row = String(row);
  addTileDialog.dataset.column = String(column);
  addTileSessionSelect.replaceChildren(
    ...eligible.map((session) => {
      const option = document.createElement('option');
      option.value = session.layoutKey;
      option.textContent =
        `${session.name} · ${placementLabel(session)} · ${session.cwd}`;
      return option;
    })
  );
  addTileSessionEmpty.hidden = eligible.length > 0;
  addTileForm.elements['add-tile-kind'].value = 'rotating';
  updateAddTileDialogState();
  addTileDialog.showModal();
}

function updateAddTileDialogState() {
  const kind = addTileForm.elements['add-tile-kind'].value;
  const needsSession = kind === 'pinned';
  addTileSessionPicker.hidden = !needsSession;
  confirmAddTileButton.disabled =
    needsSession && addTileSessionSelect.options.length === 0;
}

function createTerminal(metadata) {
  const {
    listRow,
    label,
    close,
    restart,
    statusBadge,
    placement,
    git,
    cwd
  } = createSessionRowElement(metadata);
  const pane = document.createElement('section');
  pane.className = 'terminal-pane';
  pane.hidden = true;
  pane.setAttribute('role', 'group');
  pane.setAttribute('aria-label', `${metadata.name} 터미널`);
  // pane은 주차 영역에서 만들고 Terminal.open()을 한 번만 호출한다. 이후에는
  // renderDeck()이 DOM 이동만으로 타일과 주차 영역 사이를 옮긴다.
  terminalParking.append(pane);
  sessionList.append(listRow);

  const terminal = new Terminal({
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    fontSize: 14,
    lineHeight: 1.15,
    scrollback: 10000,
    allowTransparency: false,
    theme: {
      background: '#111418',
      foreground: '#e6edf3',
      cursor: '#e6edf3',
      selectionBackground: '#34506f'
    }
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(pane);

  pane.addEventListener(
    'paste',
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      // 배치 편집 중에는 붙여넣기 경로도 막는다.
      if (isEditingDeck()) {
        return;
      }
      const text = event.clipboardData?.getData('text/plain') || '';
      if (text) {
        terminal.paste(text);
      }
    },
    true
  );

  const session = {
    ...metadata,
    listRow,
    label,
    close,
    restart,
    statusBadge,
    placementLabel: placement,
    gitLabel: git,
    cwdLabel: cwd,
    pane,
    terminal,
    fitAddon,
    displayedTileId: null,
    reparentCount: 0,
    needsFit: false,
    ptyCols: null,
    ptyRows: null,
    // 복원된 세션은 저장된 순환 번호를 유지한다. 고정 세션은 순환 번호가 없고
    // 새 세션은 가장 낮은 순환 번호를 받는다(§12.1).
    rotationSlot: 'rotationSlot' in metadata
      ? normalizeRotationSlot(metadata.rotationSlot)
      : currentRotationSlot(),
    exited: false,
    exitedAt: null,
    exitAcknowledged: false,
    restarting: false,
    statusState: createTerminalStatus(Date.now()),
    lastOutputAt: Date.now(),
    lastActivityAt: Date.now(),
    gitContext: null,
    gitRefreshState: 'idle',
    gitRequestSequence: 0,
    gitRefreshTimer: null,
    gitStaleTimer: null,
    idleTimer: null,
    attentionTimer: null,
    toast: null,
    toastTimer: null,
    isRenaming: false,
    description:
      typeof metadata.description === 'string'
        ? metadata.description
        : '',
    provider: metadata.provider || null,
    providerHint: metadata.provider?.kind || null,
    layoutKey: metadata.layoutKey || window.crypto.randomUUID(),
    history: Array.isArray(metadata.history) ? metadata.history : [],
    historyCursor: Array.isArray(metadata.history)
      ? metadata.history.length
      : 0,
    isRecallingHistory: false,
    atPowerShellPrompt: false,
    commandBlocks: [],
    pendingCommand: '',
    currentCommandCapture: null,
    interactiveCliCapture: null,
    clearBlocksForNextClearHost: false,
    commandInProgress: false,
    interactiveCliActive: false,
    selectedCommandBlockIds: new Set(),
    commandBlockSequence: 0
  };
  pane.dataset.sessionKey = session.layoutKey;
  pane.dataset.sessionId = session.id;
  sessions.set(session.id, session);
  updateStatusDisplay(session);
  updateSessionRow(session);
  updateSessionListEmptyState();
  scheduleGitContextRefresh(session);

  terminal.parser.registerOscHandler(133, (payload) => {
    const marker = parseOsc133(payload, session.shellIntegrationNonce);
    if (!marker) {
      return false;
    }

    if (marker.type === 'A') {
      session.atPowerShellPrompt = false;
    } else if (marker.type === 'B') {
      session.atPowerShellPrompt = true;
      applyStatusEvent(session, { type: 'SHELL_READY', now: Date.now() });
      session.historyCursor = session.history.length;
      if (!isClosing && marker.cwd && marker.cwd !== session.cwd) {
        session.cwd = marker.cwd;
        window.terminalApi.updateCwd(session.id, marker.cwd);
        updateSessionRow(session);
        scheduleStateSave();
        scheduleGitContextRefresh(session);
      }
      refreshSessionSurfaces(session);
    } else if (marker.type === 'E') {
      session.atPowerShellPrompt = false;
      session.pendingCommand = marker.command;
      session.providerHint = providerKindFromCommand(marker.command);
      updateSessionRow(session);
      session.interactiveCliActive = isInteractiveCliCommand(marker.command);
      session.interactiveCliCapture?.marker.dispose();
      session.interactiveCliCapture = null;
      if (!isClosing) {
        appendHistory(session, marker.command);
      }
      if (session.id === focusedSessionId) {
        renderCommandBlocks();
      }
    } else if (marker.type === 'C') {
      applyStatusEvent(session, { type: 'COMMAND_STARTED', now: Date.now() });
      clearAttention(session);
      updateStatusDisplay(session);
      scheduleIdleTransition(session);

      const clearsCommandBlocks =
        (clearCommandBlocksOnClearHost || session.clearBlocksForNextClearHost)
        && isPowerShellClearHostCommand(session.pendingCommand);
      if (
        !session.interactiveCliActive
        && !clearsCommandBlocks
        && session.pendingCommand
      ) {
        const startMarker = terminal.registerMarker(0);
        session.currentCommandCapture = startMarker
          ? {
              command: session.pendingCommand,
              marker: startMarker,
              column: terminal.buffer.active.cursorX
            }
          : null;
      } else if (session.interactiveCliActive) {
        const startMarker = terminal.registerMarker(0);
        session.interactiveCliCapture = startMarker
          ? {
              marker: startMarker,
              column: terminal.buffer.active.cursorX
            }
          : null;
      }
    } else if (marker.type === 'D') {
      const clearsCommandBlocks =
        (clearCommandBlocksOnClearHost || session.clearBlocksForNextClearHost)
        && isPowerShellClearHostCommand(session.pendingCommand);
      if (session.currentCommandCapture) {
        const capture = session.currentCommandCapture;
        const buffer = terminal.buffer.active;
        const startLine = capture.marker.line;
        let output = '';
        if (!capture.marker.isDisposed && startLine >= 0) {
          output = extractBufferText(
            buffer,
            { line: startLine, column: capture.column },
            {
              line: buffer.baseY + buffer.cursorY,
              column: buffer.cursorX
            }
          );
        }
        session.commandBlocks.push({
          id: ++session.commandBlockSequence,
          command: capture.command,
          output,
          exitCode: marker.exitCode,
          completedAt: Date.now(),
          expanded: false
        });
        if (session.commandBlocks.length > MAX_COMMAND_BLOCKS) {
          session.commandBlocks.splice(
            0,
            session.commandBlocks.length - MAX_COMMAND_BLOCKS
          );
          // 최대 개수를 넘겨 밀려난 블록의 선택도 함께 정리한다.
          pruneSelectedBlockIds(session);
        }
        capture.marker.dispose();
      }

      if (clearsCommandBlocks) {
        session.commandBlocks = [];
        session.selectedCommandBlockIds.clear();
      }

      session.currentCommandCapture = null;
      session.interactiveCliCapture?.marker.dispose();
      session.interactiveCliCapture = null;
      session.clearBlocksForNextClearHost = false;
      session.pendingCommand = '';
      session.interactiveCliActive = false;
      if (session.idleTimer !== null) {
        clearTimeout(session.idleTimer);
        session.idleTimer = null;
      }
      applyStatusEvent(session, {
        type: 'COMMAND_COMPLETED',
        now: Date.now(),
        exitCode: marker.exitCode
      });
      updateStatusDisplay(session);
      emphasizeIdleTransition(session);
      showIdleToast(session);
      // 숨은 세션도 블록을 계속 모으므로, 표시 중이면 타일 header의 블록 수를 갱신한다.
      refreshSessionSurfaces(session);
      scheduleGitContextRefresh(session);
      if (session.id === focusedSessionId) {
        renderCommandBlocks();
      }
    }

    return true;
  });

  terminal.onData((data) => {
    // 배치 편집 중에는 키 입력을 PTY로 보내지 않는다(overlay와 별개의 방어선).
    if (isEditingDeck() || isClosing) {
      return;
    }
    if (session.isRecallingHistory) {
      session.isRecallingHistory = false;
    } else {
      session.historyCursor = session.history.length;
    }
    window.terminalApi.write(session.id, data);
  });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') {
      return true;
    }

    if (
      !event.ctrlKey
      && !event.altKey
      && !event.metaKey
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      && recallHistory(
        session,
        event.key === 'ArrowUp' ? 'up' : 'down'
      )
    ) {
      return false;
    }

    const action = getTerminalShortcutAction(event, terminal.hasSelection());
    if (action === 'copy') {
      const selection = terminal.getSelection();
      if (selection) {
        void window.terminalApi.writeClipboard(selection);
      }
      return false;
    }

    if (action === 'paste') {
      // The capturing paste listener above sends clipboard text exactly once.
      // Returning false prevents full-screen CLIs from treating Ctrl+V as
      // their own image-paste or quoted-insert shortcut.
      return false;
    }

    return true;
  });

  // 왼쪽 목록이 표시와 포커스의 유일한 컨트롤러다. 이미 표시·포커스된 행을
  // 다시 눌러도 배치는 바뀌지 않는다(같은 타일에 같은 세션을 다시 붙일 뿐).
  listRow.addEventListener('click', (event) => {
    if (event.detail <= 1) {
      focusSession(session.id);
    }
  });
  listRow.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSessionPlacementMenu(session, { x: event.clientX, y: event.clientY });
  });
  listRow.addEventListener('keydown', (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      openSessionPlacementMenu(session, { anchor: listRow.getBoundingClientRect() });
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      focusSession(session.id);
    }
  });
  label.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    beginRename(session);
  });
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    requestSessionRemoval(session.id);
  });
  restart.addEventListener('click', (event) => {
    event.stopPropagation();
    void restartSession(session.id);
  });

  return session;
}

async function addSession(cwd, options = {}) {
  if (isClosing) {
    showToastMessage(APP_CLOSING_REASON);
    updateSessionLifecycleControls();
    return null;
  }
  // UI 비활성만 믿지 않는다. 편집 중에는 세션 생성 IPC 자체를 부르지 않는다.
  if (isEditingDeck()) {
    announceDeckEdit(EDIT_LOCK_REASON);
    // 버튼이 강제로 활성화된 상태였다면 잠금을 다시 적용한다.
    updateSessionLifecycleControls();
    return null;
  }

  // createSession → createTerminal → sessions 등록 → attach까지 전부 끝난 뒤에만
  // lifecycle을 닫는다. 그 전에는 배치 편집에 들어갈 수 없다.
  const lifecycle = beginSessionLifecycle('create');

  try {
    const metadata = await window.terminalApi.createSession({
      cwd,
      initialCwd: options.restore?.initialCwd,
      name: options.restore?.name,
      shellKind: options.restore?.shellKind,
      shellPath: configuredShellPath
    });
    if (!metadata) {
      return null;
    }

    const session = createTerminal({
      ...metadata,
      layoutKey: options.restore?.key,
      description: options.restore?.description,
      history: options.restore?.history,
      provider: options.restore?.provider,
      // 복원된 세션만 저장된 순환 번호를 넘긴다. 고정 세션의 null도 그대로 유지된다.
      ...(options.restore ? { rotationSlot: options.restore.rotationSlot } : {})
    });
    if (options.activate !== false) {
      focusSession(session.id);
    }
    updateEmptyState();

    const pendingOutput = await window.terminalApi.attachSession(session.id);
    if (pendingOutput) {
      recordOutputActivity(session);
      session.terminal.write(pendingOutput);
    }
    scheduleFit(session);
    if (options.persist !== false) {
      scheduleStateSave();
    }
    return session;
  } catch (error) {
    const detail = typeof error?.message === 'string'
      ? error.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
      : '알 수 없는 오류입니다.';
    showToastMessage(`terminal을 시작하지 못했습니다: ${detail}`);
    return null;
  } finally {
    // 실패·예외에서도 반드시 해제한다. 그러지 않으면 편집 버튼이 영구 잠긴다.
    endSessionLifecycle(lifecycle);
  }
}

async function addSessionFromLastDirectory() {
  const cwd = focusedSession()?.cwd;
  await addSession(cwd);
}

async function addSessionFromChosenDirectory() {
  const cwd = await window.terminalApi.chooseDirectory();
  if (cwd) {
    await addSession(cwd);
  }
}

async function restartSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session.exited || session.restarting) return null;
  if (isClosing) {
    showToastMessage(APP_CLOSING_REASON);
    return null;
  }
  if (isEditingDeck()) {
    announceDeckEdit(EDIT_LOCK_REASON);
    return null;
  }

  const lifecycle = beginSessionLifecycle('restart');
  session.restarting = true;
  updateStatusDisplay(session);
  updateSessionRow(session);
  renderDeck();
  let replacement = null;
  try {
    const released = await window.terminalApi.closeSession(session.id);
    if (!released?.ok && released?.status !== 'not-found') {
      throw new Error('종료된 PTY 정리 확인에 실패했습니다.');
    }
    const metadata = await window.terminalApi.createSession({
      cwd: session.cwd,
      initialCwd: session.initialCwd,
      name: session.name,
      shellKind: session.shellKind,
      shellPath: configuredShellPath
    });
    if (!metadata) throw new Error('새 PTY를 만들지 못했습니다.');

    replacement = createTerminal({
      ...metadata,
      layoutKey: session.layoutKey,
      description: session.description,
      history: session.history.map((entry) => ({ ...entry })),
      provider: null,
      rotationSlot: session.rotationSlot
    });
    const wasFocused = focusedSessionId === session.id;
    sessionList.insertBefore(replacement.listRow, session.listRow);
    const orderedSessions = [...sessions.values()];
    sessions.clear();
    for (const item of orderedSessions) {
      if (item === session) {
        sessions.set(replacement.id, replacement);
      } else if (item !== replacement) {
        sessions.set(item.id, item);
      }
    }
    disposeSessionRuntime(session);
    if (wasFocused) focusedSessionId = replacement.id;
    renderDeck();
    updateSessionListEmptyState();
    updateEmptyState();

    const pendingOutput = await window.terminalApi.attachSession(replacement.id);
    if (pendingOutput) {
      recordOutputActivity(replacement);
      replacement.terminal.write(pendingOutput);
    }
    scheduleFit(replacement);
    scheduleStateSave();
    return replacement;
  } catch (error) {
    if (replacement && sessions.get(replacement.id) === replacement) {
      try {
        await window.terminalApi.closeSession(replacement.id);
      } catch {
        // attach 실패 뒤 정리는 best effort이며 화면에는 종료 상태를 남긴다.
      }
      replacement.exited = true;
      replacement.exitedAt = Date.now();
      replacement.exitAcknowledged = false;
      applyStatusEvent(replacement, { type: 'PTY_EXIT', now: replacement.exitedAt });
      replacement.listRow.classList.add('exited');
      updateStatusDisplay(replacement);
    } else if (sessions.get(session.id) === session) {
      session.restarting = false;
      updateStatusDisplay(session);
      updateSessionRow(session);
      renderDeck();
    }
    const detail = typeof error?.message === 'string'
      ? error.message.replace(/^Error invoking remote method '[^']+':\s*/, '')
      : '알 수 없는 오류입니다.';
    showToastMessage(`${session.name}: 다시 시작하지 못했습니다. ${detail}`);
    return null;
  } finally {
    endSessionLifecycle(lifecycle);
  }
}

async function removeSession(sessionId) {
  if (isClosing) {
    showToastMessage(APP_CLOSING_REASON);
    updateSessionLifecycleControls();
    return;
  }
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }

  // 편집 중 세션을 지우면 draft가 실제 sessions와 어긋난다. terminal.dispose와
  // closeSession IPC를 부르지 않고 그대로 돌려보낸다.
  if (isEditingDeck()) {
    announceDeckEdit(EDIT_LOCK_REASON);
    updateSessionLifecycleControls();
    return;
  }

  // sessions 삭제 → terminal 정리 → closeSession IPC → releaseSession → 포커스
  // 이동 → renderDeck이 모두 끝날 때까지 배치 편집 진입을 막는다.
  const lifecycle = beginSessionLifecycle('close');
  try {
    await closeSessionInternal(session, sessionId);
  } finally {
    endSessionLifecycle(lifecycle);
  }
}

async function terminateSessionProcess(sessionId) {
  if (isClosing) {
    showToastMessage(APP_CLOSING_REASON);
    return;
  }
  const session = sessions.get(sessionId);
  if (!session || session.exited) return;
  if (isEditingDeck()) {
    announceDeckEdit(EDIT_LOCK_REASON);
    return;
  }

  const lifecycle = beginSessionLifecycle('terminate');
  try {
    const result = await window.terminalApi.terminateSession(sessionId);
    if (!result?.ok) {
      const reason = result?.status === 'kill-timeout'
        ? '종료 확인 시간이 초과됐습니다.'
        : '종료 요청에 실패했습니다.';
      showToastMessage(`${session.name}: ${reason}`);
    }
  } catch {
    showToastMessage(`${session.name}: PowerShell 프로세스 종료 요청에 실패했습니다.`);
  } finally {
    endSessionLifecycle(lifecycle);
  }
}

function disposeSessionRuntime(session) {
  if (sessions.get(session.id) === session) sessions.delete(session.id);
  if (session.idleTimer !== null) clearTimeout(session.idleTimer);
  if (session.gitRefreshTimer !== null) clearTimeout(session.gitRefreshTimer);
  if (session.gitStaleTimer !== null) clearTimeout(session.gitStaleTimer);
  clearAttention(session);
  clearSessionToast(session);
  session.currentCommandCapture?.marker.dispose();
  session.interactiveCliCapture?.marker.dispose();
  session.terminal.dispose();
  session.listRow.remove();
  session.pane.remove();
}

// 세션 하나를 로컬에서 완전히 정리한다. sessions·DOM·deck·포커스·렌더·저장까지
// 한 경로에서 끝내므로, IPC 성공 여부와 무관하게 일부만 정리되는 상태가 없다.
function detachSessionLocally(session, sessionId) {
  if (sessions.get(sessionId) !== session) {
    return;
  }
  const orderedKeys = [...sessions.values()].map((item) => item.layoutKey);
  const nextSession = sessionByKey(
    nextFocusKey(orderedKeys, session.layoutKey)
  );

  disposeSessionRuntime(session);

  // 세션 종료는 배치에서 그 세션만 회수한다. 순환 타일은 남고 표시만 비워지며,
  // 고정 타일은 함께 제거된다(§12.3). 남은 타일의 기하는 건드리지 않는다.
  deckLayout = releaseSession(deckLayout, session.layoutKey);
  ensureMaximizeIsValid();

  // 표시 중이던 세션이 사라졌으면 목록 순서에서 예측 가능한 다음 세션을 표시한다.
  // 숨은 세션 종료는 현재 타일과 포커스를 그대로 둔다.
  if (focusedSessionId === sessionId) {
    focusedSessionId = null;
    if (nextSession && sessions.has(nextSession.id)) {
      focusSession(nextSession.id);
    }
  }
  renderDeck();

  updateSessionListEmptyState();
  updateEmptyState();
  scheduleStateSave();
  if (sessions.size === 0) {
    document.title = applicationTitle();
  }
}

async function closeSessionInternal(session, sessionId) {
  try {
    const result = await window.terminalApi.closeSession(sessionId);
    if (result?.ok) {
      detachSessionLocally(session, sessionId);
      return;
    }
    const reason = result?.status === 'kill-timeout'
      ? 'PTY 종료 확인 시간이 초과됐습니다.'
      : 'PTY 종료 요청에 실패했습니다.';
    showToastMessage(`${session.name}: ${reason} terminal을 화면에 유지합니다.`);
  } catch (error) {
    showToastMessage(
      `${session.name} 종료 요청이 실패했습니다. terminal을 화면에 유지합니다.`
    );
  }
}

window.terminalApi.onOutput(({ sessionId, data }) => {
  const session = sessions.get(sessionId);
  if (session) {
    recordOutputActivity(session);
    session.terminal.write(data);
  }
});

window.terminalApi.onExit(({ sessionId, closeRequested }) => {
  const session = sessions.get(sessionId);
  if (session) {
    if (closeRequested) {
      detachSessionLocally(session, sessionId);
      return;
    }
    // PTY가 끝나도 포커스와 배치는 그대로 둔다. 표시면 문구만 갱신한다.
    session.exited = true;
    session.exitedAt = Date.now();
    session.exitAcknowledged = false;
    applyStatusEvent(session, { type: 'PTY_EXIT', now: session.exitedAt });
    session.listRow.classList.add('exited');
    updateStatusDisplay(session);
  }
});

window.terminalApi.onSessionError?.(({ sessionId, message }) => {
  const session = sessions.get(sessionId);
  showToastMessage(`${session?.name || '관리자 terminal'} 입력 처리 실패: ${message}`);
});

workspaceDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
});
newWorkspaceButton.addEventListener('click', () => openWorkspaceEditor());
cancelWorkspaceEditButton.addEventListener('click', closeWorkspaceEditor);
openEphemeralWorkspaceButton.addEventListener('click', () => {
  void selectWorkspace({ ephemeral: true });
});
workspaceEditor.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = {
    name: workspaceNameInput.value.trim(),
    description: workspaceDescriptionInput.value.trim(),
    elevation: workspaceElevationInput.checked
      ? 'administrator'
      : 'standard'
  };
  if (!input.name) {
    return;
  }

  const editingId = workspaceIdInput.value;
  if (editingId) {
    await window.terminalApi.updateWorkspace(editingId, input);
    closeWorkspaceEditor();
    await refreshWorkspaceList();
    return;
  }

  const sourceId = workspaceSourceIdInput.value;
  if (sourceId) {
    try {
      const cloned = await window.terminalApi.cloneWorkspace(sourceId, input);
      closeWorkspaceEditor();
      if (cloned) {
        await selectWorkspace({ workspaceId: cloned.id });
      } else {
        window.alert('복제할 작업 공간을 찾지 못했습니다.');
        await refreshWorkspaceList();
      }
    } catch (error) {
      window.alert(`작업 공간을 복제하지 못했습니다.\n\n${error.message}`);
    }
    return;
  }

  const created = await window.terminalApi.createWorkspace(input);
  closeWorkspaceEditor();
  if (created) {
    await selectWorkspace({ workspaceId: created.id });
  } else {
    await refreshWorkspaceList();
  }
});

newTabButton.addEventListener('click', () => void addSessionFromLastDirectory());
folderTabButton.addEventListener('click', () => void addSessionFromChosenDirectory());
for (const button of sidePanelButtons) {
  button.addEventListener('click', () => switchSidePanel(button.dataset.panel));
}
// 접기/펴기로 누른 버튼이 화면에서 사라지므로 상대 버튼으로 포커스를 인계한다.
collapseCommandPanelButton.addEventListener('click', () => {
  setCommandPanelCollapsed(true);
  focusAfterLayout(expandCommandPanelButton);
});
expandCommandPanelButton.addEventListener('click', () => {
  setCommandPanelCollapsed(false);
  focusAfterLayout(collapseCommandPanelButton);
});
// 두 splitter는 같은 pointer/keyboard 규칙을 쓴다. 방향키는 16px, Home/End는
// 최소/최대. drag 중에는 저장하지 않고 pointerup에서 한 번만 저장을 예약한다.
const RESIZER_KEY_STEP = 16;

function registerPanelResizer(resizer, options) {
  resizer.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    try {
      resizer.setPointerCapture(event.pointerId);
    } catch {
      // 합성 이벤트에서는 capture가 없어도 아래 핸들러가 동작한다.
    }
    resizer.dataset.resizing = 'true';
    document.body.classList.add('panel-resizing');
  });
  resizer.addEventListener('pointermove', (event) => {
    if (resizer.dataset.resizing !== 'true') {
      return;
    }
    const bounds = workArea.getBoundingClientRect();
    options.setWidth(options.widthFromPointer(bounds, event.clientX));
  });
  const finish = (event, persist) => {
    if (resizer.dataset.resizing !== 'true') {
      return;
    }
    delete resizer.dataset.resizing;
    if (event && resizer.hasPointerCapture?.(event.pointerId)) {
      resizer.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove('panel-resizing');
    scheduleVisibleFits();
    if (persist) {
      scheduleStateSave();
    }
  };
  resizer.addEventListener('pointerup', (event) => finish(event, true));
  resizer.addEventListener('pointercancel', (event) => finish(event, false));
  resizer.addEventListener('keydown', (event) => {
    const current = options.currentWidth();
    let next = null;
    if (event.key === 'ArrowLeft') {
      next = current + options.keyDirection * RESIZER_KEY_STEP;
    } else if (event.key === 'ArrowRight') {
      next = current - options.keyDirection * RESIZER_KEY_STEP;
    } else if (event.key === 'Home') {
      next = options.minimum;
    } else if (event.key === 'End') {
      next = options.maximum;
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    options.setWidth(next, true);
  });
}

registerPanelResizer(sessionPanelResizer, {
  // 왼쪽 splitter: 오른쪽으로 끌수록 넓어진다.
  keyDirection: -1,
  minimum: MIN_SESSION_PANEL_WIDTH,
  maximum: MAX_SESSION_PANEL_WIDTH,
  currentWidth: () => effectivePanelLayout?.sessionWidth ?? sessionPanelWidth,
  widthFromPointer: (bounds, clientX) => clientX - bounds.left,
  setWidth: (width, persist = false) => setSessionPanelWidth(width, persist)
});

registerPanelResizer(panelResizer, {
  // 오른쪽 splitter: 왼쪽으로 끌수록 넓어진다(기존 방향 유지).
  keyDirection: 1,
  minimum: MIN_COMMAND_PANEL_WIDTH,
  maximum: MAX_COMMAND_PANEL_WIDTH,
  currentWidth: () => effectivePanelLayout?.commandWidth ?? commandPanelWidth,
  widthFromPointer: (bounds, clientX) => bounds.right - clientX,
  setWidth: (width, persist = false) => setCommandPanelWidth(width, persist)
});

collapseSessionPanelButton.addEventListener('click', () => {
  setSessionPanelCollapsed(true);
  focusAfterLayout(expandSessionPanelButton);
});
expandSessionPanelButton.addEventListener('click', () => {
  setSessionPanelCollapsed(false);
  focusAfterLayout(collapseSessionPanelButton);
});
addFavoriteButton.addEventListener('click', () => openFavoriteDialog());
cancelFavoriteButton.addEventListener('click', () => favoriteDialog.close());
favoriteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = favoriteNameInput.value.trim();
  const command = favoriteCommandInput.value.trim();
  if (!name || !command) {
    return;
  }

  const editingId = favoriteIdInput.value;
  if (editingId) {
    const favorite = favorites.find((item) => item.id === editingId);
    if (favorite) {
      favorite.name = name;
      favorite.command = command;
    }
  } else {
    favorites.push({
      id: window.crypto.randomUUID(),
      name,
      command,
      expanded: false
    });
  }

  favoriteDialog.close();
  renderFavorites();
  scheduleStateSave();
});
clearHistoryButton.addEventListener('click', () => {
  const session = focusedSession();
  if (
    !session
    || session.history.length === 0
    || !window.confirm('현재 대상 terminal의 명령 히스토리를 모두 지울까요?')
  ) {
    return;
  }

  session.history = [];
  session.historyCursor = 0;
  renderHistory();
  scheduleStateSave();
});
selectAllCommandBlocks.addEventListener('change', () => {
  const session = focusedSession();
  if (!session) {
    return;
  }

  session.selectedCommandBlockIds.clear();
  if (selectAllCommandBlocks.checked) {
    for (const block of session.commandBlocks) {
      session.selectedCommandBlockIds.add(block.id);
    }
  }
  renderCommandBlocks();
});
copySelectedCommandBlocksButton.addEventListener('click', async () => {
  const session = focusedSession();
  const blocks = session ? selectedBlocks(session) : [];
  if (blocks.length > 0) {
    await window.terminalApi.writeClipboard(formatCommandBlocks(blocks));
    setTemporaryButtonLabel(copySelectedCommandBlocksButton, '복사됨');
  }
});

copyInteractiveCliButton.addEventListener('click', async () => {
  const session = focusedSession();
  if (!session?.interactiveCliActive) {
    return;
  }

  const text = extractInteractiveCliText(
    session.terminal,
    session.interactiveCliCapture
  );
  if (!text.trim()) {
    setTemporaryButtonLabel(copyInteractiveCliButton, '내용 없음');
    return;
  }

  await window.terminalApi.writeClipboard(text);
  setTemporaryButtonLabel(copyInteractiveCliButton, '복사됨');
});
commandBlockCount.addEventListener('click', async () => {
  const session = focusedSession();
  if (!session || session.commandBlocks.length === 0) {
    return;
  }
  await window.terminalApi.writeClipboard(formatCommandBlocks(session.commandBlocks));
  setTemporaryButtonLabel(commandBlockCount, '전체 복사됨');
});
saveSelectedCommandBlocksButton.addEventListener('click', async () => {
  const session = focusedSession();
  const blocks = session ? selectedBlocks(session) : [];
  if (blocks.length === 0) {
    return;
  }

  const result = await window.terminalApi.saveCommandBlock({
    defaultName: defaultSelectedBlocksFileName(),
    text: formatCommandBlocks(blocks)
  });
  if (result?.saved) {
    setTemporaryButtonLabel(saveSelectedCommandBlocksButton, '저장됨');
  }
});
deleteSelectedCommandBlocksButton.addEventListener('click', () => {
  const session = focusedSession();
  if (!session || session.selectedCommandBlockIds.size === 0) {
    return;
  }

  session.commandBlocks = session.commandBlocks.filter(
    (block) => !session.selectedCommandBlockIds.has(block.id)
  );
  session.selectedCommandBlockIds.clear();
  renderCommandBlocks();
});
clearCommandBlocksButton.addEventListener('click', () => {
  const session = focusedSession();
  if (
    !session
    || session.commandBlocks.length === 0
    || !window.confirm('이 대상 terminal의 명령 블록을 모두 지울까요?')
  ) {
    return;
  }

  session.commandBlocks = [];
  session.selectedCommandBlockIds.clear();
  renderCommandBlocks();
});
openSettingsButton.addEventListener('click', () => {
  topbarMore.removeAttribute('open');
  idleSecondsInput.value = String(idleTimeoutMs / 1000);
  shellPathInput.value = configuredShellPath;
  inactiveSessionNotificationsInput.checked = inactiveSessionNotifications;
  clearCommandBlocksOnClearHostInput.checked =
    clearCommandBlocksOnClearHost;
  settingsDialog.showModal();
});
cancelSettingsButton.addEventListener('click', () => settingsDialog.close());
chooseShellPathButton.addEventListener('click', async () => {
  const selectedPath = await window.terminalApi.chooseShellExecutable();
  if (selectedPath) {
    shellPathInput.value = selectedPath;
  }
});
resetShellPathButton.addEventListener('click', () => {
  shellPathInput.value = '';
});
settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const idleSeconds = normalizeIdleSeconds(idleSecondsInput.value);
  idleSecondsInput.value = String(idleSeconds);
  idleTimeoutMs = idleSeconds * 1000;
  configuredShellPath = shellPathInput.value;
  inactiveSessionNotifications =
    inactiveSessionNotificationsInput.checked;
  clearCommandBlocksOnClearHost =
    clearCommandBlocksOnClearHostInput.checked;

  for (const session of sessions.values()) {
    if (session.commandInProgress) {
      scheduleIdleTransition(session);
    }
    if (!inactiveSessionNotifications) {
      clearSessionToast(session);
    }
  }
  settingsDialog.close();
  scheduleStateSave();
});

// 창·패널 크기 변화. 개별 타일 크기 변화는 tileBodyResizeObserver가 처리한다.
const resizeObserver = new ResizeObserver(() => {
  applyPanelLayout();
  scheduleVisibleFits();
});
resizeObserver.observe(sessionDeck);
resizeObserver.observe(workArea);

startDeckEditButton.addEventListener('click', beginDeckEditMode);
commitDeckEditButton.addEventListener('click', commitDeckEditMode);
cancelDeckEditButton.addEventListener('click', cancelDeckEditMode);
cancelAddTileButton.addEventListener('click', () => addTileDialog.close());
addTileForm.addEventListener('change', updateAddTileDialogState);
addTileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isEditingDeck()) {
    addTileDialog.close();
    return;
  }

  const row = Number(addTileDialog.dataset.row);
  const column = Number(addTileDialog.dataset.column);
  const kind = addTileForm.elements['add-tile-kind'].value;
  const result = kind === 'pinned'
    ? addPinnedTile(deckEdit.draft, addTileSessionSelect.value, { row, column })
    : addRotatingTile(deckEdit.draft, { row, column });
  if (applyDeckEditResult(result)) {
    addTileDialog.close();
  }
});

// 타일 메뉴는 바깥 클릭이나 Escape로 닫는다.
document.addEventListener('click', closeTileMenus);
document.addEventListener('click', (event) => {
  if (!topbarMore.contains(event.target)) {
    topbarMore.removeAttribute('open');
  }
});
document.addEventListener('keydown', (event) => {
  if (
    event.ctrlKey
    && event.shiftKey
    && !event.altKey
    && !event.metaKey
    && event.code === 'KeyP'
  ) {
    event.preventDefault();
    event.stopPropagation();
    openQuickSwitcher();
  }
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') {
    return;
  }

  closeTileMenus();
  // gesture 중 Escape는 그 gesture만 취소하고, 그렇지 않으면 편집 전체를 취소한다.
  if (tileGesture) {
    event.preventDefault();
    endTileGesture(false);
    return;
  }
  if (isEditingDeck() && !addTileDialog.open) {
    event.preventDefault();
    cancelDeckEditMode();
  }
});

window.terminalApi.onPrepareClose(({ requestId, minimumRevision } = {}) => {
  if (typeof requestId !== 'string') {
    return;
  }
  commitActiveInlineEditorForClose();
  isClosing = true;
  updateSessionLifecycleControls();
  void (async () => {
    await waitForSessionLifecycleIdle();
    if (!isClosing) {
      return;
    }
    if (isRestoringState || !activeSaveEpoch) {
      await window.terminalApi.reportFinalStateUnavailable({
        requestId,
        reason: 'restoring'
      });
      return;
    }
    if (Number.isSafeInteger(minimumRevision)) {
      stateSaveRevision = Math.max(stateSaveRevision, minimumRevision - 1);
    }
    await flushStateSave({ force: true, finalRequestId: requestId });
  })().catch(() => {});
});

window.terminalApi.onCloseCancelled(() => {
  isClosing = false;
  updateSessionLifecycleControls();
  scheduleStateSave();
});

async function initializeApp() {
  let savedState = null;
  let restoredSessionKey = null;
  try {
    savedState = await chooseWorkspace();
    const idleSeconds = normalizeIdleSeconds(
      savedState?.settings?.idleSeconds
    );
    idleSecondsInput.value = String(idleSeconds);
    idleTimeoutMs = idleSeconds * 1000;
    configuredShellPath =
      typeof savedState?.settings?.shellPath === 'string'
        ? savedState.settings.shellPath
        : '';
    inactiveSessionNotifications =
      savedState?.settings?.inactiveSessionNotifications !== false;
    clearCommandBlocksOnClearHost =
      savedState?.settings?.clearCommandBlocksOnClearHost === true;
    commandPanelWidth = normalizeCommandPanelWidth(
      savedState?.settings?.commandPanelWidth
    );
    // 접힘 상태는 shared settings에서 복원한다. 접혀 있어도 폭은 그대로 둔다.
    commandPanelCollapsed =
      savedState?.settings?.commandPanelCollapsed === true;
    sessionPanelWidth = normalizeSessionPanelWidth(
      savedState?.settings?.sessionPanelWidth
    );
    sessionPanelCollapsed =
      savedState?.settings?.sessionPanelCollapsed === true;
    applyPanelLayout();
    shellPathInput.value = configuredShellPath;
    inactiveSessionNotificationsInput.checked =
      inactiveSessionNotifications;
    clearCommandBlocksOnClearHostInput.checked =
      clearCommandBlocksOnClearHost;
    favorites = Array.isArray(savedState?.favorites)
      ? savedState.favorites
      : [];
    renderFavorites();

    const savedTabs = Array.isArray(savedState?.tabs)
      ? savedState.tabs
      : [];

    // 저장된 배치를 정규화해 그대로 런타임 deck으로 쓴다. 화면은 이 모델의 타일
    // 전부를 렌더하며, 렌더링 때문에 모델을 다시 만들거나 덮어쓰지 않는다.
    const restored = resolveDeckState({
      tabs: savedTabs,
      activeTabIndex: savedState?.activeTabIndex,
      deck: savedState?.deck
    });
    deckLayout = restored.deck;
    restoredSessionKey = restoreFocusKey(
      restored.deck,
      restored.tabs.map((tab) => tab.key)
    );

    for (const tab of restored.tabs) {
      const session = await addSession(tab.cwd, {
        restore: tab,
        activate: false,
        persist: false
      });
      if (!session) {
        unrestoredTabs.push(tab);
      }
    }
    if (unrestoredTabs.length > 0) {
      showToastMessage(
        `${unrestoredTabs.length}개 세션을 시작하지 못했습니다. 구성은 유지되며 다음 시작 시 다시 시도합니다.`
      );
    }
  } catch (error) {
    console.error('저장된 앱 상태를 복원하지 못했습니다.', error);
  }

  if (sessions.size === 0 && unrestoredTabs.length === 0) {
    await addSession(undefined, {
      activate: false,
      persist: false
    });
  }

  // 저장된 표시 세션을 모두 타일에 연결한 뒤 포커스를 복원한다.
  renderDeck();
  const restoredSession = sessionByKey(restoredSessionKey);
  const initialSession = restoredSession || [...sessions.values()][0];
  if (initialSession) {
    focusSession(initialSession.id);
  }
  updateEmptyState();
  renderHistory();
  // 최초 복원에서는 표시 중인 모든 terminal을 fit한다.
  scheduleVisibleFits();
  isRestoringState = false;
  void flushStateSave().catch(() => {});
}

applyPanelLayout();
updateEmptyState();
updateWorkspaceDisplay();
renderFavorites();
renderHistory();
void initializeApp();
