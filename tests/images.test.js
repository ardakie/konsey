const test = require('node:test');
const assert = require('node:assert/strict');

const { attachmentPaths } = require('../dist/src/core/images.js');

test('sohbet istemindeki ekli gorsel yollarini ayiklar', () => {
  const prompt = `Yazıyı değiştir.\n\nEkli görseller (yerel dosya yolları):\n- /tmp/ekran görüntüsü.png\n- /tmp/not.txt`;
  assert.deepEqual(attachmentPaths(prompt), ['/tmp/ekran görüntüsü.png']);
});
