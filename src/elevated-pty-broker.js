const net = require('node:net');
const path = require('node:path');
const pty = require('node-pty');
const { JsonLineChannel, protocolError } = require('./elevated-pty-protocol');
const { normalizeTerminalSize } = require('./terminal-policy');
const { terminatePtyTree } = require('./pty-tree');
const { detectProcessElevation } = require('./windows-elevation');
const { resolvePowerShell } = require('./shell');
const {
  buildPowerShellArguments,
  shellIntegrationPath
} = require('./shell-integration');
const { buildElevatedPtyEnvironment } = require('./pty-environment');

const HEARTBEAT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_CHUNK = 8 * 1024;
const SHELL_KINDS = new Set(['pwsh', 'powershell']);

function boundedString(value, maxLength, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw protocolError('ERR_INVALID_BROKER_REQUEST', `${name} 값이 유효하지 않습니다.`);
  }
  return value;
}

function validateSpawnRequest(message) {
  const size = normalizeTerminalSize(message);
  if (!size) {
    throw protocolError('ERR_INVALID_BROKER_REQUEST', 'PTY 크기가 유효하지 않습니다.');
  }
  const sessionId = boundedString(message.sessionId, 128, 'sessionId');
  if (!/^[A-Za-z0-9-]+$/u.test(sessionId)) {
    throw protocolError('ERR_INVALID_BROKER_REQUEST', 'sessionId 형식이 유효하지 않습니다.');
  }
  const cwd = boundedString(message.cwd, 4096, 'cwd');
  const nonce = boundedString(message.nonce, 128, 'nonce');
  if (
    !SHELL_KINDS.has(message.shellKind)
    || !path.isAbsolute(cwd)
    || !/^[A-Za-z0-9_-]+$/u.test(nonce)
  ) {
    throw protocolError('ERR_INVALID_BROKER_REQUEST', 'PTY 실행 인수가 유효하지 않습니다.');
  }
  return {
    sessionId,
    shellKind: message.shellKind,
    nonce,
    cwd,
    cols: size.cols,
    rows: size.rows
  };
}

function sendError(channel, requestId, error) {
  channel.send({
    type: 'response',
    requestId,
    ok: false,
    error: {
      code: error.code || 'ERR_ELEVATED_BROKER',
      message: error.message
    }
  });
}

async function runElevatedPtyBroker(config, options = {}) {
  const connect = options.connect || net.createConnection;
  const exit = options.exit || ((code) => process.exit(code));
  const elevation = (options.detectElevation || detectProcessElevation)();

  const sessions = new Map();
  const socket = connect(config.pipeName);
  const channel = new JsonLineChannel(socket);
  let authenticated = false;
  let shuttingDown = false;
  let lastHeartbeat = Date.now();

  const cleanup = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await Promise.allSettled(
      [...sessions.values()].map((terminal) => terminatePtyTree(terminal))
    );
    sessions.clear();
  };

  const heartbeat = setInterval(() => {
    let parentAlive = true;
    try {
      process.kill(config.parentPid, 0);
    } catch {
      parentAlive = false;
    }
    if (!parentAlive || Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
      void cleanup().finally(() => exit(0));
    }
  }, 2_000);
  heartbeat.unref?.();

  socket.once('connect', () => {
    if (elevation !== 'administrator') {
      channel.send({
        type: 'startup-error',
        token: config.token,
        parentPid: config.parentPid,
        error: {
          code: 'ERR_BROKER_NOT_ELEVATED',
          message: 'PTY broker가 관리자 integrity로 실행되지 않았습니다.'
        }
      });
      channel.close();
      void cleanup().finally(() => exit(1));
      return;
    }
    channel.send({
      type: 'hello',
      token: config.token,
      parentPid: config.parentPid,
      brokerPid: process.pid,
      elevation
    });
  });

  channel.on('message', (message) => {
    void (async () => {
      if (!authenticated) {
        if (message.type !== 'authenticated') {
          throw protocolError('ERR_BROKER_AUTH', 'broker 인증 응답이 유효하지 않습니다.');
        }
        authenticated = true;
        lastHeartbeat = Date.now();
        return;
      }
      if (message.type === 'ping') {
        lastHeartbeat = Date.now();
        channel.send({ type: 'pong', nonce: message.nonce });
        return;
      }
      const requestId = boundedString(message.requestId, 128, 'requestId');
      if (message.type === 'spawn') {
        const request = validateSpawnRequest(message);
        if (sessions.has(request.sessionId)) {
          throw protocolError('ERR_BROKER_SESSION_EXISTS', '이미 존재하는 broker session입니다.');
        }
        const shell = resolvePowerShell({
          preferredKind: request.shellKind,
          includePath: false
        });
        const terminal = pty.spawn(shell.executable, buildPowerShellArguments(
          shellIntegrationPath({
            isPackaged: options.isPackaged === true,
            resourcesPath: options.resourcesPath || process.resourcesPath
          }),
          { noProfile: true }
        ), {
          name: 'xterm-256color',
          cols: request.cols,
          rows: request.rows,
          cwd: request.cwd,
          env: buildElevatedPtyEnvironment(shell.executable, {
            MULTI_SESSION_MANAGER_OSC_NONCE: request.nonce
          })
        });
        sessions.set(request.sessionId, terminal);
        terminal.onData((data) => {
          for (let offset = 0; offset < data.length; offset += MAX_OUTPUT_CHUNK) {
            channel.send({
              type: 'data',
              sessionId: request.sessionId,
              data: data.slice(offset, offset + MAX_OUTPUT_CHUNK)
            });
          }
        });
        terminal.onExit(({ exitCode }) => {
          if (sessions.get(request.sessionId) === terminal) {
            sessions.delete(request.sessionId);
          }
          channel.send({
            type: 'exit',
            sessionId: request.sessionId,
            exitCode
          });
        });
        channel.send({
          type: 'response',
          requestId,
          ok: true,
          result: {
            pid: terminal.pid,
            shellKind: shell.kind,
            shellLabel: shell.label
          }
        });
        return;
      }
      if (message.type === 'shutdown') {
        await cleanup();
        channel.send({ type: 'response', requestId, ok: true, result: {} });
        channel.close();
        exit(0);
        return;
      }
      const sessionId = boundedString(message.sessionId, 128, 'sessionId');
      const terminal = sessions.get(sessionId);
      if (!terminal) {
        throw protocolError('ERR_BROKER_SESSION_MISSING', 'broker session이 없습니다.');
      }
      if (message.type === 'write') {
        terminal.write(boundedString(message.data, 48 * 1024, 'data'));
      } else if (message.type === 'resize') {
        const size = normalizeTerminalSize(message);
        if (!size) {
          throw protocolError('ERR_INVALID_BROKER_REQUEST', 'PTY 크기가 유효하지 않습니다.');
        }
        terminal.resize(size.cols, size.rows);
      } else if (message.type === 'kill') {
        await terminatePtyTree(terminal);
      } else {
        throw protocolError('ERR_INVALID_BROKER_REQUEST', '알 수 없는 broker 요청입니다.');
      }
      channel.send({ type: 'response', requestId, ok: true, result: {} });
    })().catch((error) => {
      if (message?.requestId) {
        sendError(channel, message.requestId, error);
      } else {
        channel.close();
        void cleanup().finally(() => exit(1));
      }
    });
  });
  channel.on('close', () => {
    clearInterval(heartbeat);
    void cleanup().finally(() => exit(0));
  });
  channel.on('protocol-error', () => {
    void cleanup().finally(() => exit(1));
  });
  channel.on('error', () => {
    void cleanup().finally(() => exit(1));
  });
  return { channel, cleanup };
}

module.exports = { runElevatedPtyBroker, validateSpawnRequest };
