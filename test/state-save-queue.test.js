const test = require('node:test');
const assert = require('node:assert/strict');
const { StateSaveQueue } = require('../src/state-save-queue');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

test('state saves commit serially and stale revisions cannot overwrite newer state', async () => {
  const firstGate = deferred();
  const commits = [];
  const queue = new StateSaveQueue(async (state, metadata) => {
    if (metadata.revision === 1) {
      await firstGate.promise;
    }
    commits.push({ state, ...metadata });
  }, { epoch: 'epoch-1' });

  const first = queue.enqueue({
    saveEpoch: 'epoch-1', revision: 1, state: { value: 'first' }
  });
  const newest = queue.enqueue({
    saveEpoch: 'epoch-1', revision: 3, state: { value: 'newest' }
  });
  const stale = queue.enqueue({
    saveEpoch: 'epoch-1', revision: 2, state: { value: 'stale' }
  });
  firstGate.resolve();

  assert.equal((await first).saved, true);
  assert.equal((await newest).saved, true);
  assert.deepEqual(await stale, {
    ok: true,
    saved: false,
    stale: true,
    saveEpoch: 'epoch-1',
    revision: 2,
    committedRevision: 3,
    requestId: null
  });
  assert.deepEqual(commits.map(({ state }) => state.value), ['first', 'newest']);
});

test('failed state save does not advance the committed revision', async () => {
  let fail = true;
  const commits = [];
  const queue = new StateSaveQueue(async (state) => {
    if (fail) {
      fail = false;
      throw new Error('injected save failure');
    }
    commits.push(state);
  }, { epoch: 'epoch-2' });

  await assert.rejects(
    queue.enqueue({
      saveEpoch: 'epoch-2', revision: 1, state: { value: 'failed' }
    }),
    /injected save failure/u
  );
  const retried = await queue.enqueue({
    saveEpoch: 'epoch-2',
    revision: 1,
    state: { value: 'retried' },
    requestId: 'close-1'
  });
  assert.equal(retried.saved, true);
  assert.equal(retried.requestId, 'close-1');
  assert.deepEqual(commits, [{ value: 'retried' }]);
});

test('invalid revisions fail before commit', async () => {
  const queue = new StateSaveQueue(() => {
    throw new Error('must not run');
  }, { epoch: 'epoch-3' });
  await assert.rejects(
    queue.enqueue({ saveEpoch: 'epoch-3', revision: 0, state: {} }),
    { code: 'ERR_INVALID_SAVE_REVISION' }
  );
});

test('epoch, duplicate revisions, close phase, and final seal are fenced', async () => {
  const commits = [];
  const queue = new StateSaveQueue(async (state) => commits.push(state), {
    epoch: 'epoch-close'
  });
  await assert.rejects(
    queue.enqueue({ saveEpoch: 'old', revision: 1, state: {} }),
    { code: 'ERR_SAVE_EPOCH_MISMATCH' }
  );
  const request = {
    saveEpoch: 'epoch-close', revision: 1, state: { value: 1 }
  };
  const first = queue.enqueue(request);
  assert.equal(queue.enqueue(request), first);
  await first;
  await assert.rejects(
    queue.enqueue({
      saveEpoch: 'epoch-close', revision: 1, state: { value: 'conflict' }
    }),
    { code: 'ERR_SAVE_REVISION_CONFLICT' }
  );

  const close = queue.beginClose();
  assert.deepEqual(close, { saveEpoch: 'epoch-close', minimumRevision: 2 });
  await assert.rejects(
    queue.enqueue({
      saveEpoch: 'epoch-close', revision: 2, state: {}, kind: 'normal'
    }),
    { code: 'ERR_CLOSE_IN_PROGRESS' }
  );
  await assert.rejects(
    queue.enqueue({
      saveEpoch: 'epoch-close',
      revision: 1,
      state: { value: 'old-final' },
      kind: 'final',
      requestId: 'close-request'
    }),
    { code: 'ERR_FINAL_SAVE_REVISION_TOO_OLD' }
  );
  const final = await queue.enqueue({
    saveEpoch: 'epoch-close',
    revision: 2,
    state: { value: 'final' },
    kind: 'final',
    requestId: 'close-request'
  });
  queue.seal(final.revision);
  await assert.rejects(
    queue.enqueue({
      saveEpoch: 'epoch-close', revision: 3, state: { value: 'late' }
    }),
    { code: 'ERR_SAVE_QUEUE_SEALED' }
  );
  assert.deepEqual(commits, [{ value: 1 }, { value: 'final' }]);
});
