const fs = require('node:fs');

function loadConfig(filePath, env = process.env) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return {
    api: { baseUrl: env.JUE_API_URL || raw.api.baseUrl },
    retry: raw.retry ?? 3,
  };
}

module.exports = { loadConfig };
