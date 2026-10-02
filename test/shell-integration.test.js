const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPowerShellArguments,
  createShellIntegrationNonce,
  quotePowerShellLiteral,
  shellIntegrationPath
} = require('../src/shell-integration');

test('PowerShell literal quoting escapes apostrophes', () => {
  assert.equal(
    quotePowerShellLiteral("C:\\Example's Tools\\integration.ps1"),
    "'C:\\Example''s Tools\\integration.ps1'"
  );
});

test('shell integration is injected for this process without changing profiles', () => {
  const args = buildPowerShellArguments('C:\\app\\shell-integration.ps1');
  assert.deepEqual(args.slice(0, 5), [
    '-NoLogo',
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command'
  ]);
  assert.match(args[5], /\. 'C:\\app\\shell-integration\.ps1'/);
  assert.equal(args.includes('-NoProfile'), false);
});

test('elevated shell integration disables user PowerShell profiles', () => {
  const args = buildPowerShellArguments(
    'C:\\app\\shell-integration.ps1',
    { noProfile: true }
  );
  assert.equal(args.includes('-NoProfile'), true);
});

test('shell integration nonces are URL-safe and unique', () => {
  const first = createShellIntegrationNonce();
  const second = createShellIntegrationNonce();
  assert.match(first, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
});

test('packaged apps load shell integration from Electron resources', () => {
  assert.equal(
    shellIntegrationPath({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\TerminalDeck\\resources'
    }),
    'C:\\Program Files\\TerminalDeck\\resources\\shell-integration.ps1'
  );
});
