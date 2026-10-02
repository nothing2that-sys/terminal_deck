const ATTENTION_PRIORITY = {
  failed: 0,
  exited: 1,
  complete: 2
};

function matchesSearchQuery(searchable, query) {
  const haystack = String(searchable || '').toLocaleLowerCase();
  const terms = String(query || '')
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  return terms.every((term) => haystack.includes(term));
}

function sortAttentionEntries(entries) {
  return [...entries].sort((left, right) => {
    const priority = (ATTENTION_PRIORITY[left.kind] ?? 99)
      - (ATTENTION_PRIORITY[right.kind] ?? 99);
    if (priority !== 0) return priority;
    const recency = (right.occurredAt || 0) - (left.occurredAt || 0);
    if (recency !== 0) return recency;
    return String(left.name || '').localeCompare(String(right.name || ''), 'ko');
  });
}

function relativeTimeLabel(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return '시간 정보 없음';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

function nextSelectionIndex(current, direction, length) {
  if (!Number.isInteger(length) || length <= 0) return -1;
  const start = Number.isInteger(current) && current >= 0 ? current : 0;
  return (start + direction + length) % length;
}

module.exports = {
  matchesSearchQuery,
  nextSelectionIndex,
  relativeTimeLabel,
  sortAttentionEntries
};
