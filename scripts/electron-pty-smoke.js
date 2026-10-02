const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const resultPath = path.join(process.cwd(), 'electron-pty-smoke.log');
fs.writeFileSync(resultPath, 'Electron PTY smoke test started.\n', 'utf8');

function report(message) {
  fs.appendFileSync(resultPath, `${message}\n`, 'utf8');
}

process.on('uncaughtException', (error) => {
  report(`Uncaught exception: ${error.stack || error.message}`);
  app.exit(1);
});

process.on('unhandledRejection', (error) => {
  report(`Unhandled rejection: ${error?.stack || error}`);
  app.exit(1);
});

let pty;
try {
  const ptyModulePath = process.env.PACKAGED_NODE_PTY_PATH || 'node-pty';
  pty = require(ptyModulePath);
  report(`node-pty loaded in Electron from ${ptyModulePath}.`);
} catch (error) {
  report(`node-pty load failed: ${error.stack || error.message}`);
  app.exit(1);
}

const expectedUtf8 = 'UTF8 한글 출력 테스트';
const expectedCp949 = 'CP949 한글 출력 테스트';
const script = [
  "$cp949File = Join-Path $env:TEMP 'terminal-manager-cp949-smoke.txt'",
  '$cp949 = [Text.Encoding]::GetEncoding(949)',
  `[IO.File]::WriteAllText($cp949File, "${expectedCp949}\`r\`n", $cp949)`,
  'cmd.exe /d /c "chcp 949>nul & type `"$cp949File`""',
  'Remove-Item -LiteralPath $cp949File',
  `Write-Output "${expectedUtf8}"`
].join('; ');

function resolvePowerShellPath() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const pwshPath = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
  if (fs.existsSync(pwshPath)) {
    return pwshPath;
  }

  return 'powershell.exe';
}

app.whenReady().then(() => {
  let output = '';
  let settled = false;
  const terminal = pty.spawn(
    resolvePowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    }
  );

  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      terminal.kill();
      report('Electron PTY smoke test timed out.');
      console.error('Electron PTY smoke test timed out.');
      app.exit(1);
    }
  }, 10000);

  terminal.onData((data) => {
    output += data;
  });

  terminal.onExit(({ exitCode }) => {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeout);

    const missing = [expectedUtf8, expectedCp949].filter(
      (expected) => !output.includes(expected)
    );

    if (exitCode !== 0 || missing.length > 0) {
      report(`PTY exited with code ${exitCode}.`);
      report(`Missing output: ${missing.join(', ') || '(none)'}`);
      report(`Captured output: ${JSON.stringify(output)}`);
      console.error('Electron PTY smoke test failed.');
      console.error(`Exit code: ${exitCode}`);
      console.error(`Missing output: ${missing.join(', ') || '(none)'}`);
      console.error(output);
      app.exit(1);
      return;
    }

    report('Electron ABI, PowerShell PTY, UTF-8, and CP949 smoke test passed.');
    console.log('Electron ABI, PowerShell PTY, UTF-8, and CP949 smoke test passed.');
    app.exit(0);
  });
}).catch((error) => {
  report(`Electron app readiness failed: ${error.stack || error.message}`);
  app.exit(1);
});
