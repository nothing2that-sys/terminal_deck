const fs = require('node:fs');
const path = require('node:path');

function resolvePowerShell(options = {}) {
  const environment = options.environment || process.env;
  const exists = options.exists || fs.existsSync;
  const pathDirectories = (environment.Path || environment.PATH || '')
    .split(path.delimiter)
    .filter(Boolean);
  const includePath = options.includePath !== false;
  const programFiles = environment.ProgramFiles || 'C:\\Program Files';
  const systemRoot = environment.SystemRoot || 'C:\\Windows';
  const preferredKind = options.preferredKind;
  const explicitPath = options.explicitPath;

  if (
    typeof explicitPath === 'string'
    && /^(pwsh|powershell)\.exe$/iu.test(path.basename(explicitPath))
    && exists(explicitPath)
  ) {
    const kind = path.basename(explicitPath).toLowerCase() === 'pwsh.exe'
      ? 'pwsh'
      : 'powershell';
    return {
      executable: explicitPath,
      kind,
      label:
        kind === 'pwsh'
          ? 'PowerShell 7 (지정 경로)'
          : 'Windows PowerShell 5.1 (지정 경로)'
    };
  }

  const pwshCandidates = [
    ...(includePath
      ? pathDirectories.map((directory) => path.join(directory, 'pwsh.exe'))
      : []),
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  ];

  const windowsPowerShell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

  if (preferredKind === 'powershell' && exists(windowsPowerShell)) {
    return {
      executable: windowsPowerShell,
      kind: 'powershell',
      label: 'Windows PowerShell 5.1'
    };
  }

  for (const candidate of new Set(pwshCandidates)) {
    if (exists(candidate)) {
      return {
        executable: candidate,
        kind: 'pwsh',
        label: 'PowerShell 7'
      };
    }
  }

  if (exists(windowsPowerShell)) {
    return {
      executable: windowsPowerShell,
      kind: 'powershell',
      label: 'Windows PowerShell 5.1'
    };
  }

  throw new Error('PowerShell 7 또는 Windows PowerShell 5.1을 찾을 수 없습니다.');
}

module.exports = {
  resolvePowerShell
};
