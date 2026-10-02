function initializePtyLifecycle(session) {
  let resolveExit;
  session.lifecycle = session.pty ? 'running' : 'exited';
  session.exitResult = session.pty ? null : { exitCode: null };
  session.exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  session.resolveExit = resolveExit;
  session.closePromise = null;
  if (!session.pty) {
    resolveExit(session.exitResult);
  }
  return session;
}

function markPtyExited(session, result = {}) {
  if (session.lifecycle === 'exited') {
    return;
  }
  session.pty = null;
  session.lifecycle = 'exited';
  session.exitResult = result;
  session.resolveExit?.(result);
}

function shouldRemoveAfterPtyExit(session) {
  return session?.lifecycle === 'closing'
    && session.retainAfterTermination !== true;
}

function requestPtyClose(
  session,
  { timeoutMs = 2_000, terminate = (pty) => pty.kill() } = {}
) {
  if (session.closePromise) {
    return session.closePromise;
  }
  if (!session.pty || session.lifecycle === 'exited') {
    return Promise.resolve({ ok: true, status: 'already-exited' });
  }

  session.closePromise = (async () => {
    session.lifecycle = 'closing';
    try {
      await terminate(session.pty);
    } catch (error) {
      if (session.lifecycle === 'exited') {
        return {
          ok: true,
          status: 'pty-exit-observed',
          exitCode: session.exitResult?.exitCode ?? null
        };
      }
      session.lifecycle = 'running';
      return {
        ok: false,
        status: 'kill-error',
        error: { code: error.code || 'ERR_PTY_KILL', message: error.message }
      };
    }

    let timeout;
    const timeoutPromise = new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), timeoutMs);
    });
    const result = await Promise.race([session.exitPromise, timeoutPromise]);
    clearTimeout(timeout);
    if (result?.timeout) {
      return { ok: false, status: 'kill-timeout' };
    }
    return {
      ok: true,
      status: 'pty-exit-observed',
      exitCode: result?.exitCode ?? null
    };
  })().finally(() => {
    session.closePromise = null;
  });
  return session.closePromise;
}

module.exports = {
  initializePtyLifecycle,
  markPtyExited,
  requestPtyClose,
  shouldRemoveAfterPtyExit
};
