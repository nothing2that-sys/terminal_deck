const test = require('node:test');
const assert = require('node:assert/strict');
const {
  activityStatus,
  normalizeIdleSeconds,
  remainingIdleDelay
} = require('../src/activity-policy');

test('idle seconds default, round, and clamp to the supported range', () => {
  assert.equal(normalizeIdleSeconds('invalid'), 3);
  assert.equal(normalizeIdleSeconds(3.4), 3);
  assert.equal(normalizeIdleSeconds(3.6), 4);
  assert.equal(normalizeIdleSeconds(0), 1);
  assert.equal(normalizeIdleSeconds(90), 60);
});

test('remaining idle delay is measured from the last output', () => {
  assert.equal(remainingIdleDelay(1000, 2500, 3000), 1500);
  assert.equal(remainingIdleDelay(1000, 4000, 3000), 0);
  assert.equal(remainingIdleDelay(1000, 4500, 3000), 0);
});

test('activity changes to idle exactly at the timeout boundary', () => {
  assert.equal(activityStatus(1000, 3999, 3000), 'running');
  assert.equal(activityStatus(1000, 4000, 3000), 'idle');
});
