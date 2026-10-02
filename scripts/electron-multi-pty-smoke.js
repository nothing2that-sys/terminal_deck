const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const pty = require('node-pty');
const { resolvePowerShell } = require('../src/shell');

function runSession(marker, cwd) {
  return new Promise((resolve, reject) => {
    let output = '';
    const script = [
      `$env:TERMINAL_DECK_SMOKE_MARKER = '${marker}'`,
      'Start-Sleep -Milliseconds 250',
      'Write-Output "$env:TERMINAL_DECK_SMOKE_MARKER|$PID|$(Get-Location)"'
    ].join('; ');
    const terminal = pty.spawn(
      resolvePowerShell().executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd,
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      }
    );
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error(`Session ${marker} timed out.`));
    }, 10000);

    terminal.onData((data) => {
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`Session ${marker} exited with code ${exitCode}.`));
        return;
      }

      resolve(output);
    });
  });
}

app.whenReady().then(async () => {
  try {
    const rootDirectory = process.cwd();
    const secondDirectory = path.join(rootDirectory, 'src');
    if (!fs.statSync(secondDirectory).isDirectory()) {
      throw new Error('The source test directory is missing.');
    }

    const [firstOutput, secondOutput] = await Promise.all([
      runSession('SESSION_A', rootDirectory),
      runSession('SESSION_B', secondDirectory)
    ]);
    const firstMatch = firstOutput.match(/SESSION_A\|(\d+)\|([^\r\n]+)/);
    const secondMatch = secondOutput.match(/SESSION_B\|(\d+)\|([^\r\n]+)/);

    if (!firstMatch || !secondMatch) {
      throw new Error('Expected output from both PTY sessions was not found.');
    }
    if (firstMatch[1] === secondMatch[1]) {
      throw new Error('The PTY sessions unexpectedly shared a process ID.');
    }
    if (!firstMatch[2].includes(rootDirectory)) {
      throw new Error('The first PTY did not use the requested start directory.');
    }
    if (!secondMatch[2].includes(secondDirectory)) {
      throw new Error('The second PTY did not use the requested start directory.');
    }

    console.log('Two independent PowerShell PTYs and start directories passed.');
    app.exit(0);
  } catch (error) {
    console.error(error.stack || error.message);
    app.exit(1);
  }
});
