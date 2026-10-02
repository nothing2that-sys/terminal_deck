const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveDeckState } = require('../src/deck-layout');
const {
  displaySession,
  displayedSessionKey,
  isSessionVisible,
  nextFocusKey,
  pinnedTileOrder,
  releaseSession,
  restoreFocusKey,
  sessionPlacementLabel,
  tileForSession
} = require('../src/deck-session');

function singleRotationDeck(currentSessionKey = null) {
  return {
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: currentSessionKey,
    tiles: [{
      id: 'r1',
      kind: 'rotating',
      rotationIndex: 1,
      currentSessionKey,
      row: 0,
      column: 0,
      rowSpan: 4,
      columnSpan: 4
    }]
  };
}

// 고정 2개 + 순환 2개를 가진 저장된 배치. Stage 1 화면은 한 타일만 렌더하지만
// 이 배치는 저장·복원 사이에 그대로 유지되어야 한다.
function mixedDeck() {
  return {
    version: 1,
    rows: 4,
    columns: 4,
    focusedSessionKey: 'pinned-a',
    tiles: [
      {
        id: 'p1',
        kind: 'pinned',
        sessionKey: 'pinned-a',
        row: 0,
        column: 0,
        rowSpan: 2,
        columnSpan: 2
      },
      {
        id: 'p2',
        kind: 'pinned',
        sessionKey: 'pinned-b',
        row: 0,
        column: 2,
        rowSpan: 2,
        columnSpan: 2
      },
      {
        id: 'r1',
        kind: 'rotating',
        rotationIndex: 1,
        currentSessionKey: 'rot-c',
        row: 2,
        column: 0,
        rowSpan: 2,
        columnSpan: 2
      },
      {
        id: 'r2',
        kind: 'rotating',
        rotationIndex: 2,
        currentSessionKey: 'rot-d',
        row: 2,
        column: 2,
        rowSpan: 2,
        columnSpan: 2
      }
    ]
  };
}

const MIXED_TABS = [
  { key: 'pinned-a', name: 'A' },
  { key: 'pinned-b', name: 'B' },
  { key: 'rot-c', name: 'C', rotationSlot: 1 },
  { key: 'rot-d', name: 'D', rotationSlot: 2 },
  { key: 'rot-e', name: 'E', rotationSlot: 1 }
];

test('순환1에 A 표시 중 B를 클릭하면 A는 숨고 B가 표시·포커스된다', () => {
  const deck = displaySession(singleRotationDeck('a'), 'b', 1);
  assert.equal(deck.tiles[0].currentSessionKey, 'b');
  assert.equal(deck.focusedSessionKey, 'b');
  assert.equal(isSessionVisible(deck, 'a'), false);
  assert.equal(isSessionVisible(deck, 'b'), true);
});

test('이미 표시·포커스된 행을 다시 클릭해도 배치가 그대로다', () => {
  const before = displaySession(singleRotationDeck('a'), 'a', 1);
  assert.deepEqual(displaySession(before, 'a', 1), before);
});

test('고정 세션을 클릭하면 순환 타일은 바뀌지 않고 포커스만 옮겨진다', () => {
  const before = mixedDeck();
  const after = displaySession(before, 'pinned-b', null);

  assert.equal(after.focusedSessionKey, 'pinned-b');
  assert.deepEqual(
    after.tiles.map((tile) => tile.currentSessionKey ?? tile.sessionKey),
    before.tiles.map((tile) => tile.currentSessionKey ?? tile.sessionKey)
  );
});

test('순환 세션은 자기 순환 번호의 타일에서만 교체된다', () => {
  const after = displaySession(mixedDeck(), 'rot-e', 1);

  assert.equal(after.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    'rot-e');
  assert.equal(after.tiles.find((tile) => tile.id === 'r2').currentSessionKey,
    'rot-d');
  assert.equal(after.tiles.find((tile) => tile.id === 'p1').sessionKey,
    'pinned-a');
  assert.equal(after.focusedSessionKey, 'rot-e');
});

test('세션이 두 타일에 동시에 표시되지 않는다', () => {
  // rot-d가 순환2에 표시 중인데 순환1로 옮기면 순환2에서 회수된다.
  const after = displaySession(mixedDeck(), 'rot-d', 1);
  const visible = after.tiles.filter((tile) =>
    (tile.kind === 'pinned' ? tile.sessionKey : tile.currentSessionKey)
      === 'rot-d');

  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'r1');
  assert.equal(after.tiles.find((tile) => tile.id === 'r2').currentSessionKey,
    null);
});

test('고정 세션이 순환 타일에도 남아 있으면 고정 타일만 남긴다', () => {
  const deck = mixedDeck();
  deck.tiles.find((tile) => tile.id === 'r1').currentSessionKey = 'pinned-a';
  const after = displaySession(deck, 'pinned-a', 1);

  assert.equal(after.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    null);
  assert.equal(after.tiles.find((tile) => tile.id === 'p1').sessionKey,
    'pinned-a');
  assert.equal(after.focusedSessionKey, 'pinned-a');
});

test('앱을 열고 배치를 편집하지 않으면 저장된 다중 타일 배치가 그대로 유지된다', () => {
  // 렌더러의 열기→저장 경로와 같은 순서로 합성한다.
  // resolveDeckState(복원) → restoreFocusKey → displaySession(포커스 복원)
  // → resolveDeckState(저장).
  const persisted = mixedDeck();
  const opened = resolveDeckState({ tabs: MIXED_TABS, deck: persisted });
  const sessionKeys = MIXED_TABS.map((tab) => tab.key);
  const focusKey = restoreFocusKey(opened.deck, sessionKeys);
  const focusedSlot = opened.tabs
    .find((tab) => tab.key === focusKey)?.rotationSlot;
  const runtime = displaySession(opened.deck, focusKey, focusedSlot);
  const saved = resolveDeckState({ tabs: opened.tabs, deck: runtime });

  assert.equal(focusKey, 'pinned-a');
  assert.deepEqual(saved.deck, opened.deck);
  assert.deepEqual(saved.deck.tiles, persisted.tiles);
  assert.equal(saved.deck.tiles.length, 4);
  assert.deepEqual(
    saved.deck.tiles.map((tile) => [
      tile.id,
      tile.kind,
      tile.row,
      tile.column,
      tile.rowSpan,
      tile.columnSpan
    ]),
    [
      ['p1', 'pinned', 0, 0, 2, 2],
      ['p2', 'pinned', 0, 2, 2, 2],
      ['r1', 'rotating', 2, 0, 2, 2],
      ['r2', 'rotating', 2, 2, 2, 2]
    ]
  );
  assert.equal(saved.deck.focusedSessionKey, 'pinned-a');
  assert.deepEqual(saved.tabs.map((tab) => tab.rotationSlot), [
    null,
    null,
    1,
    2,
    1
  ]);
});

test('순환 세션을 전환해도 저장된 타일 수와 기하는 유지된다', () => {
  const opened = resolveDeckState({ tabs: MIXED_TABS, deck: mixedDeck() });
  const switched = displaySession(opened.deck, 'rot-e', 1);
  const saved = resolveDeckState({ tabs: opened.tabs, deck: switched });

  assert.deepEqual(
    saved.deck.tiles.map((tile) => tile.id),
    ['p1', 'p2', 'r1', 'r2']
  );
  assert.deepEqual(
    saved.deck.tiles.map((tile) => `${tile.row},${tile.column}`),
    ['0,0', '0,2', '2,0', '2,2']
  );
  assert.equal(displayedSessionKey(saved.deck, 'r1'), 'rot-e');
  assert.equal(displayedSessionKey(saved.deck, 'p1'), 'pinned-a');
});

test('출력이나 상태 변화는 포커스를 훔치지 않는다', () => {
  // 표시/포커스는 displaySession으로만 바뀐다. 출력 이벤트가 호출하는
  // 어떤 순수 전이도 존재하지 않으므로 deck은 불변이어야 한다.
  const deck = displaySession(singleRotationDeck('a'), 'a', 1);
  const snapshot = JSON.stringify(deck);
  assert.equal(isSessionVisible(deck, 'b'), false);
  assert.equal(JSON.stringify(deck), snapshot);
  assert.equal(deck.focusedSessionKey, 'a');
});

test('포커스 세션 종료 시 목록 순서의 다음 세션이 후보가 된다', () => {
  assert.equal(nextFocusKey(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(nextFocusKey(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(nextFocusKey(['a'], 'a'), null);
  assert.equal(nextFocusKey([], 'a'), null);
});

test('순환 세션 종료는 타일을 남기고 표시만 비운다', () => {
  const after = releaseSession(singleRotationDeck('a'), 'a');
  assert.equal(after.tiles.length, 1);
  assert.equal(after.tiles[0].currentSessionKey, null);
  assert.equal(after.focusedSessionKey, null);
});

test('숨은 세션 종료는 현재 표시·포커스를 바꾸지 않는다', () => {
  const before = displaySession(mixedDeck(), 'rot-c', 1);
  const after = releaseSession(before, 'rot-e');

  assert.deepEqual(after, before);
});

test('고정 세션 종료는 그 고정 타일을 제거하고 다른 타일은 두 채로 남긴다', () => {
  const after = releaseSession(mixedDeck(), 'pinned-a');

  assert.deepEqual(after.tiles.map((tile) => tile.id), ['p2', 'r1', 'r2']);
  assert.equal(after.focusedSessionKey, null);
  assert.equal(after.tiles.find((tile) => tile.id === 'r1').currentSessionKey,
    'rot-c');
});

test('배치 태그는 고정과 순환을 구분한다', () => {
  const deck = mixedDeck();
  assert.equal(sessionPlacementLabel(deck, 'pinned-a', null), '고정1');
  assert.equal(sessionPlacementLabel(deck, 'pinned-b', null), '고정2');
  assert.equal(sessionPlacementLabel(deck, 'rot-c', 1), '순환1');
  assert.equal(sessionPlacementLabel(deck, 'rot-d', 2), '순환2');
  assert.equal(sessionPlacementLabel(deck, 'rot-new', null), '순환1');
});

test('세션이 붙을 타일을 찾는다', () => {
  const deck = mixedDeck();
  assert.equal(tileForSession(deck, 'pinned-b', null).id, 'p2');
  assert.equal(tileForSession(deck, 'rot-d', 2).id, 'r2');
  assert.equal(tileForSession(deck, 'rot-new', 1).id, 'r1');
  // 없는 순환 번호는 가장 낮은 순환 타일로 내려간다.
  assert.equal(tileForSession(deck, 'rot-new', 9).id, 'r1');
});

test('여러 타일이 동시에 표시 세션을 갖는다', () => {
  const deck = mixedDeck();
  const visible = deck.tiles.map((tile) => displayedSessionKey(deck, tile.id));

  assert.deepEqual(visible, ['pinned-a', 'pinned-b', 'rot-c', 'rot-d']);
  assert.equal(new Set(visible).size, 4);
  assert.equal(isSessionVisible(deck, 'rot-e'), false);
});

test('한 세션은 정확히 한 타일에만 표시된다', () => {
  // 어떤 전환을 거쳐도 같은 세션 키가 두 타일에 나타나지 않는다.
  let deck = mixedDeck();
  for (const key of ['rot-e', 'rot-d', 'pinned-a', 'rot-c', 'rot-e']) {
    const slot = key === 'rot-d' ? 2 : 1;
    deck = displaySession(deck, key, slot);
    const shown = deck.tiles
      .map((tile) => displayedSessionKey(deck, tile.id))
      .filter(Boolean);
    assert.equal(new Set(shown).size, shown.length, `중복 표시: ${key}`);
  }
});

test('고정 타일 번호는 타일 순서를 따른다', () => {
  const deck = mixedDeck();
  assert.equal(pinnedTileOrder(deck, 'p1'), 1);
  assert.equal(pinnedTileOrder(deck, 'p2'), 2);
  // 순환 타일은 고정 번호를 갖지 않는다.
  assert.equal(pinnedTileOrder(deck, 'r1'), 0);
});

test('고정 타일을 제거해도 남은 고정 번호가 순서대로 다시 매겨진다', () => {
  const after = releaseSession(mixedDeck(), 'pinned-a');
  assert.equal(pinnedTileOrder(after, 'p2'), 1);
  assert.equal(sessionPlacementLabel(after, 'pinned-b', null), '고정1');
});

test('표시 세션이 여러 개여도 포커스는 하나뿐이고 표시 중이어야 한다', () => {
  const deck = displaySession(mixedDeck(), 'rot-d', 2);
  const visible = deck.tiles
    .map((tile) => displayedSessionKey(deck, tile.id))
    .filter(Boolean);

  assert.equal(visible.length, 4);
  assert.equal(typeof deck.focusedSessionKey, 'string');
  assert.equal(visible.includes(deck.focusedSessionKey), true);
  assert.equal(isSessionVisible(deck, deck.focusedSessionKey), true);
});

test('포커스 세션 종료 후 다음 후보는 표시 중인 세션으로 이어진다', () => {
  const deck = mixedDeck();
  const orderedKeys = MIXED_TABS.map((tab) => tab.key);
  const nextKey = nextFocusKey(orderedKeys, 'pinned-b');
  const after = releaseSession(deck, 'pinned-b');
  const focused = displaySession(
    after,
    nextKey,
    MIXED_TABS.find((tab) => tab.key === nextKey)?.rotationSlot
  );

  assert.equal(nextKey, 'rot-c');
  assert.equal(focused.focusedSessionKey, 'rot-c');
  assert.equal(isSessionVisible(focused, 'rot-c'), true);
  // 종료된 고정 타일만 사라지고 나머지 기하는 그대로다.
  assert.deepEqual(focused.tiles.map((tile) => tile.id), ['p1', 'r1', 'r2']);
  assert.deepEqual(
    focused.tiles.map((tile) => `${tile.row},${tile.column}`),
    ['0,0', '2,0', '2,2']
  );
});

test('복원 포커스는 저장된 포커스 세션을 우선한다', () => {
  const deck = mixedDeck();
  assert.equal(restoreFocusKey(deck, ['pinned-a', 'rot-c']), 'pinned-a');
  // 저장된 포커스 세션이 사라졌으면 순환 타일에 남아 있던 세션.
  assert.equal(restoreFocusKey(deck, ['rot-c', 'rot-d']), 'rot-c');
  // 그것도 없으면 목록 첫 세션.
  assert.equal(restoreFocusKey(deck, ['rot-e']), 'rot-e');
  assert.equal(restoreFocusKey(deck, []), null);
  assert.equal(restoreFocusKey(singleRotationDeck(null), ['x']), 'x');
});
