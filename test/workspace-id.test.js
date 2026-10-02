const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidWorkspaceId,
  requireWorkspaceId,
  resolveContainedPath
} = require('../src/workspace-id');

test('workspace IDs accept UUID-compatible safe tokens only', () => {
  for (const value of [
    '01234567-89ab-cdef-0123-456789abcdef',
    'workspace-1',
    'Workspace_2026'
  ]) {
    assert.equal(isValidWorkspaceId(value), true, value);
  }
  for (const value of [
    '',
    '..',
    '..\\shared',
    '../shared',
    'C:shared',
    'workspace.json',
    'CON',
    'con',
    'PRN',
    'AUX',
    'NUL',
    'COM1',
    'com9',
    'LPT1',
    'lpt9',
    'trailing ',
    'trailing.',
    'a'.repeat(121)
  ]) {
    assert.equal(isValidWorkspaceId(value), false, String(value));
  }
});

test('invalid workspace IDs fail before becoming file paths', () => {
  assert.throws(
    () => requireWorkspaceId('..\\shared'),
    { code: 'ERR_INVALID_WORKSPACE_ID' }
  );
  assert.throws(
    () => resolveContainedPath('C:\\safe\\workspaces', '..\\shared.json'),
    { code: 'ERR_WORKSPACE_PATH_OUTSIDE_ROOT' }
  );
  assert.equal(
    resolveContainedPath('C:\\safe\\workspaces', 'workspace-1.json'),
    path.resolve('C:\\safe\\workspaces', 'workspace-1.json')
  );
});
