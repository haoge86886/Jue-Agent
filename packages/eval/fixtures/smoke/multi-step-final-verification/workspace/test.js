const { value } = require('./lib');
if (value() !== 'good') throw new Error('expected good');
