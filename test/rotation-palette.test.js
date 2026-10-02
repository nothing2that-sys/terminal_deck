const assert = require('node:assert/strict');
const test = require('node:test');
const { ROTATION_COLORS, rotationColor } = require('../src/rotation-palette');

test('rotation palette provides sixteen stable distinct colors', () => {
  assert.equal(ROTATION_COLORS.length, 16);
  assert.equal(new Set(ROTATION_COLORS).size, 16);
  assert.equal(rotationColor(1), ROTATION_COLORS[0]);
  assert.equal(rotationColor(16), ROTATION_COLORS[15]);
  assert.equal(rotationColor(17), null);
});
