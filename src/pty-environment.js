function buildPtyEnvironment(additions = {}, source = process.env) {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([, value]) => typeof value === 'string')
  );
  return {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...additions
  };
}

function buildElevatedPtyEnvironment(shellExecutable, additions = {}, source = process.env) {
  const allowed = [
    'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE',
    'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'APPDATA', 'ProgramData'
  ];
  const environment = Object.fromEntries(allowed
    .filter((name) => typeof source[name] === 'string')
    .map((name) => [name, source[name]]));
  const systemRoot = environment.SystemRoot || environment.WINDIR || 'C:\\Windows';
  environment.Path = [
    require('node:path').dirname(shellExecutable),
    require('node:path').join(systemRoot, 'System32'),
    systemRoot
  ].join(require('node:path').delimiter);
  environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  return {
    ...environment,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    ...additions
  };
}

module.exports = { buildElevatedPtyEnvironment, buildPtyEnvironment };
