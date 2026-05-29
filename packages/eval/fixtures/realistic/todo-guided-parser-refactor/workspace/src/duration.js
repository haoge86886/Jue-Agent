function parseDuration(text) {
  const match = /^(\d+)m$/.exec(text.trim());
  if (!match) return 0;
  return Number(match[1]);
}

module.exports = { parseDuration };
