/**
 * Prosedurel piksel sanati.
 *
 * Hicbir hazir gorsel varligi kullanilmiyor — her sprite dikdortgenlerden
 * cizilir. Boylece harici bir asset paketine ve onun lisansina bagli
 * kalmiyoruz, ajan renkleri de calisma aninda uygulanabiliyor.
 *
 * Tum cizim "mantiksal piksel" birimindedir; olcekleme cagiran tarafta yapilir.
 */

export interface Palette {
  skin: string;
  skinShade: string;
  hair: string;
  shirt: string;
  shirtShade: string;
  pants: string;
  shoes: string;
}

/** Ajan rengine gore tutarli bir karakter paleti uretir. */
export function paletteFor(accent: string, variant: number): Palette {
  const skins = ['#e8b894', '#c98f6a', '#f0cba8', '#a9714b', '#dda57c'];
  const hairs = ['#3a2a1f', '#1f1a17', '#6b4423', '#2d2418', '#4a3728'];
  return {
    skin: skins[variant % skins.length],
    skinShade: shade(skins[variant % skins.length], -0.18),
    hair: hairs[variant % hairs.length],
    shirt: accent,
    shirtShade: shade(accent, -0.22),
    pants: '#3f4550',
    shoes: '#22262e',
  };
}

/** Hex rengi verilen orana gore koyulastirir/aciklastirir. */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((n >> 16) & 255) * (1 + amount));
  const g = clamp(((n >> 8) & 255) * (1 + amount));
  const b = clamp((n & 255) * (1 + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

type Ctx = CanvasRenderingContext2D;

/** Tek bir mantiksal piksel dikdortgeni. */
function px(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

export type Pose = 'stand' | 'walk' | 'sit' | 'type' | 'read' | 'think' | 'cheer' | 'slump';

export interface CharacterOptions {
  palette: Palette;
  pose: Pose;
  /** 0..1 arasi surekli artan animasyon fazi. */
  phase: number;
  /** Yuru yonu: 1 saga, -1 sola. */
  facing: 1 | -1;
}

/**
 * Karakteri (x, y) sol-ust kosesinden cizer. Ayak hizasi y + 20'dir.
 * Genislik 12, ayakta yukseklik 20, oturur halde 17 mantiksal piksel.
 */
export function drawCharacter(ctx: Ctx, x: number, y: number, opts: CharacterOptions): void {
  const { palette: p, pose, phase } = opts;

  // Yurume ve yazma gibi dongusel hareketler icin iki kareli sallanma.
  const step = Math.floor(phase * 4) % 4;
  const bob = pose === 'walk' ? (step === 1 || step === 3 ? 1 : 0) : 0;
  const seated = pose === 'sit' || pose === 'type' || pose === 'read';
  const top = y + bob + (seated ? 3 : 0);

  ctx.save();
  if (opts.facing === -1) {
    ctx.translate(x + 12, 0);
    ctx.scale(-1, 1);
    ctx.translate(-x, 0);
  }

  // --- bacaklar ---
  if (seated) {
    // Oturur pozisyonda uyluk one dogru uzanir, baldir asagi iner.
    px(ctx, x + 2, top + 13, 8, 3, p.pants);
    px(ctx, x + 8, top + 16, 3, 3, p.pants);
    px(ctx, x + 8, top + 19, 3, 1, p.shoes);
  } else if (pose === 'walk') {
    const spread = step === 0 || step === 2 ? 0 : 1;
    px(ctx, x + 3 - spread, top + 14, 3, 5, p.pants);
    px(ctx, x + 6 + spread, top + 14, 3, 5, p.pants);
    px(ctx, x + 3 - spread, top + 19, 3, 1, p.shoes);
    px(ctx, x + 6 + spread, top + 19, 3, 1, p.shoes);
  } else {
    px(ctx, x + 3, top + 14, 3, 5, p.pants);
    px(ctx, x + 6, top + 14, 3, 5, p.pants);
    px(ctx, x + 3, top + 19, 3, 1, p.shoes);
    px(ctx, x + 6, top + 19, 3, 1, p.shoes);
  }

  // --- govde ---
  const slump = pose === 'slump' ? 1 : 0;
  px(ctx, x + 2, top + 8 + slump, 8, 6, p.shirt);
  px(ctx, x + 2, top + 12 + slump, 8, 2, p.shirtShade);

  // --- kollar ---
  if (pose === 'type') {
    // Eller klavyede; iki kare arasinda sirayla iner.
    const left = step % 2 === 0 ? 0 : 1;
    const right = step % 2 === 0 ? 1 : 0;
    px(ctx, x + 1, top + 9, 2, 3, p.shirt);
    px(ctx, x + 9, top + 9, 2, 3, p.shirt);
    px(ctx, x + 1, top + 12 + left, 2, 2, p.skin);
    px(ctx, x + 9, top + 12 + right, 2, 2, p.skin);
  } else if (pose === 'read') {
    // Kollar one uzanmis, elde bir tablet.
    px(ctx, x + 1, top + 9, 2, 4, p.shirt);
    px(ctx, x + 9, top + 9, 2, 4, p.shirt);
    px(ctx, x + 1, top + 13, 10, 1, p.skin);
    px(ctx, x + 2, top + 10, 8, 4, '#f5f2ea');
    px(ctx, x + 3, top + 11, 6, 1, '#b9b3a6');
    px(ctx, x + 3, top + 12, 4, 1, '#b9b3a6');
  } else if (pose === 'cheer') {
    px(ctx, x + 0, top + 5, 2, 4, p.shirt);
    px(ctx, x + 10, top + 5, 2, 4, p.shirt);
    px(ctx, x + 0, top + 3, 2, 2, p.skin);
    px(ctx, x + 10, top + 3, 2, 2, p.skin);
  } else if (pose === 'walk') {
    const swing = step === 0 || step === 2 ? 0 : 1;
    px(ctx, x + 1, top + 9 - swing, 2, 4, p.shirt);
    px(ctx, x + 9, top + 9 + swing, 2, 4, p.shirt);
    px(ctx, x + 1, top + 13 - swing, 2, 2, p.skin);
    px(ctx, x + 9, top + 13 + swing, 2, 2, p.skin);
  } else {
    px(ctx, x + 1, top + 9 + slump, 2, 4, p.shirt);
    px(ctx, x + 9, top + 9 + slump, 2, 4, p.shirt);
    px(ctx, x + 1, top + 13 + slump, 2, 2, p.skin);
    px(ctx, x + 9, top + 13 + slump, 2, 2, p.skin);
  }

  // --- bas ---
  const headY = top + 2 + slump;
  px(ctx, x + 3, headY, 6, 6, p.skin);
  px(ctx, x + 3, headY + 5, 6, 1, p.skinShade);
  // sac
  px(ctx, x + 3, headY - 1, 6, 2, p.hair);
  px(ctx, x + 2, headY, 1, 3, p.hair);
  px(ctx, x + 9, headY, 1, 3, p.hair);
  // gozler — dusuk enerjide kapali
  const eyesClosed = pose === 'slump' || (pose === 'think' && step === 3);
  if (eyesClosed) {
    px(ctx, x + 4, headY + 3, 2, 1, '#4a3a30');
    px(ctx, x + 7, headY + 3, 2, 1, '#4a3a30');
  } else {
    px(ctx, x + 4, headY + 2, 1, 2, '#2b2118');
    px(ctx, x + 7, headY + 2, 1, 2, '#2b2118');
  }

  ctx.restore();
}

/** Karakterin ustunde beliren konusma/dusunce balonu. */
export function drawBubble(
  ctx: Ctx,
  x: number,
  y: number,
  kind: 'think' | 'alert' | 'check',
  phase: number,
): void {
  const bounce = Math.sin(phase * Math.PI * 2) > 0 ? 0 : 1;
  const bx = x + 8;
  const by = y - 9 + bounce;

  if (kind === 'alert') {
    px(ctx, bx, by, 7, 8, '#f0e5d8');
    px(ctx, bx + 1, by + 8, 2, 1, '#f0e5d8');
    px(ctx, bx + 3, by + 1, 1, 4, '#c1502e');
    px(ctx, bx + 3, by + 6, 1, 1, '#c1502e');
    return;
  }

  if (kind === 'check') {
    px(ctx, bx, by, 8, 8, '#e4efe2');
    px(ctx, bx + 1, by + 8, 2, 1, '#e4efe2');
    px(ctx, bx + 2, by + 4, 1, 2, '#3f8f5c');
    px(ctx, bx + 3, by + 5, 1, 1, '#3f8f5c');
    px(ctx, bx + 4, by + 3, 1, 1, '#3f8f5c');
    px(ctx, bx + 5, by + 2, 1, 1, '#3f8f5c');
    return;
  }

  // dusunce: sirayla yanan uc nokta
  px(ctx, bx, by, 9, 7, '#f0e5d8');
  px(ctx, bx + 1, by + 7, 2, 1, '#f0e5d8');
  const lit = Math.floor(phase * 6) % 3;
  for (let i = 0; i < 3; i++) {
    px(ctx, bx + 1 + i * 3, by + 3, 2, 2, i <= lit ? '#8a7d6b' : '#d5c8b6');
  }
}

/** Masa, sandalye ve monitor. Monitor yazarken parlar. */
export function drawDesk(
  ctx: Ctx,
  x: number,
  y: number,
  accent: string,
  active: boolean,
  phase: number,
): void {
  // sandalye sirtligi — oturan karakterin sag arkasinda kalir
  px(ctx, x + 30, y + 2, 3, 14, '#7c5f48');
  px(ctx, x + 24, y + 16, 9, 2, '#8b6b50');

  // masa tablasi
  px(ctx, x, y + 14, 20, 3, '#b98d63');
  px(ctx, x, y + 17, 20, 1, '#8f6a48');
  // ayaklar
  px(ctx, x + 1, y + 18, 2, 8, '#8f6a48');
  px(ctx, x + 17, y + 18, 2, 8, '#8f6a48');

  // monitor
  px(ctx, x + 3, y + 2, 13, 10, '#3a3630');
  const screen = active ? shade(accent, 0.15) : '#5a5750';
  px(ctx, x + 4, y + 3, 11, 8, screen);

  if (active) {
    // Ekranda akan kod satirlari.
    const t = Math.floor(phase * 8);
    for (let i = 0; i < 4; i++) {
      const w = 2 + ((t + i * 3) % 8);
      px(ctx, x + 5, y + 4 + i * 2, Math.min(w, 9), 1, shade(accent, 0.55));
    }
  } else {
    px(ctx, x + 5, y + 5, 7, 1, '#6f6c64');
    px(ctx, x + 5, y + 7, 5, 1, '#6f6c64');
  }

  // ayak / stand
  px(ctx, x + 8, y + 12, 3, 2, '#3a3630');
  // klavye
  px(ctx, x + 4, y + 13, 11, 1, '#2f2c27');
}

/** Duvardaki pencere — disarida gunun rengi. */
export function drawWindow(ctx: Ctx, x: number, y: number): void {
  px(ctx, x - 1, y - 1, 26, 18, '#c9b294');
  px(ctx, x, y, 24, 16, '#bcd8e4');
  // gokyuzu ve tepeler
  px(ctx, x, y + 10, 24, 6, '#a8c9a2');
  px(ctx, x + 4, y + 7, 7, 4, '#93b98e');
  px(ctx, x + 14, y + 8, 6, 3, '#93b98e');
  px(ctx, x + 17, y + 2, 4, 4, '#f2d9a0');
  // pencere boluculeri
  px(ctx, x + 11, y, 2, 16, '#c9b294');
  px(ctx, x, y + 7, 24, 1, '#c9b294');
}

/** Kose bitkisi — ofisi yasatir. */
export function drawPlant(ctx: Ctx, x: number, y: number): void {
  px(ctx, x + 2, y + 10, 8, 8, '#b9764f');
  px(ctx, x + 2, y + 10, 8, 2, '#cf8a5f');
  px(ctx, x + 5, y + 4, 2, 7, '#4f7a45');
  px(ctx, x + 1, y + 2, 4, 4, '#5c8f4f');
  px(ctx, x + 7, y + 1, 4, 4, '#5c8f4f');
  px(ctx, x + 4, y, 4, 3, '#6ba35b');
  px(ctx, x + 0, y + 6, 3, 3, '#4f7a45');
  px(ctx, x + 9, y + 5, 3, 3, '#4f7a45');
}

/** Zemin karolari ve duvar. Sicak, Claude paletine yakin tonlar. */
export function drawRoom(ctx: Ctx, w: number, h: number, wallHeight: number): void {
  // duvar
  px(ctx, 0, 0, w, wallHeight, '#efe9dd');
  // duvar sup pervazi
  px(ctx, 0, wallHeight - 2, w, 2, '#ddd3c2');

  // zemin — iki tonlu ahsap serit
  for (let y = wallHeight; y < h; y += 6) {
    const band = ((y - wallHeight) / 6) % 2 === 0;
    px(ctx, 0, y, w, 6, band ? '#e3d6c3' : '#dccebb');
    // tahta derzleri
    for (let x = ((y / 6) % 2) * 12; x < w; x += 24) {
      px(ctx, x, y, 1, 6, '#cfbfa9');
    }
  }
}
