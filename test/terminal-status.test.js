const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createTerminalStatus,
  reduceTerminalStatus,
  terminalStatusView
} = require('../src/terminal-status');

function apply(events) {
  return events.reduce(reduceTerminalStatus, createTerminalStatus(0));
}

test('silence makes a running command quiet but never complete', () => {
  const state = apply([
    { type: 'COMMAND_STARTED', now: 100 },
    { type: 'OUTPUT', now: 200 },
    { type: 'SILENCE_TIMEOUT', now: 3200 }
  ]);
  assert.equal(state.commandInProgress, true);
  assert.deepEqual(terminalStatusView(state), {
    kind: 'quiet', label: '출력 대기', attention: false
  });
});

test('shell-ready never creates completion attention', () => {
  const state = apply([{ type: 'SHELL_READY', now: 100 }]);
  assert.equal(terminalStatusView(state).kind, 'ready');
  assert.equal(state.attention, 'none');
});

test('only command completion creates completion attention and focus clears it', () => {
  let state = apply([
    { type: 'COMMAND_STARTED', now: 100 },
    { type: 'COMMAND_COMPLETED', now: 200, exitCode: 0 }
  ]);
  assert.equal(terminalStatusView(state).kind, 'complete');
  state = reduceTerminalStatus(state, { type: 'FOCUS', now: 300 });
  assert.equal(terminalStatusView(state).kind, 'ready');
  assert.equal(state.completedAt, 200);
});

test('PTY exit overrides running and completed states', () => {
  const runningExit = apply([
    { type: 'COMMAND_STARTED', now: 100 },
    { type: 'PTY_EXIT', now: 200, exitCode: 1 },
    { type: 'COMMAND_COMPLETED', now: 300, exitCode: 0 }
  ]);
  assert.equal(terminalStatusView(runningExit).kind, 'exited');
  assert.equal(runningExit.exitCode, 1);
});

test('nonzero command completion creates failed attention', () => {
  const state = apply([
    { type: 'COMMAND_STARTED', now: 100 },
    { type: 'COMMAND_COMPLETED', now: 200, exitCode: 1 }
  ]);
  assert.deepEqual(terminalStatusView(state), {
    kind: 'failed', label: '명령 실패', attention: true
  });
});
