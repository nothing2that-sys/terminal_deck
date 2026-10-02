const INITIAL_SOURCE = 'generic';

function createTerminalStatus(now = Date.now()) {
  return {
    lifecycle: 'open',
    activity: 'ready',
    attention: 'none',
    source: INITIAL_SOURCE,
    commandInProgress: false,
    commandStartedAt: null,
    lastOutputAt: now,
    completedAt: null,
    exitCode: null
  };
}

function reduceTerminalStatus(state, event) {
  const current = state || createTerminalStatus(event?.now);
  if (!event || current.lifecycle === 'exited') {
    return current;
  }
  const now = Number.isFinite(event.now) ? event.now : Date.now();
  switch (event.type) {
    case 'SHELL_READY':
      return current.commandInProgress
        ? current
        : { ...current, activity: 'ready' };
    case 'COMMAND_STARTED':
      return {
        ...current,
        activity: 'running',
        attention: 'none',
        commandInProgress: true,
        commandStartedAt: now,
        lastOutputAt: now,
        completedAt: null,
        exitCode: null
      };
    case 'OUTPUT':
      return current.commandInProgress
        ? { ...current, activity: 'running', lastOutputAt: now }
        : { ...current, lastOutputAt: now };
    case 'SILENCE_TIMEOUT':
      return current.commandInProgress
        ? { ...current, activity: 'quiet' }
        : current;
    case 'COMMAND_COMPLETED':
      return {
        ...current,
        activity: 'ready',
        attention: Number.isInteger(event.exitCode) && event.exitCode !== 0
          ? 'failed'
          : 'complete',
        commandInProgress: false,
        completedAt: now,
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null
      };
    case 'FOCUS':
      return { ...current, attention: 'none' };
    case 'PTY_EXIT':
      return {
        ...current,
        lifecycle: 'exited',
        activity: 'ready',
        commandInProgress: false,
        exitCode: Number.isInteger(event.exitCode) ? event.exitCode : current.exitCode
      };
    default:
      return current;
  }
}

function terminalStatusView(state) {
  if (state.lifecycle === 'exited') {
    return { kind: 'exited', label: '종료됨', attention: true };
  }
  if (state.attention === 'complete') {
    return { kind: 'complete', label: '명령 종료', attention: true };
  }
  if (state.attention === 'failed') {
    return { kind: 'failed', label: '명령 실패', attention: true };
  }
  if (state.commandInProgress && state.activity === 'quiet') {
    return { kind: 'quiet', label: '출력 대기', attention: false };
  }
  if (state.commandInProgress) {
    return { kind: 'running', label: '명령 실행 중', attention: false };
  }
  return { kind: 'ready', label: '입력 대기', attention: false };
}

module.exports = {
  createTerminalStatus,
  reduceTerminalStatus,
  terminalStatusView
};
