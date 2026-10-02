const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { normalizeState } = require('./state-store');
const {
  isValidWorkspaceId,
  requireWorkspaceId,
  resolveContainedPath,
  workspaceIdKey
} = require('./workspace-id');

const WORKSPACE_INDEX_VERSION = 1;
// 세션 배치(deck)가 추가된 작업공간 state 형식이다. shared.json과 workspaces.json 버전과는 별개다.
const WORKSPACE_STATE_VERSION = 3;
const SHARED_STATE_VERSION = 1;
const MAX_WORKSPACES = 100;
const MAX_WORKSPACE_NAME_LENGTH = 80;
const MAX_WORKSPACE_DESCRIPTION_LENGTH = 500;
const WORKSPACE_ELEVATIONS = new Set(['standard', 'administrator']);
const STORE_LOCK_WAIT_MS = 5_000;
const STORE_LOCK_RETRY_MS = 10;
const TRANSACTION_RECEIPT_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_TRANSACTION_RECEIPTS = 32;
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);
const PROCESS_INSTANCE_TOKEN = randomUUID();
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function boundedString(value, maxLength, fallback = '') {
  return typeof value === 'string'
    ? value.slice(0, maxLength)
    : fallback;
}

function writeJsonAtomic(filePath, value) {
  assertRegularFileOrMissing(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify(value, null, 2)}\n`,
      'utf8'
    );
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporaryPath, filePath);
        break;
      } catch (error) {
        if (
          attempt >= 9
          || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)
        ) {
          throw error;
        }
        sleepSync(5 * (attempt + 1));
      }
    }
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readJson(filePath, fallback) {
  try {
    assertRegularFileOrMissing(filePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ERR_UNSAFE_STORE_PATH') {
      throw error;
    }
    if (error.code !== 'ENOENT') {
      console.warn(`${path.basename(filePath)} 파일을 읽지 못했습니다: ${error.message}`);
    }
    return fallback;
  }
}

function pathsFor(baseDirectory) {
  return {
    index: path.join(baseDirectory, 'workspaces.json'),
    shared: path.join(baseDirectory, 'shared.json'),
    legacy: path.join(baseDirectory, 'state.json'),
    workspaces: path.join(baseDirectory, 'workspaces'),
    locks: path.join(baseDirectory, 'workspace-locks'),
    storeLocks: path.join(baseDirectory, 'store-locks'),
    transactions: path.join(baseDirectory, 'save-transactions')
  };
}

function transactionError(message) {
  const error = new Error(message);
  error.code = 'ERR_STORE_RECOVERY_REQUIRED';
  return error;
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeTextDurable(filePath, value) {
  assertRegularFileOrMissing(filePath);
  const descriptor = fs.openSync(filePath, 'wx');
  try {
    fs.writeFileSync(descriptor, value, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateOperationId(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value);
}

function transactionPath(baseDirectory, operationId, phase) {
  if (!validateOperationId(operationId) || !['prepared', 'committed', 'applied'].includes(phase)) {
    throw transactionError('상태 저장 transaction 식별자가 유효하지 않습니다.');
  }
  return resolveContainedPath(
    ensureManagedDirectory(baseDirectory, 'save-transactions'),
    `${operationId}.${phase}`
  );
}

function assertTransactionDirectory(directoryPath) {
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw transactionError('상태 저장 transaction 경로가 안전한 디렉터리가 아닙니다.');
  }
  const root = fs.realpathSync.native(path.dirname(directoryPath));
  const actual = fs.realpathSync.native(directoryPath);
  if (!samePath(actual, path.join(root, path.basename(directoryPath)))) {
    throw transactionError('상태 저장 transaction 경로가 저장소를 벗어났습니다.');
  }
}

function readTransactionJson(filePath) {
  assertRegularFileOrMissing(filePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw transactionError(
      `${path.basename(filePath)} transaction 파일을 검증하지 못했습니다: ${error.message}`
    );
  }
}

function transactionTarget(baseDirectory, manifest, target) {
  if (target.kind === 'shared') {
    return pathsFor(baseDirectory).shared;
  }
  if (target.kind === 'index') {
    return pathsFor(baseDirectory).index;
  }
  if (target.kind === 'workspace' && isValidWorkspaceId(manifest.workspaceId)) {
    return workspaceFilePath(baseDirectory, manifest.workspaceId);
  }
  throw transactionError('상태 저장 transaction target이 유효하지 않습니다.');
}

function loadTransaction(directoryPath) {
  assertTransactionDirectory(directoryPath);
  const manifest = readTransactionJson(path.join(directoryPath, 'manifest.json'));
  if (
    manifest?.version !== 1
    || !validateOperationId(manifest.operationId)
    || !Array.isArray(manifest.targets)
    || manifest.targets.length < 1
    || manifest.targets.length > 3
  ) {
    throw transactionError('상태 저장 transaction manifest가 유효하지 않습니다.');
  }
  const seen = new Set();
  if (
    typeof manifest.resultFile !== 'string'
    || path.basename(manifest.resultFile) !== manifest.resultFile
    || typeof manifest.resultSha256 !== 'string'
  ) {
    throw transactionError('상태 저장 transaction 결과 선언이 유효하지 않습니다.');
  }
  const payloads = manifest.targets.map((target) => {
    if (
      !target
      || !['shared', 'workspace', 'index'].includes(target.kind)
      || seen.has(target.kind)
      || typeof target.file !== 'string'
      || path.basename(target.file) !== target.file
      || typeof target.sha256 !== 'string'
    ) {
      throw transactionError('상태 저장 transaction payload 선언이 유효하지 않습니다.');
    }
    seen.add(target.kind);
    const payloadPath = path.join(directoryPath, target.file);
    assertRegularFileOrMissing(payloadPath);
    const text = fs.readFileSync(payloadPath, 'utf8');
    if (hashText(text) !== target.sha256) {
      throw transactionError(`${target.kind} transaction payload hash가 일치하지 않습니다.`);
    }
    return { target, text };
  });
  const resultPath = path.join(directoryPath, manifest.resultFile);
  assertRegularFileOrMissing(resultPath);
  const resultText = fs.readFileSync(resultPath, 'utf8');
  if (hashText(resultText) !== manifest.resultSha256) {
    throw transactionError('상태 저장 transaction 결과 hash가 일치하지 않습니다.');
  }
  let result;
  try {
    result = JSON.parse(resultText);
  } catch (error) {
    throw transactionError(`상태 저장 transaction 결과가 유효하지 않습니다: ${error.message}`);
  }
  return { manifest, payloads, result };
}

function publishTextAtomic(filePath, value) {
  assertRegularFileOrMissing(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, value, 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function applyCommittedTransaction(baseDirectory, committedPath) {
  const { manifest, payloads } = loadTransaction(committedPath);
  for (const { target, text } of payloads) {
    publishTextAtomic(transactionTarget(baseDirectory, manifest, target), text);
  }
  const appliedPath = transactionPath(baseDirectory, manifest.operationId, 'applied');
  if (fs.existsSync(appliedPath)) {
    throw transactionError('같은 상태 저장 transaction receipt가 이미 존재합니다.');
  }
  fs.renameSync(committedPath, appliedPath);
  return { manifest, appliedPath };
}

function recoverWorkspaceTransactionsUnlocked(baseDirectory) {
  const root = ensureManagedDirectory(baseDirectory, 'save-transactions');
  const appliedReceipts = [];
  for (const name of fs.readdirSync(root).sort()) {
    const match = /^([A-Za-z0-9][A-Za-z0-9-]{0,127})\.(prepared|committed|applied)$/.exec(name);
    if (!match) {
      throw transactionError(`알 수 없는 상태 저장 transaction 항목입니다: ${name}`);
    }
    const directoryPath = resolveContainedPath(root, name);
    assertTransactionDirectory(directoryPath);
    if (match[2] === 'prepared') {
      fs.rmSync(directoryPath, { recursive: true });
    } else if (match[2] === 'committed') {
      applyCommittedTransaction(baseDirectory, directoryPath);
    } else {
      loadTransaction(directoryPath);
      appliedReceipts.push({
        directoryPath,
        modifiedAt: fs.statSync(directoryPath).mtimeMs
      });
    }
  }
  appliedReceipts.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const now = Date.now();
  for (const [index, receipt] of appliedReceipts.entries()) {
    if (
      index >= MAX_TRANSACTION_RECEIPTS
      || now - receipt.modifiedAt > TRANSACTION_RECEIPT_MAX_AGE_MS
    ) {
      assertTransactionDirectory(receipt.directoryPath);
      fs.rmSync(receipt.directoryPath, { recursive: true });
    }
  }
}

function createWorkspaceTransaction(
  baseDirectory,
  operationId,
  workspaceId,
  payloadValues,
  result
) {
  const preparedPath = transactionPath(baseDirectory, operationId, 'prepared');
  const committedPath = transactionPath(baseDirectory, operationId, 'committed');
  const appliedPath = transactionPath(baseDirectory, operationId, 'applied');
  if (fs.existsSync(appliedPath)) {
    return loadTransaction(appliedPath).result;
  }
  if (fs.existsSync(preparedPath) || fs.existsSync(committedPath)) {
    throw transactionError('동일한 상태 저장 transaction이 미완료 상태입니다.');
  }
  fs.mkdirSync(preparedPath);
  assertTransactionDirectory(preparedPath);
  const fileByKind = {
    shared: 'shared.json',
    workspace: 'workspace.json',
    index: 'index.json'
  };
  const targets = [];
  try {
    for (const [kind, value] of Object.entries(payloadValues)) {
      const text = jsonText(value);
      const file = fileByKind[kind];
      writeTextDurable(path.join(preparedPath, file), text);
      targets.push({ kind, file, sha256: hashText(text) });
    }
    const resultText = jsonText(result);
    writeTextDurable(path.join(preparedPath, 'result.json'), resultText);
    const manifest = {
      version: 1,
      operationId,
      workspaceId,
      targets,
      resultFile: 'result.json',
      resultSha256: hashText(resultText)
    };
    writeTextDurable(path.join(preparedPath, 'manifest.json'), jsonText(manifest));
    fs.renameSync(preparedPath, committedPath);
    applyCommittedTransaction(baseDirectory, committedPath);
    return result;
  } catch (error) {
    if (fs.existsSync(preparedPath)) {
      assertTransactionDirectory(preparedPath);
      fs.rmSync(preparedPath, { recursive: true });
    }
    throw error;
  }
}

function withWorkspaceCommitLocks(baseDirectory, action) {
  return withStoreLock(baseDirectory, 'commit', () =>
    withStoreLock(baseDirectory, 'catalog', () =>
      withStoreLock(baseDirectory, 'shared', action)
    )
  );
}

function samePath(left, right) {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function unsafeStorePath(message) {
  const error = new Error(message);
  error.code = 'ERR_UNSAFE_STORE_PATH';
  return error;
}

function ensureManagedDirectory(baseDirectory, childName) {
  fs.mkdirSync(baseDirectory, { recursive: true });
  const baseStats = fs.lstatSync(baseDirectory);
  if (!baseStats.isDirectory() || baseStats.isSymbolicLink()) {
    throw unsafeStorePath('작업 공간 저장소 루트가 안전한 디렉터리가 아닙니다.');
  }
  const canonicalBase = fs.realpathSync.native(baseDirectory);
  const childPath = path.join(baseDirectory, childName);
  try {
    fs.mkdirSync(childPath);
  } catch (error) {
    // 여러 첫 실행 프로세스가 같은 관리 폴더를 동시에 만들 수 있다. EEXIST만
    // 허용하고, 바로 아래 lstat/realpath 검증으로 실제 디렉터리인지 확인한다.
    if (error.code !== 'EEXIST') throw error;
  }
  const childStats = fs.lstatSync(childPath);
  if (!childStats.isDirectory() || childStats.isSymbolicLink()) {
    throw unsafeStorePath(`${childName} 저장 경로에 reparse point가 있습니다.`);
  }
  const canonicalChild = fs.realpathSync.native(childPath);
  if (!samePath(canonicalChild, path.join(canonicalBase, childName))) {
    throw unsafeStorePath(`${childName} 저장 경로가 저장소 경계를 벗어났습니다.`);
  }
  return childPath;
}

function assertRegularFileOrMissing(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw unsafeStorePath(`${path.basename(filePath)} 파일 형식이 안전하지 않습니다.`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function normalizeWorkspaceMetadata(value, index = 0) {
  const now = Date.now();
  return {
    id: isValidWorkspaceId(value?.id) ? value.id : '',
    name: boundedString(
      value?.name,
      MAX_WORKSPACE_NAME_LENGTH,
      `작업 공간 ${index + 1}`
    ) || `작업 공간 ${index + 1}`,
    description: boundedString(
      value?.description,
      MAX_WORKSPACE_DESCRIPTION_LENGTH
    ),
    elevation: WORKSPACE_ELEVATIONS.has(value?.elevation)
      ? value.elevation
      : 'standard',
    createdAt: Number.isFinite(value?.createdAt) ? value.createdAt : now,
    lastUsedAt: Number.isFinite(value?.lastUsedAt) ? value.lastUsedAt : now,
    tabCount: Number.isInteger(value?.tabCount)
      ? Math.max(0, value.tabCount)
      : 0,
    tabNames: Array.isArray(value?.tabNames)
      ? value.tabNames
          .slice(0, 5)
          .map((name) => boundedString(name, 120))
          .filter(Boolean)
      : [],
    lastCwd: boundedString(value?.lastCwd, 4096)
  };
}

function normalizeWorkspaceIndex(value) {
  const seenIds = new Set();
  const workspaces = [];
  for (const candidate of Array.isArray(value?.workspaces)
    ? value.workspaces.slice(0, MAX_WORKSPACES)
    : []) {
    if (!isValidWorkspaceId(candidate?.id)) {
      console.warn('유효하지 않은 작업 공간 ID를 catalog에서 제외했습니다.');
      continue;
    }
    const key = workspaceIdKey(candidate.id);
    if (seenIds.has(key)) {
      console.warn(`대소문자가 충돌하는 작업 공간 ID를 catalog에서 격리했습니다: ${candidate.id}`);
      continue;
    }
    seenIds.add(key);
    workspaces.push(normalizeWorkspaceMetadata(candidate, workspaces.length));
  }

  return {
    version: WORKSPACE_INDEX_VERSION,
    workspaces
  };
}

function normalizeSharedState(value) {
  const normalized = normalizeState(value);
  return {
    version: SHARED_STATE_VERSION,
    settings: normalized.settings,
    favorites: normalized.favorites
  };
}

function normalizeWorkspaceState(value) {
  const normalized = normalizeState(value);
  return {
    version: WORKSPACE_STATE_VERSION,
    tabs: normalized.tabs,
    activeTabIndex: normalized.activeTabIndex,
    deck: normalized.deck
  };
}

function mergeChangedSettings(current, previous, next) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(value) !== JSON.stringify(previous?.[key])) {
      merged[key] = value;
    }
  }
  return merged;
}

function mergeChangedFavorites(current, previous, next) {
  const previousById = new Map(
    (previous || []).map((favorite) => [favorite.id, favorite])
  );
  const nextById = new Map(next.map((favorite) => [favorite.id, favorite]));
  const mergedById = new Map(
    current.map((favorite) => [favorite.id, favorite])
  );

  for (const favorite of previous || []) {
    if (!nextById.has(favorite.id)) {
      mergedById.delete(favorite.id);
    }
  }
  for (const favorite of next) {
    if (
      !previousById.has(favorite.id)
      || JSON.stringify(previousById.get(favorite.id))
        !== JSON.stringify(favorite)
    ) {
      mergedById.set(favorite.id, favorite);
    }
  }
  return [...mergedById.values()];
}

function workspaceFilePath(baseDirectory, workspaceId) {
  const id = requireWorkspaceId(workspaceId);
  return resolveContainedPath(
    ensureManagedDirectory(baseDirectory, 'workspaces'),
    `${id}.json`
  );
}

function lockFilePath(baseDirectory, workspaceId) {
  const id = requireWorkspaceId(workspaceId);
  return resolveContainedPath(
    ensureManagedDirectory(baseDirectory, 'workspace-locks'),
    `${id}.lock`
  );
}

function lockOwnerPath(lockPath) {
  return path.join(lockPath, 'owner.json');
}

function sleepSync(milliseconds) {
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function currentProcessOwner(purpose = 'exclusive') {
  return {
    schemaVersion: 1,
    leaseToken: randomUUID(),
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
    executablePath: process.execPath,
    instanceToken: PROCESS_INSTANCE_TOKEN,
    acquiredAt: Date.now(),
    purpose
  };
}

function processIdentity(pid) {
  if (pid === process.pid) {
    return {
      running: true,
      processStartedAt: PROCESS_STARTED_AT,
      executablePath: process.execPath
    };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') {
      return { running: false };
    }
    return { running: true, identityKnown: false };
  }
  return { running: true, identityKnown: false };
}

function parseLockOwner(lockPath) {
  let stats;
  try {
    stats = fs.lstatSync(lockPath);
  } catch {
    return null;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    return null;
  }
  const owner = readJson(lockOwnerPath(lockPath), null);
  if (
    owner?.schemaVersion !== 1
    || typeof owner.leaseToken !== 'string'
    || !/^[A-Fa-f0-9-]{36}$/u.test(owner.leaseToken)
    || !Number.isInteger(owner.pid)
    || owner.pid <= 0
    || !Number.isFinite(owner.processStartedAt)
    || typeof owner.executablePath !== 'string'
    || owner.executablePath.length === 0
    || typeof owner.instanceToken !== 'string'
    || owner.instanceToken.length === 0
    || !Number.isFinite(owner.acquiredAt)
  ) {
    return null;
  }
  return owner;
}

function lockOwnerStatus(lockPath) {
  const owner = parseLockOwner(lockPath);
  if (!owner) {
    return { active: true, known: false, owner: null };
  }

  const identity = processIdentity(owner.pid);
  if (!identity.running) {
    return { active: false, known: true, owner };
  }
  if (owner.pid === process.pid) {
    return {
      active: owner.instanceToken === PROCESS_INSTANCE_TOKEN,
      known: true,
      owner
    };
  }
  return { active: true, known: false, owner };
}

function retiredLockPath(lockPath, leaseToken) {
  return `${lockPath}.retired.${leaseToken}`;
}

function retireLock(lockPath, owner) {
  if (!owner?.leaseToken) {
    return false;
  }
  const retiredPath = retiredLockPath(lockPath, owner.leaseToken);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(lockPath, retiredPath);
      return parseLockOwner(retiredPath)?.leaseToken === owner.leaseToken;
    } catch (error) {
      if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) {
        return false;
      }
      if (fs.existsSync(retiredPath)) {
        return false;
      }
      if (
        attempt >= 9
        || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)
      ) {
        throw error;
      }
      sleepSync(5 * (attempt + 1));
    }
  }
}

function retireInactiveLock(lockPath) {
  const status = lockOwnerStatus(lockPath);
  if (!status.known || status.active) {
    return false;
  }
  return retireLock(lockPath, status.owner);
}

function removePendingLock(pendingPath) {
  try {
    fs.unlinkSync(lockOwnerPath(pendingPath));
  } catch {}
  try {
    fs.rmdirSync(pendingPath);
  } catch {}
}

function publishLock(lockPath, purpose) {
  const owner = currentProcessOwner(purpose);
  const pendingPath = `${lockPath}.pending.${process.pid}.${owner.leaseToken}`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    fs.mkdirSync(pendingPath);
    try {
      fs.writeFileSync(
        lockOwnerPath(pendingPath),
        `${JSON.stringify(owner)}\n`,
        { encoding: 'utf8', flag: 'wx' }
      );
      fs.renameSync(pendingPath, lockPath);
      return { filePath: lockPath, ...owner };
    } catch (error) {
      removePendingLock(pendingPath);
      const ambiguousRename = [
        'EEXIST',
        'ENOTEMPTY',
        'EACCES',
        'EBUSY',
        'EPERM'
      ].includes(error.code);
      if (ambiguousRename && fs.existsSync(lockPath)) {
        return null;
      }
      if (ambiguousRename && attempt < 2) {
        sleepSync(10 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

function releaseLock(lock) {
  if (!lock?.filePath || !lock.leaseToken) {
    return;
  }
  const current = parseLockOwner(lock.filePath);
  if (
    current?.pid === lock.pid
    && current.instanceToken === lock.instanceToken
    && current.leaseToken === lock.leaseToken
  ) {
    const releasedPath = `${lock.filePath}.released.${current.leaseToken}`;
    for (let attempt = 0; ; attempt += 1) {
      const latest = parseLockOwner(lock.filePath);
      if (latest?.leaseToken !== current.leaseToken) {
        return false;
      }
      try {
        fs.renameSync(lock.filePath, releasedPath);
        break;
      } catch (error) {
        if (
          attempt >= 9
          || !['EACCES', 'EBUSY', 'EPERM'].includes(error.code)
        ) {
          console.error(`잠금 release에 실패했습니다: ${error.message}`);
          return false;
        }
        sleepSync(5 * (attempt + 1));
      }
    }
    if (parseLockOwner(releasedPath)?.leaseToken !== current.leaseToken) {
      console.error('잠금 release token 검증에 실패했습니다.');
      return false;
    }
    removePendingLock(releasedPath);
    return true;
  }
  return false;
}

function storeLockPath(baseDirectory, name) {
  return resolveContainedPath(
    ensureManagedDirectory(baseDirectory, 'store-locks'),
    `${name}.lock`
  );
}

function withStoreLock(baseDirectory, name, action) {
  const filePath = storeLockPath(baseDirectory, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const deadline = Date.now() + STORE_LOCK_WAIT_MS;
  let retryDelay = STORE_LOCK_RETRY_MS;
  let lock = null;
  while (true) {
    lock = publishLock(filePath, `store:${name}`);
    if (lock) {
      break;
    }
    if (retireInactiveLock(filePath)) {
      continue;
    }
    if (Date.now() >= deadline) {
      const timeout = new Error(`${name} 저장 잠금을 기다리는 시간이 초과됐습니다.`);
      timeout.code = 'ERR_STORE_LOCK_TIMEOUT';
      throw timeout;
    }
    sleepSync(retryDelay);
    retryDelay = Math.min(200, retryDelay * 2);
  }

  let result;
  try {
    result = action();
  } catch (error) {
    releaseLock(lock);
    throw error;
  }
  if (!releaseLock(lock)) {
    console.error(
      `${name} 저장 mutation은 commit됐지만 잠금 정리에 실패했습니다. 재시도하면 안 됩니다.`
    );
  }
  return result;
}

function initializeWorkspaceStoreUnlocked(baseDirectory) {
  const storePaths = pathsFor(baseDirectory);
  ensureManagedDirectory(baseDirectory, 'workspaces');
  ensureManagedDirectory(baseDirectory, 'workspace-locks');
  ensureManagedDirectory(baseDirectory, 'store-locks');
  ensureManagedDirectory(baseDirectory, 'save-transactions');

  if (fs.existsSync(storePaths.index)) {
    return normalizeWorkspaceIndex(readJson(storePaths.index, null));
  }

  const legacy = normalizeState(readJson(storePaths.legacy, null));
  const workspaceId = randomUUID();
  const now = Date.now();
  const activeTab = legacy.tabs[legacy.activeTabIndex] || legacy.tabs[0];
  const metadata = normalizeWorkspaceMetadata({
    id: workspaceId,
    name: '기본 작업 공간',
    description: legacy.tabs.length > 0
      ? '기존에 저장된 터미널 탭과 히스토리'
      : '기본 터미널 작업 공간',
    createdAt: now,
    lastUsedAt: now,
    tabCount: legacy.tabs.length,
    tabNames: legacy.tabs.map((tab) => tab.name),
    lastCwd: activeTab?.cwd || ''
  });
  const index = {
    version: WORKSPACE_INDEX_VERSION,
    workspaces: [metadata]
  };

  writeJsonAtomic(storePaths.shared, normalizeSharedState(legacy));
  writeJsonAtomic(
    workspaceFilePath(baseDirectory, workspaceId),
    normalizeWorkspaceState(legacy)
  );
  writeJsonAtomic(storePaths.index, index);
  return index;
}

function initializeWorkspaceStore(baseDirectory) {
  const storePaths = pathsFor(baseDirectory);
  ensureManagedDirectory(baseDirectory, 'workspaces');
  ensureManagedDirectory(baseDirectory, 'workspace-locks');
  ensureManagedDirectory(baseDirectory, 'store-locks');
  ensureManagedDirectory(baseDirectory, 'save-transactions');
  return withWorkspaceCommitLocks(baseDirectory, () => {
    recoverWorkspaceTransactionsUnlocked(baseDirectory);
    if (fs.existsSync(storePaths.index)) {
      return normalizeWorkspaceIndex(readJson(storePaths.index, null));
    }
    return initializeWorkspaceStoreUnlocked(baseDirectory);
  });
}

function loadIndex(baseDirectory) {
  initializeWorkspaceStore(baseDirectory);
  return normalizeWorkspaceIndex(
    readJson(pathsFor(baseDirectory).index, null)
  );
}

function saveIndex(baseDirectory, index) {
  const normalized = normalizeWorkspaceIndex(index);
  writeJsonAtomic(pathsFor(baseDirectory).index, normalized);
  return normalized;
}

function workspacePosition(index, workspaceId) {
  const key = workspaceIdKey(workspaceId);
  return index.workspaces.findIndex(
    (workspace) => workspaceIdKey(workspace.id) === key
  );
}

function workspaceIsRunning(baseDirectory, workspaceId) {
  if (!isValidWorkspaceId(workspaceId)) {
    return false;
  }
  const filePath = lockFilePath(baseDirectory, workspaceId);
  if (!fs.existsSync(filePath)) {
    return false;
  }
  return lockOwnerStatus(filePath).active;
}

function listWorkspaces(baseDirectory) {
  const index = loadIndex(baseDirectory);
  return index.workspaces
    .map((workspace) => ({
      ...workspace,
      running: workspaceIsRunning(baseDirectory, workspace.id)
    }))
    .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}

function acquireWorkspaceLock(baseDirectory, workspaceId) {
  if (!isValidWorkspaceId(workspaceId)) {
    return null;
  }
  initializeWorkspaceStore(baseDirectory);
  return withStoreLock(baseDirectory, 'catalog', () => {
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    const position = workspacePosition(index, workspaceId);
    if (position < 0) {
      return null;
    }
    const filePath = lockFilePath(baseDirectory, index.workspaces[position].id);
    let lock = publishLock(filePath, 'workspace:open');
    if (!lock && retireInactiveLock(filePath)) {
      lock = publishLock(filePath, 'workspace:open');
    }
    return lock;
  });
}

function releaseWorkspaceLock(lock) {
  return releaseLock(lock);
}

function loadSharedState(baseDirectory) {
  initializeWorkspaceStore(baseDirectory);
  return withStoreLock(baseDirectory, 'commit', () =>
    normalizeSharedState(readJson(pathsFor(baseDirectory).shared, null))
  );
}

function loadWorkspace(baseDirectory, workspaceId) {
  if (!isValidWorkspaceId(workspaceId)) {
    return null;
  }
  initializeWorkspaceStore(baseDirectory);
  return withStoreLock(baseDirectory, 'commit', () => {
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    const position = workspacePosition(index, workspaceId);
    if (position < 0) {
      return null;
    }
    const workspace = index.workspaces[position];
    const shared = normalizeSharedState(
      readJson(pathsFor(baseDirectory).shared, null)
    );
    const state = normalizeWorkspaceState(
      readJson(workspaceFilePath(baseDirectory, workspace.id), null)
    );
    return {
      workspace,
      state: {
        version: WORKSPACE_STATE_VERSION,
        settings: shared.settings,
        favorites: shared.favorites,
        tabs: state.tabs,
        activeTabIndex: state.activeTabIndex,
        deck: state.deck
      }
    };
  });
}

function createWorkspace(baseDirectory, input = {}) {
  initializeWorkspaceStore(baseDirectory);
  return withStoreLock(baseDirectory, 'catalog', () => {
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    if (index.workspaces.length >= MAX_WORKSPACES) {
      throw new Error(`작업 공간은 최대 ${MAX_WORKSPACES}개까지 만들 수 있습니다.`);
    }

    const now = Date.now();
    const workspace = normalizeWorkspaceMetadata({
      id: randomUUID(),
      name: input.name,
      description: input.description,
      elevation: input.elevation,
      createdAt: now,
      lastUsedAt: now
    }, index.workspaces.length);
    index.workspaces.push(workspace);
    writeJsonAtomic(
      workspaceFilePath(baseDirectory, workspace.id),
      normalizeWorkspaceState(null)
    );
    saveIndex(baseDirectory, index);
    return workspace;
  });
}

function cloneWorkspaceState(value) {
  const source = normalizeWorkspaceState(value);
  return normalizeWorkspaceState({
    ...source,
    tabs: source.tabs.map((tab) => ({
      ...tab,
      history: [],
      provider: null
    }))
  });
}

function cloneWorkspace(baseDirectory, sourceWorkspaceId, input = {}) {
  if (!isValidWorkspaceId(sourceWorkspaceId)) {
    return null;
  }
  initializeWorkspaceStore(baseDirectory);
  return withWorkspaceCommitLocks(baseDirectory, () => {
    recoverWorkspaceTransactionsUnlocked(baseDirectory);
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    if (index.workspaces.length >= MAX_WORKSPACES) {
      throw new Error(`작업 공간은 최대 ${MAX_WORKSPACES}개까지 만들 수 있습니다.`);
    }
    const sourcePosition = workspacePosition(index, sourceWorkspaceId);
    if (sourcePosition < 0) {
      return null;
    }
    const sourceMetadata = index.workspaces[sourcePosition];
    const state = cloneWorkspaceState(
      readJson(workspaceFilePath(baseDirectory, sourceMetadata.id), null)
    );
    const now = Date.now();
    const activeTab = state.tabs[state.activeTabIndex] || state.tabs[0];
    const workspace = normalizeWorkspaceMetadata({
      id: randomUUID(),
      name: input.name || `${sourceMetadata.name} 복사본`,
      description: Object.hasOwn(input, 'description')
        ? input.description
        : sourceMetadata.description,
      elevation: Object.hasOwn(input, 'elevation')
        ? input.elevation
        : sourceMetadata.elevation,
      createdAt: now,
      lastUsedAt: now,
      tabCount: state.tabs.length,
      tabNames: state.tabs.map((tab) => tab.name),
      lastCwd: activeTab?.cwd || ''
    }, index.workspaces.length);
    index.workspaces.push(workspace);
    writeJsonAtomic(workspaceFilePath(baseDirectory, workspace.id), state);
    saveIndex(baseDirectory, index);
    return workspace;
  });
}

function updateWorkspace(baseDirectory, workspaceId, input = {}) {
  if (!isValidWorkspaceId(workspaceId)) {
    return null;
  }
  initializeWorkspaceStore(baseDirectory);
  return withStoreLock(baseDirectory, 'catalog', () => {
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    const position = workspacePosition(index, workspaceId);
    if (position < 0) {
      return null;
    }

    index.workspaces[position] = normalizeWorkspaceMetadata({
      ...index.workspaces[position],
      name: input.name,
      description: input.description,
      elevation: Object.hasOwn(input, 'elevation')
        ? input.elevation
        : index.workspaces[position].elevation
    }, position);
    saveIndex(baseDirectory, index);
    return index.workspaces[position];
  });
}

function deleteWorkspace(baseDirectory, workspaceId) {
  if (!isValidWorkspaceId(workspaceId)) {
    return { deleted: false, reason: 'invalid' };
  }
  initializeWorkspaceStore(baseDirectory);
  return withStoreLock(baseDirectory, 'catalog', () => {
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    const position = workspacePosition(index, workspaceId);
    if (position < 0) {
      return { deleted: false, reason: 'missing' };
    }
    const canonicalId = index.workspaces[position].id;
    const lockPath = lockFilePath(baseDirectory, canonicalId);
    let deleteLease = publishLock(lockPath, 'workspace:delete');
    if (!deleteLease && retireInactiveLock(lockPath)) {
      deleteLease = publishLock(lockPath, 'workspace:delete');
    }
    if (!deleteLease) {
      return { deleted: false, reason: 'running' };
    }
    try {
      const filePath = workspaceFilePath(baseDirectory, canonicalId);
      assertRegularFileOrMissing(filePath);
      index.workspaces.splice(position, 1);
      saveIndex(baseDirectory, index);
      fs.rmSync(filePath, { force: true });
      return { deleted: true };
    } finally {
      releaseLock(deleteLease);
    }
  });
}

function saveWorkspace(baseDirectory, workspaceId, state, options = {}) {
  if (workspaceId != null && !isValidWorkspaceId(workspaceId)) {
    requireWorkspaceId(workspaceId);
  }
  initializeWorkspaceStore(baseDirectory);
  const operationId = options.operationId || randomUUID();
  if (!validateOperationId(operationId)) {
    throw transactionError('상태 저장 operation ID가 유효하지 않습니다.');
  }
  return withWorkspaceCommitLocks(baseDirectory, () => {
    recoverWorkspaceTransactionsUnlocked(baseDirectory);
    const index = normalizeWorkspaceIndex(
      readJson(pathsFor(baseDirectory).index, null)
    );
    let canonicalWorkspaceId = workspaceId;
    let position = -1;
    if (workspaceId) {
      position = workspacePosition(index, workspaceId);
      if (position < 0) {
        const error = new Error('저장할 작업 공간이 catalog에 없습니다.');
        error.code = 'ERR_WORKSPACE_NOT_FOUND';
        throw error;
      }
      canonicalWorkspaceId = index.workspaces[position].id;
      // A newer application may have written fields this version cannot
      // preserve. Refuse to overwrite that file during an ordinary save.
      normalizeWorkspaceState(
        readJson(workspaceFilePath(baseDirectory, canonicalWorkspaceId), null)
      );
    }
    const normalized = normalizeState(state);
    const previousShared = options.previousShared;
    const currentShared = normalizeSharedState(
      readJson(pathsFor(baseDirectory).shared, null)
    );
    const nextShared = normalizeSharedState({
      settings: options.saveSettings
        ? (
            previousShared
              ? mergeChangedSettings(
                  currentShared.settings,
                  previousShared.settings,
                  normalized.settings
                )
              : normalized.settings
          )
        : currentShared.settings,
      favorites: options.saveFavorites
        ? (
            previousShared
              ? mergeChangedFavorites(
                  currentShared.favorites,
                  previousShared.favorites,
                  normalized.favorites
                )
              : normalized.favorites
          )
        : currentShared.favorites
    });
    const result = canonicalWorkspaceId
      ? {
          ...normalized,
          settings: nextShared.settings,
          favorites: nextShared.favorites
        }
      : {
          settings: nextShared.settings,
          favorites: nextShared.favorites
        };
    const payloads = {};
    if (options.saveSettings || options.saveFavorites) {
      payloads.shared = nextShared;
    }
    if (canonicalWorkspaceId) {
      const activeTab =
        normalized.tabs[normalized.activeTabIndex] || normalized.tabs[0];
      index.workspaces[position] = normalizeWorkspaceMetadata({
        ...index.workspaces[position],
        lastUsedAt: Date.now(),
        tabCount: normalized.tabs.length,
        tabNames: normalized.tabs.map((tab) => tab.name),
        lastCwd: activeTab?.cwd || ''
      }, position);
      payloads.workspace = normalizeWorkspaceState(normalized);
      payloads.index = index;
    }
    if (Object.keys(payloads).length === 0) {
      return result;
    }
    return createWorkspaceTransaction(
      baseDirectory,
      operationId,
      canonicalWorkspaceId,
      payloads,
      result
    );
  });
}

function acknowledgeWorkspaceSave(baseDirectory, operationId) {
  if (!validateOperationId(operationId)) {
    throw transactionError('확인할 상태 저장 operation ID가 유효하지 않습니다.');
  }
  ensureManagedDirectory(baseDirectory, 'store-locks');
  ensureManagedDirectory(baseDirectory, 'save-transactions');
  return withWorkspaceCommitLocks(baseDirectory, () => {
    recoverWorkspaceTransactionsUnlocked(baseDirectory);
    const appliedPath = transactionPath(baseDirectory, operationId, 'applied');
    if (!fs.existsSync(appliedPath)) {
      return false;
    }
    loadTransaction(appliedPath);
    fs.rmSync(appliedPath, { recursive: true });
    return true;
  });
}

function loadEphemeralWorkspace(baseDirectory) {
  const shared = loadSharedState(baseDirectory);
  return {
    workspace: {
      id: null,
      name: '일회성 작업 공간',
      description: '앱을 닫으면 탭과 히스토리가 저장되지 않습니다.',
      elevation: 'current',
      ephemeral: true
    },
    state: {
      version: WORKSPACE_STATE_VERSION,
      settings: shared.settings,
      favorites: shared.favorites,
      tabs: [],
      activeTabIndex: 0,
      deck: normalizeWorkspaceState(null).deck
    }
  };
}

module.exports = {
  MAX_WORKSPACE_DESCRIPTION_LENGTH,
  MAX_WORKSPACE_NAME_LENGTH,
  acknowledgeWorkspaceSave,
  acquireWorkspaceLock,
  cloneWorkspace,
  cloneWorkspaceState,
  createWorkspace,
  deleteWorkspace,
  initializeWorkspaceStore,
  listWorkspaces,
  loadEphemeralWorkspace,
  loadWorkspace,
  normalizeWorkspaceIndex,
  releaseWorkspaceLock,
  saveWorkspace,
  updateWorkspace,
  workspaceIsRunning
};
