const path = require('node:path');
const { randomBytes } = require('node:crypto');

function shellIntegrationPath(options = {}) {
  if (options.isPackaged && options.resourcesPath) {
    return path.join(options.resourcesPath, 'shell-integration.ps1');
  }

  return path.join(__dirname, '..', 'scripts', 'shell-integration.ps1');
}

function createShellIntegrationNonce() {
  return randomBytes(18).toString('base64url');
}

function quotePowerShellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function buildPowerShellArguments(scriptPath = shellIntegrationPath(), options = {}) {
  const command = `try { . ${quotePowerShellLiteral(scriptPath)} } catch { Write-Warning $_ }`;
  return [
    '-NoLogo',
    ...(options.noProfile === true ? ['-NoProfile'] : []),
    '-NoExit',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command
  ];
}

module.exports = {
  buildPowerShellArguments,
  createShellIntegrationNonce,
  quotePowerShellLiteral,
  shellIntegrationPath
};
