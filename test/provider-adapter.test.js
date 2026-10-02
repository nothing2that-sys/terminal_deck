const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createProviderEventState,
  normalizeProviderMetadata,
  providerCapabilities,
  providerForkCommand,
  providerKindFromCommand,
  providerResumeCommand,
  reduceProviderEvent
} = require('../src/provider-adapter');

test('provider commands are identified without matching arguments or prose', () => {
  assert.equal(providerKindFromCommand('claude --continue'), 'claude');
  assert.equal(providerKindFromCommand('& "C:\\Tools\\codex.cmd"'), 'codex');
  assert.equal(providerKindFromCommand('Write-Output codex'), null);
});

test('unknown versions and unverified Codex fork remain fail closed', () => {
  assert.deepEqual(providerCapabilities('claude', 'unknown'), {
    resume: false, fork: false, structuredEvents: 'stream-json-hooks', version: null
  });
  assert.equal(providerForkCommand({
    kind: 'codex', sessionId: 's1', cliVersion: '1.2.3', lastSeenAt: 1
  }), null);
});

test('provider metadata stores only bounded non-secret identity fields', () => {
  assert.deepEqual(normalizeProviderMetadata({
    kind: 'codex', sessionId: 'abc', cliVersion: '1.2.3', lastSeenAt: 3,
    token: 'secret'
  }), { kind: 'codex', sessionId: 'abc', cliVersion: '1.2.3', lastSeenAt: 3 });
});

test('provider events reject stale and cross-session updates', () => {
  const initial = createProviderEventState('session-a');
  const working = reduceProviderEvent(initial, {
    provider: 'codex', sessionId: 'session-a', turnId: 'turn-a', sequence: 1,
    phase: 'working', attention: 'none', source: 'verified-provider'
  });
  assert.equal(working.phase, 'working');
  assert.equal(reduceProviderEvent(working, {
    provider: 'codex', sessionId: 'session-b', sequence: 2, phase: 'failed'
  }), working);
  assert.equal(reduceProviderEvent(working, {
    provider: 'codex', sessionId: 'session-a', sequence: 1, phase: 'failed'
  }), working);
});

test('resume command quotes the persisted provider session id', () => {
  assert.equal(providerResumeCommand({
    kind: 'claude', sessionId: "abc'def", cliVersion: null, lastSeenAt: 1
  }), "claude --resume 'abc''def'");
});
