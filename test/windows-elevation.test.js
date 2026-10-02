const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  detectProcessElevation,
  elevationFromWhoamiOutput,
  launchWithElevation,
  sanitizedElevationEnvironment
} = require('../src/windows-elevation');

test('Windows integrity SID distinguishes elevated and standard processes', () => {
  assert.equal(elevationFromWhoamiOutput('High Mandatory Level,S-1-16-12288'), 'administrator');
  assert.equal(elevationFromWhoamiOutput('System Mandatory Level,S-1-16-16384'), 'administrator');
  assert.equal(elevationFromWhoamiOutput('Medium Mandatory Level,S-1-16-8192'), 'standard');
  assert.equal(elevationFromWhoamiOutput('unexpected output'), 'unknown');
  assert.equal(detectProcessElevation({ platform: 'linux' }), 'unknown');
});

test('elevation detection fails closed when whoami cannot run', () => {
  assert.equal(detectProcessElevation({
    platform: 'win32',
    execFileSync: () => { throw new Error('missing'); }
  }), 'unknown');
});

test('administrator relaunch uses PowerShell RunAs without interpolating values', async () => {
  let call = null;
  const fakeSpawn = (...args) => {
    call = args;
    const child = new EventEmitter();
    process.nextTick(() => child.emit('exit', 0));
    return child;
  };
  assert.equal(await launchWithElevation({
    elevated: true,
    executablePath: 'C:\\Program Files\\TerminalDeck.exe',
    args: ['D:\\app path'],
    cwd: 'C:\\Program Files',
    spawn: fakeSpawn
  }), true);
  assert.match(call[0], /(?:System32[\\/])?WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/u);
  assert.match(call[1].at(-1), /Verb = "RunAs"/u);
  assert.equal(call[2].env.TERMINAL_DECK_RELAUNCH_EXE,
    'C:\\Program Files\\TerminalDeck.exe');
  assert.equal(call[1].at(-1).includes('TerminalDeck.exe'), false);
});

test('elevated launch environment removes Node and Electron injection variables', () => {
  assert.deepEqual(sanitizedElevationEnvironment({
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\test',
    NODE_OPTIONS: '--require malicious.js',
    ELECTRON_RUN_AS_NODE: '1',
    PATH: 'D:\\attacker'
  }, { TERMINAL_DECK_BROKER_TOKEN: 'token' }), {
    SystemRoot: 'C:\\Windows',
    USERPROFILE: 'C:\\Users\\test',
    TERMINAL_DECK_BROKER_TOKEN: 'token'
  });
});

test('detailed elevated launch distinguishes UAC cancellation', async () => {
  const fakeSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    process.nextTick(() => {
      child.stderr.emit('data', Buffer.from('The operation was canceled by the user.'));
      child.emit('exit', 1);
    });
    return child;
  };
  assert.deepEqual(await launchWithElevation({
    elevated: true,
    detailed: true,
    executablePath: 'C:\\Apps\\TerminalDeck.exe',
    spawn: fakeSpawn
  }), {
    started: false,
    reason: 'canceled',
    detail: 'The operation was canceled by the user.'
  });
});

test('standard relaunch delegates to the unelevated Explorer shell', async () => {
  let call = null;
  const fakeSpawn = (...args) => {
    call = args;
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => child.emit('spawn'));
    return child;
  };
  assert.equal(await launchWithElevation({
    elevated: false,
    executablePath: 'C:\\Apps\\TerminalDeck.exe',
    spawn: fakeSpawn
  }), true);
  assert.match(call[0], /(?:System32[\\/])?explorer\.exe$/u);
  assert.deepEqual(call[1], ['C:\\Apps\\TerminalDeck.exe']);
});
