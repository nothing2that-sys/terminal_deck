const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BrokerPtyProxy,
  brokerLaunchArguments,
  isAuthenticatedBrokerMessage
} = require('../src/elevated-pty-client');

test('broker launch carries the one-time token across RunAs as an argument', () => {
  const token = 'a'.repeat(64);
  const args = brokerLaunchArguments({
    isPackaged: false,
    appPath: 'D:\\Terminal Deck',
    token,
    pipeName: '\\\\.\\pipe\\terminal-deck-1234-abcdefabcdef',
    parentPid: 1234
  });
  assert.equal(args[0], 'D:\\Terminal Deck');
  assert.equal(args.includes(`--broker-token=${token}`), true);
  assert.equal(args.includes('--broker-parent-pid=1234'), true);
});

test('broker startup messages require the one-time token and parent PID', () => {
  const token = 'a'.repeat(64);
  assert.equal(isAuthenticatedBrokerMessage({
    token,
    parentPid: 1234
  }, token, 1234), true);
  assert.equal(isAuthenticatedBrokerMessage({
    token: 'b'.repeat(64),
    parentPid: 1234
  }, token, 1234), false);
  assert.equal(isAuthenticatedBrokerMessage({
    token,
    parentPid: 9999
  }, token, 1234), false);
});

test('broker PTY proxy exposes node-pty compatible lifecycle callbacks', async () => {
  const requests = [];
  const client = {
    request: async (type, payload) => {
      requests.push({ type, payload });
      return {};
    }
  };
  const proxy = new BrokerPtyProxy(client, 'session-1', 1234);
  const data = [];
  const exits = [];
  proxy.onData((value) => data.push(value));
  proxy.onExit((value) => exits.push(value));
  proxy.write('hello');
  proxy.resize(100, 40);
  await proxy.kill();
  proxy.emitData('output');
  proxy.emitExit(0);
  assert.deepEqual(data, ['output']);
  assert.deepEqual(exits, [{ exitCode: 0 }]);
  assert.deepEqual(requests.map((item) => item.type), ['write', 'resize', 'kill']);
});

test('broker proxy replays output and exit that arrive before listeners', async () => {
  const proxy = new BrokerPtyProxy({ request: async () => ({}) }, 'session-2', 99);
  proxy.emitData('early prompt');
  proxy.emitExit(0);
  const data = [];
  const exits = [];
  proxy.onData((value) => data.push(value));
  proxy.onExit((value) => exits.push(value));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(data, ['early prompt']);
  assert.deepEqual(exits, [{ exitCode: 0 }]);
});

test('broker proxy chunks large writes and preserves Enter ordering', async () => {
  const requests = [];
  const proxy = new BrokerPtyProxy({
    request: async (type, payload) => { requests.push({ type, payload }); }
  }, 'session-3', 100);
  proxy.write('x'.repeat(70_000));
  proxy.write('\r');
  await proxy.kill();
  const writes = requests.filter((item) => item.type === 'write');
  assert.equal(writes.length > 2, true);
  assert.equal(writes.at(-1).payload.data, '\r');
  assert.equal(writes.slice(0, -1).map((item) => item.payload.data).join('').length, 70_000);
  assert.equal(requests.at(-1).type, 'kill');
});

test('failed write suppresses already queued Enter but later input can recover', async () => {
  const requests = [];
  let fail = true;
  const proxy = new BrokerPtyProxy({
    request: async (type, payload) => {
      requests.push({ type, payload });
      if (type === 'write' && fail) {
        fail = false;
        throw new Error('temporary failure');
      }
    }
  }, 'session-4', 101);
  const errors = [];
  proxy.onOperationError((error) => errors.push(error.message));
  proxy.write('paste');
  proxy.write('\r');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests.map((item) => item.payload.data), ['paste']);
  proxy.write('retry');
  await proxy.kill();
  assert.equal(requests.some((item) => item.payload?.data === 'retry'), true);
  assert.equal(errors.length >= 1, true);
});
