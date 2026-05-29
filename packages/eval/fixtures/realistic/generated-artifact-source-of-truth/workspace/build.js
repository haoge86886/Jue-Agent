const fs = require('node:fs');
const { renderBanner } = require('./src/template');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/banner.txt', '# GENERATED FILE - DO NOT EDIT\n' + renderBanner() + '\n', 'utf8');
