const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePowerShell } = require('../src/shell');

test('PowerShell 7 on PATH has priority', () => {
  const portableDirectory = path.join('C:\\', 'PortablePowerShell');
  const expected = path.join(portableDirectory, 'pwsh.exe');
  const result = resolvePowerShell({
    environment: {
      Path: portableDirectory,
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows'
    },
    exists: (candidate) => candidate === expected
  });

  assert.deepEqual(result, {
    executable: expected,
    kind: 'pwsh',
    label: 'PowerShell 7'
  });
});

test('PowerShell 7 default installation path is detected', () => {
  const expected = path.join(
    'C:\\Program Files',
    'PowerShell',
    '7',
    'pwsh.exe'
  );
  const result = resolvePowerShell({
    environment: {
      Path: '',
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows'
    },
    exists: (candidate) => candidate === expected
  });

  assert.equal(result.executable, expected);
  assert.equal(result.kind, 'pwsh');
});

test('elevated resolution can ignore user-controlled PATH entries', () => {
  const expected = path.join(
    'C:\\Program Files',
    'PowerShell',
    '7',
    'pwsh.exe'
  );
  const visited = [];
  const result = resolvePowerShell({
    includePath: false,
    environment: {
      Path: 'D:\\UserWritable',
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows'
    },
    exists: (candidate) => {
      visited.push(candidate);
      return candidate === expected;
    }
  });

  assert.equal(result.executable, expected);
  assert.equal(visited.some((candidate) => candidate.includes('UserWritable')), false);
});

test('Windows PowerShell 5.1 is the fallback', () => {
  const expected = path.join(
    'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = resolvePowerShell({
    environment: {
      Path: '',
      ProgramFiles: 'C:\\Program Files',
      SystemRoot: 'C:\\Windows'
    },
    exists: (candidate) => candidate === expected
  });

  assert.deepEqual(result, {
    executable: expected,
    kind: 'powershell',
    label: 'Windows PowerShell 5.1'
  });
});

test('restored Windows PowerShell tabs keep their shell kind', () => {
  const existing = new Set([
    'C:\\Tools\\pwsh.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ]);
  const result = resolvePowerShell({
    environment: {
      Path: 'C:\\Tools',
      SystemRoot: 'C:\\Windows'
    },
    exists: (candidate) => existing.has(candidate),
    preferredKind: 'powershell'
  });

  assert.equal(result.kind, 'powershell');
});

test('an explicit PowerShell executable path has priority', () => {
  const explicitPath = 'D:\\Portable\\pwsh.exe';
  const result = resolvePowerShell({
    explicitPath,
    environment: {
      Path: 'C:\\Tools',
      SystemRoot: 'C:\\Windows'
    },
    exists: (candidate) => candidate === explicitPath
  });

  assert.equal(result.executable, explicitPath);
  assert.equal(result.kind, 'pwsh');
  assert.match(result.label, /지정 경로/);
});

test('missing PowerShell produces a clear error', () => {
  assert.throws(
    () =>
      resolvePowerShell({
        environment: {
          Path: '',
          ProgramFiles: 'C:\\Program Files',
          SystemRoot: 'C:\\Windows'
        },
        exists: () => false
      }),
    /PowerShell 7.+Windows PowerShell 5\.1/
  );
});
