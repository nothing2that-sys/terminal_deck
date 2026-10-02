const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isBoundsInsideDisplays,
  loadWindowPlacement,
  resolveWindowPlacement,
  saveWindowPlacement
} = require('../src/window-placement');

const minimumSize = { width: 640, height: 420 };

test('window placement round-trips through its JSON file', () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'msm-window-placement-')
  );
  const filePath = path.join(directory, 'window-placement.json');
  const placement = {
    bounds: { x: -1200, y: 40, width: 1000, height: 700 },
    maximized: true
  };

  assert.deepEqual(saveWindowPlacement(filePath, placement), {
    version: 1,
    ...placement
  });
  assert.deepEqual(loadWindowPlacement(filePath), {
    version: 1,
    ...placement
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test('window bounds may span adjacent displays without leaving them', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: 0, width: 1920, height: 1040 }
  ];

  assert.equal(
    isBoundsInsideDisplays(
      { x: 1600, y: 100, width: 800, height: 600 },
      displays
    ),
    true
  );
});

test('partially off-screen window placement is moved into the work area', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  assert.deepEqual(
    resolveWindowPlacement({
      bounds: { x: 1800, y: 100, width: 800, height: 600 }
    }, displays, minimumSize),
    {
      version: 1,
      bounds: { x: 1120, y: 100, width: 800, height: 600 },
      maximized: false
    }
  );
});

test('placement on a disconnected display moves to the nearest display', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  assert.deepEqual(
    resolveWindowPlacement({
      bounds: { x: 2200, y: 100, width: 1000, height: 700 },
      maximized: true
    }, displays, minimumSize),
    {
      version: 1,
      bounds: { x: 920, y: 100, width: 1000, height: 700 },
      maximized: true
    }
  );
});

test('undersized window placement still falls back to defaults', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }];

  assert.equal(
    resolveWindowPlacement({
      bounds: { x: 100, y: 100, width: 500, height: 400 }
    }, displays, minimumSize),
    null
  );
});

test('oversized placement is reduced to the available work area', () => {
  assert.deepEqual(
    resolveWindowPlacement({
      bounds: { x: -100, y: -80, width: 2400, height: 1400 }
    }, [{ x: 0, y: 0, width: 1920, height: 1040 }], minimumSize),
    {
      version: 1,
      bounds: { x: 0, y: 0, width: 1920, height: 1040 },
      maximized: false
    }
  );
});

test('fully visible placement is restored with its maximized state', () => {
  const placement = {
    bounds: { x: 100, y: 80, width: 1100, height: 720 },
    maximized: true
  };
  const resolved = resolveWindowPlacement(
    placement,
    [{ x: 0, y: 0, width: 1920, height: 1040 }],
    minimumSize
  );

  assert.deepEqual(resolved, { version: 1, ...placement });
});
