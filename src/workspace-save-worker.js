const {
  acknowledgeWorkspaceSave,
  saveWorkspace
} = require('./workspace-store');

if (!process.parentPort) {
  throw new Error('workspace save worker는 Electron utility process에서만 실행할 수 있습니다.');
}

process.parentPort.on('message', (event) => {
  const message = event?.data;
  if (!['save-workspace', 'acknowledge-save'].includes(message?.type) || !message.requestId) {
    return;
  }
  try {
    const { baseDirectory, workspaceId, state, options, operationId } =
      message.payload || {};
    const saved = message.type === 'save-workspace'
      ? saveWorkspace(baseDirectory, workspaceId, state, options)
      : acknowledgeWorkspaceSave(baseDirectory, operationId);
    process.parentPort.postMessage({
      requestId: message.requestId,
      ok: true,
      saved
    });
  } catch (error) {
    process.parentPort.postMessage({
      requestId: message.requestId,
      ok: false,
      error: {
        code: error.code || 'ERR_WORKSPACE_SAVE',
        message: error.message,
        stack: error.stack
      }
    });
  }
});
