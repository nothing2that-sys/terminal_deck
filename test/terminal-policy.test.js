const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTerminalShortcutAction,
  normalizeTerminalSize
} = require('../src/terminal-policy');

function keyboardEvent(overrides = {}) {
  return {
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides
  };
}

test('Ctrl+C interrupts the terminal when there is no selection', () => {
  const action = getTerminalShortcutAction(
    keyboardEvent({ code: 'KeyC', ctrlKey: true }),
    false
  );

  assert.equal(action, 'terminal');
});

test('Ctrl+C copies when text is selected', () => {
  const action = getTerminalShortcutAction(
    keyboardEvent({ code: 'KeyC', ctrlKey: true }),
    true
  );

  assert.equal(action, 'copy');
});

test('Ctrl+Shift+C is the explicit copy shortcut', () => {
  const action = getTerminalShortcutAction(
    keyboardEvent({ code: 'KeyC', ctrlKey: true, shiftKey: true }),
    true
  );

  assert.equal(action, 'copy');
});

test('Ctrl+V and Ctrl+Shift+V use the host text paste path once', () => {
  assert.equal(
    getTerminalShortcutAction(
      keyboardEvent({ code: 'KeyV', ctrlKey: true }),
      false
    ),
    'paste'
  );
  assert.equal(
    getTerminalShortcutAction(
      keyboardEvent({ code: 'KeyV', ctrlKey: true, shiftKey: true }),
      false
    ),
    'paste'
  );
});

test('AltGr-like Ctrl+Alt combinations remain terminal input', () => {
  const action = getTerminalShortcutAction(
    keyboardEvent({ code: 'KeyV', ctrlKey: true, altKey: true }),
    false
  );

  assert.equal(action, 'terminal');
});

test('terminal size validation accepts only bounded integer dimensions', () => {
  assert.deepEqual(
    normalizeTerminalSize({ cols: 120, rows: 30 }),
    { cols: 120, rows: 30 }
  );
  assert.equal(normalizeTerminalSize({ cols: 0, rows: 30 }), null);
  assert.equal(normalizeTerminalSize({ cols: 120.5, rows: 30 }), null);
  assert.equal(normalizeTerminalSize({ cols: 120, rows: 1001 }), null);
});
