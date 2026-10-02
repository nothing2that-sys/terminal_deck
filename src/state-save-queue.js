function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function snapshotFingerprint(state) {
  return JSON.stringify(state);
}

class StateSaveQueue {
  constructor(commit, { epoch } = {}) {
    if (typeof commit !== 'function') {
      throw new TypeError('commit 함수가 필요합니다.');
    }
    if (typeof epoch !== 'string' || epoch.length === 0) {
      throw new TypeError('save epoch이 필요합니다.');
    }
    this.commit = commit;
    this.epoch = epoch;
    this.phase = 'open';
    this.committedRevision = 0;
    this.highestAcceptedRevision = 0;
    this.minimumFinalRevision = null;
    this.requests = new Map();
    this.tail = Promise.resolve();
  }

  beginClose() {
    if (this.phase === 'sealed') {
      throw protocolError('ERR_SAVE_QUEUE_SEALED', '저장 queue가 이미 종료됐습니다.');
    }
    this.phase = 'closing';
    this.minimumFinalRevision = this.highestAcceptedRevision + 1;
    return {
      saveEpoch: this.epoch,
      minimumRevision: this.minimumFinalRevision
    };
  }

  cancelClose() {
    if (this.phase === 'closing') {
      this.phase = 'open';
      this.minimumFinalRevision = null;
    }
  }

  seal(revision) {
    if (revision > this.committedRevision) {
      throw protocolError(
        'ERR_FINAL_SAVE_NOT_COMMITTED',
        'commit되지 않은 revision으로 저장 queue를 종료할 수 없습니다.'
      );
    }
    this.phase = 'sealed';
    this.minimumFinalRevision = null;
  }

  pruneRequests() {
    for (const revision of this.requests.keys()) {
      if (this.requests.size <= 128) {
        break;
      }
      if (revision < this.committedRevision) {
        this.requests.delete(revision);
      }
    }
  }

  enqueue({ saveEpoch, revision, state, kind = 'normal', requestId = null }) {
    if (saveEpoch !== this.epoch) {
      return Promise.reject(protocolError(
        'ERR_SAVE_EPOCH_MISMATCH',
        '현재 작업 공간과 다른 save epoch입니다.'
      ));
    }
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      return Promise.reject(protocolError(
        'ERR_INVALID_SAVE_REVISION',
        '유효하지 않은 state save revision입니다.'
      ));
    }
    if (!['normal', 'final'].includes(kind)) {
      return Promise.reject(protocolError(
        'ERR_INVALID_SAVE_KIND',
        '유효하지 않은 state save 종류입니다.'
      ));
    }
    if (this.phase === 'sealed') {
      return Promise.reject(protocolError(
        'ERR_SAVE_QUEUE_SEALED',
        '종료된 저장 queue에는 저장할 수 없습니다.'
      ));
    }
    if (this.phase === 'closing' && kind !== 'final') {
      return Promise.reject(protocolError(
        'ERR_CLOSE_IN_PROGRESS',
        '종료 준비 중에는 일반 저장을 받을 수 없습니다.'
      ));
    }
    if (kind === 'final' && this.phase !== 'closing') {
      return Promise.reject(protocolError(
        'ERR_FINAL_SAVE_NOT_REQUESTED',
        '종료 요청 없이 final snapshot을 받을 수 없습니다.'
      ));
    }
    if (kind === 'final' && revision < this.minimumFinalRevision) {
      return Promise.reject(protocolError(
        'ERR_FINAL_SAVE_REVISION_TOO_OLD',
        'final snapshot revision이 종료 요청의 최소 revision보다 작습니다.'
      ));
    }

    const fingerprint = snapshotFingerprint(state);
    const existing = this.requests.get(revision);
    if (existing) {
      if (
        existing.fingerprint !== fingerprint
        || existing.kind !== kind
        || existing.requestId !== requestId
      ) {
        return Promise.reject(protocolError(
          'ERR_SAVE_REVISION_CONFLICT',
          '같은 revision에 서로 다른 snapshot이 제출됐습니다.'
        ));
      }
      return existing.promise;
    }

    this.highestAcceptedRevision = Math.max(
      this.highestAcceptedRevision,
      revision
    );
    const operation = this.tail.then(async () => {
      if (revision <= this.committedRevision) {
        return {
          ok: true,
          saved: false,
          stale: true,
          saveEpoch: this.epoch,
          revision,
          committedRevision: this.committedRevision,
          requestId
        };
      }
      await this.commit(state, { revision, kind, requestId });
      this.committedRevision = revision;
      this.pruneRequests();
      return {
        ok: true,
        saved: true,
        stale: false,
        saveEpoch: this.epoch,
        revision,
        committedRevision: revision,
        requestId
      };
    });
    const tracked = operation.catch((error) => {
      if (this.requests.get(revision)?.promise === tracked) {
        this.requests.delete(revision);
      }
      throw error;
    });
    this.requests.set(revision, {
      fingerprint,
      kind,
      requestId,
      promise: tracked
    });
    this.tail = tracked.catch(() => {});
    return tracked;
  }

  drain() {
    return this.tail;
  }
}

module.exports = { StateSaveQueue };
