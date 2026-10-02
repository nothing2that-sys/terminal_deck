const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializePtyLifecycle,
  markPtyExited,
  requestPtyClose,
  shouldRemoveAfterPtyExit
} = require('../src/pty-lifecycle');

function sessionWithPty(kill) {
  return initializePtyLifecycle({ pty: { kill } });
}

test('concurrent PTY close requests share one kill and wait for observed exit', async () => {
  let kills = 0;
  const session = sessionWithPty(() => { kills += 1; });
  const first = requestPtyClose(session, { timeoutMs: 100 });
  const second = requestPtyClose(session, { timeoutMs: 100 });
  assert.equal(first, second);
  assert.equal(kills, 1);
  markPtyExited(session, { exitCode: 0 });
  assert.deepEqual(await first, {
    ok: true,
    status: 'pty-exit-observed',
    exitCode: 0
  });
});

test('PTY kill errors and timeouts remain explicit', async () => {
  const error = new Error('injected kill failure');
  error.code = 'EPERM';
  const failed = sessionWithPty(() => { throw error; });
  assert.deepEqual(await requestPtyClose(failed), {
    ok: false,
    status: 'kill-error',
    error: { code: 'EPERM', message: 'injected kill failure' }
  });
  assert.equal(failed.lifecycle, 'running');

  const timedOut = sessionWithPty(() => {});
  assert.deepEqual(
    await requestPtyClose(timedOut, { timeoutMs: 5 }),
    { ok: false, status: 'kill-timeout' }
  );
  assert.equal(timedOut.lifecycle, 'closing');
  markPtyExited(timedOut, { exitCode: 1 });
  assert.equal(timedOut.lifecycle, 'exited');
});

test('an already exited PTY closes without another kill', async () => {
  let kills = 0;
  const session = sessionWithPty(() => { kills += 1; });
  markPtyExited(session, { exitCode: 0 });
  assert.deepEqual(await requestPtyClose(session), {
    ok: true,
    status: 'already-exited'
  });
  assert.equal(kills, 0);
});

test('process-only termination retains the exited terminal while deletion removes it', () => {
  const session = sessionWithPty(() => {});
  session.lifecycle = 'closing';
  session.retainAfterTermination = true;
  assert.equal(shouldRemoveAfterPtyExit(session), false);
  session.retainAfterTermination = false;
  assert.equal(shouldRemoveAfterPtyExit(session), true);
});
