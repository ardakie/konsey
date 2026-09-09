/**
 * 3x5'lik minik bir bitmap yazi tipi.
 *
 * Tuvale ctx.fillText ile yazmak, sahne buyutuldugunde bulanik kenarlar
 * uretiyor. Isim etiketlerinin de piksel sanatiyla ayni dokuda durmasi icin
 * harfler tek tek piksel olarak ciziliyor.
 */

const GLYPH_W = 3;
const GLYPH_H = 5;
/** Harfler arasi bosluk. */
const TRACKING = 1;

/** Her glif 5 satir x 3 sutun, satirlar bitisik yazilmis (15 karakter). */
const GLYPHS: Record<string, string> = {
  A: '.#.#.#####.##.#',
  B: '##.#.###.#.###.',
  C: '.###..#..#...##',
  D: '##.#.##.##.###.',
  E: '####..##.#..###',
  F: '####..##.#..#..',
  G: '.###..#.##.#.##',
  H: '#.##.#####.##.#',
  I: '###.#..#..#.###',
  J: '..#..#..##.#.#.',
  K: '#.##.###.#.##.#',
  L: '#..#..#..#..###',
  M: '#.########.##.#',
  N: '#.###########.#',
  O: '.#.#.##.##.#.#.',
  P: '##.#.###.#..#..',
  Q: '.#.#.##.###..##',
  R: '##.#.###.#.##.#',
  S: '.###...#...###.',
  T: '###.#..#..#..#.',
  U: '#.##.##.##.#.#.',
  V: '#.##.##.#.#..#.',
  W: '#.##.########.#',
  X: '#.##.#.#.#.##.#',
  Y: '#.##.#.#..#..#.',
  Z: '###..#.#.#..###',
  '0': '.#.#.##.##.#.#.',
  '1': '.#.##..#..#.###',
  '2': '##...#.#.#..###',
  '3': '##...#.#...###.',
  '4': '#.##.####..#..#',
  '5': '####..##...###.',
  '6': '.###..##.#.#.#.',
  '7': '###..#.#..#..#.',
  '8': '.#.#.#.#.#.#.#.',
  '9': '.#.#.#.##..###.',
  '.': '.............#.',
  '-': '......###......',
  ':': '....#.....#....',
  '/': '..#..#.#.#..#..',
  '+': '....#.###.#....',
  '_': '............###',
  ' ': '...............',
};

/** Turkce harfleri en yakin ASCII karsiligina indirger. */
const FOLD: Record<string, string> = {
  '\u00c7': 'C', '\u011e': 'G', '\u0130': 'I', '\u0131': 'I',
  '\u00d6': 'O', '\u015e': 'S', '\u00dc': 'U',
};

function normalize(text: string): string {
  return [...text]
    .map((ch) => FOLD[ch] ?? ch)
    .map((ch) => ch.toUpperCase())
    .map((ch) => FOLD[ch] ?? ch)
    .map((ch) => (GLYPHS[ch] ? ch : ' '))
    .join('');
}

/** Metnin piksel cinsinden genisligi. */
export function measureText(text: string): number {
  const n = normalize(text).length;
  return n === 0 ? 0 : n * GLYPH_W + (n - 1) * TRACKING;
}

export const FONT_HEIGHT = GLYPH_H;

/** Metni (x, y) sol-ust kosesinden, tek renkte, piksel piksel cizer. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color;
  let cursor = x;

  for (const ch of normalize(text)) {
    const bits = GLYPHS[ch];
    if (bits && ch !== ' ') {
      for (let row = 0; row < GLYPH_H; row++) {
        for (let col = 0; col < GLYPH_W; col++) {
          if (bits[row * GLYPH_W + col] === '#') {
            ctx.fillRect(cursor + col, y + row, 1, 1);
          }
        }
      }
    }
    cursor += GLYPH_W + TRACKING;
  }
}

/** Metni verilen genislige sigacak sekilde kisaltir. */
export function fitText(text: string, maxWidth: number): string {
  let out = text;
  while (out.length > 1 && measureText(out) > maxWidth) out = out.slice(0, -1);
  return out;
}
