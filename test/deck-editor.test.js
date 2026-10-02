const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDeckState } = require('../src/deck-layout');
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
  resizeTile,
  validateDeckEdit
} = require('../src/deck-editor');

// 고정 2 + 순환 2, 세션 5개(하나는 숨은 순환1 세션).
function mixedDeck() {
  return {
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'rot-c',
    tiles: [
      { id: 'p1', kind: 'pinned', sessionKey: 'pin-a', row: 0, column: 0, rowSpan: 2, columnSpan: 2 },
      { id: 'p2', kind: 'pinned', sessionKey: 'pin-b', row: 0, column: 2, rowSpan: 2, columnSpan: 2 },
      { id: 'r1', kind: 'rotating', rotationIndex: 1, currentSessionKey: 'rot-c', row: 2, column: 0, rowSpan: 2, columnSpan: 2 },
      { id: 'r2', kind: 'rotating', rotationIndex: 2, currentSessionKey: 'rot-d', row: 2, column: 2, rowSpan: 2, columnSpan: 2 }
    ]
  };
}

function mixedTabs() {
  return [
    { key: 'pin-a', name: 'A', rotationSlot: null },
    { key: 'pin-b', name: 'B', rotationSlot: null },
    { key: 'rot-c', name: 'C', rotationSlot: 1 },
    { key: 'rot-d', name: 'D', rotationSlot: 2 },
    { key: 'rot-e', name: 'E', rotationSlot: 1 }
  ];
}

function draft() {
  return beginDeckEdit(mixedDeck(), mixedTabs());
}

// 순환1 타일 하나만 있는 최소 배치.
function singleRotationDraft() {
  return beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'rot-c',
    tiles: [{
      id: 'r1',
      kind: 'rotating',
      rotationIndex: 1,
      currentSessionKey: 'rot-c',
      row: 0,
      column: 0,
      rowSpan: 2,
      columnSpan: 2
    }]
  }, [{ key: 'rot-c', name: 'C', rotationSlot: 1 }]);
}

function geometryOf(deck, tileId) {
  const tile = deck.tiles.find((item) => item.id === tileId);
  return `${tile.row},${tile.column},${tile.rowSpan},${tile.columnSpan}`;
}

test('타일 이동이 성공하면 크기는 유지되고 위치만 바뀐다', () => {
  const editing = draft();
  const moved = moveTile(editing, 'r1', { row: 2, column: 0 });
  assert.equal(moved.ok, true);
  assert.equal(geometryOf(moved.deck, 'r1'), '2,0,2,2');

  // 빈 자리로 옮기려면 먼저 다른 타일을 비워야 하므로 p1을 제거한 배치로 확인한다.
  const removed = removeTileFromDeck(editing, 'p1');
  const shifted = moveTile(
    { ...editing, deck: removed.deck, tabs: removed.tabs },
    'r1',
    { row: 0, column: 0 }
  );
  assert.equal(shifted.ok, true);
  assert.equal(geometryOf(shifted.deck, 'r1'), '0,0,2,2');
});

test('격자 밖 이동은 거부되고 원본이 그대로 반환된다', () => {
  const editing = draft();
  const before = JSON.stringify(editing.deck);
  const result = moveTile(editing, 'r1', { row: 3, column: 3 });

  assert.equal(result.ok, false);
  assert.match(result.reason, /격자/u);
  assert.equal(JSON.stringify(result.deck), before);
  assert.equal(JSON.stringify(editing.deck), before);
});

test('겹치는 이동은 거부되고 원본이 그대로 반환된다', () => {
  const editing = draft();
  const before = JSON.stringify(editing.deck);
  const result = moveTile(editing, 'r1', { row: 0, column: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, '다른 타일과 겹칩니다.');
  assert.equal(JSON.stringify(editing.deck), before);
});

test('resize는 시작 위치를 고정하고 크기만 바꾼다', () => {
  const editing = draft();
  const result = resizeTile(editing, 'r1', { rowSpan: 1, columnSpan: 1 });

  assert.equal(result.ok, true);
  assert.equal(geometryOf(result.deck, 'r1'), '2,0,1,1');
});

test('span 0 resize는 거부된다', () => {
  const editing = draft();
  for (const geometry of [
    { rowSpan: 0, columnSpan: 2 },
    { rowSpan: 2, columnSpan: 0 }
  ]) {
    const result = resizeTile(editing, 'r1', geometry);
    assert.equal(result.ok, false);
    assert.match(result.reason, /1×1/u);
  }
});

test('격자 밖 resize는 거부된다', () => {
  const editing = draft();
  const result = resizeTile(editing, 'r1', { rowSpan: 4, columnSpan: 2 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /격자/u);
});

test('겹치는 resize는 거부된다', () => {
  const editing = draft();
  const result = resizeTile(editing, 'r1', { rowSpan: 2, columnSpan: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, '다른 타일과 겹칩니다.');
});

test('빈 cell을 포함하는 2×2 자리를 찾아 타일을 추가한다', () => {
  // 순환1 타일만 (0,0)에 2×2로 있는 배치에서 (2,2)를 클릭한다.
  const editing = singleRotationDraft();
  const result = addRotatingTile(editing, { row: 2, column: 2 });

  assert.equal(result.ok, true);
  const added = result.deck.tiles.find((tile) => tile.id !== 'r1');
  assert.equal(`${added.rowSpan}×${added.columnSpan}`, '2×2');
  assert.equal(
    added.row <= 2 && 2 < added.row + added.rowSpan
    && added.column <= 2 && 2 < added.column + added.columnSpan,
    true,
    '클릭한 cell을 포함해야 합니다.'
  );
});

test('2×2가 불가능하면 클릭 cell을 포함하는 더 작은 자리를 쓴다', () => {
  const editing = beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: null,
    tiles: [
      { id: 'r1', kind: 'rotating', rotationIndex: 1, currentSessionKey: null, row: 0, column: 0, rowSpan: 4, columnSpan: 3 },
      { id: 'p1', kind: 'pinned', sessionKey: 'pin-a', row: 0, column: 3, rowSpan: 3, columnSpan: 1 }
    ]
  }, [{ key: 'pin-a', name: 'A', rotationSlot: null }]);

  // 남은 빈 cell은 (3,3) 하나뿐이다.
  const result = addRotatingTile(editing, { row: 3, column: 3 });
  assert.equal(result.ok, true);
  const added = result.deck.tiles.find((tile) => !['r1', 'p1'].includes(tile.id));
  assert.equal(`${added.row},${added.column},${added.rowSpan},${added.columnSpan}`,
    '3,3,1,1');
});

test('빈 공간이 없으면 타일 추가를 거부한다', () => {
  const editing = beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'rot-c',
    tiles: [{
      id: 'r1',
      kind: 'rotating',
      rotationIndex: 1,
      currentSessionKey: 'rot-c',
      row: 0,
      column: 0,
      rowSpan: 4,
      columnSpan: 4
    }]
  }, [{ key: 'rot-c', name: 'C', rotationSlot: 1 }]);

  const result = addRotatingTile(editing, { row: 0, column: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /빈 공간/u);
});

test('순환 타일 추가는 가장 낮은 빈 순환 번호를 쓰고 비어 있다', () => {
  const editing = singleRotationDraft();
  const first = addRotatingTile(editing, { row: 0, column: 2 });
  const second = addRotatingTile(
    { ...editing, deck: first.deck, tabs: first.tabs },
    { row: 2, column: 0 }
  );

  assert.equal(first.deck.tiles[1].rotationIndex, 2);
  assert.equal(first.deck.tiles[1].currentSessionKey, null);
  assert.equal(second.deck.tiles[2].rotationIndex, 3);
  assert.notEqual(second.deck.tiles[2].id, second.deck.tiles[1].id);
});

test('고정 타일 추가는 세션을 고정하고 순환 번호를 없앤다', () => {
  const editing = singleRotationDraft();
  const withSession = {
    ...editing,
    tabs: [...editing.tabs, { key: 'rot-e', name: 'E', rotationSlot: 1 }]
  };
  const result = addPinnedTile(withSession, 'rot-e', { row: 0, column: 2 });

  assert.equal(result.ok, true);
  const pinned = result.deck.tiles.find((tile) => tile.kind === 'pinned');
  assert.equal(pinned.sessionKey, 'rot-e');
  assert.equal(
    result.tabs.find((tab) => tab.key === 'rot-e').rotationSlot,
    null
  );
});

test('terminal을 다른 순환 칸에 지정하면 그 칸에 표시되고 번호가 바뀐다', () => {
  const result = assignSessionToTile(draft(), 'rot-c', 'r2');

  assert.equal(result.ok, true);
  assert.equal(
    result.deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    null
  );
  assert.equal(
    result.deck.tiles.find((tile) => tile.id === 'r2').currentSessionKey,
    'rot-c'
  );
  assert.equal(result.tabs.find((tab) => tab.key === 'rot-c').rotationSlot, 2);
  assert.equal(result.deck.focusedSessionKey, 'rot-c');
});

test('순환 terminal을 고정 칸에 지정하면 기존 terminal과 자리를 교환한다', () => {
  const result = assignSessionToTile(draft(), 'rot-c', 'p2');

  assert.equal(result.ok, true);
  assert.equal(result.deck.tiles.find((tile) => tile.id === 'p2').sessionKey, 'rot-c');
  assert.equal(result.deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey, 'pin-b');
  assert.equal(result.tabs.find((tab) => tab.key === 'rot-c').rotationSlot, null);
  assert.equal(result.tabs.find((tab) => tab.key === 'pin-b').rotationSlot, 1);
});

test('고정 terminal끼리 지정하면 두 고정 칸의 terminal을 교환한다', () => {
  const result = assignSessionToTile(draft(), 'pin-a', 'p2');

  assert.equal(result.ok, true);
  assert.equal(result.deck.tiles.find((tile) => tile.id === 'p1').sessionKey, 'pin-b');
  assert.equal(result.deck.tiles.find((tile) => tile.id === 'p2').sessionKey, 'pin-a');
  assert.equal(result.tabs.find((tab) => tab.key === 'pin-a').rotationSlot, null);
  assert.equal(result.tabs.find((tab) => tab.key === 'pin-b').rotationSlot, null);
});

test('고정 terminal을 순환 칸에 지정하면 표시 terminal과 자리를 교환한다', () => {
  const result = assignSessionToTile(draft(), 'pin-a', 'r2');

  assert.equal(result.ok, true);
  assert.equal(result.deck.tiles.find((tile) => tile.id === 'p1').sessionKey, 'rot-d');
  assert.equal(result.deck.tiles.find((tile) => tile.id === 'r2').currentSessionKey, 'pin-a');
  assert.equal(result.tabs.find((tab) => tab.key === 'pin-a').rotationSlot, 2);
  assert.equal(result.tabs.find((tab) => tab.key === 'rot-d').rotationSlot, null);
});

test('이미 고정된 세션은 다시 고정할 수 없다', () => {
  const editing = draft();
  const result = addPinnedTile(editing, 'pin-a', { row: 0, column: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, '이미 고정된 세션입니다.');
});

test('없는 세션은 고정할 수 없다', () => {
  const editing = draft();
  const result = addPinnedTile(editing, 'nope', { row: 0, column: 0 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /세션을 선택/u);
});

test('고정 추가는 순환 타일의 중복 표시를 제거한다', () => {
  const editing = singleRotationDraft();
  // rot-c는 r1에 표시 중이다. 이 세션을 고정하면 r1에서 회수돼야 한다.
  const result = addPinnedTile(editing, 'rot-c', { row: 0, column: 2 });

  assert.equal(result.ok, true);
  assert.equal(
    result.deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    null
  );
  const shown = result.deck.tiles
    .map((tile) => tile.sessionKey || tile.currentSessionKey)
    .filter(Boolean);
  assert.deepEqual(shown, ['rot-c']);
  assert.equal(result.deck.focusedSessionKey, 'rot-c');
});

test('표시 세션이 없는 순환 타일은 고정으로 바꿀 수 없다', () => {
  const editing = draft();
  const emptied = removeTileFromDeck(editing, 'p1');
  const withEmptyRotation = addRotatingTile(
    { ...editing, deck: emptied.deck, tabs: emptied.tabs },
    { row: 0, column: 0 }
  );
  const emptyTile = withEmptyRotation.deck.tiles
    .find((tile) => tile.kind === 'rotating' && !tile.currentSessionKey);

  const result = convertTileToPinned({
    ...editing,
    deck: withEmptyRotation.deck,
    tabs: withEmptyRotation.tabs
  }, emptyTile.id);
  assert.equal(result.ok, false);
  assert.equal(
    result.reason,
    '표시 중인 세션이 없는 순환 타일은 고정할 수 없습니다.'
  );
});

test('순환 → 고정 변환은 id와 기하를 유지한다', () => {
  const editing = draft();
  const result = convertTileToPinned(editing, 'r1');

  assert.equal(result.ok, true);
  const tile = result.deck.tiles.find((item) => item.id === 'r1');
  assert.equal(tile.kind, 'pinned');
  assert.equal(tile.sessionKey, 'rot-c');
  assert.equal('rotationIndex' in tile, false);
  assert.equal('currentSessionKey' in tile, false);
  assert.equal(geometryOf(result.deck, 'r1'), '2,0,2,2');
  assert.equal(result.tabs.find((tab) => tab.key === 'rot-c').rotationSlot, null);
  // 순환1을 쓰던 rot-e는 남은 가장 낮은 번호(2)로 내려간다.
  assert.equal(result.tabs.find((tab) => tab.key === 'rot-e').rotationSlot, 2);
});

test('마지막 순환 타일을 고정하면 대체 순환 타일이 생긴다', () => {
  const editing = singleRotationDraft();
  const result = convertTileToPinned(editing, 'r1');

  assert.equal(result.ok, true);
  const rotating = result.deck.tiles.filter((tile) => tile.kind === 'rotating');
  assert.equal(rotating.length, 1);
  assert.equal(rotating[0].rotationIndex, 1);
  assert.equal(rotating[0].currentSessionKey, null);
  assert.notEqual(rotating[0].id, 'r1');
  assert.equal(result.warnings.length, 1);
});

test('대체 순환 타일 공간이 없으면 마지막 순환 고정을 전체 거부한다', () => {
  const editing = beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'rot-c',
    tiles: [{
      id: 'r1',
      kind: 'rotating',
      rotationIndex: 1,
      currentSessionKey: 'rot-c',
      row: 0,
      column: 0,
      rowSpan: 4,
      columnSpan: 4
    }]
  }, [{ key: 'rot-c', name: 'C', rotationSlot: 1 }]);
  const before = JSON.stringify(editing.deck);

  const result = convertTileToPinned(editing, 'r1');
  assert.equal(result.ok, false);
  assert.match(result.reason, /새 순환 타일을 놓을 공간/u);
  assert.equal(JSON.stringify(result.deck), before);
  assert.equal(result.deck.tiles[0].kind, 'rotating');
});

test('고정 → 순환 변환은 가장 낮은 빈 순환 번호를 받는다', () => {
  const editing = draft();
  const result = convertTileToRotating(editing, 'p1');

  assert.equal(result.ok, true);
  const tile = result.deck.tiles.find((item) => item.id === 'p1');
  assert.equal(tile.kind, 'rotating');
  assert.equal(tile.rotationIndex, 3);
  assert.equal(tile.currentSessionKey, 'pin-a');
  assert.equal('sessionKey' in tile, false);
  assert.equal(geometryOf(result.deck, 'p1'), '0,0,2,2');
  assert.equal(result.tabs.find((tab) => tab.key === 'pin-a').rotationSlot, 3);
  // 순환 번호는 여전히 중복이 없다.
  const indexes = result.deck.tiles
    .filter((item) => item.kind === 'rotating')
    .map((item) => item.rotationIndex);
  assert.equal(new Set(indexes).size, indexes.length);
});

test('고정 타일 제거는 세션을 유지하고 순환 번호를 다시 준다', () => {
  const editing = draft();
  const result = removeTileFromDeck(editing, 'p1');

  assert.equal(result.ok, true);
  assert.deepEqual(result.deck.tiles.map((tile) => tile.id), ['p2', 'r1', 'r2']);
  assert.equal(result.tabs.length, 5);
  assert.equal(result.tabs.find((tab) => tab.key === 'pin-a').rotationSlot, 1);
  // 자동으로 순환 타일에 끼워 넣지 않는다.
  assert.equal(
    result.deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    'rot-c'
  );
});

test('순환 타일 제거는 세션을 유지하고 남은 번호로 재지정한다', () => {
  const editing = draft();
  const result = removeTileFromDeck(editing, 'r2');

  assert.equal(result.ok, true);
  assert.equal(result.tabs.length, 5);
  assert.equal(result.tabs.find((tab) => tab.key === 'rot-d').rotationSlot, 1);
  // 남은 순환 타일의 표시 세션은 교체되지 않는다.
  assert.equal(
    result.deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    'rot-c'
  );
});

test('마지막 순환 타일은 제거할 수 없다', () => {
  const editing = singleRotationDraft();
  const before = JSON.stringify(editing.deck);
  const result = removeTileFromDeck(editing, 'r1');

  assert.equal(result.ok, false);
  assert.equal(result.reason, '마지막 순환 타일은 제거할 수 없습니다.');
  assert.equal(JSON.stringify(result.deck), before);
});

test('변환·제거 뒤에도 포커스 세션은 표시 중이어야 한다', () => {
  const editing = draft();
  // 포커스 세션(rot-c)이 표시되던 순환 타일을 제거한다.
  const removed = removeTileFromDeck(editing, 'r1');
  assert.equal(removed.ok, true);
  const shown = removed.deck.tiles
    .map((tile) => tile.sessionKey || tile.currentSessionKey)
    .filter(Boolean);
  assert.equal(shown.includes(removed.deck.focusedSessionKey), true);
  assert.equal(removed.deck.focusedSessionKey, 'pin-a');

  // 표시 세션이 하나도 없어지면 가장 낮은 순환 타일에 되살린다.
  const stripped = beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'rot-c',
    tiles: [
      { id: 'p1', kind: 'pinned', sessionKey: 'pin-a', row: 0, column: 0, rowSpan: 2, columnSpan: 4 },
      { id: 'r1', kind: 'rotating', rotationIndex: 1, currentSessionKey: null, row: 2, column: 0, rowSpan: 2, columnSpan: 4 }
    ]
  }, [{ key: 'pin-a', name: 'A', rotationSlot: null }, { key: 'rot-c', name: 'C', rotationSlot: 1 }]);
  const removedPinned = removeTileFromDeck(stripped, 'p1');
  assert.equal(removedPinned.ok, true);
  assert.equal(
    removedPinned.deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    'rot-c'
  );
  assert.equal(removedPinned.deck.focusedSessionKey, 'rot-c');
});

test('취소하면 deck·tabs·포커스가 완전히 복원된다', () => {
  const editing = draft();
  const originalDeck = JSON.stringify(editing.deck);
  const originalTabs = JSON.stringify(editing.tabs);

  const moved = moveTile(editing, 'r1', { row: 2, column: 0 });
  const converted = convertTileToRotating(
    { ...editing, deck: moved.deck, tabs: moved.tabs },
    'p1'
  );
  const removed = removeTileFromDeck(
    { ...editing, deck: converted.deck, tabs: converted.tabs },
    'p2'
  );
  assert.notEqual(JSON.stringify(removed.deck), originalDeck);

  const cancelled = cancelDeckEdit(editing);
  assert.equal(JSON.stringify(cancelled.deck), originalDeck);
  assert.equal(JSON.stringify(cancelled.tabs), originalTabs);
  assert.equal(cancelled.deck.focusedSessionKey, 'rot-c');
});

test('잘못된 draft는 finalize에서 거부된다', () => {
  const editing = draft();
  // 검증기를 직접 시험하기 위해 draft를 손으로 망가뜨린다.
  const broken = {
    ...editing,
    deck: {
      ...editing.deck,
      tiles: [
        { ...editing.deck.tiles[0] },
        { ...editing.deck.tiles[1], row: 1, column: 1 },
        { ...editing.deck.tiles[2] },
        { ...editing.deck.tiles[3] }
      ]
    }
  };

  const result = finalizeDeckEdit(broken);
  assert.equal(result.ok, false);
  assert.match(result.reason, /겹칩니다/u);
  // 안전한 기본 배치로 폴백하지 않고 편집 중 배치를 그대로 돌려준다.
  assert.equal(result.deck.tiles.length, 4);

  const duplicateRotation = finalizeDeckEdit({
    ...editing,
    deck: {
      ...editing.deck,
      tiles: editing.deck.tiles.map((tile) =>
        tile.id === 'r2' ? { ...tile, rotationIndex: 1 } : tile)
    }
  });
  assert.equal(duplicateRotation.ok, false);
  assert.match(duplicateRotation.reason, /중복/u);

  const noRotation = finalizeDeckEdit({
    ...editing,
    deck: {
      ...editing.deck,
      tiles: editing.deck.tiles.filter((tile) => tile.kind === 'pinned')
    }
  });
  assert.equal(noRotation.ok, false);
  assert.match(noRotation.reason, /순환 타일/u);

  const badFocus = finalizeDeckEdit({
    ...editing,
    deck: { ...editing.deck, focusedSessionKey: 'rot-e' }
  });
  assert.equal(badFocus.ok, false);
  assert.match(badFocus.reason, /표시 중/u);
});

test('범위를 벗어난 rotationIndex는 finalize에서 거부된다', () => {
  const editing = draft();
  const before = JSON.stringify(editing.deck);

  for (const rotationIndex of [0, -1, 17, 99, 1.5, null, '1']) {
    const broken = {
      ...editing,
      deck: {
        ...editing.deck,
        tiles: editing.deck.tiles.map((tile) =>
          tile.id === 'r2' ? { ...tile, rotationIndex } : tile)
      }
    };
    const result = finalizeDeckEdit(broken);
    assert.equal(result.ok, false, `${rotationIndex}는 거부되어야 합니다.`);
    assert.match(result.reason, /순환 번호|표시 중|순환 타일/u);
    // 실패해도 원본 draft는 그대로다.
    assert.equal(JSON.stringify(editing.deck), before);
  }
});

test('모든 세션이 고정이고 빈 순환 타일 번호만 잘못돼도 거부된다', () => {
  // tabs가 전부 pinned라 tab 순환 번호 검사에 걸리지 않는 경로다.
  const editing = beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'pin-a',
    tiles: [
      { id: 'p1', kind: 'pinned', sessionKey: 'pin-a', row: 0, column: 0, rowSpan: 2, columnSpan: 4 },
      { id: 'r1', kind: 'rotating', rotationIndex: 17, currentSessionKey: null, row: 2, column: 0, rowSpan: 2, columnSpan: 4 }
    ]
  }, [{ key: 'pin-a', name: 'A', rotationSlot: null }]);

  const result = finalizeDeckEdit(editing);
  assert.equal(result.ok, false);
  assert.match(result.reason, /순환 번호는 1~16/u);
});

test('허용 범위의 최대 순환 번호는 통과한다', () => {
  const editing = beginDeckEdit({
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'pin-a',
    tiles: [
      { id: 'p1', kind: 'pinned', sessionKey: 'pin-a', row: 0, column: 0, rowSpan: 2, columnSpan: 4 },
      { id: 'r1', kind: 'rotating', rotationIndex: 16, currentSessionKey: null, row: 2, column: 0, rowSpan: 2, columnSpan: 4 }
    ]
  }, [{ key: 'pin-a', name: 'A', rotationSlot: null }]);

  const result = finalizeDeckEdit(editing);
  assert.equal(result.ok, true, result.reason);

  // 승인된 결과는 정규화 round trip에서 그대로 유지된다.
  const resolved = resolveDeckState({ tabs: result.tabs, deck: result.deck });
  assert.deepEqual(resolved.deck.tiles, result.deck.tiles);
});

test('잘못된 tile id와 타일 개수 초과도 거부된다', () => {
  const editing = draft();
  const badId = finalizeDeckEdit({
    ...editing,
    deck: {
      ...editing.deck,
      tiles: editing.deck.tiles.map((tile) =>
        tile.id === 'r2' ? { ...tile, id: '' } : tile)
    }
  });
  assert.equal(badId.ok, false);
  assert.match(badId.reason, /타일 id/u);

  const tooMany = finalizeDeckEdit({
    ...editing,
    deck: {
      ...editing.deck,
      tiles: Array.from({ length: 17 }, (_, index) => ({
        id: `t${index}`,
        kind: 'rotating',
        rotationIndex: index + 1,
        currentSessionKey: null,
        row: 0,
        column: 0,
        rowSpan: 1,
        columnSpan: 1
      }))
    }
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.reason, /최대 16개/u);
});

test('finalize 결과는 resolveDeckState round trip에서 동일하다', () => {
  const editing = draft();
  const moved = moveTile(editing, 'r2', { row: 2, column: 2 });
  const converted = convertTileToRotating(
    { ...editing, deck: moved.deck, tabs: moved.tabs },
    'p2'
  );
  const finalized = finalizeDeckEdit({
    ...editing,
    deck: converted.deck,
    tabs: converted.tabs
  });
  assert.equal(finalized.ok, true);

  const resolved = resolveDeckState({
    tabs: finalized.tabs,
    deck: finalized.deck
  });
  assert.deepEqual(resolved.deck.tiles, finalized.deck.tiles);
  assert.equal(resolved.deck.focusedSessionKey, finalized.deck.focusedSessionKey);
  assert.deepEqual(
    resolved.tabs.map((tab) => [tab.key, tab.rotationSlot]),
    finalized.tabs.map((tab) => [tab.key, tab.rotationSlot])
  );

  // 정상 배치는 validate도 통과한다.
  assert.equal(validateDeckEdit({ deck: resolved.deck, tabs: resolved.tabs }).ok,
    true);
});

test('전이는 입력 draft를 변형하지 않는다', () => {
  const editing = draft();
  const deckBefore = JSON.stringify(editing.deck);
  const tabsBefore = JSON.stringify(editing.tabs);

  moveTile(editing, 'r1', { row: 2, column: 0 });
  resizeTile(editing, 'r1', { rowSpan: 1, columnSpan: 1 });
  addRotatingTile(editing, { row: 0, column: 0 });
  convertTileToRotating(editing, 'p1');
  removeTileFromDeck(editing, 'p2');

  assert.equal(JSON.stringify(editing.deck), deckBefore);
  assert.equal(JSON.stringify(editing.tabs), tabsBefore);
});
