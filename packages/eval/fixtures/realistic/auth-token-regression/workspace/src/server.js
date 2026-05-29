const { parseAuthHeader, canAccess } = require('./token');

const usersByToken = new Map([
  ['admin-token', { id: 'u1', role: 'admin' }],
  ['viewer-token', { id: 'u2', role: 'viewer' }],
]);

function handleRequest(headers) {
  const token = parseAuthHeader(headers.authorization);
  const user = token ? usersByToken.get(token) : null;
  return canAccess(user) ? { status: 200, body: 'ok' } : { status: 401, body: 'unauthorized' };
}

module.exports = { handleRequest };
