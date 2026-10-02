const path = require('node:path');
const { spawn } = require('node:child_process');

function taskkillExecutable(environment = process.env) {
  const windowsRoot = environment.SystemRoot || environment.WINDIR;
  return windowsRoot
    ? path.join(windowsRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
}

function taskkillTree(pid, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      taskkillExecutable(),
      ['/PID', String(pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true }
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const error = new Error(`taskkill이 code ${code}로 종료됐습니다.`);
      error.code = 'ERR_PTY_TREE_KILL';
      reject(error);
    });
  });
}

async function terminatePtyTree(pty, options = {}) {
  if (pty?.isElevatedBrokerPty) {
    await pty.kill();
    return;
  }
  const platform = options.platform || process.platform;
  if (
    platform === 'win32'
    && Number.isSafeInteger(pty?.pid)
    && pty.pid > 0
  ) {
    await taskkillTree(pty.pid, options.spawn || spawn);
    return;
  }
  pty.kill();
}

module.exports = { taskkillExecutable, taskkillTree, terminatePtyTree };
