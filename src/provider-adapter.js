const PROVIDERS = new Set(['claude', 'codex']);
const PROVIDER_ATTENTION = new Set([
  'none', 'approval', 'input', 'complete', 'failed', 'rate-limit'
]);

function firstCommandToken(command) {
  const text = typeof command === 'string' ? command.trim() : '';
  const match = text.match(/^(?:&\s*)?(?:"([^"]+)"|'([^']+)'|([^\s]+))/u);
  return match ? (match[1] || match[2] || match[3]) : '';
}

function providerKindFromCommand(command) {
  const token = firstCommandToken(command).replaceAll('/', '\\');
  const name = token.split('\\').at(-1)?.toLowerCase() || '';
  if (/^claude(?:\.exe|\.cmd|\.bat|\.ps1)?$/u.test(name)) {
    return 'claude';
  }
  if (/^codex(?:\.exe|\.cmd|\.bat|\.ps1)?$/u.test(name)) {
    return 'codex';
  }
  return null;
}

function bounded(value, length) {
  return typeof value === 'string' ? value.slice(0, length) : null;
}

function normalizeProviderMetadata(value) {
  if (!value || !PROVIDERS.has(value.kind)) {
    return null;
  }
  return {
    kind: value.kind,
    sessionId: bounded(value.sessionId, 256),
    cliVersion: bounded(value.cliVersion, 80),
    lastSeenAt: Number.isFinite(value.lastSeenAt) ? value.lastSeenAt : null
  };
}

function parseVersion(text) {
  const match = String(text || '').match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/u);
  return match ? match[0] : null;
}

function providerCapabilities(kind, version) {
  if (!PROVIDERS.has(kind)) {
    return { resume: false, fork: false, structuredEvents: false };
  }
  const parsedVersion = parseVersion(version);
  return {
    // Discovery alone does not prove that this terminal owns a resumable
    // provider session. The renderer enables these only after a verified
    // provider binding supplies a session id.
    resume: parsedVersion !== null,
    fork: kind === 'claude' && parsedVersion !== null,
    structuredEvents: kind === 'codex' ? 'app-server' : 'stream-json-hooks',
    version: parsedVersion
  };
}

function createProviderEventState(sessionId = null) {
  return {
    sessionId,
    turnId: null,
    sequence: 0,
    phase: 'idle',
    attention: 'none',
    source: 'generic'
  };
}

function reduceProviderEvent(state, event) {
  if (!event || !PROVIDERS.has(event.provider)) {
    return state;
  }
  if (state.sessionId && event.sessionId !== state.sessionId) {
    return state;
  }
  if (!Number.isSafeInteger(event.sequence) || event.sequence <= state.sequence) {
    return state;
  }
  if (!PROVIDER_ATTENTION.has(event.attention || 'none')) {
    return state;
  }
  return {
    sessionId: event.sessionId,
    turnId: bounded(event.turnId, 256),
    sequence: event.sequence,
    phase: ['working', 'waiting', 'completed', 'failed'].includes(event.phase)
      ? event.phase
      : state.phase,
    attention: event.attention || 'none',
    source: event.source === 'verified-provider' ? event.source : state.source
  };
}

function quotePowerShellArgument(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function providerResumeCommand(provider) {
  const metadata = normalizeProviderMetadata(provider);
  if (!metadata?.sessionId) {
    return null;
  }
  return metadata.kind === 'claude'
    ? `claude --resume ${quotePowerShellArgument(metadata.sessionId)}`
    : `codex resume ${quotePowerShellArgument(metadata.sessionId)}`;
}

function providerForkCommand(provider) {
  const resume = providerResumeCommand(provider);
  if (!resume) {
    return null;
  }
  return provider.kind === 'claude' ? `${resume} --fork-session` : null;
}

module.exports = {
  createProviderEventState,
  normalizeProviderMetadata,
  parseVersion,
  providerCapabilities,
  providerForkCommand,
  providerKindFromCommand,
  providerResumeCommand,
  reduceProviderEvent
};
