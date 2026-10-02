const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { taskkillTree, terminatePtyTree } = require('../src/pty-tree');

function fakeSpawnWithExit(exitCode, calls) {
  return (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', exitCode));
    return child;
  };
}

test('Windows PTY termination targets the full task tree', async () => {
  const calls = [];
  let directKills = 0;
  await terminatePtyTree({ pid: 1234, kill: () => { directKills += 1; } }, {
    platform: 'win32',
    spawn: fakeSpawnWithExit(0, calls)
  });
  assert.equal(directKills, 0);
  assert.match(calls[0][0], /(?:System32[\\/])?taskkill\.exe$/u);
  assert.deepEqual(calls[0][1], ['/PID', '1234', '/T', '/F']);
});

test('non-Windows PTY termination uses the native PTY kill', async () => {
  let kills = 0;
  await terminatePtyTree({ pid: 1234, kill: () => { kills += 1; } }, {
    platform: 'linux'
  });
  assert.equal(kills, 1);
});

test('taskkill failures remain explicit', async () => {
  await assert.rejects(
    taskkillTree(1234, fakeSpawnWithExit(1, [])),
    { code: 'ERR_PTY_TREE_KILL' }
  );
});
