const { normalizeRotationSlot, rotationIndexes } = require('./deck-layout');

// 세션 표시/포커스 전이를 순수 함수로 다룬다. DOM, xterm, PTY를 참조하지 않는다.
// 렌더러는 이 함수들의 반환값을 런타임 deck에 반영하기만 한다.

function cloneDeck(deck) {
  return {
    ...deck,
    tiles: (deck?.tiles || []).map((tile) => ({ ...tile }))
  };
}

function lowestRotationIndex(deck) {
  return rotationIndexes(deck)[0] || 1;
}

function pinnedTiles(deck) {
  return (deck?.tiles || []).filter((tile) => tile.kind === 'pinned');
}

function rotatingTiles(deck) {
  return (deck?.tiles || []).filter((tile) => tile.kind === 'rotating');
}

function pinnedTileFor(deck, sessionKey) {
  return pinnedTiles(deck).find((tile) => tile.sessionKey === sessionKey) || null;
}

// 세션이 표시될 순환 타일: 지정된 순환 번호의 타일, 없으면 가장 낮은 순환 타일.
function rotationTileFor(deck, rotationSlot) {
  const tiles = rotatingTiles(deck);
  const slot = normalizeRotationSlot(rotationSlot);
  return tiles.find((tile) => tile.rotationIndex === slot) || tiles[0] || null;
}

function tileForSession(deck, sessionKey, rotationSlot) {
  return pinnedTileFor(deck, sessionKey) || rotationTileFor(deck, rotationSlot);
}

function isSessionVisible(deck, sessionKey) {
  return (deck?.tiles || []).some((tile) =>
    (tile.kind === 'pinned' ? tile.sessionKey : tile.currentSessionKey)
      === sessionKey);
}

function displayedSessionKey(deck, tileId) {
  const tile = (deck?.tiles || []).find((item) => item.id === tileId);
  if (!tile) {
    return null;
  }
  return tile.kind === 'pinned' ? tile.sessionKey : tile.currentSessionKey;
}

// 고정 타일의 표시 번호(고정1, 고정2…). 타일 배열 순서를 그대로 쓴다.
function pinnedTileOrder(deck, tileId) {
  return pinnedTiles(deck).findIndex((tile) => tile.id === tileId) + 1;
}

function sessionPlacementLabel(deck, sessionKey, rotationSlot) {
  const pinnedIndex = pinnedTiles(deck)
    .findIndex((tile) => tile.sessionKey === sessionKey);
  if (pinnedIndex >= 0) {
    return `고정${pinnedIndex + 1}`;
  }

  const slot = normalizeRotationSlot(rotationSlot) || lowestRotationIndex(deck);
  return `순환${slot}`;
}

// 세션을 자기 타일에 표시하고 포커스한다.
// - 고정 세션: 어떤 타일도 교체하지 않고 포커스만 옮긴다.
// - 순환 세션: 지정된 순환 번호의 타일에서만 교체하고, 다른 타일에 남아 있던
//   같은 세션은 회수해 중복 표시를 막는다.
function displaySession(deck, sessionKey, rotationSlot) {
  const next = cloneDeck(deck);
  if (!sessionKey) {
    return next;
  }

  const pinned = pinnedTileFor(next, sessionKey);
  const target = pinned || rotationTileFor(next, rotationSlot);
  for (const tile of next.tiles) {
    if (
      tile.kind === 'rotating'
      && tile.currentSessionKey === sessionKey
      && tile.id !== target?.id
    ) {
      tile.currentSessionKey = null;
    }
  }

  if (target && target.kind === 'rotating') {
    target.currentSessionKey = sessionKey;
  }
  next.focusedSessionKey = sessionKey;
  return next;
}

// 세션 종료. 고정 타일은 함께 제거하고, 순환 타일은 빈 상태로 남긴다.
// PTY 종료와 무관한 순수 배치 변경이다.
function releaseSession(deck, sessionKey) {
  const next = cloneDeck(deck);
  next.tiles = next.tiles.filter((tile) =>
    !(tile.kind === 'pinned' && tile.sessionKey === sessionKey));
  for (const tile of next.tiles) {
    if (tile.kind === 'rotating' && tile.currentSessionKey === sessionKey) {
      tile.currentSessionKey = null;
    }
  }
  if (next.focusedSessionKey === sessionKey) {
    next.focusedSessionKey = null;
  }
  return next;
}

// 포커스 세션이 사라진 뒤 다음 포커스 후보. 목록 순서에서 다음, 없으면 이전.
function nextFocusKey(orderedSessionKeys, removedSessionKey) {
  const keys = Array.isArray(orderedSessionKeys) ? orderedSessionKeys : [];
  const index = keys.indexOf(removedSessionKey);
  if (index < 0) {
    return keys[0] || null;
  }
  return keys[index + 1] || keys[index - 1] || null;
}

// 복원 시 표시할 세션. 저장된 포커스 세션을 우선하고, 없으면 가장 낮은 순환
// 타일에 남아 있던 세션, 그다음 목록 순서의 첫 세션이다.
function restoreFocusKey(deck, orderedSessionKeys) {
  const keys = Array.isArray(orderedSessionKeys) ? orderedSessionKeys : [];
  if (deck?.focusedSessionKey && keys.includes(deck.focusedSessionKey)) {
    return deck.focusedSessionKey;
  }

  const currentKey = rotationTileFor(deck, null)?.currentSessionKey;
  if (currentKey && keys.includes(currentKey)) {
    return currentKey;
  }
  return keys[0] || null;
}

module.exports = {
  displaySession,
  displayedSessionKey,
  isSessionVisible,
  lowestRotationIndex,
  nextFocusKey,
  pinnedTileOrder,
  releaseSession,
  restoreFocusKey,
  rotationTileFor,
  sessionPlacementLabel,
  tileForSession
};
