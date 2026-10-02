const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDefaultDeck,
  findFreeRectangle,
  findTileForSession,
  lowestFreeRotationIndex,
  normalizeDeck,
  resolveDeckState,
  rotationIndexes,
  tilesOverlap,
  visibleSessionKeys
} = require('../src/deck-layout');

function tabsFor(...keys) {
  return keys.map((key, index) => ({ key, name: `세션 ${index + 1}` }));
}

function rotating(overrides = {}) {
  return {
    id: 'rotating-1',
    kind: 'rotating',
    rotationIndex: 1,
    currentSessionKey: null,
    row: 0,
    column: 0,
    rowSpan: 2,
    columnSpan: 4,
    ...overrides
  };
}

function pinned(overrides = {}) {
  return {
    id: 'pinned-1',
    kind: 'pinned',
    sessionKey: 'a',
    row: 2,
    column: 0,
    rowSpan: 2,
    columnSpan: 2,
    ...overrides
  };
}

test('deck 필드가 없는 v1 상태는 전체 크기 순환1 타일로 마이그레이션된다', () => {
  const { tabs, deck } = resolveDeckState({
    tabs: tabsFor('a', 'b', 'c'),
    activeTabIndex: 1
  });

  assert.equal(deck.version, 1);
  assert.equal(deck.rows, 4);
  assert.equal(deck.columns, 4);
  assert.deepEqual(deck.tiles, [{
    id: 'tile-1',
    kind: 'rotating',
    rotationIndex: 1,
    currentSessionKey: 'b',
    row: 0,
    column: 0,
    rowSpan: 4,
    columnSpan: 4
  }]);
  assert.equal(deck.focusedSessionKey, 'b');
  assert.deepEqual(tabs.map((tab) => tab.rotationSlot), [1, 1, 1]);
});

test('탭이 없는 기존 작업공간은 빈 순환1 타일만 갖는다', () => {
  const { tabs, deck } = resolveDeckState({ tabs: [], activeTabIndex: 0 });
  assert.deepEqual(tabs, []);
  assert.equal(deck.tiles.length, 1);
  assert.equal(deck.tiles[0].currentSessionKey, null);
  assert.equal(deck.focusedSessionKey, null);
});

test('여러 타일이 손실 없이 round trip 한다', () => {
  const source = {
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'b',
    tiles: [
      pinned({ id: 'p1', sessionKey: 'a', row: 0, column: 0, rowSpan: 2, columnSpan: 2 }),
      pinned({ id: 'p2', sessionKey: 'b', row: 0, column: 2, rowSpan: 2, columnSpan: 2 }),
      rotating({
        id: 'r1',
        rotationIndex: 1,
        currentSessionKey: 'c',
        row: 2,
        column: 0,
        rowSpan: 2,
        columnSpan: 4
      })
    ]
  };
  const first = normalizeDeck(source, { sessionKeys: ['a', 'b', 'c', 'd'] });
  const second = normalizeDeck(first.deck, { sessionKeys: ['a', 'b', 'c', 'd'] });

  assert.deepEqual(first.warnings, []);
  assert.deepEqual(second.deck, first.deck);
  assert.deepEqual(first.deck.tiles.map((tile) => tile.id), ['p1', 'p2', 'r1']);
  assert.equal(first.deck.focusedSessionKey, 'b');
  assert.deepEqual(visibleSessionKeys(first.deck), ['a', 'b', 'c']);
  assert.equal(findTileForSession(first.deck, 'c').id, 'r1');
  assert.equal(findTileForSession(first.deck, 'd'), null);
});

test('4×4 격자를 벗어나는 타일은 거부된다', () => {
  const { deck, warnings } = normalizeDeck({
    tiles: [
      rotating({ id: 'ok', rotationIndex: 1, row: 0, column: 0, rowSpan: 2, columnSpan: 2 }),
      pinned({ id: 'too-wide', sessionKey: 'a', row: 3, column: 2, rowSpan: 1, columnSpan: 4 }),
      pinned({ id: 'negative', sessionKey: 'b', row: -1, column: 0, rowSpan: 1, columnSpan: 1 }),
      pinned({ id: 'zero-span', sessionKey: 'c', row: 2, column: 2, rowSpan: 0, columnSpan: 2 })
    ]
  }, { sessionKeys: ['a', 'b', 'c'] });

  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['ok']);
  assert.ok(warnings.some((warning) => warning.includes('격자')));
});

test('겹치는 타일이 있으면 전체 deck을 기본 배치로 되돌린다', () => {
  const { deck, warnings } = normalizeDeck({
    focusedSessionKey: 'b',
    tiles: [
      rotating({ id: 'r1', rotationIndex: 1, row: 0, column: 0, rowSpan: 2, columnSpan: 2 }),
      pinned({ id: 'p1', sessionKey: 'b', row: 1, column: 1, rowSpan: 2, columnSpan: 2 })
    ]
  }, { sessionKeys: ['a', 'b'] });

  assert.deepEqual(deck, createDefaultDeck({ currentSessionKey: 'a' }));
  assert.ok(warnings.some((warning) => warning.includes('겹쳐')));
});

test('한 세션을 두 고정 타일에 배치하면 뒤쪽 타일이 거부된다', () => {
  const { deck, warnings } = normalizeDeck({
    tiles: [
      pinned({ id: 'p1', sessionKey: 'a', row: 0, column: 0, rowSpan: 2, columnSpan: 2 }),
      pinned({ id: 'p2', sessionKey: 'a', row: 0, column: 2, rowSpan: 2, columnSpan: 2 }),
      rotating({ id: 'r1', rotationIndex: 1, row: 2, column: 0, rowSpan: 2, columnSpan: 4 })
    ]
  }, { sessionKeys: ['a'] });

  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['p1', 'r1']);
  assert.ok(warnings.some((warning) => warning.includes('고정')));
});

test('중복 순환 번호는 거부된다', () => {
  const { deck, warnings } = normalizeDeck({
    tiles: [
      rotating({ id: 'r1', rotationIndex: 1, row: 0, column: 0, rowSpan: 2, columnSpan: 4 }),
      rotating({ id: 'r2', rotationIndex: 1, row: 2, column: 0, rowSpan: 2, columnSpan: 4 })
    ]
  }, { sessionKeys: [] });

  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['r1']);
  assert.deepEqual(rotationIndexes(deck), [1]);
  assert.ok(warnings.some((warning) => warning.includes('중복')));
});

test('kind가 없거나 알 수 없는 타일은 rotating으로 바뀌지 않고 제외된다', () => {
  const { deck, warnings } = normalizeDeck({
    tiles: [
      rotating({ id: 'r1', rotationIndex: 1, row: 0, column: 0, rowSpan: 1, columnSpan: 4 }),
      { id: 'no-kind', row: 1, column: 0, rowSpan: 1, columnSpan: 4 },
      { id: 'unknown', kind: 'split', row: 2, column: 0, rowSpan: 1, columnSpan: 4 },
      { id: 'wrong-type', kind: 3, row: 3, column: 0, rowSpan: 1, columnSpan: 4 },
      { id: 'wrong-case', kind: 'Pinned', sessionKey: 'a', row: 3, column: 0, rowSpan: 1, columnSpan: 2 }
    ]
  }, { sessionKeys: ['a'] });

  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['r1']);
  assert.equal(
    warnings.filter((warning) => warning.includes('알 수 없어')).length,
    4
  );
  assert.ok(warnings.some((warning) => warning.includes('"split"')));
  assert.ok(warnings.some((warning) => warning.includes('누락')));
});

test('제외된 타일은 타일 id를 소비하지 않는다', () => {
  const { deck } = normalizeDeck({
    tiles: [
      { kind: 'split', row: 0, column: 0, rowSpan: 2, columnSpan: 4 },
      rotating({ id: null, rotationIndex: 1, row: 2, column: 0, rowSpan: 2, columnSpan: 4 })
    ]
  }, { sessionKeys: [] });

  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['tile-1']);
});

test('중복 타일 id는 새 id로 정규화된다', () => {
  const { deck } = normalizeDeck({
    tiles: [
      rotating({ id: 'same', rotationIndex: 1, row: 0, column: 0, rowSpan: 2, columnSpan: 4 }),
      rotating({ id: 'same', rotationIndex: 2, row: 2, column: 0, rowSpan: 2, columnSpan: 4 })
    ]
  }, { sessionKeys: [] });

  assert.equal(deck.tiles.length, 2);
  assert.notEqual(deck.tiles[0].id, deck.tiles[1].id);
});

test('없는 세션 키를 참조하는 고정 타일과 표시 세션이 정리된다', () => {
  const { deck, warnings } = normalizeDeck({
    focusedSessionKey: 'gone',
    tiles: [
      pinned({ id: 'p1', sessionKey: 'gone', row: 0, column: 0, rowSpan: 2, columnSpan: 4 }),
      rotating({
        id: 'r1',
        rotationIndex: 1,
        currentSessionKey: 'also-gone',
        row: 2,
        column: 0,
        rowSpan: 2,
        columnSpan: 4
      })
    ]
  }, { sessionKeys: ['a'] });

  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['r1']);
  assert.equal(deck.tiles[0].currentSessionKey, null);
  assert.equal(deck.focusedSessionKey, null);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => warning.includes('존재하지 않는 세션')));
});

test('한 세션이 고정과 순환 타일에 동시에 표시되지 않는다', () => {
  const { deck } = normalizeDeck({
    tiles: [
      pinned({ id: 'p1', sessionKey: 'a', row: 0, column: 0, rowSpan: 2, columnSpan: 4 }),
      rotating({
        id: 'r1',
        rotationIndex: 1,
        currentSessionKey: 'a',
        row: 2,
        column: 0,
        rowSpan: 2,
        columnSpan: 4
      })
    ]
  }, { sessionKeys: ['a'] });

  assert.equal(deck.tiles[0].sessionKey, 'a');
  assert.equal(deck.tiles[1].currentSessionKey, null);
  assert.deepEqual(visibleSessionKeys(deck), ['a']);
});

test('순환 타일이 하나도 없으면 빈 공간에 순환 타일을 만든다', () => {
  const { deck, warnings } = normalizeDeck({
    tiles: [
      pinned({ id: 'p1', sessionKey: 'a', row: 0, column: 0, rowSpan: 2, columnSpan: 4 })
    ]
  }, { sessionKeys: ['a'] });

  const rotatingTiles = deck.tiles.filter((tile) => tile.kind === 'rotating');
  assert.equal(rotatingTiles.length, 1);
  assert.equal(rotatingTiles[0].rotationIndex, 1);
  assert.deepEqual(
    {
      row: rotatingTiles[0].row,
      column: rotatingTiles[0].column,
      rowSpan: rotatingTiles[0].rowSpan,
      columnSpan: rotatingTiles[0].columnSpan
    },
    { row: 2, column: 0, rowSpan: 2, columnSpan: 4 }
  );
  assert.ok(warnings.some((warning) => warning.includes('순환 타일이 없어')));
});

test('고정 타일이 격자를 모두 채우면 기본 배치로 되돌린다', () => {
  const { deck, warnings } = normalizeDeck({
    tiles: [
      pinned({ id: 'p1', sessionKey: 'a', row: 0, column: 0, rowSpan: 4, columnSpan: 4 })
    ]
  }, { sessionKeys: ['a'] });

  assert.deepEqual(deck, createDefaultDeck({ currentSessionKey: 'a' }));
  assert.ok(warnings.some((warning) => warning.includes('빈 공간이 없어')));
});

test('삭제된 순환 번호를 가리키는 세션은 가장 낮은 순환 번호로 내려간다', () => {
  const { tabs } = resolveDeckState({
    tabs: [
      { key: 'a', rotationSlot: 2 },
      { key: 'b', rotationSlot: 5 },
      { key: 'c', rotationSlot: 3 }
    ],
    deck: {
      focusedSessionKey: 'a',
      tiles: [
        rotating({
          id: 'r2',
          rotationIndex: 2,
          currentSessionKey: 'a',
          row: 0,
          column: 0,
          rowSpan: 2,
          columnSpan: 4
        }),
        rotating({
          id: 'r3',
          rotationIndex: 3,
          currentSessionKey: null,
          row: 2,
          column: 0,
          rowSpan: 2,
          columnSpan: 4
        })
      ]
    }
  });

  assert.deepEqual(tabs.map((tab) => tab.rotationSlot), [2, 2, 3]);
});

test('고정된 세션은 순환 번호를 갖지 않고 표시 중인 세션은 타일 번호를 따른다', () => {
  const { tabs } = resolveDeckState({
    tabs: [
      { key: 'a', rotationSlot: 1 },
      { key: 'b', rotationSlot: 1 }
    ],
    deck: {
      tiles: [
        pinned({ id: 'p1', sessionKey: 'a', row: 0, column: 0, rowSpan: 2, columnSpan: 4 }),
        rotating({
          id: 'r2',
          rotationIndex: 2,
          currentSessionKey: 'b',
          row: 2,
          column: 0,
          rowSpan: 2,
          columnSpan: 4
        })
      ]
    }
  });

  assert.equal(tabs[0].rotationSlot, null);
  assert.equal(tabs[1].rotationSlot, 2);
});

test('focusedSessionKey는 표시 중인 세션으로만 유지된다', () => {
  const parked = normalizeDeck({
    focusedSessionKey: 'c',
    tiles: [
      pinned({ id: 'p1', sessionKey: 'b', row: 0, column: 0, rowSpan: 2, columnSpan: 4 }),
      rotating({
        id: 'r1',
        rotationIndex: 1,
        currentSessionKey: 'a',
        row: 2,
        column: 0,
        rowSpan: 2,
        columnSpan: 4
      })
    ]
  }, { sessionKeys: ['a', 'b', 'c'] });

  // 'c'는 숨은 세션이므로 세션 목록 순서에서 첫 번째 표시 세션인 'a'로 내려간다.
  assert.equal(parked.deck.focusedSessionKey, 'a');

  const kept = normalizeDeck({
    focusedSessionKey: 'b',
    tiles: [
      pinned({ id: 'p1', sessionKey: 'b', row: 0, column: 0, rowSpan: 4, columnSpan: 2 }),
      rotating({
        id: 'r1',
        rotationIndex: 1,
        currentSessionKey: 'a',
        row: 0,
        column: 2,
        rowSpan: 4,
        columnSpan: 2
      })
    ]
  }, { sessionKeys: ['a', 'b', 'c'] });
  assert.equal(kept.deck.focusedSessionKey, 'b');
});

test('빈 사각형 찾기는 요청한 크기를 먼저 시도한다', () => {
  const tiles = [
    { row: 0, column: 0, rowSpan: 2, columnSpan: 2 }
  ];
  assert.deepEqual(findFreeRectangle(tiles, { rowSpan: 2, columnSpan: 2 }), {
    row: 0,
    column: 2,
    rowSpan: 2,
    columnSpan: 2
  });
  // 4×4가 들어가지 않으면 남은 가장 큰 사각형을 위/왼쪽 우선으로 고른다.
  assert.deepEqual(findFreeRectangle(tiles, { rowSpan: 4, columnSpan: 4 }), {
    row: 0,
    column: 2,
    rowSpan: 4,
    columnSpan: 2
  });
  assert.equal(
    findFreeRectangle([{ row: 0, column: 0, rowSpan: 4, columnSpan: 4 }]),
    null
  );
});

test('겹침 판정과 남은 순환 번호 계산', () => {
  assert.equal(
    tilesOverlap(
      { row: 0, column: 0, rowSpan: 2, columnSpan: 2 },
      { row: 1, column: 1, rowSpan: 2, columnSpan: 2 }
    ),
    true
  );
  assert.equal(
    tilesOverlap(
      { row: 0, column: 0, rowSpan: 2, columnSpan: 2 },
      { row: 2, column: 0, rowSpan: 2, columnSpan: 2 }
    ),
    false
  );
  assert.equal(lowestFreeRotationIndex([1, 2, 4]), 3);
  assert.equal(lowestFreeRotationIndex([]), 1);
});
