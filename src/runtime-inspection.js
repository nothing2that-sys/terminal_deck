const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parseVersion, providerCapabilities } = require('./provider-adapter');

const execFileAsync = promisify(execFile);
const EXEC_OPTIONS = {
  timeout: 2500,
  maxBuffer: 64 * 1024,
  windowsHide: true,
  encoding: 'utf8'
};

async function run(file, args, options = {}) {
  const { trimOutput = true, ...execOptions } = options;
  const result = await execFileAsync(file, args, {
    ...EXEC_OPTIONS,
    ...execOptions,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...execOptions.env }
  });
  const stdout = String(result.stdout || '');
  return trimOutput ? stdout.trim() : stdout.replace(/\r?\n$/u, '');
}

async function discoverProvider(kind) {
  if (!['claude', 'codex'].includes(kind)) {
    return { kind, available: false, error: 'unsupported' };
  }
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const located = (await run(locator, [kind])).split(/\r?\n/u)[0];
    if (!located || !path.isAbsolute(located)) {
      throw new Error('absolute executable path not found');
    }
    const extension = path.extname(located).toLowerCase();
    if ((extension === '.cmd' || extension === '.bat') && /["%&|<>^!]/u.test(located)) {
      throw new Error('unsafe command shim path');
    }
    const stdout = extension === '.cmd' || extension === '.bat'
      ? await run(process.env.ComSpec || 'cmd.exe', [
          '/d', '/s', '/c', `""${located.replaceAll('"', '""')}" --version"`
        ])
      : await run(located, ['--version']);
    const version = parseVersion(stdout);
    return {
      kind,
      available: true,
      path: located,
      version,
      capabilities: providerCapabilities(kind, version)
    };
  } catch (error) {
    return {
      kind,
      available: false,
      error: error.code || error.message || 'discovery-failed'
    };
  }
}

function parseGitPorcelain(text) {
  const lines = String(text || '').split(/\r?\n/u).filter(Boolean);
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;
  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (const line of lines) {
    const code = line.slice(0, 2);
    if (code === '??') {
      untrackedCount += 1;
      continue;
    }
    if (conflictCodes.has(code)) {
      conflictedCount += 1;
      continue;
    }
    if (code[0] && code[0] !== ' ') stagedCount += 1;
    if (code[1] && code[1] !== ' ') unstagedCount += 1;
  }
  return {
    changedCount: lines.length,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount
  };
}

function parseAheadBehind(text) {
  const match = String(text || '').trim().match(/^(\d+)\s+(\d+)$/u);
  return match
    ? { ahead: Number(match[1]), behind: Number(match[2]) }
    : { ahead: null, behind: null };
}

function gitFailureStatus(error) {
  if (error?.code === 'ENOENT') return 'unavailable';
  const detail = `${error?.stderr || ''}\n${error?.message || ''}`;
  return /not a git repository|outside repository/iu.test(detail)
    ? 'not-repository'
    : 'error';
}

async function queryGitContext(cwd, execute = run, now = Date.now) {
  const checkedAt = now();
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4096) {
    return { status: 'invalid', checkedAt };
  }
  try {
    const root = await execute('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
    let branch;
    let detached = false;
    try {
      branch = await execute('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD']);
    } catch {
      branch = await execute('git', ['-C', cwd, 'rev-parse', '--short', 'HEAD']);
      detached = true;
    }
    const porcelain = await execute(
      'git',
      ['-C', cwd, 'status', '--porcelain=v1', '--untracked-files=all'],
      { trimOutput: false }
    );
    const changes = parseGitPorcelain(porcelain);
    let tracking = { ahead: null, behind: null };
    try {
      tracking = parseAheadBehind(await execute('git', [
        '-C', cwd, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'
      ]));
    } catch {
      // upstream이 없는 branch는 정상이므로 추적 정보만 비운다.
    }
    return {
      status: 'ok',
      root,
      branch,
      detached,
      dirty: changes.changedCount > 0,
      ...changes,
      ...tracking,
      checkedAt
    };
  } catch (error) {
    return { status: gitFailureStatus(error), checkedAt };
  }
}

module.exports = {
  discoverProvider,
  parseAheadBehind,
  parseGitPorcelain,
  queryGitContext
};
