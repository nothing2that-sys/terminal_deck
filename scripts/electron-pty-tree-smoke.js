const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app } = require('electron');
const pty = require('node-pty');
const { terminatePtyTree } = require('../src/pty-tree');

const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'msm-pty-tree-'));
for (const [name, directory] of [
  ['userData', 'user-data'],
  ['sessionData', 'session-data'],
  ['cache', 'cache'],
  ['crashDumps', 'crash-dumps']
]) {
  const target = path.join(profileRoot, directory);
  fs.mkdirSync(target, { recursive: true });
  app.setPath(name, target);
}
app.disableHardwareAcceleration();

function resolvePowerShellPath() {
  const candidate = path.join(
    process.env.ProgramFiles || 'C:\\Program Files',
    'PowerShell',
    '7',
    'pwsh.exe'
  );
  return fs.existsSync(candidate) ? candidate : 'powershell.exe';
}

function processExists(shellPath, pid) {
  try {
    const output = execFileSync(shellPath, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; `
        + 'if ($null -ne $process) { [Console]::Write($process.Id) }'
    ], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    return output.trim() === String(pid);
  } catch (error) {
    if (error.status === 1 && !String(error.stdout || '').trim()) {
      return false;
    }
    throw error;
  }
}

app.whenReady().then(() => new Promise((resolve, reject) => {
  const shellPath = resolvePowerShellPath();
  const terminal = pty.spawn(shellPath, ['-NoLogo', '-NoProfile'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' }
  });
  let output = '';
  let childPid = null;
  let killRequested = false;
  const timeout = setTimeout(() => {
    try { terminal.kill(); } catch {}
    reject(new Error(`nested PTY smoke timed out: ${JSON.stringify(output)}`));
  }, 15_000);
  terminal.onData((data) => {
    output += data;
    const match = /MSM_CHILD_PID:(\d+)/u.exec(output);
    if (!match || killRequested) {
      return;
    }
    childPid = Number(match[1]);
    killRequested = true;
    setTimeout(() => {
      void terminatePtyTree(terminal).catch(reject);
    }, 100);
  });
  terminal.onExit(() => {
    if (!killRequested || !Number.isInteger(childPid)) {
      return;
    }
    setTimeout(() => {
      clearTimeout(timeout);
      try {
        if (processExists(shellPath, childPid)) {
          try {
            execFileSync('taskkill.exe', ['/PID', String(childPid), '/T', '/F'], {
              windowsHide: true,
              timeout: 5_000
            });
          } catch {}
          reject(new Error(`nested child process ${childPid} survived PTY close`));
          return;
        }
        resolve();
      } catch (error) {
        reject(new Error(`nested child verification was UNCOMPARABLE: ${error.message}`));
      }
    }, 700);
  });
  const quotedShell = shellPath.replaceAll("'", "''");
  terminal.write(
    `$p = Start-Process -FilePath '${quotedShell}' `
      + "-ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command',"
      + "'Start-Sleep -Seconds 30') -PassThru; "
      + 'Write-Output "MSM_CHILD_PID:$($p.Id)"; Wait-Process -Id $p.Id\r'
  );
})).then(() => {
  console.log('Nested PowerShell child exited with its PTY owner.');
  fs.rmSync(profileRoot, { recursive: true, force: true });
  app.exit(0);
}).catch((error) => {
  console.error(error.message);
  fs.rmSync(profileRoot, { recursive: true, force: true });
  app.exit(1);
});
