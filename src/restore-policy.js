function mergeLiveAndUnrestoredTabs(liveTabs, unrestoredTabs) {
  const live = Array.isArray(liveTabs) ? liveTabs : [];
  const failed = Array.isArray(unrestoredTabs) ? unrestoredTabs : [];
  const keys = new Set(live.map((tab) => tab?.key).filter(Boolean));
  return [
    ...live,
    ...failed.filter((tab) => tab?.key && !keys.has(tab.key))
  ];
}

module.exports = { mergeLiveAndUnrestoredTabs };
