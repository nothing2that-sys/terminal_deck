const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_COMMAND_PANEL_WIDTH,
  DEFAULT_SESSION_PANEL_WIDTH,
  MAX_COMMAND_PANEL_WIDTH,
  MAX_SESSION_PANEL_WIDTH,
  MIN_COMMAND_PANEL_WIDTH,
  MIN_DECK_WIDTH,
  MIN_SESSION_PANEL_WIDTH,
  PANEL_RAIL_WIDTH,
  PANEL_RESIZER_WIDTH,
  fitPanelLayout,
  normalizeCommandPanelWidth,
  normalizeSessionPanelWidth
} = require('../src/panel-layout');

function layout(overrides = {}) {
  return fitPanelLayout({
    containerWidth: 1600,
    preferredSessionWidth: DEFAULT_SESSION_PANEL_WIDTH,
    preferredCommandWidth: DEFAULT_COMMAND_PANEL_WIDTH,
    sessionCollapsed: false,
    commandCollapsed: false,
    ...overrides
  });
}

function totalWidth(result) {
  const sessionCost = result.sessionCollapsed
    ? PANEL_RAIL_WIDTH
    : result.sessionWidth + PANEL_RESIZER_WIDTH;
  const commandCost = result.commandCollapsed
    ? PANEL_RAIL_WIDTH
    : result.commandWidth + PANEL_RESIZER_WIDTH;
  return sessionCost + commandCost + result.deckWidth;
}

test('command panel width normalization applies defaults and limits', () => {
  assert.equal(normalizeCommandPanelWidth(), 340);
  assert.equal(normalizeCommandPanelWidth(100), 220);
  assert.equal(normalizeCommandPanelWidth(487.6), 488);
  assert.equal(normalizeCommandPanelWidth(900), 720);
});

test('세션 패널 폭은 기본값·반올림·최소·최대를 지킨다', () => {
  assert.equal(normalizeSessionPanelWidth(), DEFAULT_SESSION_PANEL_WIDTH);
  assert.equal(normalizeSessionPanelWidth(240), 240);
  assert.equal(normalizeSessionPanelWidth(263.4), 263);
  assert.equal(normalizeSessionPanelWidth(263.6), 264);
  assert.equal(normalizeSessionPanelWidth(10), MIN_SESSION_PANEL_WIDTH);
  assert.equal(normalizeSessionPanelWidth(9999), MAX_SESSION_PANEL_WIDTH);
});

test('잘못된 폭 값은 기본값으로 정규화된다', () => {
  // 숫자로 변환할 수 없는 값은 기본값이 된다.
  for (const invalid of [NaN, Infinity, -Infinity, 'abc', undefined, {}]) {
    assert.equal(
      normalizeSessionPanelWidth(invalid),
      DEFAULT_SESSION_PANEL_WIDTH,
      `${String(invalid)} 처리`
    );
    assert.equal(
      normalizeCommandPanelWidth(invalid),
      DEFAULT_COMMAND_PANEL_WIDTH,
      `${String(invalid)} 처리`
    );
  }

  // 숫자로 변환되는 값은 clamp한다. null과 []는 0이 되므로 최소값이 된다.
  // (기존 normalizeCommandPanelWidth 동작과 저장 데이터 호환을 위해 유지한다.)
  assert.equal(normalizeSessionPanelWidth(null), MIN_SESSION_PANEL_WIDTH);
  assert.equal(normalizeCommandPanelWidth(null), MIN_COMMAND_PANEL_WIDTH);
  assert.equal(normalizeSessionPanelWidth([]), MIN_SESSION_PANEL_WIDTH);
  assert.equal(normalizeSessionPanelWidth(-50), MIN_SESSION_PANEL_WIDTH);
  assert.equal(normalizeCommandPanelWidth(-50), MIN_COMMAND_PANEL_WIDTH);
  // 숫자 문자열은 숫자로 인정한다(저장 파일 호환).
  assert.equal(normalizeSessionPanelWidth('300'), 300);
});

test('넓은 창에서는 양쪽 선호 폭이 그대로 쓰인다', () => {
  const result = layout({
    containerWidth: 1600,
    preferredSessionWidth: 300,
    preferredCommandWidth: 420
  });

  assert.equal(result.sessionWidth, 300);
  assert.equal(result.commandWidth, 420);
  assert.equal(result.sessionCollapsed, false);
  assert.equal(result.commandCollapsed, false);
  assert.equal(result.sessionResponsiveCollapsed, false);
  assert.equal(result.commandResponsiveCollapsed, false);
  assert.equal(result.deckWidth, 1600 - 300 - 6 - 420 - 6);
  assert.equal(totalWidth(result), 1600);
});

test('좁아지면 오른쪽 패널만 필요한 만큼 줄여 deck 최소 폭을 지킨다', () => {
  const result = layout({ containerWidth: 760 });

  assert.equal(result.commandCollapsed, false);
  // 왼쪽은 손대지 않고 오른쪽만 필요한 만큼(= 부족분) 줄인다.
  assert.equal(result.sessionWidth, DEFAULT_SESSION_PANEL_WIDTH);
  assert.equal(result.commandWidth, 228);
  assert.ok(result.commandWidth >= MIN_COMMAND_PANEL_WIDTH);
  assert.ok(result.commandWidth < DEFAULT_COMMAND_PANEL_WIDTH);
  assert.equal(result.deckWidth, MIN_DECK_WIDTH);
  assert.equal(totalWidth(result), 760);
});

test('더 좁아지면 오른쪽을 최소까지 줄인 뒤 왼쪽도 줄인다', () => {
  const result = layout({ containerWidth: 700 });

  assert.equal(result.commandWidth, MIN_COMMAND_PANEL_WIDTH);
  assert.equal(result.sessionWidth, 188);
  assert.ok(result.sessionWidth >= MIN_SESSION_PANEL_WIDTH);
  assert.ok(result.sessionWidth < DEFAULT_SESSION_PANEL_WIDTH);
  assert.equal(result.commandCollapsed, false);
  assert.equal(result.sessionCollapsed, false);
  assert.equal(result.deckWidth, MIN_DECK_WIDTH);
  assert.equal(totalWidth(result), 700);
});

test('최소 폭으로도 부족하면 오른쪽 패널만 임시로 접는다', () => {
  const result = layout({ containerWidth: 640 });

  assert.equal(result.commandCollapsed, true);
  assert.equal(result.commandResponsiveCollapsed, true);
  assert.equal(result.sessionCollapsed, false);
  assert.equal(result.sessionResponsiveCollapsed, false);
  // 오른쪽을 접어 공간이 생기면 왼쪽은 선호 폭을 되찾는다.
  assert.equal(result.sessionWidth, DEFAULT_SESSION_PANEL_WIDTH);
  // 임시 접힘이어도 저장용 선호 폭은 그대로 반환된다.
  assert.equal(result.commandWidth, DEFAULT_COMMAND_PANEL_WIDTH);
  assert.ok(result.deckWidth >= MIN_DECK_WIDTH, `deck=${result.deckWidth}`);
  assert.equal(totalWidth(result), 640);
});

test('아주 좁으면 양쪽 모두 임시로 접는다', () => {
  const result = layout({ containerWidth: 420 });

  assert.equal(result.commandCollapsed, true);
  assert.equal(result.sessionCollapsed, true);
  assert.equal(result.commandResponsiveCollapsed, true);
  assert.equal(result.sessionResponsiveCollapsed, true);
  assert.equal(result.sessionWidth, DEFAULT_SESSION_PANEL_WIDTH);
  assert.equal(result.commandWidth, DEFAULT_COMMAND_PANEL_WIDTH);
  assert.equal(result.deckWidth, 420 - PANEL_RAIL_WIDTH * 2);
});

test('창을 다시 넓히면 선호 폭이 복원된다', () => {
  const narrow = layout({
    containerWidth: 640,
    preferredSessionWidth: 320,
    preferredCommandWidth: 500
  });
  const wide = layout({
    containerWidth: 1600,
    preferredSessionWidth: 320,
    preferredCommandWidth: 500
  });

  assert.equal(narrow.commandResponsiveCollapsed, true);
  assert.equal(wide.commandCollapsed, false);
  assert.equal(wide.sessionWidth, 320);
  assert.equal(wide.commandWidth, 500);
  assert.equal(wide.commandResponsiveCollapsed, false);
});

test('사용자 접힘과 반응형 접힘을 구분한다', () => {
  const userCollapsed = layout({
    containerWidth: 1600,
    commandCollapsed: true
  });
  assert.equal(userCollapsed.commandCollapsed, true);
  assert.equal(userCollapsed.commandResponsiveCollapsed, false);
  // 접혀 있어도 선호 폭은 유지된다.
  assert.equal(userCollapsed.commandWidth, DEFAULT_COMMAND_PANEL_WIDTH);

  const responsive = layout({ containerWidth: 640 });
  assert.equal(responsive.commandCollapsed, true);
  assert.equal(responsive.commandResponsiveCollapsed, true);
});

test('한쪽만 사용자가 접은 경우 남은 폭을 다른 쪽이 쓴다', () => {
  const commandOnly = layout({ containerWidth: 900, commandCollapsed: true });
  assert.equal(commandOnly.sessionCollapsed, false);
  assert.equal(commandOnly.sessionWidth, DEFAULT_SESSION_PANEL_WIDTH);
  assert.equal(commandOnly.deckWidth, 900 - 240 - 6 - PANEL_RAIL_WIDTH);

  const sessionOnly = layout({ containerWidth: 900, sessionCollapsed: true });
  assert.equal(sessionOnly.commandCollapsed, false);
  assert.equal(sessionOnly.commandWidth, DEFAULT_COMMAND_PANEL_WIDTH);
  assert.equal(sessionOnly.deckWidth, 900 - 340 - 6 - PANEL_RAIL_WIDTH);
});

test('양쪽 모두 사용자가 접으면 deck이 나머지를 전부 쓴다', () => {
  const result = layout({
    containerWidth: 1000,
    sessionCollapsed: true,
    commandCollapsed: true
  });

  assert.equal(result.sessionResponsiveCollapsed, false);
  assert.equal(result.commandResponsiveCollapsed, false);
  assert.equal(result.deckWidth, 1000 - PANEL_RAIL_WIDTH * 2);
  assert.equal(totalWidth(result), 1000);
});

test('최소 창 폭 640에서도 음수나 NaN이 없다', () => {
  for (const containerWidth of [640, 700, 760, 900, 1024, 1100, 1366, 1600, 1920]) {
    const result = layout({ containerWidth });
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'number') {
        assert.ok(Number.isFinite(value), `${containerWidth}px ${key}=${value}`);
        assert.ok(value >= 0, `${containerWidth}px ${key}=${value}`);
      }
    }
    assert.ok(
      result.deckWidth >= MIN_DECK_WIDTH,
      `${containerWidth}px deck=${result.deckWidth}`
    );
    assert.ok(totalWidth(result) <= containerWidth,
      `${containerWidth}px total=${totalWidth(result)}`);
  }
});

test('컨테이너 폭을 모르면 선호 폭을 그대로 쓴다', () => {
  for (const containerWidth of [NaN, Infinity, 'abc', 0, -100, undefined]) {
    const result = layout({ containerWidth, preferredSessionWidth: 260 });
    assert.equal(result.sessionWidth, 260);
    assert.equal(result.commandWidth, DEFAULT_COMMAND_PANEL_WIDTH);
    assert.equal(result.sessionResponsiveCollapsed, false);
    assert.ok(Number.isFinite(result.deckWidth) && result.deckWidth >= 0);
  }
});

test('경계값 앞·정확히·뒤에서 반응형 전환이 일관된다', () => {
  // 오른쪽 패널이 최소 폭으로 들어가는 경계를 찾는다.
  const boundary = MIN_DECK_WIDTH
    + MIN_SESSION_PANEL_WIDTH + PANEL_RESIZER_WIDTH
    + MIN_COMMAND_PANEL_WIDTH + PANEL_RESIZER_WIDTH;

  const below = layout({ containerWidth: boundary - 1 });
  const exact = layout({ containerWidth: boundary });
  const above = layout({ containerWidth: boundary + 1 });

  assert.equal(exact.commandCollapsed, false, `boundary=${boundary}`);
  assert.equal(exact.deckWidth, MIN_DECK_WIDTH);
  assert.equal(above.commandCollapsed, false);
  assert.ok(above.deckWidth >= MIN_DECK_WIDTH);
  // 경계보다 1px 좁으면 오른쪽이 임시 접힘으로 넘어간다.
  assert.equal(below.commandCollapsed, true);
  assert.equal(below.commandResponsiveCollapsed, true);
  assert.ok(below.deckWidth >= MIN_DECK_WIDTH);
});

test('deck 최소 폭은 어떤 조합에서도 침범되지 않는다', () => {
  for (let containerWidth = 640; containerWidth <= 1400; containerWidth += 7) {
    for (const sessionCollapsed of [false, true]) {
      for (const commandCollapsed of [false, true]) {
        const result = layout({
          containerWidth,
          sessionCollapsed,
          commandCollapsed,
          preferredSessionWidth: 420,
          preferredCommandWidth: 720
        });
        assert.ok(
          result.deckWidth >= MIN_DECK_WIDTH,
          `${containerWidth}px s=${sessionCollapsed} c=${commandCollapsed}`
            + ` deck=${result.deckWidth}`
        );
        assert.ok(totalWidth(result) <= containerWidth);
      }
    }
  }
});
