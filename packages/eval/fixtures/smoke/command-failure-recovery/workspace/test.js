const { add } = require('./calc');
if (add(2, 3) !== 5) throw new Error('add failed');
