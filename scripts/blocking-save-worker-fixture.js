process.parentPort.on('message', (event) => {
  const message = event?.data;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, 300);
  process.parentPort.postMessage({
    requestId: message.requestId,
    ok: true,
    saved: { completed: true }
  });
});
