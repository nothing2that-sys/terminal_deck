const { app } = require('electron');
const { ElevatedPtyBrokerClient } = require('../src/elevated-pty-client');
const { createShellIntegrationNonce } = require('../src/shell-integration');

const MARKER = '__TERMINAL_DECK_ELEVATED__';

async function run() {
  await app.whenReady();
  const client = new ElevatedPtyBrokerClient({
    executablePath: process.execPath,
    appPath: require('node:path').resolve(__dirname, '..'),
    isPackaged: app.isPackaged,
    cwd: process.cwd(),
    startTimeoutMs: 30_000,
    requestTimeoutMs: 15_000
  });

  let output = '';
  try {
    const terminal = await client.createPty({
      sessionId: `smoke-${process.pid}`,
      shellKind: 'pwsh',
      nonce: createShellIntegrationNonce(),
      cwd: process.cwd(),
      cols: 120,
      rows: 30
    });
    terminal.onData((data) => { output += data; });
    const exited = new Promise((resolve) => terminal.onExit(resolve));
    terminal.write(
      `$principal = [Security.Principal.WindowsPrincipal]::new(`
      + `[Security.Principal.WindowsIdentity]::GetCurrent()); `
      + `$admin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); `
      + `Write-Output ('${MARKER}' + $admin); exit\r`
    );
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('elevated PTY exit timeout')),
        20_000
      ))
    ]);
    if (!output.includes(`${MARKER}True`)) {
      throw new Error(`elevated marker missing: ${JSON.stringify(output.slice(-1000))}`);
    }
    process.stdout.write('elevated PTY broker smoke passed\n');
  } finally {
    await client.close();
  }
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    app.exit(1);
  });
