const ROTATION_COLORS = [
  '#58a6ff', '#f78166', '#a371f7', '#3fb950',
  '#d29922', '#db61a2', '#39c5cf', '#ff7b72',
  '#79c0ff', '#ffa657', '#bc8cff', '#56d364',
  '#e3b341', '#ff9bce', '#76e3ea', '#f0883e'
];

function rotationColor(slot) {
  return Number.isInteger(slot) && slot >= 1 && slot <= ROTATION_COLORS.length
    ? ROTATION_COLORS[slot - 1]
    : null;
}

module.exports = { ROTATION_COLORS, rotationColor };
