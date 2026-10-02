const net = require('node:net');
const { EventEmitter } = require('node:events');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const {
  BROKER_FLAG,
  BROKER_TOKEN_PREFIX,
  JsonLineChannel,
  protocolError
} = require('./elevated-pty-protocol');
const { launchWithElevation } = require('./windows-elevation');

const BROKER_START_TIMEOUT_MS = 15_000;
const BROKER_REQUEST_TIMEOUT_MS = 10_000;
const MAX_PENDING_REQUESTS = 256;

function brokerLaunchArguments({ isPackaged, appPath, token, pipeName, parentPid }) {
  return [
    ...(isPackaged ? [] : [appPath]),
    BROKER_FLAG,
    `${BROKER_TOKEN_PREFIX}${token}`,
    `--broker-pipe=${pipeName}`,
    `--broker-parent-pid=${parentPid}`
  ];
}
const MAX_BUFFERED_PROXY_OUTPUT = 1024 * 1024;
const WRITE_CHUNK_CHARACTERS = 4096;

function isAuthenticatedBrokerMessage(message, token, parentPid) {
  const presented = Buffer.from(String(message?.token || ''), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return presented.length === expected.length
    && timingSafeEqual(presented, expected)
    && message.parentPid === parentPid;
}

class BrokerPtyProxy {
  constructor(client, sessionId, pid) {
    this.client = client;
    this.sessionId = sessionId;
    this.pid = pid;
    this.events = new EventEmitter();
    this.exited = false;
    this.isElevatedBrokerPty = true;
    this.pendingData = '';
    this.exitEvent = null;
    this.operationQueue = Promise.resolve();
  }

  onData(callback) {
    this.events.on('data', callback);
    if (this.pendingData) {
      const pending = this.pendingData;
      this.pendingData = '';
      queueMicrotask(() => {
        if (!this.exited || pending) {
          callback(pending);
        }
      });
    }
    return { dispose: () => this.events.off('data', callback) };
  }

  onExit(callback) {
    this.events.on('exit', callback);
    if (this.exitEvent) {
      const event = this.exitEvent;
      queueMicrotask(() => callback(event));
    }
    return { dispose: () => this.events.off('exit', callback) };
  }

  onOperationError(callback) {
    this.events.on('operation-error', callback);
    return { dispose: () => this.events.off('operation-error', callback) };
  }

  trackOperation(operation) {
    this.operationQueue = operation;
    void operation.catch((error) => {
      if (this.operationQueue === operation) {
        this.operationQueue = Promise.resolve();
      }
      this.emitOperationError(error);
    });
  }

  write(data) {
    const chunks = [];
    let offset = 0;
    while (offset < data.length) {
      let end = Math.min(data.length, offset + WRITE_CHUNK_CHARACTERS);
      if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1])) {
        end -= 1;
      }
      chunks.push(data.slice(offset, end));
      offset = end;
    }
    const operation = this.operationQueue.then(async () => {
      for (const chunk of chunks) {
        await this.client.request('write', { sessionId: this.sessionId, data: chunk });
      }
    });
    this.trackOperation(operation);
  }

  resize(cols, rows) {
    const operation = this.operationQueue.then(
      () => this.client.request('resize', { sessionId: this.sessionId, cols, rows })
    );
    this.trackOperation(operation);
  }

  kill() {
    return this.operationQueue
      .catch(() => {})
      .then(() => this.client.request('kill', { sessionId: this.sessionId }));
  }

  emitData(data) {
    if (!this.exited) {
      if (this.events.listenerCount('data') === 0) {
        this.pendingData = `${this.pendingData}${data}`.slice(-MAX_BUFFERED_PROXY_OUTPUT);
      } else {
        this.events.emit('data', data);
      }
    }
  }

  emitOperationError(error) {
    this.lastOperationError = error;
    this.events.emit('operation-error', error);
  }

  emitExit(exitCode) {
    if (!this.exited) {
      this.exited = true;
      this.exitEvent = { exitCode };
      this.events.emit('exit', this.exitEvent);
    }
  }
}

class ElevatedPtyBrokerClient {
  constructor(options = {}) {
    this.createServer = options.createServer || net.createServer;
    this.launch = options.launch || launchWithElevation;
    this.executablePath = options.executablePath;
    this.appPath = options.appPath;
    this.isPackaged = options.isPackaged === true;
    this.cwd = options.cwd || process.cwd();
    this.parentPid = options.parentPid || process.pid;
    this.startTimeoutMs = options.startTimeoutMs || BROKER_START_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs || BROKER_REQUEST_TIMEOUT_MS;
    this.connectionPromise = null;
    this.server = null;
    this.channel = null;
    this.pending = new Map();
    this.proxies = new Map();
    this.heartbeat = null;
  }

  ensureConnected() {
    if (this.channel) {
      return Promise.resolve();
    }
    if (this.connectionPromise) {
      return this.connectionPromise;
    }
    this.connectionPromise = this.start().catch((error) => {
      this.disposeConnection();
      throw error;
    }).finally(() => {
      this.connectionPromise = null;
    });
    return this.connectionPromise;
  }

  start() {
    const token = randomBytes(32).toString('hex');
    const pipeName = `\\\\.\\pipe\\terminal-deck-${this.parentPid}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        callback(value);
      };
      const timeout = setTimeout(() => finish(
        reject,
        protocolError('ERR_BROKER_START_TIMEOUT', '관리자 PTY broker 연결 시간이 초과됐습니다.')
      ), this.startTimeoutMs);
      this.server = this.createServer((socket) => {
        if (this.channel) {
          socket.destroy();
          return;
        }
        const channel = new JsonLineChannel(socket);
        const onHello = (message) => {
          if (message.type === 'startup-error') {
            if (!isAuthenticatedBrokerMessage(message, token, this.parentPid)) {
              socket.destroy();
              return;
            }
            socket.destroy();
            finish(reject, protocolError(
              message.error?.code || 'ERR_BROKER_STARTUP',
              message.error?.message || '관리자 PTY broker 시작에 실패했습니다.'
            ));
            return;
          }
          if (
            message.type !== 'hello'
            || !isAuthenticatedBrokerMessage(message, token, this.parentPid)
            || message.elevation !== 'administrator'
          ) {
            socket.destroy();
            return;
          }
          channel.off('message', onHello);
          this.channel = channel;
          this.bindChannel(channel);
          channel.send({ type: 'authenticated' });
          this.server.close();
          this.server = null;
          this.startHeartbeat();
          finish(resolve);
        };
        channel.on('message', onHello);
        channel.once('protocol-error', () => socket.destroy());
        channel.once('error', () => socket.destroy());
      });
      this.server.once('error', (error) => finish(reject, error));
      this.server.listen(pipeName, async () => {
        try {
          const args = brokerLaunchArguments({
            isPackaged: this.isPackaged,
            appPath: this.appPath,
            token,
            pipeName,
            parentPid: this.parentPid
          });
          const launchResult = await this.launch({
            elevated: true,
            detailed: true,
            executablePath: this.executablePath,
            args,
            cwd: this.isPackaged ? undefined : this.cwd,
            environment: {}
          });
          const launched = launchResult === true || launchResult?.started === true;
          if (!launched) {
            const canceled = launchResult?.reason === 'canceled';
            const error = protocolError(
              canceled ? 'ERR_BROKER_UAC_CANCELED' : 'ERR_BROKER_LAUNCH_FAILED',
              canceled
                ? '관리자 권한 요청이 취소됐습니다.'
                : `관리자 PTY broker 실행 helper가 실패했습니다.${
                    launchResult?.detail
                      ? ` ${String(launchResult.detail).slice(0, 500)}`
                      : ''
                  }`
            );
            finish(reject, error);
          }
        } catch (error) {
          finish(reject, error);
        }
      });
    });
  }

  bindChannel(channel) {
    channel.on('message', (message) => {
      if (message.type === 'response') {
        const pending = this.pending.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(message.requestId);
        clearTimeout(pending.timeout);
        if (message.ok) {
          pending.resolve(message.result || {});
        } else {
          const error = new Error(message.error?.message || 'broker 요청이 실패했습니다.');
          error.code = message.error?.code || 'ERR_ELEVATED_BROKER';
          pending.reject(error);
        }
      } else if (message.type === 'data') {
        this.proxies.get(message.sessionId)?.emitData(message.data);
      } else if (message.type === 'exit') {
        const proxy = this.proxies.get(message.sessionId);
        this.proxies.delete(message.sessionId);
        proxy?.emitExit(message.exitCode);
      }
    });
    const disconnected = () => this.handleDisconnect();
    channel.once('close', disconnected);
    channel.once('protocol-error', disconnected);
    channel.once('error', disconnected);
  }

  startHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (!this.channel) {
        return;
      }
      try {
        this.channel.send({ type: 'ping', nonce: randomUUID() });
      } catch {
        this.handleDisconnect();
      }
    }, 2_000);
    this.heartbeat.unref?.();
  }

  handleDisconnect() {
    if (!this.channel) {
      return;
    }
    const error = protocolError('ERR_BROKER_DISCONNECTED', '관리자 PTY broker 연결이 끊겼습니다.');
    this.channel = null;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const proxy of this.proxies.values()) {
      proxy.emitExit(null);
    }
    this.proxies.clear();
  }

  request(type, payload = {}) {
    if (!this.channel) {
      return Promise.reject(protocolError(
        'ERR_BROKER_NOT_CONNECTED',
        '관리자 PTY broker가 연결되지 않았습니다.'
      ));
    }
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(protocolError(
        'ERR_BROKER_BACKPRESSURE',
        '관리자 PTY broker 요청 대기 한도를 초과했습니다.'
      ));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(requestId)) {
          reject(protocolError('ERR_BROKER_REQUEST_TIMEOUT', '관리자 PTY broker 요청 시간이 초과됐습니다.'));
        }
      }, this.requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(requestId, { resolve, reject, timeout });
      try {
        this.channel.send({ type, requestId, ...payload });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async createPty(spec) {
    await this.ensureConnected();
    const sessionId = spec.sessionId;
    const proxy = new BrokerPtyProxy(this, sessionId, null);
    this.proxies.set(sessionId, proxy);
    try {
      const result = await this.request('spawn', spec);
      proxy.pid = result.pid;
      proxy.shellKind = result.shellKind;
      proxy.shellLabel = result.shellLabel;
      return proxy;
    } catch (error) {
      this.proxies.delete(sessionId);
      throw error;
    }
  }

  async close() {
    if (this.channel) {
      try {
        await this.request('shutdown');
      } catch {}
    }
    this.disposeConnection();
  }

  disposeConnection() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.channel?.close();
    this.channel = null;
    this.server?.close();
    this.server = null;
    const error = protocolError('ERR_BROKER_DISCONNECTED', '관리자 PTY broker 연결이 종료됐습니다.');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

module.exports = {
  BrokerPtyProxy,
  ElevatedPtyBrokerClient,
  brokerLaunchArguments,
  isAuthenticatedBrokerMessage
};
