const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  BROKER_FLAG,
  JsonLineChannel,
  parseBrokerArguments
} = require('../src/elevated-pty-protocol');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyedWith = null;
  }
  write(value) { this.writes.push(value); }
  end() { this.emit('close'); }
  destroy(error) { this.destroyedWith = error; }
}

test('broker arguments require a strong token, scoped pipe, and parent PID', () => {
  const token = 'a'.repeat(64);
  const parsed = parseBrokerArguments([
    BROKER_FLAG,
    `--broker-token=${token}`,
    '--broker-pipe=\\\\.\\pipe\\terminal-deck-1234-abcdefabcdef',
    '--broker-parent-pid=1234'
  ], {});
  assert.deepEqual(parsed, {
    token,
    pipeName: '\\\\.\\pipe\\terminal-deck-1234-abcdefabcdef',
    parentPid: 1234
  });
  assert.equal(parseBrokerArguments([]), null);
  assert.throws(
    () => parseBrokerArguments([BROKER_FLAG, '--broker-token=weak'], {}),
    { code: 'ERR_INVALID_BROKER_ARGUMENTS' }
  );
});

test('JSON line channel frames messages and rejects oversized input', () => {
  const socket = new FakeSocket();
  const channel = new JsonLineChannel(socket, { maxBytes: 64 });
  const messages = [];
  channel.on('message', (message) => messages.push(message));
  socket.emit('data', Buffer.from('{"type":"ping"}\n{"type":'));
  socket.emit('data', Buffer.from('"pong"}\n'));
  assert.deepEqual(messages, [{ type: 'ping' }, { type: 'pong' }]);
  channel.send({ type: 'ok' });
  assert.equal(socket.writes[0].toString(), '{"type":"ok"}\n');
  socket.emit('data', Buffer.alloc(65, 0x61));
  assert.equal(socket.destroyedWith.code, 'ERR_BROKER_MESSAGE_TOO_LARGE');
});

test('JSON line channel accepts coalesced frames whose individual sizes are bounded', () => {
  const socket = new FakeSocket();
  const channel = new JsonLineChannel(socket, { maxBytes: 32 });
  const messages = [];
  channel.on('message', (message) => messages.push(message));
  const frame = '{"type":"ok"}\n';
  socket.emit('data', Buffer.from(frame.repeat(4)));
  assert.equal(messages.length, 4);
  assert.equal(socket.destroyedWith, null);
});
