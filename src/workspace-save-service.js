const path = require('node:path');
const { randomUUID } = require('node:crypto');

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deserializeError(value) {
  const error = new Error(value?.message || '상태 저장 process에서 오류가 발생했습니다.');
  error.code = value?.code || 'ERR_WORKSPACE_SAVE';
  if (typeof value?.stack === 'string') {
    error.stack = value.stack;
  }
  return error;
}

class WorkspaceSaveService {
  constructor(forkProcess, options = {}) {
    if (typeof forkProcess !== 'function') {
      throw new TypeError('utility process fork 함수가 필요합니다.');
    }
    this.forkProcess = forkProcess;
    this.workerPath = options.workerPath || path.join(__dirname, 'workspace-save-worker.js');
    this.child = null;
    this.pending = new Map();
    this.generation = 0;
  }

  ensureChild() {
    if (this.child) {
      return this.child;
    }
    const child = this.forkProcess(this.workerPath, [], {
      stdio: 'ignore'
    });
    const generation = ++this.generation;
    this.child = child;
    child.on('message', (message) => {
      if (generation !== this.generation || !message?.requestId) {
        return;
      }
      const request = this.pending.get(message.requestId);
      if (!request) {
        return;
      }
      this.pending.delete(message.requestId);
      if (message.ok) {
        request.resolve(message.saved);
      } else {
        request.reject(deserializeError(message.error));
      }
    });
    child.once('exit', (code) => {
      if (generation !== this.generation) {
        return;
      }
      this.child = null;
      const error = serviceError(
        'ERR_WORKSPACE_SAVE_PROCESS_EXIT',
        `상태 저장 process가 종료됐습니다. (code ${code})`
      );
      for (const request of this.pending.values()) {
        request.reject(error);
      }
      this.pending.clear();
    });
    return child;
  }

  save(payload) {
    return this.request('save-workspace', payload);
  }

  acknowledge(payload) {
    return this.request('acknowledge-save', payload);
  }

  request(type, payload) {
    const child = this.ensureChild();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        child.postMessage({ type, requestId, payload });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  get pendingCount() {
    return this.pending.size;
  }

  get pid() {
    return this.child?.pid;
  }

  terminate() {
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    const generation = this.generation;
    const error = serviceError(
      'ERR_WORKSPACE_SAVE_ABORTED',
      '진행 중인 상태 저장을 중단했습니다.'
    );
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
    this.child = null;
    this.generation += 1;
    return new Promise((resolve) => {
      let settled = false;
      let timeout = null;
      const finish = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };
      child.once('exit', finish);
      timeout = setTimeout(finish, 2_000);
      timeout.unref?.();
      try {
        child.kill();
      } catch {
        finish();
      }
    }).finally(() => {
      if (this.generation === generation) {
        this.generation += 1;
      }
    });
  }
}

module.exports = { WorkspaceSaveService };
