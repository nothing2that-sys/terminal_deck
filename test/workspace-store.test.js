const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acquireWorkspaceLock,
  cloneWorkspace,
  cloneWorkspaceState,
  createWorkspace,
  deleteWorkspace,
  initializeWorkspaceStore,
  listWorkspaces,
  loadEphemeralWorkspace,
  loadWorkspace,
  releaseWorkspaceLock,
  saveWorkspace,
  updateWorkspace,
  workspaceIsRunning
} = require('../src/workspace-store');

function temporaryStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'msm-workspaces-'));
}

function runWorker(code, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`worker exited ${exitCode}: ${stderr || stdout}`));
      }
    });
  });
}

async function waitForFiles(files, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => fs.existsSync(file))) {
    if (Date.now() >= deadline) {
      throw new Error('worker readiness timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('legacy state is migrated into a described default workspace', () => {
  const directory = temporaryStore();
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    favorites: [{ id: 'f1', name: '빌드', command: 'npm run build' }],
    tabs: [{
      key: 't1',
      name: '터미널 앱',
      cwd: 'D:\\work',
      history: [{ command: 'git status', timestamp: 1 }]
    }]
  }), 'utf8');

  initializeWorkspaceStore(directory);
  const [workspace] = listWorkspaces(directory);
  const loaded = loadWorkspace(directory, workspace.id);
  assert.equal(workspace.name, '기본 작업 공간');
  assert.match(workspace.description, /기존/);
  assert.equal(workspace.tabCount, 1);
  assert.equal(loaded.state.tabs[0].history[0].command, 'git status');
  assert.equal(loaded.state.favorites[0].name, '빌드');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('concurrent first launches create exactly one default workspace', async () => {
  const directory = temporaryStore();
  const modulePath = require.resolve('../src/workspace-store');
  const worker = [
    'const store = require(process.argv[1]);',
    'store.initializeWorkspaceStore(process.argv[2]);'
  ].join(' ');

  await Promise.all(
    Array.from({ length: 8 }, () => runWorker(worker, [modulePath, directory]))
  );

  const index = JSON.parse(fs.readFileSync(
    path.join(directory, 'workspaces.json'),
    'utf8'
  ));
  const workspaceFiles = fs.readdirSync(path.join(directory, 'workspaces'));
  assert.equal(index.workspaces.length, 1);
  assert.equal(workspaceFiles.length, 1);
  assert.equal(workspaceFiles[0], `${index.workspaces[0].id}.json`);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('concurrent legacy migration preserves one complete migrated workspace', async () => {
  const directory = temporaryStore();
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    tabs: [{ key: 'legacy-tab', name: 'legacy terminal' }],
    favorites: [{ id: 'legacy-favorite', name: 'legacy', command: 'Get-Date' }]
  }), 'utf8');
  const modulePath = require.resolve('../src/workspace-store');
  const worker = [
    'const store = require(process.argv[1]);',
    'store.initializeWorkspaceStore(process.argv[2]);'
  ].join(' ');

  await Promise.all(
    Array.from({ length: 8 }, () => runWorker(worker, [modulePath, directory]))
  );

  const workspaces = listWorkspaces(directory);
  const workspaceFiles = fs.readdirSync(path.join(directory, 'workspaces'));
  assert.equal(workspaces.length, 1);
  assert.equal(workspaceFiles.length, 1);
  const loaded = loadWorkspace(directory, workspaces[0].id).state;
  assert.equal(loaded.tabs[0].key, 'legacy-tab');
  assert.equal(loaded.favorites[0].id, 'legacy-favorite');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('concurrent workspace creators do not lose catalog entries', async () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const modulePath = require.resolve('../src/workspace-store');
  const workers = 6;
  const perWorker = 4;
  const worker = [
    'const store = require(process.argv[1]);',
    'const directory = process.argv[2];',
    'const prefix = process.argv[3];',
    'const count = Number(process.argv[4]);',
    'for (let index = 0; index < count; index += 1) {',
    '  store.createWorkspace(directory, { name: `${prefix}-${index}` });',
    '}'
  ].join(' ');

  await Promise.all(Array.from({ length: workers }, (_, index) => runWorker(
    worker,
    [modulePath, directory, `worker-${index}`, String(perWorker)]
  )));

  const workspaces = listWorkspaces(directory);
  const workspaceFiles = fs.readdirSync(path.join(directory, 'workspaces'));
  assert.equal(workspaces.length, 1 + workers * perWorker);
  assert.equal(workspaceFiles.length, workspaces.length);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('concurrent stale catalog reapers cannot remove a newly published owner', async () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const lockPath = path.join(directory, 'store-locks', 'catalog.lock');
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    pid: 2147483000,
    processStartedAt: 1,
    executablePath: process.execPath,
    instanceToken: 'dead-process',
    acquiredAt: 1
  }), 'utf8');
  const modulePath = require.resolve('../src/workspace-store');
  const worker = [
    'const store = require(process.argv[1]);',
    'store.createWorkspace(process.argv[2], { name: process.argv[3] });'
  ].join(' ');
  await Promise.all(Array.from({ length: 6 }, (_, index) => runWorker(
    worker,
    [modulePath, directory, `reaper-${index}`]
  )));

  assert.equal(listWorkspaces(directory).length, 7);
  assert.equal(fs.existsSync(
    `${lockPath}.retired.22222222-2222-4222-8222-222222222222`
  ), true);
  for (const entry of fs.readdirSync(path.dirname(lockPath))) {
    const ownerPath = path.join(path.dirname(lockPath), entry, 'owner.json');
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(ownerPath, 'utf8')));
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('workspace open and delete are serialized by catalog then workspace lease', async () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'open-delete-race' });
  const modulePath = require.resolve('../src/workspace-store');
  const gate = path.join(directory, 'race.go');
  const finish = path.join(directory, 'race.finish');
  const openerResult = path.join(directory, 'open-result.json');
  const deleteResult = path.join(directory, 'delete-result.json');
  const opener = [
    'const fs = require("node:fs");',
    'const store = require(process.argv[1]);',
    'const wait = new Int32Array(new SharedArrayBuffer(4));',
    'while (!fs.existsSync(process.argv[4])) Atomics.wait(wait, 0, 0, 2);',
    'const lock = store.acquireWorkspaceLock(process.argv[2], process.argv[3]);',
    'fs.writeFileSync(process.argv[5], JSON.stringify({ acquired: Boolean(lock) }));',
    'while (!fs.existsSync(process.argv[6])) Atomics.wait(wait, 0, 0, 2);',
    'if (lock) store.releaseWorkspaceLock(lock);'
  ].join(' ');
  const deleter = [
    'const fs = require("node:fs");',
    'const store = require(process.argv[1]);',
    'const wait = new Int32Array(new SharedArrayBuffer(4));',
    'while (!fs.existsSync(process.argv[4])) Atomics.wait(wait, 0, 0, 2);',
    'const result = store.deleteWorkspace(process.argv[2], process.argv[3]);',
    'fs.writeFileSync(process.argv[5], JSON.stringify(result));'
  ].join(' ');
  const opening = runWorker(opener, [
    modulePath, directory, workspace.id, gate, openerResult, finish
  ]);
  const deleting = runWorker(deleter, [
    modulePath, directory, workspace.id, gate, deleteResult
  ]);
  fs.writeFileSync(gate, 'go', 'utf8');
  await waitForFiles([openerResult, deleteResult]);
  const openOutcome = JSON.parse(fs.readFileSync(openerResult, 'utf8'));
  const deleteOutcome = JSON.parse(fs.readFileSync(deleteResult, 'utf8'));
  fs.writeFileSync(finish, 'finish', 'utf8');
  await Promise.all([opening, deleting]);

  assert.equal(openOutcome.acquired, !deleteOutcome.deleted);
  assert.equal(
    deleteOutcome.deleted || deleteOutcome.reason === 'running',
    true
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('concurrent shared favorite saves merge every writer', async () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const modulePath = require.resolve('../src/workspace-store');
  const workspaces = Array.from(
    { length: 4 },
    (_, index) => createWorkspace(directory, { name: `shared-${index}` })
  );
  const gate = path.join(directory, 'shared-save.go');
  const readyFiles = workspaces.map((_, index) => path.join(directory, `ready-${index}`));
  const worker = [
    'const fs = require("node:fs");',
    'const store = require(process.argv[1]);',
    'const directory = process.argv[2];',
    'const workspaceId = process.argv[3];',
    'const favoriteId = process.argv[4];',
    'const ready = process.argv[5];',
    'const gate = process.argv[6];',
    'const snapshot = store.loadWorkspace(directory, workspaceId).state;',
    'fs.writeFileSync(ready, "ready", "utf8");',
    'const wait = new Int32Array(new SharedArrayBuffer(4));',
    'while (!fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 5);',
    'store.saveWorkspace(directory, workspaceId, {',
    '  ...snapshot,',
    '  favorites: [{ id: favoriteId, name: favoriteId, command: "Get-Date" }]',
    '}, { saveFavorites: true, previousShared: snapshot });'
  ].join(' ');
  const running = workspaces.map((workspace, index) => runWorker(worker, [
    modulePath,
    directory,
    workspace.id,
    `favorite-${index}`,
    readyFiles[index],
    gate
  ]));
  await waitForFiles(readyFiles);
  fs.writeFileSync(gate, 'go', 'utf8');
  await Promise.all(running);

  assert.deepEqual(
    loadWorkspace(directory, workspaces[0].id).state.favorites
      .map(({ id }) => id)
      .sort(),
    workspaces.map((_, index) => `favorite-${index}`)
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('malformed workspace IDs cannot escape the workspace directory', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const maliciousId = '..\\outside-sentinel';
  const sentinel = path.join(directory, 'outside-sentinel.json');
  fs.writeFileSync(sentinel, 'do not delete', 'utf8');
  fs.writeFileSync(path.join(directory, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: [{ id: maliciousId, name: 'malicious' }]
  }), 'utf8');

  assert.deepEqual(deleteWorkspace(directory, maliciousId), {
    deleted: false,
    reason: 'invalid'
  });
  assert.equal(loadWorkspace(directory, maliciousId), null);
  assert.throws(
    () => saveWorkspace(directory, maliciousId, { tabs: [] }),
    { code: 'ERR_INVALID_WORKSPACE_ID' }
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'do not delete');
  assert.deepEqual(listWorkspaces(directory), []);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('case-only workspace ID collisions are quarantined deterministically', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  fs.writeFileSync(path.join(directory, 'workspaces.json'), JSON.stringify({
    version: 1,
    workspaces: [
      { id: 'Workspace', name: 'first' },
      { id: 'workspace', name: 'collision' }
    ]
  }), 'utf8');

  const workspaces = listWorkspaces(directory);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].id, 'Workspace');
  assert.equal(updateWorkspace(directory, 'workspace', {
    name: 'updated through folded lookup'
  }).id, 'Workspace');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('managed workspace directories reject junction redirection', {
  skip: process.platform !== 'win32'
}, () => {
  for (const managedName of ['workspaces', 'workspace-locks', 'store-locks']) {
    const directory = temporaryStore();
    initializeWorkspaceStore(directory);
    const external = temporaryStore();
    const sentinel = path.join(external, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'unchanged', 'utf8');
    const managedPath = path.join(directory, managedName);
    assert.equal(path.dirname(managedPath), directory);
    fs.rmSync(managedPath, { recursive: true });
    fs.symlinkSync(external, managedPath, 'junction');

    assert.throws(
      () => initializeWorkspaceStore(directory),
      { code: 'ERR_UNSAFE_STORE_PATH' }
    );
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
    fs.unlinkSync(managedPath);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test('unsafe catalog and workspace targets fail closed instead of loading defaults', {
  skip: process.platform !== 'win32'
}, () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const [workspace] = listWorkspaces(directory);
  const external = temporaryStore();
  const sentinel = path.join(external, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'unchanged', 'utf8');
  const workspaceFile = path.join(
    directory,
    'workspaces',
    `${workspace.id}.json`
  );
  fs.rmSync(workspaceFile);
  fs.symlinkSync(external, workspaceFile, 'junction');
  assert.throws(
    () => loadWorkspace(directory, workspace.id),
    { code: 'ERR_UNSAFE_STORE_PATH' }
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  fs.unlinkSync(workspaceFile);

  const indexPath = path.join(directory, 'workspaces.json');
  fs.rmSync(indexPath);
  fs.mkdirSync(indexPath);
  assert.throws(
    () => listWorkspaces(directory),
    { code: 'ERR_UNSAFE_STORE_PATH' }
  );
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(external, { recursive: true, force: true });
});

test('workspace lock publish retries then surfaces EPERM without a contender', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'publish-error' });
  const lockPath = path.join(
    directory,
    'workspace-locks',
    `${workspace.id}.lock`
  );
  const originalRename = fs.renameSync;
  let remainingFailures = 3;
  fs.renameSync = (source, target) => {
    if (
      remainingFailures > 0
      && target === lockPath
      && source.includes('.pending.')
    ) {
      remainingFailures -= 1;
      const error = new Error('injected publish denial');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename(source, target);
  };
  try {
    assert.throws(
      () => acquireWorkspaceLock(directory, workspace.id),
      { code: 'EPERM' }
    );
    assert.equal(remainingFailures, 0);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workspace lock release retries transient Windows rename failures', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'release-retry' });
  const lock = acquireWorkspaceLock(directory, workspace.id);
  const originalRename = fs.renameSync;
  let remainingFailures = 2;
  fs.renameSync = (source, target) => {
    if (
      remainingFailures > 0
      && source === lock.filePath
      && target.includes('.released.')
    ) {
      remainingFailures -= 1;
      const error = new Error('injected transient release denial');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename(source, target);
  };
  try {
    assert.equal(releaseWorkspaceLock(lock), true);
    assert.equal(remainingFailures, 0);
    assert.equal(fs.existsSync(lock.filePath), false);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workspace locks reject a reused PID identity and preserve unknown owners', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'lock identity' });
  const lockPath = path.join(
    directory,
    'workspace-locks',
    `${workspace.id}.lock`
  );
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    leaseToken: '11111111-1111-4111-8111-111111111111',
    pid: process.pid,
    processStartedAt: 0,
    executablePath: process.execPath,
    instanceToken: 'previous-process',
    acquiredAt: 1
  }), 'utf8');
  assert.equal(workspaceIsRunning(directory, workspace.id), false);
  assert.equal(fs.existsSync(lockPath), true);
  const reclaimed = acquireWorkspaceLock(directory, workspace.id);
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseToken, '11111111-1111-4111-8111-111111111111');
  releaseWorkspaceLock(reclaimed);
  assert.equal(fs.existsSync(lockPath), false);

  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    pid: process.pid,
    openedAt: Date.now()
  }), 'utf8');
  assert.equal(workspaceIsRunning(directory, workspace.id), true);
  assert.equal(fs.existsSync(lockPath), true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a valid live owner remains locked when native identity is unavailable', async () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'unknown owner' });
  const lockPath = path.join(
    directory,
    'workspace-locks',
    `${workspace.id}.lock`
  );
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  fs.mkdirSync(lockPath, { recursive: true });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    leaseToken: '33333333-3333-4333-8333-333333333333',
    pid: child.pid,
    processStartedAt: 0,
    executablePath: process.execPath,
    instanceToken: 'other-process',
    acquiredAt: 1
  }), 'utf8');

  try {
    assert.equal(workspaceIsRunning(directory, workspace.id), true);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('non-ESRCH process lookup errors preserve the owner fail-closed', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'lookup-error' });
  const lockPath = path.join(
    directory,
    'workspace-locks',
    `${workspace.id}.lock`
  );
  fs.mkdirSync(lockPath);
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    schemaVersion: 1,
    leaseToken: '44444444-4444-4444-8444-444444444444',
    pid: 987654321,
    processStartedAt: 1,
    executablePath: process.execPath,
    instanceToken: 'unknown-process',
    acquiredAt: 1
  }), 'utf8');
  const originalKill = process.kill;
  process.kill = () => {
    const error = new Error('injected lookup denial');
    error.code = 'EACCES';
    throw error;
  };
  try {
    assert.equal(workspaceIsRunning(directory, workspace.id), true);
    assert.equal(acquireWorkspaceLock(directory, workspace.id), null);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    process.kill = originalKill;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workspace metadata can be created, described, and updated', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const created = createWorkspace(directory, {
    name: '검사 시스템',
    description: 'EIS 오류 확인과 배포 작업',
    elevation: 'administrator'
  });
  assert.equal(created.elevation, 'administrator');
  const renamed = updateWorkspace(directory, created.id, {
    name: '검사 시스템 이름 변경',
    description: created.description
  });
  assert.equal(renamed.elevation, 'administrator');
  const updated = updateWorkspace(directory, created.id, {
    name: '검사 시스템 유지보수',
    description: '백엔드와 UI를 함께 점검',
    elevation: 'standard'
  });
  assert.equal(updated.name, '검사 시스템 유지보수');
  assert.equal(updated.description, '백엔드와 UI를 함께 점검');
  assert.equal(updated.elevation, 'standard');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('workspace clone keeps session layout but removes history and provider identity', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const source = createWorkspace(directory, {
    name: '원본',
    description: '복제 테스트',
    elevation: 'administrator'
  });
  saveWorkspace(directory, source.id, {
    tabs: [{
      key: 'session-a',
      name: 'A',
      cwd: 'D:\\work\\a',
      description: '세션 설명',
      shellKind: 'pwsh',
      history: [{ command: 'secret-command', timestamp: 1 }],
      rotationSlot: 1,
      provider: {
        kind: 'claude',
        sessionId: 'provider-secret',
        cliVersion: '1.2.3',
        lastSeenAt: 1
      }
    }]
  });

  const cloned = cloneWorkspace(directory, source.id, {
    name: '복제본',
    description: '새 작업',
    elevation: 'standard'
  });
  const sourceState = loadWorkspace(directory, source.id).state;
  const clonedWorkspace = loadWorkspace(directory, cloned.id);
  assert.equal(cloned.name, '복제본');
  assert.equal(cloned.description, '새 작업');
  assert.equal(cloned.elevation, 'standard');
  assert.equal(clonedWorkspace.state.tabs[0].key, 'session-a');
  assert.equal(clonedWorkspace.state.tabs[0].history.length, 0);
  assert.equal(clonedWorkspace.state.tabs[0].provider, null);
  assert.deepEqual(clonedWorkspace.state.deck, sourceState.deck);
  assert.equal(sourceState.tabs[0].history[0].command, 'secret-command');
  assert.equal(sourceState.tabs[0].provider.sessionId, 'provider-secret');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('clone workspace state is a sanitized independent copy', () => {
  const source = {
    tabs: [{
      key: 'a',
      name: 'A',
      history: [{ command: 'Get-Date', timestamp: 1 }],
      provider: { kind: 'codex', sessionId: 'secret' }
    }]
  };
  const cloned = cloneWorkspaceState(source);
  assert.deepEqual(cloned.tabs[0].history, []);
  assert.equal(cloned.tabs[0].provider, null);
  assert.equal(source.tabs[0].history.length, 1);
});

test('legacy and invalid workspace elevation values normalize to standard', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const legacy = createWorkspace(directory, { name: '기존 작업 공간' });
  assert.equal(legacy.elevation, 'standard');
  const updated = updateWorkspace(directory, legacy.id, {
    name: legacy.name,
    description: legacy.description,
    elevation: 'unexpected'
  });
  assert.equal(updated.elevation, 'standard');
  assert.equal(loadWorkspace(directory, legacy.id).workspace.elevation, 'standard');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('workspace tab history is isolated while favorites stay shared', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const first = createWorkspace(directory, { name: '첫 번째' });
  const second = createWorkspace(directory, { name: '두 번째' });

  saveWorkspace(directory, first.id, {
    favorites: [{ id: 'f1', name: '공용', command: 'Get-Date' }],
    tabs: [{
      key: 'a',
      name: 'A',
      history: [{ command: 'command-a', timestamp: 1 }]
    }]
  }, { saveFavorites: true });
  saveWorkspace(directory, second.id, {
    favorites: [{ id: 'f1', name: '공용', command: 'Get-Date' }],
    tabs: [{
      key: 'b',
      name: 'B',
      history: [{ command: 'command-b', timestamp: 2 }]
    }]
  }, { saveFavorites: true });

  assert.equal(loadWorkspace(directory, first.id).state.tabs[0].name, 'A');
  assert.equal(loadWorkspace(directory, second.id).state.tabs[0].name, 'B');
  assert.equal(loadWorkspace(directory, first.id).state.favorites[0].name, '공용');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('tab-only saves do not overwrite shared changes from another instance', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const first = createWorkspace(directory, { name: '첫 번째' });
  const second = createWorkspace(directory, { name: '두 번째' });

  saveWorkspace(directory, first.id, {
    favorites: [{ id: 'new', name: '새 즐겨찾기', command: 'Get-Date' }],
    tabs: [{ key: 'a', name: 'A' }]
  }, { saveFavorites: true });
  saveWorkspace(directory, second.id, {
    favorites: [],
    tabs: [{ key: 'b', name: 'B' }]
  });

  assert.equal(
    loadWorkspace(directory, second.id).state.favorites[0].name,
    '새 즐겨찾기'
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('favorites added concurrently in different instances are merged by id', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const first = createWorkspace(directory, { name: '첫 번째' });
  const second = createWorkspace(directory, { name: '두 번째' });
  const firstSnapshot = loadWorkspace(directory, first.id).state;
  const secondSnapshot = loadWorkspace(directory, second.id).state;

  saveWorkspace(directory, first.id, {
    ...firstSnapshot,
    favorites: [{ id: 'a', name: 'A', command: 'Get-Date' }]
  }, {
    saveFavorites: true,
    previousShared: firstSnapshot
  });
  saveWorkspace(directory, second.id, {
    ...secondSnapshot,
    favorites: [{ id: 'b', name: 'B', command: 'Get-Location' }]
  }, {
    saveFavorites: true,
    previousShared: secondSnapshot
  });

  assert.deepEqual(
    loadWorkspace(directory, first.id).state.favorites.map(({ id }) => id),
    ['a', 'b']
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a running workspace cannot be opened or deleted twice', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '실행 중 테스트' });
  const lock = acquireWorkspaceLock(directory, workspace.id);
  assert.ok(lock);
  assert.equal(acquireWorkspaceLock(directory, workspace.id), null);
  assert.deepEqual(deleteWorkspace(directory, workspace.id), {
    deleted: false,
    reason: 'running'
  });
  releaseWorkspaceLock(lock);
  assert.deepEqual(deleteWorkspace(directory, workspace.id), {
    deleted: true
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('commandPanelCollapsed는 shared.json에만 저장된다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '패널 접힘' });

  saveWorkspace(directory, workspace.id, {
    settings: {
      commandPanelCollapsed: true,
      commandPanelWidth: 480,
      idleSeconds: 5
    },
    favorites: [{ id: 'f1', name: '빌드', command: 'npm run build' }],
    tabs: [{ key: 'a', name: 'A' }]
  }, { saveSettings: true, saveFavorites: true });

  const sharedJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'shared.json'),
    'utf8'
  ));
  const workspaceJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'workspaces', `${workspace.id}.json`),
    'utf8'
  ));

  assert.equal(sharedJson.settings.commandPanelCollapsed, true);
  assert.equal(sharedJson.settings.commandPanelWidth, 480);
  assert.equal(sharedJson.settings.idleSeconds, 5);
  assert.equal(sharedJson.favorites.length, 1);
  // 작업공간 파일에는 설정을 중복 저장하지 않는다.
  assert.equal('settings' in workspaceJson, false);
  assert.equal(workspaceJson.version, 3);
  assert.ok(workspaceJson.deck);

  const loaded = loadWorkspace(directory, workspace.id).state;
  assert.equal(loaded.settings.commandPanelCollapsed, true);
  assert.equal(loaded.settings.commandPanelWidth, 480);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('세션 패널 폭·접힘도 shared.json에만 저장된다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '세션 패널' });

  saveWorkspace(directory, workspace.id, {
    settings: {
      sessionPanelWidth: 320,
      sessionPanelCollapsed: true,
      commandPanelWidth: 480,
      commandPanelCollapsed: false
    },
    favorites: [{ id: 'f1', name: '빌드', command: 'npm run build' }],
    tabs: [{ key: 'a', name: 'A' }]
  }, { saveSettings: true, saveFavorites: true });

  const sharedJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'shared.json'),
    'utf8'
  ));
  const workspaceJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'workspaces', `${workspace.id}.json`),
    'utf8'
  ));

  assert.equal(sharedJson.settings.sessionPanelWidth, 320);
  assert.equal(sharedJson.settings.sessionPanelCollapsed, true);
  assert.equal(sharedJson.settings.commandPanelWidth, 480);
  assert.equal(sharedJson.version, 1);
  assert.equal('settings' in workspaceJson, false);
  assert.equal('sessionPanelWidth' in workspaceJson, false);
  assert.equal(workspaceJson.version, 3);

  const loaded = loadWorkspace(directory, workspace.id).state;
  assert.equal(loaded.settings.sessionPanelWidth, 320);
  assert.equal(loaded.settings.sessionPanelCollapsed, true);
  // 일회성 작업공간도 같은 shared 설정을 쓴다.
  const ephemeral = loadEphemeralWorkspace(directory).state;
  assert.equal(ephemeral.settings.sessionPanelWidth, 320);
  assert.equal(ephemeral.settings.sessionPanelCollapsed, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('다른 인스턴스가 바꾼 shared 설정과 병합해도 패널 설정이 보존된다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const first = createWorkspace(directory, { name: '첫 번째' });
  const second = createWorkspace(directory, { name: '두 번째' });

  const firstSnapshot = loadWorkspace(directory, first.id).state;
  saveWorkspace(directory, first.id, {
    ...firstSnapshot,
    settings: { ...firstSnapshot.settings, sessionPanelWidth: 300 },
    tabs: [{ key: 'a', name: 'A' }]
  }, { saveSettings: true, previousShared: firstSnapshot });

  // 두 번째 인스턴스는 폭을 모른 채 다른 설정만 바꿔 저장한다.
  const secondSnapshot = loadWorkspace(directory, second.id).state;
  saveWorkspace(directory, second.id, {
    ...secondSnapshot,
    settings: { ...secondSnapshot.settings, idleSeconds: 11 },
    tabs: [{ key: 'b', name: 'B' }]
  }, { saveSettings: true, previousShared: secondSnapshot });

  const merged = loadWorkspace(directory, first.id).state.settings;
  assert.equal(merged.idleSeconds, 11);
  assert.equal(merged.sessionPanelWidth, 300);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('잘못된 commandPanelCollapsed 값은 false로 저장되고 일회성 작업공간도 공유 설정을 쓴다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '정규화' });

  saveWorkspace(directory, workspace.id, {
    settings: { commandPanelCollapsed: 'yes' },
    tabs: []
  }, { saveSettings: true });

  const sharedJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'shared.json'),
    'utf8'
  ));
  assert.equal(sharedJson.settings.commandPanelCollapsed, false);
  assert.equal(
    loadEphemeralWorkspace(directory).state.settings.commandPanelCollapsed,
    false
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('세션 배치는 작업공간 파일에 저장되고 복원된다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '배치 테스트' });

  saveWorkspace(directory, workspace.id, {
    tabs: [
      { key: 'a', name: 'A' },
      { key: 'b', name: 'B' },
      { key: 'c', name: 'C' }
    ],
    deck: {
      version: 1,
      rows: 4,
      columns: 4,
      focusedSessionKey: 'b',
      tiles: [
        {
          id: 'p1',
          kind: 'pinned',
          sessionKey: 'b',
          row: 0,
          column: 0,
          rowSpan: 2,
          columnSpan: 4
        },
        {
          id: 'r1',
          kind: 'rotating',
          rotationIndex: 1,
          currentSessionKey: 'a',
          row: 2,
          column: 0,
          rowSpan: 2,
          columnSpan: 4
        }
      ]
    }
  });

  const { deck, tabs } = loadWorkspace(directory, workspace.id).state;
  assert.deepEqual(deck.tiles.map((tile) => tile.id), ['p1', 'r1']);
  assert.equal(deck.focusedSessionKey, 'b');
  assert.deepEqual(tabs.map((tab) => tab.rotationSlot), [1, null, 1]);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('저장된 workspace JSON은 version 3, shared와 index는 version 1이다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '버전 테스트' });
  saveWorkspace(directory, workspace.id, {
    tabs: [{ key: 'a', name: 'A' }],
    favorites: [{ id: 'f1', name: '빌드', command: 'npm run build' }]
  }, { saveFavorites: true, saveSettings: true });

  const workspaceJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'workspaces', `${workspace.id}.json`),
    'utf8'
  ));
  const sharedJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'shared.json'),
    'utf8'
  ));
  const indexJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'workspaces.json'),
    'utf8'
  ));

  assert.equal(workspaceJson.version, 3);
  assert.ok(workspaceJson.deck);
  assert.equal(sharedJson.version, 1);
  assert.equal(indexJson.version, 1);
  assert.equal(loadWorkspace(directory, workspace.id).state.version, 3);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('미래 workspace 버전은 읽기와 덮어쓰기를 모두 거부한다', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: '미래 버전' });
  const filePath = path.join(directory, 'workspaces', `${workspace.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ version: 4, tabs: [] }), 'utf8');
  assert.throws(
    () => loadWorkspace(directory, workspace.id),
    { code: 'ERR_UNSUPPORTED_STATE_VERSION' }
  );
  assert.throws(
    () => saveWorkspace(directory, workspace.id, { version: 3, tabs: [] }),
    { code: 'ERR_UNSUPPORTED_STATE_VERSION' }
  );
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).version, 4);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('legacy state.json에서 만들어진 작업공간 파일도 version 3으로 저장된다', () => {
  const directory = temporaryStore();
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    tabs: [{ key: 't1', name: '첫 세션' }]
  }), 'utf8');

  initializeWorkspaceStore(directory);
  const [workspace] = listWorkspaces(directory);
  const workspaceJson = JSON.parse(fs.readFileSync(
    path.join(directory, 'workspaces', `${workspace.id}.json`),
    'utf8'
  ));
  assert.equal(workspaceJson.version, 3);
  assert.equal(workspaceJson.deck.tiles[0].currentSessionKey, 't1');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('deck 없는 기존 작업공간은 순환1 타일 하나로 열린다', () => {
  const directory = temporaryStore();
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    tabs: [
      { key: 't1', name: '첫 세션' },
      { key: 't2', name: '두 번째 세션' }
    ],
    activeTabIndex: 1
  }), 'utf8');

  initializeWorkspaceStore(directory);
  const [workspace] = listWorkspaces(directory);
  const { state } = loadWorkspace(directory, workspace.id);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.deck.tiles.length, 1);
  assert.deepEqual(
    {
      kind: state.deck.tiles[0].kind,
      rotationIndex: state.deck.tiles[0].rotationIndex,
      currentSessionKey: state.deck.tiles[0].currentSessionKey,
      rowSpan: state.deck.tiles[0].rowSpan,
      columnSpan: state.deck.tiles[0].columnSpan
    },
    {
      kind: 'rotating',
      rotationIndex: 1,
      currentSessionKey: 't2',
      rowSpan: 4,
      columnSpan: 4
    }
  );
  assert.equal(state.deck.focusedSessionKey, 't2');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('ephemeral workspace loads shared data without persistent tabs', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const ephemeral = loadEphemeralWorkspace(directory);
  assert.equal(ephemeral.workspace.ephemeral, true);
  assert.deepEqual(ephemeral.state.tabs, []);
  assert.equal(ephemeral.state.deck.tiles.length, 1);
  assert.equal(ephemeral.state.deck.tiles[0].rotationIndex, 1);
  assert.equal(ephemeral.state.deck.focusedSessionKey, null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('committed multi-file save rolls forward after process death during apply', async () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const workspace = createWorkspace(directory, { name: 'transaction test' });
  saveWorkspace(directory, workspace.id, {
    favorites: [{ id: 'old', name: 'old', command: 'old' }],
    tabs: [{ key: 'old-tab', name: 'old tab', cwd: directory }]
  }, {
    saveFavorites: true,
    operationId: 'baseline-transaction'
  });

  const modulePath = require.resolve('../src/workspace-store');
  const workspacePath = path.join(
    directory,
    'workspaces',
    `${workspace.id}.json`
  );
  const worker = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const originalRename = fs.renameSync;',
    'const target = path.resolve(process.argv[4]);',
    'fs.renameSync = (source, destination) => {',
    "  if (path.resolve(destination) === target && String(source).endsWith('.tmp')) process.exit(91);",
    '  return originalRename(source, destination);',
    '};',
    'const store = require(process.argv[1]);',
    'store.saveWorkspace(process.argv[2], process.argv[3], {',
    "  favorites: [{ id: 'new', name: 'new', command: 'new' }],",
    "  tabs: [{ key: 'new-tab', name: 'new tab', cwd: process.argv[2] }]",
    '}, { saveFavorites: true, operationId: "crash-roll-forward" });'
  ].join(' ');
  await assert.rejects(
    runWorker(worker, [modulePath, directory, workspace.id, workspacePath]),
    /worker exited 91/
  );

  const transactionRoot = path.join(directory, 'save-transactions');
  assert.ok(fs.existsSync(path.join(
    transactionRoot,
    'crash-roll-forward.committed'
  )));
  const recovered = loadWorkspace(directory, workspace.id);
  assert.equal(recovered.state.tabs[0].key, 'new-tab');
  assert.deepEqual(recovered.state.favorites.map((item) => item.id), ['new']);
  assert.ok(fs.existsSync(path.join(
    transactionRoot,
    'crash-roll-forward.applied'
  )));
  assert.equal(fs.existsSync(path.join(
    transactionRoot,
    'crash-roll-forward.committed'
  )), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('corrupt transaction receipts fail closed', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  const corrupt = path.join(
    directory,
    'save-transactions',
    'corrupt-receipt.applied'
  );
  fs.mkdirSync(corrupt);
  fs.writeFileSync(path.join(corrupt, 'manifest.json'), '{}', 'utf8');
  assert.throws(
    () => initializeWorkspaceStore(directory),
    { code: 'ERR_STORE_RECOVERY_REQUIRED' }
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('ephemeral transaction receipts contain only the persisted shared projection', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  saveWorkspace(directory, null, {
    favorites: [{ id: 'shared', name: 'shared', command: 'echo shared' }],
    tabs: [{
      key: 'secret-tab',
      name: 'secret tab',
      history: [{ command: 'secret command', timestamp: 1 }]
    }]
  }, {
    saveFavorites: true,
    operationId: 'ephemeral-projection'
  });
  const receipt = path.join(
    directory,
    'save-transactions',
    'ephemeral-projection.applied',
    'result.json'
  );
  const receiptText = fs.readFileSync(receipt, 'utf8');
  assert.equal(receiptText.includes('secret-tab'), false);
  assert.equal(receiptText.includes('secret command'), false);
  assert.equal(JSON.parse(receiptText).favorites[0].id, 'shared');
  fs.rmSync(directory, { recursive: true, force: true });
});

test('orphan applied transaction receipts expire after the recovery window', () => {
  const directory = temporaryStore();
  initializeWorkspaceStore(directory);
  saveWorkspace(directory, null, {
    favorites: [{ id: 'shared', name: 'shared', command: 'echo shared' }]
  }, {
    saveFavorites: true,
    operationId: 'expired-receipt'
  });
  const receipt = path.join(
    directory,
    'save-transactions',
    'expired-receipt.applied'
  );
  const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
  fs.utimesSync(receipt, old, old);
  initializeWorkspaceStore(directory);
  assert.equal(fs.existsSync(receipt), false);
  fs.rmSync(directory, { recursive: true, force: true });
});
