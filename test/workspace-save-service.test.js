const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { WorkspaceSaveService } = require('../src/workspace-save-service');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.kills = 0;
  }

  postMessage(message) {
    this.messages.push(message);
  }

  kill() {
    this.kills += 1;
    queueMicrotask(() => this.emit('exit', 0));
    return true;
  }
}

test('workspace save service resolves matching utility-process responses', async () => {
  const child = new FakeChild();
  const service = new WorkspaceSaveService(() => child);
  const saving = service.save({ state: { value: 1 } });
  assert.equal(child.messages.length, 1);
  child.emit('message', {
    requestId: child.messages[0].requestId,
    ok: true,
    saved: { value: 1 }
  });
  assert.deepEqual(await saving, { value: 1 });
  await service.terminate();
});

test('workspace save service rejects errors and process exits', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const children = [first, second];
  const service = new WorkspaceSaveService(() => children.shift());
  const failed = service.save({});
  first.emit('message', {
    requestId: first.messages[0].requestId,
    ok: false,
    error: { code: 'EACCES', message: 'denied' }
  });
  await assert.rejects(failed, { code: 'EACCES', message: 'denied' });
  first.emit('exit', 2);

  const interrupted = service.save({});
  second.emit('exit', 3);
  await assert.rejects(interrupted, { code: 'ERR_WORKSPACE_SAVE_PROCESS_EXIT' });
});

test('terminating the service aborts pending saves and allows restart', async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const children = [first, second];
  const service = new WorkspaceSaveService(() => children.shift());
  const interrupted = service.save({});
  const terminating = service.terminate();
  await assert.rejects(interrupted, { code: 'ERR_WORKSPACE_SAVE_ABORTED' });
  await terminating;
  assert.equal(first.kills, 1);

  const retried = service.save({ state: { value: 2 } });
  second.emit('message', {
    requestId: second.messages[0].requestId,
    ok: true,
    saved: { value: 2 }
  });
  assert.deepEqual(await retried, { value: 2 });
  await service.terminate();
});
