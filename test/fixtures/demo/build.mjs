import fs from 'node:fs';
console.log('building...');
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync('api.mjs', 'dist/api.mjs');
console.log('built dist/api.mjs');
