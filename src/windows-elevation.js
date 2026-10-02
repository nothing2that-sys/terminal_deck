const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const HIGH_INTEGRITY_SIDS = new Set([
  'S-1-16-12288',
  'S-1-16-16384'
]);
const STANDARD_INTEGRITY_SID = 'S-1-16-8192';

function windowsSystemExecutable(name, environment = process.env) {
  const windowsRoot = environment.SystemRoot || environment.WINDIR;
  return windowsRoot ? path.join(windowsRoot, 'System32', name) : name;
}

function elevationFromWhoamiOutput(output) {
  const text = typeof output === 'string' ? output : '';
  if ([...HIGH_INTEGRITY_SIDS].some((sid) => text.includes(sid))) {
    return 'administrator';
  }
  if (text.includes(STANDARD_INTEGRITY_SID)) {
    return 'standard';
  }
  return 'unknown';
}

function detectProcessElevation(options = {}) {
  const platform = options.platform || process.platform;
  const run = options.execFileSync || execFileSync;
  if (platform !== 'win32') {
    return 'unknown';
  }
  try {
    return elevationFromWhoamiOutput(run(
      windowsSystemExecutable('whoami.exe', options.environment),
      ['/groups', '/fo', 'csv', '/nh'],
      { encoding: 'utf8', windowsHide: true }
    ));
  } catch {
    return 'unknown';
  }
}

function waitForSpawn(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.once('spawn', () => finish(true));
    child.once('error', () => finish(false));
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function waitForElevatedLaunch(child) {
  return new Promise((resolve) => {
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8192);
    });
    child.once('error', (error) => resolve({
      started: false,
      reason: 'helper-failed',
      detail: error.message
    }));
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ started: true });
        return;
      }
      const canceled = /(?:1223|cancel(?:ed|led)|취소)/iu.test(stderr);
      resolve({
        started: false,
        reason: canceled ? 'canceled' : 'helper-failed',
        detail: stderr.trim()
      });
    });
  });
}

function sanitizedElevationEnvironment(source, additions = {}) {
  const allowed = [
    'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'ProgramData',
    'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432'
  ];
  return {
    ...Object.fromEntries(allowed
      .filter((name) => typeof source[name] === 'string')
      .map((name) => [name, source[name]])),
    ...additions
  };
}

async function launchWithElevation(options = {}) {
  const launch = options.spawn || spawn;
  const executablePath = options.executablePath;
  const args = Array.isArray(options.args) ? options.args : [];
  const cwd = options.cwd || path.dirname(executablePath);
  if (options.elevated === true) {
    const command = [
      '$ErrorActionPreference = "Stop"',
      '$arguments = [string[]](ConvertFrom-Json $env:TERMINAL_DECK_RELAUNCH_ARGS)',
      '$parameters = @{ FilePath = $env:TERMINAL_DECK_RELAUNCH_EXE; '
        + 'WorkingDirectory = $env:TERMINAL_DECK_RELAUNCH_CWD; Verb = "RunAs" }',
      'if ($arguments.Count -gt 0) { $parameters.ArgumentList = $arguments }',
      'Start-Process @parameters | Out-Null'
    ].join('; ');
    const child = launch(windowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      command
    ], {
      env: {
        ...sanitizedElevationEnvironment(process.env, options.environment),
        TERMINAL_DECK_RELAUNCH_EXE: executablePath,
        TERMINAL_DECK_RELAUNCH_ARGS: JSON.stringify(args),
        TERMINAL_DECK_RELAUNCH_CWD: cwd
      },
      stdio: options.detailed === true ? ['ignore', 'ignore', 'pipe'] : 'ignore',
      windowsHide: true
    });
    const result = options.detailed === true
      ? await waitForElevatedLaunch(child)
      : await waitForExit(child);
    return result;
  }

  const child = launch(windowsSystemExecutable('explorer.exe'), [executablePath, ...args], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref?.();
  return waitForSpawn(child);
}

module.exports = {
  detectProcessElevation,
  elevationFromWhoamiOutput,
  launchWithElevation,
  sanitizedElevationEnvironment
};
