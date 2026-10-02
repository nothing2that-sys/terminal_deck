const assert = require('node:assert/strict');
const test = require('node:test');
const {
  matchesSearchQuery,
  nextSelectionIndex,
  relativeTimeLabel,
  sortAttentionEntries
} = require('../src/session-productivity');

test('quick switcher search requires every query term regardless of case', () => {
  const searchable = '테스트 서버 D:\\project feature/login 순환 2 명령 실패';
  assert.equal(matchesSearchQuery(searchable, 'FEATURE/login 순환'), true);
  assert.equal(matchesSearchQuery(searchable, '테스트 실패'), true);
  assert.equal(matchesSearchQuery(searchable, '테스트 완료'), false);
});

test('attention entries prioritize failures then exits then completions', () => {
  const entries = sortAttentionEntries([
    { kind: 'complete', occurredAt: 30, name: '완료' },
    { kind: 'failed', occurredAt: 10, name: '이전 실패' },
    { kind: 'exited', occurredAt: 40, name: '종료' },
    { kind: 'failed', occurredAt: 50, name: '최근 실패' }
  ]);
  assert.deepEqual(entries.map((entry) => entry.name), [
    '최근 실패', '이전 실패', '종료', '완료'
  ]);
});

test('relative time and wrapped keyboard selection stay bounded', () => {
  assert.equal(relativeTimeLabel(1_000, 46_000), '45초 전');
  assert.equal(relativeTimeLabel(1_000, 181_000), '3분 전');
  assert.equal(nextSelectionIndex(0, -1, 3), 2);
  assert.equal(nextSelectionIndex(2, 1, 3), 0);
  assert.equal(nextSelectionIndex(0, 1, 0), -1);
});
