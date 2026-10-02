const {
  DECK_COLUMNS,
  DECK_ROWS,
  MAX_ROTATION_INDEX,
  MAX_TILES,
  MAX_TILE_ID_LENGTH,
  findFreeRectangle,
  findFreeRectangleAt,
  lowestFreeRotationIndex,
  nextTileId,
  normalizeRotationSlot,
  rotationIndexes,
  tileWithinBounds,
  tilesOverlap
} = require('./deck-layout');
const { displayedSessionKey } = require('./deck-session');

// 배치 편집 전이를 다루는 순수 모듈. DOM, xterm, PTY를 참조하지 않는다.
//
// 편집 중에는 normalizeDeck을 쓰지 않는다. 잘못된 배치를 정규화로 "고쳐서"
// 기본 배치로 폴백시키면 사용자의 편집 의도가 사라지기 때문이다. 대신 모든 전이를
// 사전에 엄격히 검증하고, 실패하면 원본을 그대로 돌려준다.
//
// 성공: { ok: true, deck, tabs, warnings }
// 실패: { ok: false, reason, deck: 원본, tabs: 원본 }

const DEFAULT_TILE_SPAN = { rowSpan: 2, columnSpan: 2 };

function cloneTile(tile) {
  return { ...tile };
}

function cloneDeck(deck) {
  return {
    ...deck,
    tiles: (deck?.tiles || []).map(cloneTile)
  };
}

function cloneTabs(tabs) {
  return (tabs || []).map((tab) => ({ ...tab }));
}

function failure(draft, reason) {
  return {
    ok: false,
    reason,
    deck: draft.deck,
    tabs: draft.tabs
  };
}

function success(deck, tabs, warnings = []) {
  return { ok: true, deck, tabs, warnings };
}

function rotatingTiles(deck) {
  return deck.tiles.filter((tile) => tile.kind === 'rotating');
}

function pinnedTiles(deck) {
  return deck.tiles.filter((tile) => tile.kind === 'pinned');
}

function usedRotationIndexes(deck) {
  return rotatingTiles(deck).map((tile) => tile.rotationIndex);
}

function lowestExistingRotationIndex(deck) {
  return rotationIndexes(deck)[0] || null;
}

function visibleSessionKeySet(deck) {
  return new Set(
    deck.tiles
      .map((tile) => displayedSessionKey(deck, tile.id))
      .filter(Boolean)
  );
}

function sessionKeysOf(tabs) {
  return tabs.map((tab) => tab.key).filter(Boolean);
}

function withTab(tabs, sessionKey, changes) {
  return tabs.map((tab) =>
    tab.key === sessionKey ? { ...tab, ...changes } : tab);
}

// 순환 번호가 사라졌을 때, 그 번호를 쓰던 세션을 남은 가장 낮은 번호로 내린다.
// 고정된 세션은 순환 번호를 갖지 않는다.
function reassignRotationSlots(deck, tabs) {
  const available = rotationIndexes(deck);
  const lowest = available[0] || null;
  const pinnedKeys = new Set(pinnedTiles(deck).map((tile) => tile.sessionKey));

  return tabs.map((tab) => {
    if (pinnedKeys.has(tab.key)) {
      return tab.rotationSlot === null ? tab : { ...tab, rotationSlot: null };
    }

    const slot = normalizeRotationSlot(tab.rotationSlot);
    if (slot !== null && available.includes(slot)) {
      return tab;
    }
    return { ...tab, rotationSlot: lowest };
  });
}

// 포커스 세션은 반드시 표시 중이어야 한다. 표시 세션이 하나도 없는데 세션은
// 있으면 가장 낮은 순환 타일에 되살린다.
function repairFocus(deck, tabs) {
  const next = cloneDeck(deck);
  const visible = visibleSessionKeySet(next);
  const sessionKeys = sessionKeysOf(tabs);

  if (next.focusedSessionKey && visible.has(next.focusedSessionKey)) {
    return next;
  }

  if (visible.size > 0) {
    // deck tile 순서에서 첫 표시 세션으로 옮긴다.
    const firstVisible = next.tiles
      .map((tile) => displayedSessionKey(next, tile.id))
      .find(Boolean);
    next.focusedSessionKey = firstVisible || null;
    return next;
  }

  if (sessionKeys.length === 0) {
    next.focusedSessionKey = null;
    return next;
  }

  const target = rotatingTiles(next)
    .slice()
    .sort((left, right) => left.rotationIndex - right.rotationIndex)[0];
  if (!target) {
    next.focusedSessionKey = null;
    return next;
  }

  const revived = sessionKeys.includes(next.focusedSessionKey)
    ? next.focusedSessionKey
    : sessionKeys[0];
  target.currentSessionKey = revived;
  next.focusedSessionKey = revived;
  return next;
}

function finishTransition(deck, tabs, warnings = []) {
  const nextTabs = reassignRotationSlots(deck, tabs);
  return success(repairFocus(deck, nextTabs), nextTabs, warnings);
}

function beginDeckEdit(deck, tabs) {
  const draftDeck = cloneDeck(deck);
  const draftTabs = cloneTabs(tabs);
  return {
    deck: draftDeck,
    tabs: draftTabs,
    snapshot: {
      deck: cloneDeck(deck),
      tabs: cloneTabs(tabs)
    }
  };
}

function cancelDeckEdit(draft) {
  return {
    ok: true,
    deck: cloneDeck(draft.snapshot.deck),
    tabs: cloneTabs(draft.snapshot.tabs),
    warnings: []
  };
}

function normalizeGeometryInput(value) {
  const geometry = {
    row: value?.row,
    column: value?.column,
    rowSpan: value?.rowSpan,
    columnSpan: value?.columnSpan
  };
  const isInteger = Object.values(geometry).every(Number.isInteger);
  return isInteger ? geometry : null;
}

// 이동과 resize가 같은 검증을 쓰도록 한 곳에 모은다.
function applyGeometry(draft, tileId, geometry) {
  const tile = draft.deck.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return failure(draft, '타일을 찾을 수 없습니다.');
  }

  const next = normalizeGeometryInput(geometry);
  if (!next) {
    return failure(draft, '타일 위치와 크기는 정수여야 합니다.');
  }
  if (next.rowSpan < 1 || next.columnSpan < 1) {
    return failure(draft, '타일은 최소 1×1이어야 합니다.');
  }
  if (!tileWithinBounds(next)) {
    return failure(draft, `${DECK_ROWS}×${DECK_COLUMNS} 격자를 벗어납니다.`);
  }

  const collision = draft.deck.tiles.find((item) =>
    item.id !== tileId && tilesOverlap(next, item));
  if (collision) {
    return failure(draft, '다른 타일과 겹칩니다.');
  }

  const deck = cloneDeck(draft.deck);
  const target = deck.tiles.find((item) => item.id === tileId);
  target.row = next.row;
  target.column = next.column;
  target.rowSpan = next.rowSpan;
  target.columnSpan = next.columnSpan;
  return finishTransition(deck, draft.tabs);
}

function moveTile(draft, tileId, geometry) {
  const tile = draft.deck.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return failure(draft, '타일을 찾을 수 없습니다.');
  }

  // 이동은 크기를 유지한다.
  return applyGeometry(draft, tileId, {
    row: geometry?.row,
    column: geometry?.column,
    rowSpan: tile.rowSpan,
    columnSpan: tile.columnSpan
  });
}

function resizeTile(draft, tileId, geometry) {
  const tile = draft.deck.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return failure(draft, '타일을 찾을 수 없습니다.');
  }

  // resize는 시작 row/column을 고정한다.
  return applyGeometry(draft, tileId, {
    row: tile.row,
    column: tile.column,
    rowSpan: geometry?.rowSpan,
    columnSpan: geometry?.columnSpan
  });
}

// 클릭한 빈 cell을 포함하는 자리를 찾는다. 기존 타일은 절대 밀어내지 않는다.
function placementFor(deck, options) {
  const preferred = {
    rowSpan: options?.rowSpan || DEFAULT_TILE_SPAN.rowSpan,
    columnSpan: options?.columnSpan || DEFAULT_TILE_SPAN.columnSpan
  };
  if (Number.isInteger(options?.row) && Number.isInteger(options?.column)) {
    return findFreeRectangleAt(
      deck.tiles,
      options.row,
      options.column,
      preferred
    );
  }
  return findFreeRectangle(deck.tiles, preferred);
}

function addRotatingTile(draft, options = {}) {
  if (draft.deck.tiles.length >= MAX_TILES) {
    return failure(draft, `타일은 최대 ${MAX_TILES}개까지 만들 수 있습니다.`);
  }

  const geometry = placementFor(draft.deck, options);
  if (!geometry) {
    return failure(draft, '타일을 놓을 빈 공간이 없습니다.');
  }

  const deck = cloneDeck(draft.deck);
  deck.tiles.push({
    id: nextTileId(deck.tiles),
    kind: 'rotating',
    rotationIndex: lowestFreeRotationIndex(usedRotationIndexes(deck)),
    currentSessionKey: null,
    ...geometry
  });
  return finishTransition(deck, draft.tabs);
}

function addPinnedTile(draft, sessionKey, options = {}) {
  if (!sessionKey || !sessionKeysOf(draft.tabs).includes(sessionKey)) {
    return failure(draft, '고정할 세션을 선택하세요.');
  }
  if (pinnedTiles(draft.deck).some((tile) => tile.sessionKey === sessionKey)) {
    return failure(draft, '이미 고정된 세션입니다.');
  }
  if (draft.deck.tiles.length >= MAX_TILES) {
    return failure(draft, `타일은 최대 ${MAX_TILES}개까지 만들 수 있습니다.`);
  }

  const geometry = placementFor(draft.deck, options);
  if (!geometry) {
    return failure(draft, '타일을 놓을 빈 공간이 없습니다.');
  }

  const deck = cloneDeck(draft.deck);
  // 같은 세션이 순환 타일에 표시 중이면 중복 표시를 막기 위해 회수한다.
  for (const tile of deck.tiles) {
    if (tile.kind === 'rotating' && tile.currentSessionKey === sessionKey) {
      tile.currentSessionKey = null;
    }
  }
  deck.tiles.push({
    id: nextTileId(deck.tiles),
    kind: 'pinned',
    sessionKey,
    ...geometry
  });
  return finishTransition(deck, withTab(draft.tabs, sessionKey, {
    rotationSlot: null
  }));
}

// 왼쪽 terminal 목록에서 기존 타일을 직접 골라 배치한다. 고정 타일은 비어
// 있을 수 없으므로 고정↔고정, 고정↔순환 이동은 현재 표시 terminal과 교환한다.
function assignSessionToTile(draft, sessionKey, tileId) {
  if (!sessionKey || !sessionKeysOf(draft.tabs).includes(sessionKey)) {
    return failure(draft, '배치할 terminal을 찾을 수 없습니다.');
  }

  const requestedTarget = draft.deck.tiles.find((tile) => tile.id === tileId);
  if (!requestedTarget) {
    return failure(draft, '배치할 타일을 찾을 수 없습니다.');
  }

  const deck = cloneDeck(draft.deck);
  const target = deck.tiles.find((tile) => tile.id === tileId);
  const sourcePinned = pinnedTiles(deck)
    .find((tile) => tile.sessionKey === sessionKey) || null;
  const sourceTab = draft.tabs.find((tab) => tab.key === sessionKey);
  const sourceRotation = normalizeRotationSlot(sourceTab?.rotationSlot)
    || lowestExistingRotationIndex(deck);
  let tabs = cloneTabs(draft.tabs);

  if (target.kind === 'pinned') {
    if (target.sessionKey === sessionKey) {
      deck.focusedSessionKey = sessionKey;
      return finishTransition(deck, tabs);
    }

    const displacedKey = target.sessionKey;
    if (sourcePinned) {
      sourcePinned.sessionKey = displacedKey;
      target.sessionKey = sessionKey;
    } else {
      target.sessionKey = sessionKey;
      for (const tile of rotatingTiles(deck)) {
        if (tile.currentSessionKey === sessionKey) {
          tile.currentSessionKey = displacedKey;
        }
      }
      tabs = withTab(tabs, displacedKey, { rotationSlot: sourceRotation });
    }
    tabs = withTab(tabs, sessionKey, { rotationSlot: null });
  } else {
    if (sourcePinned) {
      const displacedKey = target.currentSessionKey;
      if (!displacedKey) {
        return failure(
          draft,
          '빈 순환 칸으로 옮기려면 먼저 그 칸에 다른 terminal을 표시하세요.'
        );
      }
      sourcePinned.sessionKey = displacedKey;
      tabs = withTab(tabs, displacedKey, { rotationSlot: null });
    }

    for (const tile of rotatingTiles(deck)) {
      if (tile.currentSessionKey === sessionKey) {
        tile.currentSessionKey = null;
      }
    }
    target.currentSessionKey = sessionKey;
    tabs = withTab(tabs, sessionKey, { rotationSlot: target.rotationIndex });
  }

  deck.focusedSessionKey = sessionKey;
  return finishTransition(deck, tabs);
}

function convertTileToPinned(draft, tileId) {
  const tile = draft.deck.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return failure(draft, '타일을 찾을 수 없습니다.');
  }
  if (tile.kind !== 'rotating') {
    return failure(draft, '순환 타일만 고정으로 바꿀 수 있습니다.');
  }
  if (!tile.currentSessionKey) {
    return failure(
      draft,
      '표시 중인 세션이 없는 순환 타일은 고정할 수 없습니다.'
    );
  }

  const deck = cloneDeck(draft.deck);
  const target = deck.tiles.find((item) => item.id === tileId);
  const sessionKey = target.currentSessionKey;
  const warnings = [];

  // 마지막 순환 타일을 고정으로 바꾸면 순환 타일이 0개가 된다.
  // 대체 순환 타일을 놓을 자리가 있을 때만 허용한다.
  const isLastRotating = rotatingTiles(deck).length === 1;
  let replacement = null;
  if (isLastRotating) {
    // 변환되는 타일은 같은 자리에 그대로 남으므로 모든 타일을 기준으로 빈 자리를 찾는다.
    const geometry = findFreeRectangle(deck.tiles, DEFAULT_TILE_SPAN);
    if (!geometry) {
      return failure(
        draft,
        '마지막 순환 타일을 고정하려면 새 순환 타일을 놓을 공간이 필요합니다.'
      );
    }
    replacement = geometry;
  }

  target.kind = 'pinned';
  target.sessionKey = sessionKey;
  delete target.rotationIndex;
  delete target.currentSessionKey;

  if (replacement) {
    deck.tiles.push({
      id: nextTileId(deck.tiles),
      kind: 'rotating',
      rotationIndex: lowestFreeRotationIndex(usedRotationIndexes(deck)),
      currentSessionKey: null,
      ...replacement
    });
    warnings.push('순환 타일이 없어져 새 순환 타일을 만들었습니다.');
  }

  return finishTransition(
    deck,
    withTab(draft.tabs, sessionKey, { rotationSlot: null }),
    warnings
  );
}

function convertTileToRotating(draft, tileId) {
  const tile = draft.deck.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return failure(draft, '타일을 찾을 수 없습니다.');
  }
  if (tile.kind !== 'pinned') {
    return failure(draft, '고정 타일만 순환으로 바꿀 수 있습니다.');
  }

  const deck = cloneDeck(draft.deck);
  const target = deck.tiles.find((item) => item.id === tileId);
  const sessionKey = target.sessionKey;
  const rotationIndex = lowestFreeRotationIndex(usedRotationIndexes(deck));

  target.kind = 'rotating';
  target.rotationIndex = rotationIndex;
  target.currentSessionKey = sessionKey;
  delete target.sessionKey;

  // 같은 세션이 다른 타일에 남아 있으면 중복 표시가 되므로 정리한다.
  for (const item of deck.tiles) {
    if (
      item.id !== tileId
      && item.kind === 'rotating'
      && item.currentSessionKey === sessionKey
    ) {
      item.currentSessionKey = null;
    }
  }

  return finishTransition(
    deck,
    withTab(draft.tabs, sessionKey, { rotationSlot: rotationIndex })
  );
}

// 타일만 없앤다. 세션과 PTY는 그대로 두고 숨은 순환 세션으로 남긴다.
function removeTileFromDeck(draft, tileId) {
  const tile = draft.deck.tiles.find((item) => item.id === tileId);
  if (!tile) {
    return failure(draft, '타일을 찾을 수 없습니다.');
  }
  if (tile.kind === 'rotating' && rotatingTiles(draft.deck).length === 1) {
    return failure(draft, '마지막 순환 타일은 제거할 수 없습니다.');
  }

  const deck = cloneDeck(draft.deck);
  deck.tiles = deck.tiles.filter((item) => item.id !== tileId);

  // 제거된 타일이 보여주던 세션은 표시에서만 빠진다.
  let tabs = draft.tabs;
  if (tile.kind === 'pinned') {
    tabs = withTab(tabs, tile.sessionKey, {
      rotationSlot: lowestExistingRotationIndex(deck)
    });
  }

  return finishTransition(deck, tabs);
}

// 완료 직전 전체 검증(§12). 실패 이유를 그대로 사용자에게 보여준다.
function validateDeckEdit(draft) {
  const deck = draft.deck;
  const tabs = draft.tabs;
  const sessionKeys = new Set(sessionKeysOf(tabs));
  const errors = [];

  if (deck.rows !== DECK_ROWS || deck.columns !== DECK_COLUMNS) {
    errors.push(`격자는 ${DECK_ROWS}×${DECK_COLUMNS}이어야 합니다.`);
  }
  if (deck.tiles.length > MAX_TILES) {
    errors.push(`타일은 최대 ${MAX_TILES}개까지 만들 수 있습니다.`);
  }

  const seenIds = new Set();
  const seenPinned = new Set();
  const seenRotation = new Set();
  const shown = new Set();

  for (const tile of deck.tiles) {
    if (!tileWithinBounds(tile)) {
      errors.push(`타일 ${tile.id}이(가) 격자를 벗어났습니다.`);
    }
    if (
      typeof tile.id !== 'string'
      || tile.id.length === 0
      || tile.id.length > MAX_TILE_ID_LENGTH
    ) {
      errors.push('타일 id가 올바르지 않습니다.');
    }
    if (seenIds.has(tile.id)) {
      errors.push(`타일 id ${tile.id}이(가) 중복입니다.`);
    }
    seenIds.add(tile.id);

    if (tile.kind === 'pinned') {
      if (!tile.sessionKey || !sessionKeys.has(tile.sessionKey)) {
        errors.push(`고정 타일 ${tile.id}이(가) 없는 세션을 가리킵니다.`);
      } else if (seenPinned.has(tile.sessionKey)) {
        errors.push('한 세션을 두 고정 타일에 배치할 수 없습니다.');
      }
      seenPinned.add(tile.sessionKey);
    } else if (tile.kind === 'rotating') {
      // 정규화(resolveDeckState)와 같은 상한을 쓴다. 범위를 넘는 번호를 승인하면
      // 저장 후 정규화에서 값이 바뀌어 배치가 달라진다.
      if (
        !Number.isInteger(tile.rotationIndex)
        || tile.rotationIndex < 1
        || tile.rotationIndex > MAX_ROTATION_INDEX
      ) {
        errors.push(
          `순환 타일 ${tile.id}의 순환 번호는 1~${MAX_ROTATION_INDEX} 정수여야 합니다.`
        );
      } else if (seenRotation.has(tile.rotationIndex)) {
        errors.push(`순환 번호 ${tile.rotationIndex}이(가) 중복입니다.`);
      }
      seenRotation.add(tile.rotationIndex);
      if (tile.currentSessionKey && !sessionKeys.has(tile.currentSessionKey)) {
        errors.push(`순환 타일 ${tile.id}이(가) 없는 세션을 가리킵니다.`);
      }
    } else {
      errors.push(`타일 ${tile.id}의 종류를 알 수 없습니다.`);
    }

    const displayed = displayedSessionKey(deck, tile.id);
    if (displayed) {
      if (shown.has(displayed)) {
        errors.push('한 세션이 두 타일에 표시될 수 없습니다.');
      }
      shown.add(displayed);
    }
  }

  for (let index = 0; index < deck.tiles.length; index += 1) {
    for (let other = index + 1; other < deck.tiles.length; other += 1) {
      if (tilesOverlap(deck.tiles[index], deck.tiles[other])) {
        errors.push(
          `타일 ${deck.tiles[index].id}과(와) ${deck.tiles[other].id}이(가) 겹칩니다.`
        );
      }
    }
  }

  if (rotatingTiles(deck).length === 0) {
    errors.push('순환 타일이 최소 하나 있어야 합니다.');
  }

  const available = rotationIndexes(deck);
  for (const tab of tabs) {
    if (seenPinned.has(tab.key)) {
      if (tab.rotationSlot !== null && tab.rotationSlot !== undefined) {
        errors.push(`${tab.key}는 고정 세션이라 순환 번호를 가질 수 없습니다.`);
      }
    } else if (!available.includes(normalizeRotationSlot(tab.rotationSlot))) {
      errors.push(`${tab.key}의 순환 번호가 존재하지 않습니다.`);
    }
  }

  if (deck.focusedSessionKey) {
    if (!sessionKeys.has(deck.focusedSessionKey)) {
      errors.push('포커스 세션이 존재하지 않습니다.');
    } else if (!shown.has(deck.focusedSessionKey)) {
      errors.push('포커스 세션은 반드시 표시 중이어야 합니다.');
    }
  } else if (shown.size > 0) {
    errors.push('표시 세션이 있는데 포커스 세션이 없습니다.');
  }

  return errors.length === 0
    ? { ok: true, errors: [] }
    : { ok: false, reason: errors[0], errors };
}

function finalizeDeckEdit(draft) {
  const validation = validateDeckEdit(draft);
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.reason,
      errors: validation.errors,
      deck: draft.deck,
      tabs: draft.tabs
    };
  }

  return success(cloneDeck(draft.deck), cloneTabs(draft.tabs));
}

module.exports = {
  DEFAULT_TILE_SPAN,
  addPinnedTile,
  addRotatingTile,
  assignSessionToTile,
  beginDeckEdit,
  cancelDeckEdit,
  convertTileToPinned,
  convertTileToRotating,
  finalizeDeckEdit,
  moveTile,
  placementFor,
  removeTileFromDeck,
  resizeTile,
  validateDeckEdit
};
