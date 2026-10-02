const { EventEmitter } = require('node:events');

const BROKER_FLAG = '--terminal-deck-elevated-broker';
const BROKER_TOKEN_PREFIX = '--broker-token=';
const MAX_BROKER_MESSAGE_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;
const PIPE_PATTERN = /^\\\\\.\\pipe\\terminal-deck-[A-Za-z0-9-]{16,160}$/u;

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function argumentValue(argv, prefix) {
  const match = argv.find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function parseBrokerArguments(argv = process.argv, environment = process.env) {
  if (!argv.includes(BROKER_FLAG)) {
    return null;
  }
  // ShellExecute/RunAs does not reliably preserve a helper process's custom
  // environment. Carry the one-time token as a bounded launch argument and
  // retain the environment fallback for older callers.
  const token = argumentValue(argv, BROKER_TOKEN_PREFIX)
    || environment.TERMINAL_DECK_BROKER_TOKEN;
  const pipeName = argumentValue(argv, '--broker-pipe=');
  const parentPid = Number(argumentValue(argv, '--broker-parent-pid='));
  if (
    !TOKEN_PATTERN.test(token || '')
    || !PIPE_PATTERN.test(pipeName || '')
    || !Number.isSafeInteger(parentPid)
    || parentPid <= 0
  ) {
    throw protocolError(
      'ERR_INVALID_BROKER_ARGUMENTS',
      'elevated PTY broker 시작 인수가 유효하지 않습니다.'
    );
  }
  return { token, pipeName, parentPid };
}

class JsonLineChannel extends EventEmitter {
  constructor(socket, { maxBytes = MAX_BROKER_MESSAGE_BYTES } = {}) {
    super();
    this.socket = socket;
    this.maxBytes = maxBytes;
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.consume(chunk));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (error) => this.emit('error', error));
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxBytes) {
          this.rejectOversizedMessage();
        }
        return;
      }
      if (newline + 1 > this.maxBytes) {
        this.rejectOversizedMessage();
        return;
      }
      const line = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      if (line.length === 0) {
        continue;
      }
      try {
        const message = JSON.parse(line.toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new Error('message must be an object');
        }
        this.emit('message', message);
      } catch (error) {
        const wrapped = protocolError(
          'ERR_INVALID_BROKER_MESSAGE',
          `broker message를 해석하지 못했습니다: ${error.message}`
        );
        this.emit('protocol-error', wrapped);
        this.socket.destroy(wrapped);
        return;
      }
    }
  }

  rejectOversizedMessage() {
    const error = protocolError(
      'ERR_BROKER_MESSAGE_TOO_LARGE',
      'broker message 크기 제한을 초과했습니다.'
    );
    this.emit('protocol-error', error);
    this.socket.destroy(error);
  }

  send(message) {
    const payload = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
    if (payload.length > this.maxBytes) {
      throw protocolError(
        'ERR_BROKER_MESSAGE_TOO_LARGE',
        'broker message 크기 제한을 초과했습니다.'
      );
    }
    this.socket.write(payload);
  }

  close() {
    this.socket.end();
  }
}

module.exports = {
  BROKER_FLAG,
  BROKER_TOKEN_PREFIX,
  JsonLineChannel,
  MAX_BROKER_MESSAGE_BYTES,
  parseBrokerArguments,
  protocolError
};
