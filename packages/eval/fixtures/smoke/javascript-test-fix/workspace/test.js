const slugify = require('./slugify');
if (slugify('Hello World') !== 'hello-world') throw new Error('bad slug');
