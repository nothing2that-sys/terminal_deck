const assert = require('node:assert/strict');
const test = require('node:test');
const { mergeLiveAndUnrestoredTabs } = require('../src/restore-policy');

test('failed restore metadata survives saves without duplicating live tabs', () => {
  const live = [{ key: 'live', name: '실행 중' }];
  const failed = [
    { key: 'failed', name: '복원 실패' },
    { key: 'live', name: '예전 메타데이터' }
  ];
  assert.deepEqual(mergeLiveAndUnrestoredTabs(live, failed), [
    live[0],
    failed[0]
  ]);
});

test('all failed restore tabs remain intact when there are no live tabs', () => {
  const failed = Array.from({ length: 32 }, (_, index) => ({
    key: `failed-${index}`
  }));
  assert.deepEqual(mergeLiveAndUnrestoredTabs([], failed), failed);
});
