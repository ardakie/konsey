/** Arayuzun statik dosyalarini dist/ui altina kopyalar (her platformda). */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist', 'ui');
fs.mkdirSync(out, { recursive: true });
for (const file of ['index.html', 'styles.css']) fs.copyFileSync(path.join(root, 'ui', file), path.join(out, file));
fs.rmSync(path.join(out, 'assets'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'ui', 'pixel', 'assets'), path.join(out, 'assets'), { recursive: true });
