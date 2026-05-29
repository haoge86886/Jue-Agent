function businessDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function dueLabel(dueAt, now) {
  const due = businessDateKey(dueAt);
  const today = businessDateKey(now);
  if (due === today) return 'today';
  return due < today ? 'overdue' : 'upcoming';
}

module.exports = { dueLabel, businessDateKey };
