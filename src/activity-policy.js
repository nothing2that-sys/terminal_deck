const DEFAULT_IDLE_SECONDS = 3;
const MIN_IDLE_SECONDS = 1;
const MAX_IDLE_SECONDS = 60;

function normalizeIdleSeconds(value, fallback = DEFAULT_IDLE_SECONDS) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.min(
    MAX_IDLE_SECONDS,
    Math.max(MIN_IDLE_SECONDS, Math.round(numericValue))
  );
}

function remainingIdleDelay(lastOutputAt, now, idleTimeoutMs) {
  if (
    !Number.isFinite(lastOutputAt)
    || !Number.isFinite(now)
    || !Number.isFinite(idleTimeoutMs)
    || idleTimeoutMs < 0
  ) {
    return 0;
  }

  return Math.max(0, lastOutputAt + idleTimeoutMs - now);
}

function activityStatus(lastOutputAt, now, idleTimeoutMs) {
  return remainingIdleDelay(lastOutputAt, now, idleTimeoutMs) === 0
    ? 'idle'
    : 'running';
}

module.exports = {
  DEFAULT_IDLE_SECONDS,
  MAX_IDLE_SECONDS,
  MIN_IDLE_SECONDS,
  activityStatus,
  normalizeIdleSeconds,
  remainingIdleDelay
};
