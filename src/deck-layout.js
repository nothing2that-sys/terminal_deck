const DECK_VERSION = 1;
const DECK_ROWS = 4;
const DECK_COLUMNS = 4;
const MAX_TILES = DECK_ROWS * DECK_COLUMNS;
const MAX_ROTATION_INDEX = MAX_TILES;
const MAX_TILE_ID_LENGTH = 120;
const DEFAULT_TILE_ROW_SPAN = 2;
const DEFAULT_TILE_COLUMN_SPAN = 2;
const TILE_KINDS = ['pinned', 'rotating'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function normalizeRotationSlot(value) {
  return boundedInteger(value, 1, MAX_ROTATION_INDEX);
}

function normalizeSessionKey(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeTileId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_TILE_ID_LENGTH
    ? value
    : null;
}

function describeTileKind(value) {
  return typeof value === 'string' && value.length > 0
    ? JSON.stringify(value.slice(0, 40))
    : '누락';
}

function tileWithinBounds(tile) {
  return Number.isInteger(tile?.row)
    && Number.isInteger(tile?.column)
    && Number.isInteger(tile?.rowSpan)
    && Number.isInteger(tile?.columnSpan)
    && tile.row >= 0
    && tile.column >= 0
    && tile.rowSpan >= 1
    && tile.columnSpan >= 1
    && tile.row + tile.rowSpan <= DECK_ROWS
    && tile.column + tile.columnSpan <= DECK_COLUMNS;
}

function tilesOverlap(left, right) {
  return left.row < right.row + right.rowSpan
    && right.row < left.row + left.rowSpan
    && left.column < right.column + right.columnSpan
    && right.column < left.column + left.columnSpan;
}

function findOverlappingPair(tiles) {
  for (let index = 0; index < tiles.length; index += 1) {
    for (let other = index + 1; other < tiles.length; other += 1) {
      if (tilesOverlap(tiles[index], tiles[other])) {
        return [tiles[index], tiles[other]];
      }
    }
  }
  return null;
}

function normalizeGeometry(value) {
  const geometry = {
    row: boundedInteger(value?.row, 0, DECK_ROWS - 1),
    column: boundedInteger(value?.column, 0, DECK_COLUMNS - 1),
    rowSpan: boundedInteger(value?.rowSpan, 1, DECK_ROWS),
    columnSpan: boundedInteger(value?.columnSpan, 1, DECK_COLUMNS)
  };
  return tileWithinBounds(geometry) ? geometry : null;
}

function occupiedGrid(tiles) {
  const grid = Array.from(
    { length: DECK_ROWS },
    () => new Array(DECK_COLUMNS).fill(false)
  );
  for (const tile of tiles) {
    for (let row = tile.row; row < tile.row + tile.rowSpan; row += 1) {
      for (
        let column = tile.column;
        column < tile.column + tile.columnSpan;
        column += 1
      ) {
        grid[row][column] = true;
      }
    }
  }
  return grid;
}

function rectangleIsFree(grid, row, column, rowSpan, columnSpan) {
  if (row + rowSpan > DECK_ROWS || column + columnSpan > DECK_COLUMNS) {
    return false;
  }

  for (let cursorRow = row; cursorRow < row + rowSpan; cursorRow += 1) {
    for (
      let cursorColumn = column;
      cursorColumn < column + columnSpan;
      cursorColumn += 1
    ) {
      if (grid[cursorRow][cursorColumn]) {
        return false;
      }
    }
  }
  return true;
}

function candidateSizes(preferred) {
  const preferredRowSpan = boundedInteger(preferred?.rowSpan, 1, DECK_ROWS);
  const preferredColumnSpan = boundedInteger(
    preferred?.columnSpan,
    1,
    DECK_COLUMNS
  );
  const sizes = [];
  for (let rowSpan = 1; rowSpan <= DECK_ROWS; rowSpan += 1) {
    for (let columnSpan = 1; columnSpan <= DECK_COLUMNS; columnSpan += 1) {
      sizes.push({ rowSpan, columnSpan });
    }
  }
  sizes.sort((left, right) =>
    right.rowSpan * right.columnSpan - left.rowSpan * left.columnSpan
    || right.rowSpan - left.rowSpan);

  return preferredRowSpan !== null && preferredColumnSpan !== null
    ? [{ rowSpan: preferredRowSpan, columnSpan: preferredColumnSpan }, ...sizes]
    : sizes;
}

// 기존 타일을 밀어내지 않고 들어갈 수 있는 빈 사각형을 찾는다. 요청한 크기를 먼저
// 시도하고, 들어가지 않으면 가장 큰 빈 사각형을 위/왼쪽 우선으로 고른다.
function findFreeRectangle(tiles, preferred = {}) {
  const grid = occupiedGrid(tiles.filter(tileWithinBounds));
  for (const size of candidateSizes(preferred)) {
    for (let row = 0; row + size.rowSpan <= DECK_ROWS; row += 1) {
      for (
        let column = 0;
        column + size.columnSpan <= DECK_COLUMNS;
        column += 1
      ) {
        if (rectangleIsFree(grid, row, column, size.rowSpan, size.columnSpan)) {
          return {
            row,
            column,
            rowSpan: size.rowSpan,
            columnSpan: size.columnSpan
          };
        }
      }
    }
  }
  return null;
}

// 클릭한 cell을 반드시 포함하는 빈 사각형을 찾는다. 요청한 크기를 먼저 시도하고,
// 들어가지 않으면 그 cell을 포함하는 가장 큰 사각형, 마지막으로 1×1까지 내려간다.
function findFreeRectangleAt(tiles, row, column, preferred = {}) {
  const anchorRow = boundedInteger(row, 0, DECK_ROWS - 1);
  const anchorColumn = boundedInteger(column, 0, DECK_COLUMNS - 1);
  if (anchorRow === null || anchorColumn === null) {
    return null;
  }

  const grid = occupiedGrid(tiles.filter(tileWithinBounds));
  if (grid[anchorRow][anchorColumn]) {
    return null;
  }

  for (const size of candidateSizes(preferred)) {
    const firstRow = Math.max(0, anchorRow - size.rowSpan + 1);
    const firstColumn = Math.max(0, anchorColumn - size.columnSpan + 1);
    for (let origin = firstRow; origin <= anchorRow; origin += 1) {
      for (let column2 = firstColumn; column2 <= anchorColumn; column2 += 1) {
        if (rectangleIsFree(grid, origin, column2, size.rowSpan, size.columnSpan)) {
          return {
            row: origin,
            column: column2,
            rowSpan: size.rowSpan,
            columnSpan: size.columnSpan
          };
        }
      }
    }
  }
  return null;
}

// 기존 id와 겹치지 않는 새 타일 id.
function nextTileId(tiles) {
  const used = new Set((tiles || []).map((tile) => tile?.id).filter(Boolean));
  let counter = used.size + 1;
  while (used.has(`tile-${counter}`)) {
    counter += 1;
  }
  return `tile-${counter}`;
}

function rotationIndexes(deck) {
  return (deck?.tiles || [])
    .filter((tile) => tile.kind === 'rotating')
    .map((tile) => tile.rotationIndex)
    .sort((left, right) => left - right);
}

function lowestFreeRotationIndex(usedIndexes) {
  const used = new Set(usedIndexes);
  for (let index = 1; index <= MAX_ROTATION_INDEX; index += 1) {
    if (!used.has(index)) {
      return index;
    }
  }
  return MAX_ROTATION_INDEX;
}

function createTileIdAllocator(reservedIds) {
  const used = new Set(reservedIds);
  let counter = 0;
  return () => {
    let candidate = '';
    do {
      counter += 1;
      candidate = `tile-${counter}`;
    } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  };
}

function createRotatingTile(id, rotationIndex, geometry, currentSessionKey) {
  return {
    id,
    kind: 'rotating',
    rotationIndex,
    currentSessionKey: currentSessionKey || null,
    row: geometry.row,
    column: geometry.column,
    rowSpan: geometry.rowSpan,
    columnSpan: geometry.columnSpan
  };
}

function createPinnedTile(id, sessionKey, geometry) {
  return {
    id,
    kind: 'pinned',
    sessionKey,
    row: geometry.row,
    column: geometry.column,
    rowSpan: geometry.rowSpan,
    columnSpan: geometry.columnSpan
  };
}

const FULL_GEOMETRY = {
  row: 0,
  column: 0,
  rowSpan: DECK_ROWS,
  columnSpan: DECK_COLUMNS
};

// 어떤 이유로든 저장된 배치를 신뢰할 수 없을 때 돌아가는 안전한 기본 배치다.
function createDefaultDeck(options = {}) {
  const currentSessionKey = normalizeSessionKey(options.currentSessionKey);
  return {
    version: DECK_VERSION,
    rows: DECK_ROWS,
    columns: DECK_COLUMNS,
    focusedSessionKey: currentSessionKey,
    tiles: [createRotatingTile('tile-1', 1, FULL_GEOMETRY, currentSessionKey)]
  };
}

// deck 필드가 없는 기존 작업공간을 전체 크기 순환1 타일 하나로 읽는다.
function migrateLegacyDeck(state = {}) {
  const sessionKeys = (Array.isArray(state.tabs) ? state.tabs : [])
    .map((tab) => normalizeSessionKey(tab?.key))
    .filter(Boolean);
  const activeIndex = Number.isInteger(state.activeTabIndex)
    ? Math.min(Math.max(state.activeTabIndex, 0), Math.max(sessionKeys.length - 1, 0))
    : 0;
  return createDefaultDeck({
    currentSessionKey: sessionKeys[activeIndex] || sessionKeys[0] || null
  });
}

function visibleSessionKeys(deck) {
  const keys = [];
  for (const tile of deck?.tiles || []) {
    const key = tile.kind === 'pinned' ? tile.sessionKey : tile.currentSessionKey;
    if (key) {
      keys.push(key);
    }
  }
  return keys;
}

function findTileForSession(deck, sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) {
    return null;
  }

  return (deck?.tiles || []).find((tile) =>
    (tile.kind === 'pinned' ? tile.sessionKey : tile.currentSessionKey) === key)
    || null;
}

function collectValidTileIds(rawTiles) {
  const ids = new Set();
  for (const raw of rawTiles) {
    const id = normalizeTileId(raw?.id);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

// 저장된 deck을 §5.3 정규화 규칙에 맞춘다. 반환값의 warnings는 호출부에서 로그로 남긴다.
function normalizeDeck(value, options = {}) {
  const sessionKeys = (Array.isArray(options.sessionKeys)
    ? options.sessionKeys
    : [])
    .map(normalizeSessionKey)
    .filter(Boolean);
  const knownSessionKeys = new Set(sessionKeys);
  const warnings = [];

  const rawTiles = Array.isArray(value?.tiles)
    ? value.tiles.slice(0, MAX_TILES)
    : [];
  if (Array.isArray(value?.tiles) && value.tiles.length > MAX_TILES) {
    warnings.push(`타일이 ${MAX_TILES}개를 넘어 뒤쪽 타일을 제외했습니다.`);
  }

  const allocateTileId = createTileIdAllocator(collectValidTileIds(rawTiles));
  const usedTileIds = new Set();
  const pinnedSessionKeys = new Set();
  const usedRotationIndexes = new Set();
  const tiles = [];
  const pendingRotating = [];

  for (const raw of rawTiles) {
    if (!isPlainObject(raw)) {
      warnings.push('타일 형식이 올바르지 않아 제외했습니다.');
      continue;
    }

    const geometry = normalizeGeometry(raw);
    if (!geometry) {
      warnings.push('4×4 격자를 벗어난 타일을 제외했습니다.');
      continue;
    }

    // kind는 반드시 pinned 또는 rotating이어야 한다. 알 수 없는 값을 순환 타일로
    // 암묵 변환하면 의도하지 않은 세션 교체가 생기므로 타일을 제외한다.
    if (!TILE_KINDS.includes(raw.kind)) {
      warnings.push(
        `타일 종류 ${describeTileKind(raw.kind)}를 알 수 없어 제외했습니다.`
      );
      continue;
    }

    const declaredId = normalizeTileId(raw.id);
    const id = declaredId && !usedTileIds.has(declaredId)
      ? declaredId
      : allocateTileId();
    if (id !== declaredId) {
      warnings.push(
        declaredId
          ? `중복된 타일 id ${declaredId}를 ${id}로 바꿨습니다.`
          : `타일 id가 없어 ${id}를 부여했습니다.`
      );
    }
    usedTileIds.add(id);

    if (raw.kind === 'pinned') {
      const sessionKey = normalizeSessionKey(raw.sessionKey);
      if (!sessionKey || !knownSessionKeys.has(sessionKey)) {
        warnings.push('존재하지 않는 세션을 참조하는 고정 타일을 제거했습니다.');
        continue;
      }
      if (pinnedSessionKeys.has(sessionKey)) {
        warnings.push('한 세션을 두 고정 타일에 배치할 수 없어 뒤쪽 타일을 제거했습니다.');
        continue;
      }
      pinnedSessionKeys.add(sessionKey);
      tiles.push(createPinnedTile(id, sessionKey, geometry));
      continue;
    }

    const rotationIndex = normalizeRotationSlot(raw.rotationIndex);
    if (rotationIndex !== null && usedRotationIndexes.has(rotationIndex)) {
      warnings.push(`순환 번호 ${rotationIndex}가 중복되어 뒤쪽 타일을 제거했습니다.`);
      continue;
    }
    if (rotationIndex !== null) {
      usedRotationIndexes.add(rotationIndex);
    }
    const tile = createRotatingTile(id, rotationIndex, geometry, null);
    pendingRotating.push({ tile, raw });
    tiles.push(tile);
  }

  // 순환 번호와 표시 세션은 고정 타일이 모두 확정된 뒤에 결정한다.
  const displayedSessionKeys = new Set(pinnedSessionKeys);
  for (const { tile, raw } of pendingRotating) {
    if (tile.rotationIndex === null) {
      tile.rotationIndex = lowestFreeRotationIndex(usedRotationIndexes);
      usedRotationIndexes.add(tile.rotationIndex);
      warnings.push(
        `순환 번호가 없는 타일에 순환 ${tile.rotationIndex}을 부여했습니다.`
      );
    }

    const currentSessionKey = normalizeSessionKey(raw.currentSessionKey);
    if (!currentSessionKey) {
      continue;
    }
    if (!knownSessionKeys.has(currentSessionKey)) {
      warnings.push('존재하지 않는 세션을 가리키는 표시 세션을 비웠습니다.');
      continue;
    }
    if (displayedSessionKeys.has(currentSessionKey)) {
      warnings.push('한 세션이 두 타일에 표시될 수 없어 순환 타일을 비웠습니다.');
      continue;
    }
    tile.currentSessionKey = currentSessionKey;
    displayedSessionKeys.add(currentSessionKey);
  }

  const overlap = findOverlappingPair(tiles);
  if (overlap) {
    warnings.push(
      `타일 ${overlap[0].id}와 ${overlap[1].id}가 겹쳐 기본 배치로 되돌렸습니다.`
    );
    return {
      deck: createDefaultDeck({ currentSessionKey: sessionKeys[0] || null }),
      warnings
    };
  }

  if (!tiles.some((tile) => tile.kind === 'rotating')) {
    const geometry = findFreeRectangle(tiles, {
      rowSpan: DECK_ROWS,
      columnSpan: DECK_COLUMNS
    });
    if (!geometry) {
      warnings.push('순환 타일을 놓을 빈 공간이 없어 기본 배치로 되돌렸습니다.');
      return {
        deck: createDefaultDeck({ currentSessionKey: sessionKeys[0] || null }),
        warnings
      };
    }
    const rotationIndex = lowestFreeRotationIndex(usedRotationIndexes);
    warnings.push(`순환 타일이 없어 순환 ${rotationIndex} 타일을 만들었습니다.`);
    tiles.push(
      createRotatingTile(allocateTileId(), rotationIndex, geometry, null)
    );
  }

  const visible = new Set(visibleSessionKeys({ tiles }));
  let focusedSessionKey = normalizeSessionKey(value?.focusedSessionKey);
  if (!focusedSessionKey || !visible.has(focusedSessionKey)) {
    focusedSessionKey = sessionKeys.find((key) => visible.has(key)) || null;
  }

  return {
    deck: {
      version: DECK_VERSION,
      rows: DECK_ROWS,
      columns: DECK_COLUMNS,
      focusedSessionKey,
      tiles
    },
    warnings
  };
}

// 고정된 세션은 순환 번호를 갖지 않고, 순환 세션은 실제로 존재하는 순환 번호만 갖는다.
function applyRotationSlots(tabs, deck) {
  const indexes = rotationIndexes(deck);
  const lowestRotationIndex = indexes[0] || 1;
  const availableIndexes = new Set(indexes);
  const pinnedSessionKeys = new Set(
    deck.tiles
      .filter((tile) => tile.kind === 'pinned')
      .map((tile) => tile.sessionKey)
  );
  const slotByDisplayedSessionKey = new Map(
    deck.tiles
      .filter((tile) => tile.kind === 'rotating' && tile.currentSessionKey)
      .map((tile) => [tile.currentSessionKey, tile.rotationIndex])
  );

  return tabs.map((tab) => {
    const key = normalizeSessionKey(tab?.key);
    if (key && pinnedSessionKeys.has(key)) {
      return { ...tab, rotationSlot: null };
    }
    if (key && slotByDisplayedSessionKey.has(key)) {
      return { ...tab, rotationSlot: slotByDisplayedSessionKey.get(key) };
    }

    const slot = normalizeRotationSlot(tab?.rotationSlot);
    return {
      ...tab,
      rotationSlot: slot !== null && availableIndexes.has(slot)
        ? slot
        : lowestRotationIndex
    };
  });
}

// 저장 상태(tabs + deck)를 함께 정규화한다. deck이 없으면 기존 단일 활성 탭으로 마이그레이션한다.
function resolveDeckState(state = {}) {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const sessionKeys = tabs
    .map((tab) => normalizeSessionKey(tab?.key))
    .filter(Boolean);
  const source = isPlainObject(state.deck)
    ? state.deck
    : migrateLegacyDeck({ tabs, activeTabIndex: state.activeTabIndex });
  const { deck, warnings } = normalizeDeck(source, { sessionKeys });

  return {
    tabs: applyRotationSlots(tabs, deck),
    deck,
    warnings
  };
}

module.exports = {
  DECK_COLUMNS,
  DECK_ROWS,
  DECK_VERSION,
  DEFAULT_TILE_COLUMN_SPAN,
  DEFAULT_TILE_ROW_SPAN,
  MAX_ROTATION_INDEX,
  MAX_TILES,
  MAX_TILE_ID_LENGTH,
  TILE_KINDS,
  applyRotationSlots,
  createDefaultDeck,
  findFreeRectangle,
  findFreeRectangleAt,
  findTileForSession,
  lowestFreeRotationIndex,
  migrateLegacyDeck,
  nextTileId,
  normalizeDeck,
  normalizeRotationSlot,
  resolveDeckState,
  rotationIndexes,
  tileWithinBounds,
  tilesOverlap,
  visibleSessionKeys
};
