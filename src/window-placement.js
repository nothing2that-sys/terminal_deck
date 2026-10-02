const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const WINDOW_PLACEMENT_VERSION = 1;

function normalizeRectangle(value) {
  if (
    !Number.isInteger(value?.x)
    || !Number.isInteger(value?.y)
    || !Number.isInteger(value?.width)
    || !Number.isInteger(value?.height)
    || value.width <= 0
    || value.height <= 0
  ) {
    return null;
  }

  return {
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height
  };
}

function normalizeWindowPlacement(value) {
  const bounds = normalizeRectangle(value?.bounds);
  if (!bounds) {
    return null;
  }

  return {
    version: WINDOW_PLACEMENT_VERSION,
    bounds,
    maximized: value?.maximized === true
  };
}

function loadWindowPlacement(filePath) {
  try {
    return normalizeWindowPlacement(
      JSON.parse(fs.readFileSync(filePath, 'utf8'))
    );
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`창 배치 파일을 읽지 못했습니다: ${error.message}`);
    }
    return null;
  }
}

function saveWindowPlacement(filePath, placement) {
  const normalized = normalizeWindowPlacement(placement);
  if (!normalized) {
    return null;
  }

  const temporaryPath =
    `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    temporaryPath,
    `${JSON.stringify(normalized, null, 2)}\n`,
    'utf8'
  );
  fs.renameSync(temporaryPath, filePath);
  return normalized;
}

function intersection(left, right) {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(
    left.x + left.width,
    right.x + right.width
  );
  const bottomEdge = Math.min(
    left.y + left.height,
    right.y + right.height
  );

  if (rightEdge <= x || bottomEdge <= y) {
    return null;
  }

  return {
    x,
    y,
    width: rightEdge - x,
    height: bottomEdge - y
  };
}

function subtractRectangle(source, covering) {
  const overlap = intersection(source, covering);
  if (!overlap) {
    return [source];
  }

  const pieces = [];
  const sourceRight = source.x + source.width;
  const sourceBottom = source.y + source.height;
  const overlapRight = overlap.x + overlap.width;
  const overlapBottom = overlap.y + overlap.height;

  if (overlap.y > source.y) {
    pieces.push({
      x: source.x,
      y: source.y,
      width: source.width,
      height: overlap.y - source.y
    });
  }
  if (overlapBottom < sourceBottom) {
    pieces.push({
      x: source.x,
      y: overlapBottom,
      width: source.width,
      height: sourceBottom - overlapBottom
    });
  }
  if (overlap.x > source.x) {
    pieces.push({
      x: source.x,
      y: overlap.y,
      width: overlap.x - source.x,
      height: overlap.height
    });
  }
  if (overlapRight < sourceRight) {
    pieces.push({
      x: overlapRight,
      y: overlap.y,
      width: sourceRight - overlapRight,
      height: overlap.height
    });
  }

  return pieces;
}

function isBoundsInsideDisplays(bounds, displayWorkAreas) {
  const normalizedBounds = normalizeRectangle(bounds);
  const workAreas = Array.isArray(displayWorkAreas)
    ? displayWorkAreas.map(normalizeRectangle).filter(Boolean)
    : [];
  if (!normalizedBounds || workAreas.length === 0) {
    return false;
  }

  let uncovered = [normalizedBounds];
  for (const workArea of workAreas) {
    uncovered = uncovered.flatMap((rectangle) =>
      subtractRectangle(rectangle, workArea)
    );
    if (uncovered.length === 0) {
      return true;
    }
  }

  return false;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function intersectionArea(left, right) {
  const overlap = intersection(left, right);
  return overlap ? overlap.width * overlap.height : 0;
}

function rectangleDistanceSquared(left, right) {
  const leftCenterX = left.x + left.width / 2;
  const leftCenterY = left.y + left.height / 2;
  const rightCenterX = right.x + right.width / 2;
  const rightCenterY = right.y + right.height / 2;
  return (
    (leftCenterX - rightCenterX) ** 2
    + (leftCenterY - rightCenterY) ** 2
  );
}

function closestWorkArea(bounds, workAreas) {
  return [...workAreas].sort((left, right) => {
    const areaDifference =
      intersectionArea(bounds, right) - intersectionArea(bounds, left);
    if (areaDifference !== 0) {
      return areaDifference;
    }
    return (
      rectangleDistanceSquared(bounds, left)
      - rectangleDistanceSquared(bounds, right)
    );
  })[0];
}

function fitBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  return {
    x: clamp(bounds.x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(bounds.y, workArea.y, workArea.y + workArea.height - height),
    width,
    height
  };
}

function resolveWindowPlacement(value, displayWorkAreas, minimumSize) {
  const placement = normalizeWindowPlacement(value);
  const workAreas = Array.isArray(displayWorkAreas)
    ? displayWorkAreas.map(normalizeRectangle).filter(Boolean)
    : [];
  if (
    !placement
    || placement.bounds.width < minimumSize.width
    || placement.bounds.height < minimumSize.height
    || workAreas.length === 0
  ) {
    return null;
  }

  if (isBoundsInsideDisplays(placement.bounds, workAreas)) {
    return placement;
  }

  const workArea = closestWorkArea(placement.bounds, workAreas);
  if (
    workArea.width < minimumSize.width
    || workArea.height < minimumSize.height
  ) {
    return null;
  }

  placement.bounds = fitBoundsToWorkArea(placement.bounds, workArea);
  return placement;
}

module.exports = {
  WINDOW_PLACEMENT_VERSION,
  isBoundsInsideDisplays,
  loadWindowPlacement,
  normalizeWindowPlacement,
  resolveWindowPlacement,
  saveWindowPlacement
};
