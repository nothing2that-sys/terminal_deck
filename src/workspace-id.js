const path = require('node:path');

const MAX_WORKSPACE_ID_LENGTH = 120;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;

function isValidWorkspaceId(value) {
  return typeof value === 'string'
    && value.length <= MAX_WORKSPACE_ID_LENGTH
    && SAFE_WORKSPACE_ID.test(value)
    && !WINDOWS_RESERVED_BASENAME.test(value);
}

function workspaceIdKey(value) {
  return requireWorkspaceId(value).toLowerCase();
}

function requireWorkspaceId(value) {
  if (!isValidWorkspaceId(value)) {
    const error = new Error('유효하지 않은 작업 공간 ID입니다.');
    error.code = 'ERR_INVALID_WORKSPACE_ID';
    throw error;
  }
  return value;
}

function resolveContainedPath(rootDirectory, fileName) {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (
    relative.length === 0
    || relative.startsWith(`..${path.sep}`)
    || relative === '..'
    || path.isAbsolute(relative)
  ) {
    const error = new Error('작업 공간 저장 경로가 허용된 경계를 벗어났습니다.');
    error.code = 'ERR_WORKSPACE_PATH_OUTSIDE_ROOT';
    throw error;
  }
  return target;
}

module.exports = {
  MAX_WORKSPACE_ID_LENGTH,
  isValidWorkspaceId,
  requireWorkspaceId,
  resolveContainedPath,
  workspaceIdKey
};
