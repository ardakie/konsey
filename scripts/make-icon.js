/**
 * Uygulama simgesini uretir: build/icon.icns
 *
 * Disaridan bir goruntu kutuphanesine bagimli olmamak icin PNG dogrudan
 * kodlaniyor (zlib Node'da hazir geliyor), ardindan macOS'un kendi
 * araclariyla (sips + iconutil) .icns'e cevriliyor.
 *
 * Tasarim: koyu yuvarlak kare uzerinde uc renkli daire — uc ajan.
 */
const { deflateSync } = require('node:zlib');
const { writeFileSync, mkdirSync, rmSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SIZE = 1024;

const BG = [26, 29, 35];
const DOTS = [
  { x: 0.5, y: 0.33, color: [217, 119, 87] },  // Claude
  { x: 0.33, y: 0.65, color: [16, 163, 127] }, // Codex
  { x: 0.67, y: 0.65, color: [66, 133, 244] }, // Antigravity
];

const DOT_RADIUS = 0.125;
const CORNER_RADIUS = 0.2237; // macOS "squircle" oranina yakin

/** Yumusak kenar icin: merkeze uzakliga gore 0..1 kapsama degeri. */
function coverage(dist, radius) {
  const edge = 1.2;
  if (dist <= radius - edge) return 1;
  if (dist >= radius + edge) return 0;
  return (radius + edge - dist) / (2 * edge);
}

/** Yuvarlatilmis kare icinde mi (kose yariciapina gore). */
function roundedRectCoverage(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return 1;
  return coverage(Math.hypot(dx, dy), radius);
}

function blend(base, top, alpha) {
  return [
    Math.round(base[0] + (top[0] - base[0]) * alpha),
    Math.round(base[1] + (top[1] - base[1]) * alpha),
    Math.round(base[2] + (top[2] - base[2]) * alpha),
  ];
}

/** RGBA ham piksel tamponu uretir. */
function render(size) {
  const corner = CORNER_RADIUS * size;
  const dotR = DOT_RADIUS * size;

  // Her satir bir filtre baytiyla baslar (0 = None).
  const raw = Buffer.alloc(size * (size * 4 + 1));

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;

    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;

      const shapeAlpha = roundedRectCoverage(px, py, size, corner);
      let rgb = BG;

      for (const dot of DOTS) {
        const dist = Math.hypot(px - dot.x * size, py - dot.y * size);
        const a = coverage(dist, dotR);
        if (a > 0) rgb = blend(rgb, dot.color, a);
      }

      const off = rowStart + 1 + x * 4;
      raw[off] = rgb[0];
      raw[off + 1] = rgb[1];
      raw[off + 2] = rgb[2];
      raw[off + 3] = Math.round(shapeAlpha * 255);
    }
  }
  return raw;
}

// --------------------------------------------------------------- PNG

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(raw, size) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit derinligi
  ihdr[9] = 6; // renk tipi: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------- main

const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');
const iconset = path.join(buildDir, 'icon.iconset');

mkdirSync(buildDir, { recursive: true });
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const masterPath = path.join(buildDir, 'icon.png');
writeFileSync(masterPath, encodePng(render(SIZE), SIZE));
console.log(`ana gorsel yazildi: ${masterPath}`);

// macOS'un bekledigi iconset boyutlari.
const variants = [
  [16, 'icon_16x16.png'],
  [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'],
  [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'],
  [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'],
  [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'],
  [1024, 'icon_512x512@2x.png'],
];

for (const [size, name] of variants) {
  execFileSync('/usr/bin/sips', [
    '-z', String(size), String(size), masterPath,
    '--out', path.join(iconset, name),
  ], { stdio: 'ignore' });
}

try {
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  console.log(`simge hazir: ${path.join(buildDir, 'icon.icns')}`);
} catch {
  // Yeni macOS surumlerinde iconutil kendi cikardigi iconset'i bile zaman zaman
  // reddediyor. electron-builder PNG'den guvenilir bicimde icns uretebildigi icin
  // bu, paketlemeyi durduracak bir hata degil.
  console.warn('iconutil iconseti reddetti; paketleyici build/icon.png kullanacak.');
} finally {
  rmSync(iconset, { recursive: true, force: true });
}
