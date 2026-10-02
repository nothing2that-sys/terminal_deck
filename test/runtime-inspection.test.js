const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseAheadBehind,
  parseGitPorcelain,
  queryGitContext
} = require('../src/runtime-inspection');

test('git porcelain counts staged, unstaged, untracked, and conflicts separately', () => {
  assert.deepEqual(parseGitPorcelain([
    'M  staged.txt',
    ' M unstaged.txt',
    '?? new.txt',
    'UU conflict.txt'
  ].join('\n')), {
    changedCount: 4,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 1,
    conflictedCount: 1
  });
  assert.deepEqual(parseAheadBehind('3\t2'), { ahead: 3, behind: 2 });
  assert.deepEqual(parseAheadBehind('unknown'), { ahead: null, behind: null });
});

test('git context reports detached state, change counts, and upstream distance', async () => {
  let statusOptions;
  const execute = async (_file, args, options) => {
    const command = args.slice(2).join(' ');
    if (command === 'rev-parse --show-toplevel') return 'D:\\repo';
    if (command === 'symbolic-ref --short HEAD') throw new Error('detached');
    if (command === 'rev-parse --short HEAD') return 'abc1234';
    if (command.startsWith('status --porcelain=v1')) {
      statusOptions = options;
      return ' M a.txt\n?? b.txt';
    }
    if (command.startsWith('rev-list --left-right')) return '2\t1';
    throw new Error(`unexpected git command: ${command}`);
  };
  assert.deepEqual(await queryGitContext('D:\\repo', execute, () => 1234), {
    status: 'ok',
    root: 'D:\\repo',
    branch: 'abc1234',
    detached: true,
    dirty: true,
    changedCount: 2,
    stagedCount: 0,
    unstagedCount: 1,
    untrackedCount: 1,
    conflictedCount: 0,
    ahead: 2,
    behind: 1,
    checkedAt: 1234
  });
  assert.deepEqual(statusOptions, { trimOutput: false });
});

test('git context distinguishes non-repository and missing git executable', async () => {
  const nonRepository = new Error('failed');
  nonRepository.stderr = 'fatal: not a git repository';
  assert.deepEqual(
    await queryGitContext('D:\\plain', async () => { throw nonRepository; }, () => 1),
    { status: 'not-repository', checkedAt: 1 }
  );
  const unavailable = new Error('spawn git ENOENT');
  unavailable.code = 'ENOENT';
  assert.deepEqual(
    await queryGitContext('D:\\plain', async () => { throw unavailable; }, () => 2),
    { status: 'unavailable', checkedAt: 2 }
  );
});
