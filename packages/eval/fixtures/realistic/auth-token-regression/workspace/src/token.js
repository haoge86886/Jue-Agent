function parseAuthHeader(header) {
  if (!header) return null;
  const parts = header.split(' ');
  if (parts[0] !== 'Token') return null;
  return parts[1] || null;
}

function canAccess(user) {
  return user && (user.role === 'admin' || user.role === 'maintainer');
}

module.exports = { parseAuthHeader, canAccess };
