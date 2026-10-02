const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const pty = require('node-pty');
const { resolvePowerShell } = require('../src/shell');
const {
  buildPowerShellArguments,
  createShellIntegrationNonce
} = require('../src/shell-integration');

const resultPath = path.join(process.cwd(), 'electron-osc133-smoke.log');
const nonce = createShellIntegrationNonce();
const command = 'Write-Output "OSC_SMOKE_OUTPUT"';
const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
const osc = (payload) => `\u001b]133;${payload}\u0007`;

fs.writeFileSync(resultPath, 'OSC 133 smoke test started.\n', 'utf8');
app.disableHardwareAcceleration();

function report(message) {
  fs.appendFileSync(resultPath, `${message}\n`, 'utf8');
}

app.whenReady().then(() => {
  const shell = resolvePowerShell();
  let output = '';
  let commandSent = false;
  let settled = false;
  let validationPassed = false;

  const terminal = pty.spawn(shell.executable, buildPowerShellArguments(), {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      MULTI_SESSION_MANAGER_OSC_NONCE: nonce
    }
  });

  function finish(success, message) {
    if (settled) {
      return;
    }

    settled = true;
    clearTimeout(timeout);
    if (!success) {
      try {
        terminal.kill();
      } catch {
        // The shell may already have exited.
      }
    }
    report(message);
    if (success) {
      console.log(message);
      app.exit(0);
    } else {
      report(`Captured output: ${JSON.stringify(output)}`);
      console.error(message);
      console.error(output);
      app.exit(1);
    }
  }

  const timeout = setTimeout(() => {
    finish(false, 'OSC 133 smoke test timed out.');
  }, 15000);

  terminal.onData((data) => {
    output += data;

    if (!commandSent && output.includes(`\u001b]133;B;${nonce};`)) {
      commandSent = true;
      terminal.write(`SHOULD_BE_CLEARED\x07${command}\r`);
    }

    const commandMarker = osc(`E;${nonce};${encodedCommand}`);
    const outputMarker = osc(`C;${nonce}`);
    const finishMarker = osc(`D;${nonce};0`);
    const commandPosition = output.indexOf(commandMarker);
    const outputMarkerPosition = output.indexOf(outputMarker, commandPosition);
    const outputPosition = output.indexOf(
      'OSC_SMOKE_OUTPUT',
      outputMarkerPosition + outputMarker.length
    );
    const finishPosition = output.indexOf(finishMarker, outputPosition);

    if (
      !validationPassed
      && commandPosition >= 0
      && outputMarkerPosition > commandPosition
      && outputPosition > outputMarkerPosition
      && finishPosition > outputPosition
    ) {
      validationPassed = true;
      clearTimeout(timeout);
      terminal.write('exit\r');
    }
  });

  terminal.onExit(({ exitCode }) => {
    if (validationPassed) {
      finish(true, 'PowerShell OSC 133 command boundaries passed.');
    } else if (!settled) {
      finish(false, `PowerShell exited early with code ${exitCode}.`);
    }
  });
}).catch((error) => {
  report(`OSC 133 smoke setup failed: ${error.stack || error.message}`);
  console.error(error);
  app.exit(1);
});
