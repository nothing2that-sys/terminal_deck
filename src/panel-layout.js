const DEFAULT_COMMAND_PANEL_WIDTH = 340;
const MIN_COMMAND_PANEL_WIDTH = 220;
const MAX_COMMAND_PANEL_WIDTH = 720;
const DEFAULT_SESSION_PANEL_WIDTH = 240;
const MIN_SESSION_PANEL_WIDTH = 180;
const MAX_SESSION_PANEL_WIDTH = 420;
// deck(터미널 타일 영역)이 이보다 좁아지면 xterm이 쓸 수 없게 된다.
// 이전 MIN_TERMINAL_WIDTH 정책을 이 이름으로 통합했다.
const MIN_DECK_WIDTH = 280;
const PANEL_RESIZER_WIDTH = 6;
const PANEL_RAIL_WIDTH = 34;

function clampWidth(value, minimum, maximum, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(numeric)));
}

function normalizeCommandPanelWidth(value) {
  return clampWidth(
    value,
    MIN_COMMAND_PANEL_WIDTH,
    MAX_COMMAND_PANEL_WIDTH,
    DEFAULT_COMMAND_PANEL_WIDTH
  );
}

function normalizeSessionPanelWidth(value) {
  return clampWidth(
    value,
    MIN_SESSION_PANEL_WIDTH,
    MAX_SESSION_PANEL_WIDTH,
    DEFAULT_SESSION_PANEL_WIDTH
  );
}

function panelCost(width, collapsed) {
  // 접힌 패널은 rail만 차지하고 splitter를 쓰지 않는다.
  return collapsed ? PANEL_RAIL_WIDTH : width + PANEL_RESIZER_WIDTH;
}

// 양쪽 패널·rail·splitter·deck 최소 폭을 한 번에 계산한다.
//
// 사용자가 저장한 선호 폭(preferred)과 화면에 실제 적용할 폭(effective)을 구분한다.
// 창이 좁아 최소 deck 폭을 지킬 수 없으면 다음 순서로 양보한다.
//   1) 오른쪽 패널을 최소 폭까지 줄인다.
//   2) 왼쪽 패널을 최소 폭까지 줄인다.
//   3) 오른쪽 패널을 임시 rail로 접는다(responsive).
//   4) 그래도 부족하면 왼쪽 패널도 임시 rail로 접는다(responsive).
// responsive 접힘은 저장값을 바꾸지 않으며, 창이 넓어지면 선호 폭으로 되돌아온다.
function fitPanelLayout(input = {}) {
  const preferredSessionWidth = normalizeSessionPanelWidth(
    input.preferredSessionWidth
  );
  const preferredCommandWidth = normalizeCommandPanelWidth(
    input.preferredCommandWidth
  );
  const userSessionCollapsed = input.sessionCollapsed === true;
  const userCommandCollapsed = input.commandCollapsed === true;

  const container = Number(input.containerWidth);
  if (!Number.isFinite(container) || container <= 0) {
    // 컨테이너 폭을 아직 모를 때는 선호 폭을 그대로 쓴다.
    return {
      sessionWidth: preferredSessionWidth,
      commandWidth: preferredCommandWidth,
      deckWidth: MIN_DECK_WIDTH,
      sessionCollapsed: userSessionCollapsed,
      commandCollapsed: userCommandCollapsed,
      sessionResponsiveCollapsed: false,
      commandResponsiveCollapsed: false
    };
  }

  const containerWidth = Math.floor(container);
  let sessionWidth = preferredSessionWidth;
  let commandWidth = preferredCommandWidth;
  let sessionCollapsed = userSessionCollapsed;
  let commandCollapsed = userCommandCollapsed;
  let sessionResponsiveCollapsed = false;
  let commandResponsiveCollapsed = false;

  const deckFor = () => containerWidth
    - panelCost(sessionWidth, sessionCollapsed)
    - panelCost(commandWidth, commandCollapsed);

  // 1) 오른쪽 → 2) 왼쪽 순으로 최소 폭까지 줄인다.
  if (!commandCollapsed && deckFor() < MIN_DECK_WIDTH) {
    commandWidth = Math.max(
      MIN_COMMAND_PANEL_WIDTH,
      commandWidth - (MIN_DECK_WIDTH - deckFor())
    );
  }
  if (!sessionCollapsed && deckFor() < MIN_DECK_WIDTH) {
    sessionWidth = Math.max(
      MIN_SESSION_PANEL_WIDTH,
      sessionWidth - (MIN_DECK_WIDTH - deckFor())
    );
  }

  // 3) 오른쪽 임시 접힘. 접고 나면 남는 폭으로 왼쪽 선호 폭을 되돌린다.
  if (!commandCollapsed && deckFor() < MIN_DECK_WIDTH) {
    commandCollapsed = true;
    commandResponsiveCollapsed = true;
    commandWidth = preferredCommandWidth;
    sessionWidth = preferredSessionWidth;
    if (!sessionCollapsed && deckFor() < MIN_DECK_WIDTH) {
      sessionWidth = Math.max(
        MIN_SESSION_PANEL_WIDTH,
        sessionWidth - (MIN_DECK_WIDTH - deckFor())
      );
    }
  }

  // 4) 왼쪽까지 임시 접힘.
  if (!sessionCollapsed && deckFor() < MIN_DECK_WIDTH) {
    sessionCollapsed = true;
    sessionResponsiveCollapsed = true;
    sessionWidth = preferredSessionWidth;
  }

  return {
    sessionWidth,
    commandWidth,
    deckWidth: Math.max(0, deckFor()),
    sessionCollapsed,
    commandCollapsed,
    sessionResponsiveCollapsed,
    commandResponsiveCollapsed
  };
}

module.exports = {
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
};
