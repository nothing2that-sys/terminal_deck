const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  normalizeCommandPanelWidth,
  normalizeSessionPanelWidth
} = require('./panel-layout');
const { normalizeRotationSlot, resolveDeckState } = require('./deck-layout');
const { normalizeProviderMetadata } = require('./provider-adapter');

const STATE_VERSION = 3;
const MAX_TABS = 30;
const MAX_FAVORITES = 200;
const MAX_HISTORY_PER_TAB = 500;
const MAX_NAME_LENGTH = 120;
const MAX_COMMAND_LENGTH = 64 * 1024;

function boundedString(value, maxLength, fallback = '') {
  return typeof value === 'string'
    ? value.slice(0, maxLength)
    : fallback;
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(-MAX_HISTORY_PER_TAB)
    .map((entry) => ({
      command: boundedString(entry?.command, MAX_COMMAND_LENGTH),
      timestamp: Number.isFinite(entry?.timestamp)
        ? entry.timestamp
        : Date.now()
    }))
    .filter((entry) => entry.command.trim().length > 0);
}

function normalizeTab(value, index) {
  const cwd = boundedString(value?.cwd, 4096);
  return {
    key: boundedString(value?.key, MAX_NAME_LENGTH, `tab-${index + 1}`),
    name: boundedString(
      value?.name,
      MAX_NAME_LENGTH,
      `PowerShell ${index + 1}`
    ) || `PowerShell ${index + 1}`,
    cwd,
    initialCwd: boundedString(value?.initialCwd, 4096, cwd),
    description: boundedString(value?.description, 300),
    shellKind: ['pwsh', 'powershell'].includes(value?.shellKind)
      ? value.shellKind
      : 'pwsh',
    history: normalizeHistory(value?.history),
    rotationSlot: normalizeRotationSlot(value?.rotationSlot),
    provider: normalizeProviderMetadata(value?.provider)
  };
}

function assertSupportedStateVersion(value) {
  if (!Number.isInteger(value?.version) || value.version <= STATE_VERSION) {
    return;
  }
  const error = new Error(
    `지원하지 않는 미래 상태 버전입니다: ${value.version} > ${STATE_VERSION}`
  );
  error.code = 'ERR_UNSUPPORTED_STATE_VERSION';
  throw error;
}

function normalizeFavorite(value, index) {
  return {
    id: boundedString(value?.id, MAX_NAME_LENGTH, `favorite-${index + 1}`),
    name: boundedString(
      value?.name,
      MAX_NAME_LENGTH,
      `즐겨찾기 ${index + 1}`
    ) || `즐겨찾기 ${index + 1}`,
    command: boundedString(value?.command, MAX_COMMAND_LENGTH)
  };
}

function normalizeState(value) {
  assertSupportedStateVersion(value);
  const tabs = Array.isArray(value?.tabs)
    ? value.tabs.slice(0, MAX_TABS).map(normalizeTab)
    : [];
  const favorites = Array.isArray(value?.favorites)
    ? value.favorites
        .slice(0, MAX_FAVORITES)
        .map(normalizeFavorite)
        .filter((favorite) => favorite.command.trim().length > 0)
    : [];
  const activeTabIndex = Number.isInteger(value?.activeTabIndex)
    ? Math.min(Math.max(value.activeTabIndex, 0), Math.max(tabs.length - 1, 0))
    : 0;
  const idleSeconds = Number.isFinite(Number(value?.settings?.idleSeconds))
    ? Math.min(60, Math.max(1, Math.round(Number(value.settings.idleSeconds))))
    : 3;
  const shellPath = boundedString(value?.settings?.shellPath, 4096);
  const inactiveSessionNotifications =
    value?.settings?.inactiveSessionNotifications !== false;
  const clearCommandBlocksOnClearHost =
    value?.settings?.clearCommandBlocksOnClearHost === true;
  const commandPanelWidth = normalizeCommandPanelWidth(
    value?.settings?.commandPanelWidth
  );
  // 접힘은 boolean만 인정하고 나머지는 false로 정규화한다. 접혀 있어도
  // 저장된 폭은 그대로 보존한다.
  const commandPanelCollapsed =
    value?.settings?.commandPanelCollapsed === true;
  const sessionPanelWidth = normalizeSessionPanelWidth(
    value?.settings?.sessionPanelWidth
  );
  const sessionPanelCollapsed =
    value?.settings?.sessionPanelCollapsed === true;

  const resolvedDeck = resolveDeckState({
    tabs,
    activeTabIndex,
    deck: value?.deck
  });
  for (const warning of resolvedDeck.warnings) {
    console.warn(`세션 배치를 정규화했습니다: ${warning}`);
  }

  return {
    version: STATE_VERSION,
    settings: {
      idleSeconds,
      shellPath,
      inactiveSessionNotifications,
      clearCommandBlocksOnClearHost,
      commandPanelWidth,
      commandPanelCollapsed,
      sessionPanelWidth,
      sessionPanelCollapsed
    },
    favorites,
    tabs: resolvedDeck.tabs,
    activeTabIndex,
    deck: resolvedDeck.deck
  };
}

function loadStateFile(filePath) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch (error) {
    if (error.code === 'ERR_UNSUPPORTED_STATE_VERSION') {
      throw error;
    }
    if (error.code !== 'ENOENT') {
      console.warn(`상태 파일을 읽지 못했습니다: ${error.message}`);
    }
    return normalizeState(null);
  }
}

function saveStateFile(filePath, state) {
  const normalized = normalizeState(state);
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf8'
  );
  fs.renameSync(temporaryPath, filePath);
  return normalized;
}

module.exports = {
  MAX_FAVORITES,
  MAX_HISTORY_PER_TAB,
  MAX_TABS,
  STATE_VERSION,
  assertSupportedStateVersion,
  loadStateFile,
  normalizeState,
  saveStateFile
};
