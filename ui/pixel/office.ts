/**
 * Piksel ofis sahnesi — tepeden bakis.
 *
 * Gorsel varliklar (karakterler, mobilya, zemin) pixel-agents projesinden
 * alinmistir (MIT). Karakter sprite'lari JIK-A-4'un "Metro City" ucretsiz
 * paketine dayanir. Lisans: ui/pixel/assets/LICENSE-pixel-agents.txt
 *
 * Sprite sayfasi duzeni (pixel-agents ile ayni):
 *   char_N.png = 112x96, 16x32'lik kareler, 3 satir (down, up, right)
 *   yurume  = [0, 1, 2, 1]
 *   yazma   = [3, 4]
 *   okuma   = [5, 6]
 *   sola bakis, saga bakisin yatay yansimasidir.
 *
 * Sahne once mantiksal cozunurlukte bir ara tuvale cizilir, sonra tam sayi
 * katiyla buyutulup ekrana basilir. Boylece piksel yazi tipi ve sprite'lar
 * ayni netlikte kalir.
 */
import { drawText, fitText, measureText } from './pixelFont';

export type AgentActivity =
  | 'offline'
  | 'idle'
  | 'arriving'
  | 'retiring'
  | 'sleeping'
  | 'meeting'
  | 'thinking'
  | 'reading'
  | 'working'
  | 'done'
  | 'blocked';

export interface OfficeAgent {
  id: string;
  label: string;
  color: string;
}

// --- izgara ve yerlesim (mantiksal piksel) ---
const TILE = 16;
/** Bir masa istasyonunun genisligi: masa (48) + bosluk (16). */
const STATION_W = 64;
/** Bir masa sirasinin yuksekligi: masa + karakter + sandalye + koridor. */
const STATION_H = 72;
/** Bir sirada en fazla kac masa; fazlasi alt siraya tasar. */
const DESKS_PER_ROW = 5;

const MARGIN_X = 16;
const WALL_H = 32;
const WORK_TOP = WALL_H + 8;
/** Alt taraftaki dinlenme alaninin yuksekligi. */
const LOUNGE_H = 132;
/** Sahnenin en az genisligi — dinlenme alani sigsin diye. */
const MIN_WIDTH = 448;
const SLEEP_CELL_W = 90;
const SLEEP_CELL_H = 86;
const SLEEP_ROWS = 2;
const SLEEP_PADDING = 14;
const SLEEP_DOOR_Y = WALL_H + 30;
const SLEEP_BEDS = 3;
const SLEEP_COLS = 2;
const SLEEP_W = SLEEP_PADDING * 2 + SLEEP_COLS * SLEEP_CELL_W;
const OPS_W = 176;

const DESK_W = 48;
/** Masanin ustunden karakterin oturdugu noktaya kadar. */
const SEAT_DY = 8;
/** Masanin ustunden sandalyeye. */
const CHAIR_DY = 6;
/** Sira icindeki yurume koridoru, sandalyenin altinda. */
const LANE_DY = 52;

const DOOR_X = 8;

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const ROW_DOWN = 0;
const ROW_UP = 1;
const ROW_RIGHT = 2;

const WALK_FRAMES = [0, 1, 2, 1];
const TYPING_FRAMES = [3, 4];
const READING_FRAMES = [5, 6];

const CHAR_COUNT = 6;

interface Runtime {
  agent: OfficeAgent;
  slot: number;
  charIndex: number;
  x: number;
  y: number;
  facing: 'up' | 'down' | 'left' | 'right';
  activity: AgentActivity;
  walkStage: 'lane' | 'seat' | 'meeting' | 'sleep-door' | 'sleep-bed' | null;
  phase: number;
  lastPulse: number;
  activitySince: number;
  /** Kapidan sirayla cikis icin: bu ana kadar bekle. */
  walkDelayUntil: number;
  /** Masaya varinca uygulanacak durum. */
  pending?: AgentActivity;
  sleepSlot?: number;
  retryAt?: number;
  retryHint?: string;
  leisure?: number;
  stroll?: boolean;
}

interface Assets {
  chars: HTMLImageElement[];
  charsFlipped: HTMLCanvasElement[];
  floor: HTMLCanvasElement;
  desk: HTMLImageElement;
  chair: HTMLImageElement;
  pcOff: HTMLImageElement;
  pcOn: HTMLImageElement[];
  props: Record<string, HTMLImageElement>;
}

const PROP_FILES = [
  'PLANT', 'PLANT_2', 'LARGE_PLANT', 'CACTUS', 'POT',
  'SOFA_BACK', 'SOFA_FRONT', 'SOFA_SIDE', 'COFFEE_TABLE', 'COFFEE',
  'BOOKSHELF', 'DOUBLE_BOOKSHELF', 'WHITEBOARD',
  'LARGE_PAINTING', 'SMALL_PAINTING', 'SMALL_PAINTING_2',
  'CLOCK', 'HANGING_PLANT', 'BIN', 'WOODEN_BENCH', 'CUSHIONED_CHAIR_FRONT',
  'CUSHIONED_CHAIR_BACK', 'CUSHIONED_CHAIR_SIDE',
];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Gorsel yuklenemedi: ${src}`));
    img.src = src;
  });
}

/**
 * Zemin karolari gri tonlamali sablon olarak geliyor; pixel-agents bunlari
 * calisma aninda renklendiriyor. Ayni yaklasim: gri degeri istenen renkle
 * carpip alfa maskesini geri koyuyoruz.
 */
function tint(img: HTMLImageElement, color: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d')!;
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0);
  cx.globalCompositeOperation = 'multiply';
  cx.fillStyle = color;
  cx.fillRect(0, 0, c.width, c.height);
  cx.globalCompositeOperation = 'destination-in';
  cx.drawImage(img, 0, 0);
  return c;
}

function flipSheet(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const cx = c.getContext('2d')!;
  cx.imageSmoothingEnabled = false;
  cx.translate(img.width, 0);
  cx.scale(-1, 1);
  cx.drawImage(img, 0, 0);
  return c;
}

export class PixelOffice {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** Mantiksal cozunurlukte ara tuval; ekrana buyutulerek basilir. */
  private buffer: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private base: string;

  private agents: Runtime[] = [];
  private assets: Assets | null = null;
  private raf = 0;
  private lastFrame = 0;
  private running = false;
  private observer: ResizeObserver | null = null;
  private lastScale = 0;
  /** Ekranda kaplayabilecegi en fazla yukseklik (CSS pikseli). */
  private maxHeight = 480;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  private width = MIN_WIDTH;
  private workWidth = MIN_WIDTH;
  private height = WORK_TOP + STATION_H + LOUNGE_H;
  private rows = 1;
  private cols = 1;

  constructor(canvas: HTMLCanvasElement, assetBase = 'assets/') {
    this.canvas = canvas;
    this.base = assetBase.endsWith('/') ? assetBase : `${assetBase}/`;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D baglami alinamadi');
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = false;

    this.buffer = document.createElement('canvas');
    const bctx = this.buffer.getContext('2d');
    if (!bctx) throw new Error('Ara tuval baglami alinamadi');
    this.bctx = bctx;
    this.bctx.imageSmoothingEnabled = false;

    this.observer = new ResizeObserver(() => this.resize());
    if (canvas.parentElement) this.observer.observe(canvas.parentElement);
  }

  async load(): Promise<void> {
    const b = this.base;
    const [chars, floor, desk, chair, pcOff, on1, on2, on3, propImages] = await Promise.all([
      Promise.all(
        Array.from({ length: CHAR_COUNT }, (_, i) => loadImage(`${b}characters/char_${i}.png`)),
      ),
      loadImage(`${b}floor_1.png`),
      loadImage(`${b}furniture/DESK_FRONT.png`),
      loadImage(`${b}furniture/WOODEN_CHAIR_BACK.png`),
      loadImage(`${b}furniture/PC_FRONT_OFF.png`),
      loadImage(`${b}furniture/PC_FRONT_ON_1.png`),
      loadImage(`${b}furniture/PC_FRONT_ON_2.png`),
      loadImage(`${b}furniture/PC_FRONT_ON_3.png`),
      // Eksik bir sus parcasi sahneyi bozmamali; tek tek tolere edilir.
      Promise.all(
        PROP_FILES.map((name) => loadImage(`${b}furniture/${name}.png`).catch(() => null)),
      ),
    ]);

    const props: Record<string, HTMLImageElement> = {};
    PROP_FILES.forEach((name, i) => {
      const img = propImages[i];
      if (img) props[name] = img;
    });

    this.assets = {
      chars,
      charsFlipped: chars.map(flipSheet),
      // Sicak ahsap tonu — referans ofisin zeminine yakin.
      floor: tint(floor, '#a9764c'),
      desk,
      chair,
      pcOff,
      pcOn: [on1, on2, on3],
      props,
    };

    this.lastScale = 0;
    this.resize();
  }

  setAgents(agents: OfficeAgent[]): void {
    const now = performance.now();
    const previous = this.agents;

    // Once yerlesim hesaplanir; oturma noktalari buna bagli.
    this.cols = Math.min(DESKS_PER_ROW, Math.max(1, agents.length));
    this.rows = Math.max(1, Math.ceil(agents.length / DESKS_PER_ROW));
    this.workWidth = Math.max(MIN_WIDTH, MARGIN_X * 2 + this.cols * STATION_W);

    this.agents = agents.map((agent, i) => {
      const existing = previous.find((r) => r.agent.id === agent.id);
      if (existing) {
        existing.agent = agent;
        existing.slot = i;
        return existing;
      }
      return {
        agent,
        slot: i,
        charIndex: i % CHAR_COUNT,
        // Bosta ajan bilgisayar basinda degil, dinlenme alaninda baslar.
        x: 0,
        y: 0,
        facing: 'down' as const,
        activity: 'idle' as AgentActivity,
        walkStage: null,
        phase: Math.random(),
        lastPulse: 0,
        activitySince: now,
        walkDelayUntil: 0,
      };
    });

    this.reflow();
    for (const r of this.agents) {
      if (r.activity !== 'idle') continue;
      const rest = this.restPosition(r.slot);
      r.x = rest.x;
      r.y = rest.y;
      r.facing = rest.facing;
    }

    this.lastScale = 0;
    this.resize();
  }

  setActivity(id: string, activity: AgentActivity): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (!r) return;
    // Kota uykusu task tamamlandi/stream geldi olaylarindan daha onceliklidir.
    if ((r.activity === 'sleeping' || r.activity === 'retiring') && activity !== 'offline') return;

    const seatsDown = activity === 'working' || activity === 'reading' || activity === 'thinking';
    const now = performance.now();

    // Masasina yuruyorsa yuruyusu bastan baslatma; yalnizca varista ne
    // yapacagini guncelle. Aksi halde her cikti parcasi ajani kapida kilitler.
    if (r.activity === 'arriving') {
      if (seatsDown) {
        if (r.walkStage === 'meeting') r.walkStage = 'lane';
        r.pending = activity;
      } else if (activity === 'meeting') {
        r.walkStage = 'meeting';
        r.pending = activity;
      } else {
        r.activity = activity;
        r.walkStage = null;
        r.activitySince = now;
      }
      return;
    }

    if (r.activity === activity) return;
    r.activitySince = now;

    if (activity === 'meeting') {
      r.activity = 'arriving';
      r.walkStage = 'meeting';
      r.walkDelayUntil = 0;
      r.pending = 'meeting';
      return;
    }

    const atSeat =
      Math.abs(r.x - this.seatX(r.slot)) < 1 && Math.abs(r.y - this.seatY(r.slot)) < 1;
    if (seatsDown && !atSeat) {
      r.activity = 'arriving';
      r.walkStage = 'lane';
      r.walkDelayUntil = 0;
      r.pending = activity;
      return;
    }

    r.activity = activity;
    r.walkStage = null;
  }

  /** Kota dolan ajani sagda acilan odaya yollar ve reset sayacini yataginda gosterir. */
  setSleeping(id: string, retryAt?: number, retryHint?: string): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (!r) return;
    const alreadySleeping = r.sleepSlot !== undefined;
    if (r.sleepSlot === undefined) {
      const used = new Set(this.agents.flatMap((a) => a.sleepSlot === undefined ? [] : [a.sleepSlot]));
      let slot = 0;
      while (used.has(slot)) slot++;
      r.sleepSlot = slot;
    }
    r.retryAt = retryAt;
    r.retryHint = retryHint;
    if (alreadySleeping && (r.activity === 'sleeping' || r.activity === 'retiring')) {
      this.reflow();
      return;
    }
    r.activity = 'retiring';
    r.walkStage = 'sleep-door';
    r.pending = 'sleeping';
    r.activitySince = performance.now();
    this.reflow();
    requestAnimationFrame(() => {
      const frame = this.canvas.parentElement;
      if (frame) frame.scrollTo({ left: frame.scrollWidth, behavior: 'smooth' });
    });
  }

  setAvailable(id: string): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (!r) return;
    r.sleepSlot = undefined;
    r.retryAt = undefined;
    r.retryHint = undefined;
    r.activity = 'idle';
    r.walkStage = null;
    this.reflow();
    const rest = this.restPosition(r.slot);
    r.x = rest.x;
    r.y = rest.y;
    r.facing = rest.facing;
  }

  private reflow(): void {
    const sleepingAgents = this.agents
      .filter((a) => a.sleepSlot !== undefined)
      .sort((a, b) => a.sleepSlot! - b.sleepSlot!);
    sleepingAgents.forEach((agent, index) => { agent.sleepSlot = index; });
    // Uc ana ajan icin uyku odasi her zaman ayni boyda ve uc yataklidir.
    this.width = this.workWidth + SLEEP_W;
    const workHeight = WORK_TOP + this.rows * STATION_H + LOUNGE_H;
    const sleepHeight = WALL_H + 16 + SLEEP_ROWS * SLEEP_CELL_H + 12;
    this.height = Math.max(workHeight, sleepHeight);
    this.lastScale = 0;
    this.resize();
  }

  /**
   * Yeni bir calisma basladi: ajanlar kapiya alinir ve masalarina yururler.
   * Kullanilamayan ajanlar disarida kalir.
   */
  enterOffice(): void {
    const now = performance.now();
    for (const r of this.agents) {
      if (r.activity === 'offline' || r.sleepSlot !== undefined) continue;
      r.activity = 'arriving';
      r.walkStage = 'meeting';
      r.activitySince = now;
      r.walkDelayUntil = now + r.slot * 420;
      r.pending = 'meeting';
    }
  }

  setTeamActivity(activity: AgentActivity): void {
    for (const r of this.agents) {
      if (r.activity === 'offline' || r.sleepSlot !== undefined) continue;
      this.setActivity(r.agent.id, activity);
    }
  }

  /**
   * Sahnenin ekranda kaplayabilecegi en fazla yuksekligi belirler.
   * Olcek hem genislige hem bu sinira gore secilir; boylece ofis
   * gorev ve akis panellerini asagi itmez.
   */
  setMaxHeight(px: number): void {
    const next = Math.max(120, Math.round(px));
    if (next === this.maxHeight) return;
    this.maxHeight = next;
    this.lastScale = 0;
    this.resize();
  }

  pulse(id: string): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (r) r.lastPulse = performance.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (t: number) => {
      if (!this.running) return;
      const dt = Math.min(100, t - this.lastFrame);
      this.lastFrame = t;
      this.update(dt, t);
      if (this.assets) this.draw(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  destroy(): void {
    this.stop();
    this.observer?.disconnect();
    this.observer = null;
  }

  // ------------------------------------------------------------- yerlesim

  private col(slot: number): number {
    return slot % DESKS_PER_ROW;
  }

  private row(slot: number): number {
    return Math.floor(slot / DESKS_PER_ROW);
  }

  private stationX(slot: number): number {
    return MARGIN_X + this.col(slot) * STATION_W;
  }

  private stationY(slot: number): number {
    return WORK_TOP + this.row(slot) * STATION_H;
  }

  private seatX(slot: number): number {
    return this.stationX(slot) + (DESK_W - CHAR_FRAME_W) / 2;
  }

  private seatY(slot: number): number {
    return this.stationY(slot) + SEAT_DY;
  }

  /** Ajanin kendi sirasindaki yurume koridoru. */
  private laneY(slot: number): number {
    return this.stationY(slot) + LANE_DY;
  }

  /** Bosta ajanlar bilgisayar basinda degil, dinlenme alaninda bekler. */
  private restPosition(slot: number): { x: number; y: number; facing: Runtime['facing'] } {
    const top = WORK_TOP + this.rows * STATION_H + 8;
    const loungeX = this.workWidth - 132;
    const seats = [
      { x: loungeX + 30, y: top + 29, facing: 'up' as const },
      { x: loungeX + 46, y: top + 29, facing: 'up' as const },
      { x: loungeX + 78, y: top + 29, facing: 'up' as const },
    ];
    return seats[slot % seats.length];
  }

  private meetingPosition(slot: number): { x: number; y: number; facing: Runtime['facing'] } {
    const top = WORK_TOP + this.rows * STATION_H + 8;
    const seats = [
      { x: 82, y: top + 2, facing: 'down' as const },
      { x: 62, y: top + 29, facing: 'right' as const },
      { x: 153, y: top + 29, facing: 'left' as const },
    ];
    return seats[slot % seats.length];
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const available = parent.clientWidth || this.width;
    const byHeight = this.maxHeight / this.height;
    const scale = Math.max(0.4, Math.min(4, byHeight));
    // Ofis cercevesi sagda bos bant birakmasin. Yukseklik kullanicinin
    // ayiricisina uyar; yatay eksen mevcut cerceveyi tamamen doldurur.
    const outputWidth = Math.max(1, Math.round(available));
    const outputHeight = Math.max(1, Math.round(this.height * scale));

    // Tuvali yeniden boyutlandirmak kabin genisligini degistirip gozlemciyi
    // tekrar tetikleyebiliyor; olcek degismediyse dokunma.
    if (Math.abs(scale - this.lastScale) < 0.001 && this.canvas.width === outputWidth && this.canvas.height === outputHeight) return;
    this.lastScale = scale;

    this.buffer.width = this.width;
    this.buffer.height = this.height;
    this.bctx.imageSmoothingEnabled = false;

    this.canvas.width = outputWidth;
    this.canvas.height = outputHeight;
    this.canvas.style.width = `${outputWidth}px`;
    this.canvas.style.height = `${outputHeight}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  // ------------------------------------------------------------- guncelle

  private update(dt: number, now: number): void {
    for (const r of this.agents) {
      const speed = r.activity === 'working' ? 0.005 : r.activity === 'arriving' ? 0.007 : 0.002;
      r.phase = (r.phase + dt * speed) % 1;

      if (r.activity === 'arriving') this.walk(r, dt, now);
      if (r.activity === 'retiring') this.walkToSleep(r, dt, now);
      if (r.activity === 'idle') {
        const cycle = this.reducedMotion ? 0 : Math.floor((now - r.activitySince + r.slot * 4500) / 16000) % 3;
        const rest = this.restPosition(r.slot);
        const target = cycle === 1
          ? { x: 215 + r.slot * 25, y: WORK_TOP + this.rows * STATION_H + 85, facing: 'up' as const }
          : rest;
        const dx = target.x - r.x, dy = target.y - r.y;
        const step = dt * 0.035;
        r.stroll = Math.abs(dx) + Math.abs(dy) > 1;
        if (r.stroll) {
          if (Math.abs(dy) > step) { r.y += Math.sign(dy) * step; r.facing = dy > 0 ? 'down' : 'up'; }
          else if (Math.abs(dx) > step) { r.y = target.y; r.x += Math.sign(dx) * step; r.facing = dx > 0 ? 'right' : 'left'; }
          else { r.x = target.x; r.y = target.y; }
        } else { r.facing = target.facing; }
        r.leisure = cycle;
      }

      if (r.activity === 'done' && now - r.activitySince > 4500) {
        r.activity = 'idle';
        r.activitySince = now;
      }
    }
  }

  /** Uc asamali yol: once kendi siranin koridoruna, sonra masanin altina, sonra otur. */
  private walk(r: Runtime, dt: number, now: number): void {
    // Hepsi ayni anda kapidan cikarsa ust uste biner; sirayla girerler.
    if (now < r.walkDelayUntil) {
      r.facing = 'right';
      return;
    }

    const step = dt * 0.03;

    if (r.walkStage === 'meeting') {
      const target = this.meetingPosition(r.slot);
      const dx = target.x - r.x;
      const dy = target.y - r.y;
      if (Math.abs(dx) > step) {
        r.x += Math.sign(dx) * step;
        r.facing = dx > 0 ? 'right' : 'left';
        return;
      }
      r.x = target.x;
      if (Math.abs(dy) > step) {
        r.y += Math.sign(dy) * step;
        r.facing = dy > 0 ? 'down' : 'up';
        return;
      }
      r.y = target.y;
      r.facing = target.facing;
      r.walkStage = null;
      r.activity = r.pending ?? 'meeting';
      r.activitySince = now;
      return;
    }

    if (r.walkStage === 'lane') {
      const laneY = this.laneY(r.slot);
      const dyLane = laneY - r.y;
      if (Math.abs(dyLane) > step) {
        r.y += Math.sign(dyLane) * step;
        r.facing = dyLane < 0 ? 'up' : 'down';
        return;
      }
      r.y = laneY;

      const targetX = this.seatX(r.slot);
      const dx = targetX - r.x;
      if (Math.abs(dx) <= step) {
        r.x = targetX;
        r.walkStage = 'seat';
      } else {
        r.x += Math.sign(dx) * step;
        r.facing = dx > 0 ? 'right' : 'left';
      }
      return;
    }

    const targetY = this.seatY(r.slot);
    const dy = targetY - r.y;
    if (Math.abs(dy) <= step) {
      r.y = targetY;
      r.walkStage = null;
      r.facing = 'up';
      r.activity = r.pending ?? 'working';
      r.activitySince = now;
    } else {
      r.y += Math.sign(dy) * step;
      r.facing = dy < 0 ? 'up' : 'down';
    }
  }

  private bedPosition(slot: number): { x: number; y: number } {
    const col = Math.floor(slot / SLEEP_ROWS);
    const row = slot % SLEEP_ROWS;
    return {
      x: this.workWidth + SLEEP_PADDING + col * SLEEP_CELL_W,
      y: WALL_H + 42 + row * SLEEP_CELL_H,
    };
  }

  /** Once bolme kapisina, sonra yataga yurur. */
  private walkToSleep(r: Runtime, dt: number, now: number): void {
    if (r.sleepSlot === undefined) return;
    const step = dt * 0.03;
    const move = (targetX: number, targetY: number): boolean => {
      const dx = targetX - r.x;
      const dy = targetY - r.y;
      if (Math.abs(dy) > step) {
        r.y += Math.sign(dy) * step;
        r.facing = dy < 0 ? 'up' : 'down';
        return false;
      }
      r.y = targetY;
      if (Math.abs(dx) > step) {
        r.x += Math.sign(dx) * step;
        r.facing = dx < 0 ? 'left' : 'right';
        return false;
      }
      r.x = targetX;
      return true;
    };

    if (r.walkStage === 'sleep-door') {
      if (move(this.workWidth + 8, SLEEP_DOOR_Y)) r.walkStage = 'sleep-bed';
      return;
    }
    const bed = this.bedPosition(r.sleepSlot);
    if (move(bed.x + 10, bed.y + 10)) {
      r.activity = 'sleeping';
      r.walkStage = null;
      r.activitySince = now;
    }
  }

  // --------------------------------------------------------------- cizim

  private frameFor(r: Runtime, now: number): { row: number; frame: number; flip: boolean } {
    const dir = (): { row: number; flip: boolean } => {
      switch (r.facing) {
        case 'up':
          return { row: ROW_UP, flip: false };
        case 'left':
          return { row: ROW_RIGHT, flip: true };
        case 'right':
          return { row: ROW_RIGHT, flip: false };
        default:
          return { row: ROW_DOWN, flip: false };
      }
    };
    const { row, flip } = dir();
    const tick = Math.floor(r.phase * 8);
    if (r.activity === 'idle' && r.stroll) return { row, flip, frame: WALK_FRAMES[tick % 4] };

    switch (r.activity) {
      case 'arriving':
      case 'retiring':
        return { row, flip, frame: WALK_FRAMES[tick % WALK_FRAMES.length] };
      case 'reading':
        return { row, flip, frame: READING_FRAMES[tick % 2] };
      case 'meeting':
        return { row, flip, frame: READING_FRAMES[Math.floor(now / 850 + r.slot) % 2] };
      case 'idle': {
        // Sprite paketinde ayri idle karesi yok. Koltukta kitap/kahve hissi
        // icin mevcut el animasyonlarini uzun, sakin araliklarla kullan.
        const mood = Math.floor(now / 4200 + r.slot) % 4;
        if (mood === 1) return { row, flip, frame: READING_FRAMES[Math.floor(now / 900) % 2] };
        if (mood === 3) return { row, flip, frame: TYPING_FRAMES[Math.floor(now / 1200) % 2] };
        return { row, flip, frame: 0 };
      }
      case 'working':
        // Cikti akmiyorsa yazmayi birakip ekrana bakar.
        return now - r.lastPulse < 2500
          ? { row, flip, frame: TYPING_FRAMES[tick % 2] }
          : { row, flip, frame: READING_FRAMES[0] };
      default:
        return { row, flip, frame: 0 };
    }
  }

  private draw(now: number): void {
    const ctx = this.bctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawFloorAndWalls();
    this.drawWallDecor();
    this.drawLounge();
    this.drawSleepWing(now, false);

    for (const r of this.agents) this.drawStation(r, now);
    for (const r of this.agents) {
      if (r.activity !== 'offline' && r.activity !== 'sleeping') this.drawAgent(r, now);
    }
    this.drawLoungeForeground();
    this.drawSleepWing(now, true);
    // Etiketler ve balonlar en uste; hicbir mobilya ustunu ortmesin.
    for (const r of this.agents) {
      if (r.activity !== 'offline' && r.activity !== 'sleeping') this.drawNametag(r);
    }

    // Ara tuvali tam sayi katiyla ekrana bas — pikseller net kalir.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
  }

  private drawFloorAndWalls(): void {
    const ctx = this.bctx;
    const a = this.assets!;

    for (let y = WALL_H; y < this.height; y += TILE) {
      for (let x = 0; x < this.width; x += TILE) ctx.drawImage(a.floor, x, y);
    }

    ctx.fillStyle = '#2b3038';
    ctx.fillRect(0, 0, this.width, WALL_H);
    ctx.fillStyle = '#3a414c';
    ctx.fillRect(0, WALL_H - 4, this.width, 4);
    ctx.fillStyle = '#20242b';
    ctx.fillRect(0, WALL_H - 1, this.width, 1);

    // yan duvarlar
    ctx.fillStyle = '#2b3038';
    ctx.fillRect(0, 0, 6, this.height);
    ctx.fillRect(this.width - 6, 0, 6, this.height);
    ctx.fillStyle = '#20242b';
    ctx.fillRect(6, 0, 1, this.height);
    ctx.fillRect(this.width - 7, 0, 1, this.height);

    if (this.width > this.workWidth) {
      // Calisma alani ile uyku kanadi arasinda, ortasi kapili bolme.
      ctx.fillStyle = '#242933';
      ctx.fillRect(this.workWidth - 3, 0, 6, this.height);
      ctx.fillStyle = '#a9764c';
      ctx.fillRect(this.workWidth - 3, SLEEP_DOOR_Y - 5, 6, 38);
      ctx.fillStyle = '#171b22';
      ctx.fillRect(this.workWidth - 3, SLEEP_DOOR_Y - 6, 6, 2);
    }

    // kapi — ajanlar buradan girer
    const doorY = this.laneY(0) - 6;
    ctx.fillStyle = '#6b4f38';
    ctx.fillRect(0, doorY, 6, 34);
    ctx.fillStyle = '#8a6743';
    ctx.fillRect(0, doorY, 6, 2);
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(4, doorY + 18, 1, 2);
  }

  /** Duvara asili tablolar, saat ve raflar — oda bos gorunmesin. */
  private drawWallDecor(): void {
    const ctx = this.bctx;
    const p = this.assets!.props;

    const order = [
      'BOOKSHELF', 'LARGE_PAINTING', 'CLOCK', 'SMALL_PAINTING',
      'WHITEBOARD', 'SMALL_PAINTING_2', 'DOUBLE_BOOKSHELF', 'HANGING_PLANT',
    ];

    let x = 18;
    let i = 0;
    // Duvari genisligi boyunca, aralarinda bosluk birakarak doldur.
    while (x < this.workWidth - 44 && i < order.length * 3) {
      const img = p[order[i % order.length]];
      i++;
      if (!img) continue;
      const y = img.height >= WALL_H ? 0 : Math.floor((WALL_H - img.height) / 2);
      ctx.drawImage(img, x, y);
      x += img.width + 20;
    }
  }

  /** Alt katta solda planlama masasi, sagda gercek oturma noktali dinlenme alani. */
  private drawLounge(): void {
    const ctx = this.bctx;
    const p = this.assets!.props;
    const top = WORK_TOP + this.rows * STATION_H + 8;

    const put = (name: string, x: number, y: number) => {
      const img = p[name];
      if (img) ctx.drawImage(img, Math.round(x), Math.round(y));
    };

    // PLANLAMA — uc kisilik masa. Toplantida ajanlar bu sandalyelere yurur.
    drawText(ctx, 'TOPLANTI MASASI', 73, top - 8, '#f4ddae');
    ctx.fillStyle = '#8a6545';
    ctx.fillRect(75, top + 10, 82, 58);
    ctx.fillStyle = '#b58358';
    ctx.fillRect(77, top + 12, 78, 54);
    ctx.fillStyle = '#463429';
    ctx.fillRect(84, top + 25, 64, 37);
    ctx.fillRect(88, top + 58, 5, 11);
    ctx.fillRect(139, top + 58, 5, 11);
    ctx.fillStyle = '#d5a66d';
    ctx.fillRect(87, top + 27, 58, 26);
    ctx.fillStyle = '#d7c39b';
    ctx.fillRect(104, top + 32, 18, 11);
    ctx.fillStyle = '#efe5c9';
    ctx.fillRect(106, top + 34, 14, 7);
    put('CUSHIONED_CHAIR_FRONT', 82, top + 14);
    put('CUSHIONED_CHAIR_FRONT', 126, top + 14);
    put('CUSHIONED_CHAIR_BACK', 82, top + 64);
    put('CUSHIONED_CHAIR_BACK', 126, top + 64);
    put('CUSHIONED_CHAIR_SIDE', 64, top + 42);
    const sideChair = p['CUSHIONED_CHAIR_SIDE'];
    if (sideChair) {
      ctx.save();
      ctx.translate(168, top + 42);
      ctx.scale(-1, 1);
      ctx.drawImage(sideChair, 0, 0);
      ctx.restore();
    }

    // DINLENME — iki kisilik kanepe ve tek berjer, toplam uc oturma noktasi.
    const loungeX = this.workWidth - 132;
    drawText(ctx, 'DINLENME', loungeX + 37, top + 1, '#6b4936');
    const rugX = loungeX + 8;
    const rugY = top + 8;
    const rugW = 116;
    const rugH = 58;
    ctx.fillStyle = '#8f4b3a';
    ctx.fillRect(rugX, rugY, rugW, rugH);
    ctx.fillStyle = '#a55a45';
    ctx.fillRect(rugX + 2, rugY + 2, rugW - 4, rugH - 4);
    ctx.fillStyle = '#8f4b3a';
    ctx.fillRect(rugX + 5, rugY + 5, rugW - 10, rugH - 10);
    ctx.fillStyle = '#b3664f';
    ctx.fillRect(rugX + 7, rugY + 7, rugW - 14, rugH - 14);

    put('COFFEE_TABLE', loungeX + 44, top + 16);
    put('COFFEE', loungeX + 53, top + 21);
    put('SOFA_BACK', loungeX + 30, top + 49);
    put('CUSHIONED_CHAIR_BACK', loungeX + 78, top + 49);
    put('SOFA_FRONT', loungeX + 30, top + 10);
    put('SOFA_SIDE', loungeX + 8, top + 27);
    put('SOFA_FRONT', 215, top + 86);
    put('SOFA_FRONT', 259, top + 86);
    put('COFFEE_TABLE', 237, top + 110);
    put('LARGE_PLANT', 12, top);
    put('BIN', 30, top + 46);
    put('PLANT_2', this.workWidth - 30, top - 2);
    put('CACTUS', loungeX + 106, top + 34);
  }

  /** Koltuk ve masa on kenarlari karakterlerin dizlerini kapatir; oturma hissini verir. */
  private drawLoungeForeground(): void {
    const ctx = this.bctx;
    const p = this.assets!.props;
    const top = WORK_TOP + this.rows * STATION_H + 8;
    const loungeX = this.workWidth - 132;

    const sofa = p['SOFA_BACK'];
    if (sofa) ctx.drawImage(sofa, 0, 8, 32, 8, loungeX + 30, top + 57, 32, 8);
    const chair = p['CUSHIONED_CHAIR_BACK'];
    if (chair) ctx.drawImage(chair, 0, 8, 16, 8, loungeX + 78, top + 57, 16, 8);

    // Toplanti masasinin alt kenari, yan koltuklardaki govdelerin onunde.
    ctx.fillStyle = '#79543b';
    ctx.fillRect(84, top + 51, 64, 5);
    ctx.fillStyle = '#a9764c';
    ctx.fillRect(87, top + 51, 58, 2);
  }

  private countdown(retryAt?: number): string {
    if (!retryAt) return '--:--:--';
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  private resetTime(retryAt?: number, retryHint?: string): string {
    if (retryAt) {
      const d = new Date(retryAt);
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return fitText((retryHint || 'BILINMIYOR').toUpperCase(), 48);
  }

  /** Kota dolunca saga eklenen piksel uyku odasi. */
  private drawSleepWing(now: number, foreground: boolean): void {
    const sleeping = this.agents.filter((r) => r.sleepSlot !== undefined);
    const ctx = this.bctx;
    const roomX = this.workWidth + 3;

    if (!foreground) {
      // Isigi kapali oda: zemini de duvari da calisma alanindan belirgin koyu.
      ctx.fillStyle = '#11182b';
      ctx.fillRect(roomX, 0, SLEEP_W - 6, this.height);
      ctx.fillStyle = '#18223a';
      for (let y = WALL_H; y < this.height; y += TILE) {
        ctx.fillRect(roomX, y, SLEEP_W - 6, 1);
      }
      ctx.fillStyle = '#202d49';
      ctx.fillRect(roomX, 0, SLEEP_W - 6, WALL_H);
      drawText(ctx, 'TOKEN UYKU ODASI', this.workWidth + 10, 11, '#b8b4cc');
      drawText(ctx, 'ISIKLAR KAPALI', this.workWidth + 10, 20, '#62708f');

      for (let slot = 0; slot < SLEEP_BEDS; slot++) {
        const bed = this.bedPosition(slot);
        ctx.fillStyle = '#33405f';
        ctx.fillRect(bed.x, bed.y + 7, 46, 25);
        ctx.fillStyle = '#465779';
        ctx.fillRect(bed.x + 2, bed.y + 4, 44, 24);
        ctx.fillStyle = '#b8bfd0';
        ctx.fillRect(bed.x + 4, bed.y + 6, 11, 18);
        ctx.fillStyle = '#0d1322';
        ctx.fillRect(bed.x + 3, bed.y + 31, 3, 3);
        ctx.fillRect(bed.x + 40, bed.y + 31, 3, 3);
        if (!sleeping.some((agent) => agent.sleepSlot === slot)) {
          drawText(ctx, 'BOS', bed.x + 17, bed.y + 14, '#aaa6ba');
        }
      }

      // Dördüncü hücre yatak değil: gece lambası ve küçük komodin.
      const nookX = this.workWidth + SLEEP_PADDING + SLEEP_CELL_W + 12;
      const nookY = WALL_H + 42 + SLEEP_CELL_H + 10;
      ctx.fillStyle = '#293551';
      ctx.fillRect(nookX, nookY + 12, 24, 18);
      ctx.fillStyle = '#3f4d6b';
      ctx.fillRect(nookX + 2, nookY + 10, 20, 4);
      ctx.fillStyle = '#766f63';
      ctx.fillRect(nookX + 10, nookY, 3, 11);
      ctx.fillStyle = '#7e805f';
      ctx.fillRect(nookX + 5, nookY, 13, 5);
    }

    for (const r of sleeping) {
      const bed = this.bedPosition(r.sleepSlot!);
      if (!foreground) continue;

      if (r.activity === 'sleeping') {
        // Bas soldaki yastikta, ayaklar sagda; yorgan yalnizca govdeyi orter.
        const sheet = this.assets!.chars[r.charIndex];
        ctx.save();
        ctx.translate(bed.x + 5, bed.y + 25);
        ctx.rotate(-Math.PI / 2);
        ctx.drawImage(sheet, 0, 0, CHAR_FRAME_W, CHAR_FRAME_H, 0, 0, CHAR_FRAME_W, CHAR_FRAME_H);
        ctx.restore();

        ctx.fillStyle = r.agent.color;
        ctx.fillRect(bed.x + 18, bed.y + 7, 25, 18);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(bed.x + 18, bed.y + 8, 25, 2);

        // Uc Z farkli fazlarda yukselir.
        for (let i = 0; i < 4; i++) {
          const phase = ((now / 1100) + i * 0.28) % 1;
          ctx.globalAlpha = 1 - phase * 0.65;
          drawText(ctx, 'Z', bed.x + 29 + i * 5, bed.y + 3 - Math.floor(phase * 8), '#e8df9a');
        }
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = '#202430';
      ctx.fillRect(bed.x - 3, bed.y - 32, 84, 27);
      const label = fitText(r.agent.label.toUpperCase(), 76);
      drawText(ctx, label, bed.x, bed.y - 29, r.agent.color);
      drawText(ctx, this.countdown(r.retryAt), bed.x, bed.y - 21, '#f3efe6');
      drawText(ctx, `RESET ${this.resetTime(r.retryAt, r.retryHint)}`, bed.x, bed.y - 13, '#aaa6ba');
    }
  }

  /** Uyku odasinin sagindaki boslugu model durum panosu olarak kullan. */
  private drawOpsWing(now: number): void {
    const ctx = this.bctx;
    const x = this.workWidth + SLEEP_W;
    ctx.fillStyle = '#1b2735';
    ctx.fillRect(x, 0, OPS_W, this.height);
    ctx.fillStyle = '#26394a';
    ctx.fillRect(x, 0, OPS_W, WALL_H);
    ctx.fillStyle = '#0e1720';
    ctx.fillRect(x, WALL_H - 2, OPS_W, 2);
    drawText(ctx, 'MODEL KONTROL', x + 12, 11, '#91b3c9');
    const d = new Date();
    drawText(ctx, `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, x + 126, 11, '#c9d9e4');

    ctx.fillStyle = '#101922';
    ctx.fillRect(x + 12, WALL_H + 12, OPS_W - 24, 61);
    ctx.fillStyle = '#31485a';
    ctx.fillRect(x + 14, WALL_H + 14, OPS_W - 28, 57);
    drawText(ctx, 'AJAN DURUMU', x + 20, WALL_H + 19, '#9cb5c5');
    this.agents.slice(0, 5).forEach((r, i) => {
      const y = WALL_H + 30 + i * 9;
      const status = r.sleepSlot !== undefined
        ? 'UYKU'
        : r.activity === 'offline'
          ? 'KAPALI'
          : r.activity === 'idle'
            ? 'MOLA'
            : r.activity === 'meeting'
              ? 'PLAN'
              : 'AKTIF';
      ctx.fillStyle = r.agent.color;
      ctx.fillRect(x + 20, y + 1, 3, 3);
      drawText(ctx, fitText(r.agent.label.toUpperCase(), 62), x + 27, y, '#e0e8ed');
      drawText(ctx, status, x + 108, y, status === 'UYKU' ? '#8fa1c8' : '#9dc6ad');
    });

    // Canli telemetri ekrani: dekoratif ama durum degisimini sakin bicimde belli eder.
    const graphY = WALL_H + 88;
    ctx.fillStyle = '#0c151e';
    ctx.fillRect(x + 12, graphY, OPS_W - 24, 52);
    ctx.strokeStyle = '#294457';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let px = 0; px <= OPS_W - 32; px++) {
      const py = graphY + 27 + Math.round(Math.sin(px * 0.17 + now / 1800) * 6);
      if (px === 0) ctx.moveTo(x + 16 + px, py);
      else ctx.lineTo(x + 16 + px, py);
    }
    ctx.stroke();
    drawText(ctx, 'YEREL TELEMETRI', x + 20, graphY + 7, '#63889f');

    ctx.fillStyle = '#293b49';
    ctx.fillRect(x + 12, graphY + 65, 48, 36);
    ctx.fillRect(x + 68, graphY + 65, 48, 36);
    ctx.fillRect(x + 124, graphY + 65, 40, 36);
    drawText(ctx, '3 YATAK', x + 18, graphY + 76, '#a8bbc7');
    drawText(ctx, 'YEREL', x + 78, graphY + 76, '#a8bbc7');
    drawText(ctx, 'CANLI', x + 130, graphY + 76, '#77b695');
  }

  /** Masa, bilgisayar ve sandalye. */
  private drawStation(r: Runtime, now: number): void {
    const ctx = this.bctx;
    const a = this.assets!;
    const sx = this.stationX(r.slot);
    const sy = this.stationY(r.slot);

    ctx.drawImage(a.desk, sx, sy);

    const pcX = sx + (DESK_W - 16) / 2;
    const pcY = sy - 8;
    const typing = r.activity === 'working' && now - r.lastPulse < 2500;
    if (typing) {
      const f = Math.floor(r.phase * 6) % a.pcOn.length;
      ctx.drawImage(a.pcOn[f], pcX, pcY);
    } else {
      ctx.drawImage(a.pcOff, pcX, pcY);
    }

    ctx.drawImage(a.chair, this.seatX(r.slot), sy + CHAIR_DY);
  }

  private drawAgent(r: Runtime, now: number): void {
    const ctx = this.bctx;
    const a = this.assets!;
    const { row, frame, flip } = this.frameFor(r, now);
    const sheet = flip ? a.charsFlipped[r.charIndex] : a.chars[r.charIndex];
    if (!sheet) return;

    // Yansitilmis sayfada kareler ters siralanir.
    const cols = Math.floor(a.chars[r.charIndex].width / CHAR_FRAME_W);
    const col = flip ? cols - 1 - frame : frame;

    const sitOffset = (r.activity === 'idle' && !r.stroll && r.leisure !== 1) || r.activity === 'meeting' ? 6 : 0;
    ctx.drawImage(
      sheet,
      col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H,
      Math.round(r.x), Math.round(r.y + sitOffset), CHAR_FRAME_W, CHAR_FRAME_H,
    );

    // Sandalye arkaligi oturan karakterin onunde kalir; ayaklar havada gorunmez.
    if (Math.abs(r.x - this.seatX(r.slot)) < 1 && Math.abs(r.y - this.seatY(r.slot)) < 1) {
      ctx.drawImage(a.chair, 0, 16, 16, 8,
        this.seatX(r.slot), this.stationY(r.slot) + CHAIR_DY + 16, 16, 8);
    }

  }

  /**
   * Karakterin basinin ustunde yari saydam, piksel yazili isim etiketi.
   * Durum ayri bir balon yerine etiketin sagina islenir; masalarin ustunde
   * dikey bosluk az oldugu icin balon monitorlere biniyordu.
   */
  private drawNametag(r: Runtime): void {
    const ctx = this.bctx;
    const label = fitText(r.agent.label, STATION_W - 22);
    const textW = measureText(label);

    const status = this.statusGlyph(r);
    const statusW = status ? 6 : 0;

    // yapi: 3 ic bosluk + 3 renk noktasi + 2 bosluk + metin + durum + 3
    const w = 3 + 3 + 2 + textW + statusW + 3;
    const h = 9;
    const x = Math.round(r.x) + Math.round((CHAR_FRAME_W - w) / 2);
    const sitOffset = r.activity === 'idle' || r.activity === 'meeting' ? 6 : 0;
    const idleStagger = r.activity === 'idle' ? (r.slot % 3) * 7 : 0;
    const y = Math.round(r.y + sitOffset) - h - 4 - idleStagger;

    // Yari saydam koyu zemin; koseler bir piksel kirpilarak yumusatilir.
    ctx.fillStyle = 'rgba(18, 20, 25, 0.72)';
    ctx.fillRect(x + 1, y, w - 2, h);
    ctx.fillRect(x, y + 1, w, h - 2);

    ctx.fillStyle = r.agent.color;
    ctx.fillRect(x + 3, y + 3, 3, 3);

    drawText(ctx, label, x + 8, y + 2, '#f3efe6');
    if (status) this.drawStatusGlyph(x + 8 + textW + 2, y + 2, status, r.phase);
  }

  private statusGlyph(r: Runtime): 'alert' | 'check' | 'dots' | null {
    if (r.activity === 'blocked') return 'alert';
    if (r.activity === 'done') return 'check';
    if (r.activity === 'thinking') return 'dots';
    return null;
  }

  /** 3x5'lik minik durum simgeleri — piksel yazi tipiyle ayni olcekte. */
  private drawStatusGlyph(x: number, y: number, kind: 'alert' | 'check' | 'dots', phase: number): void {
    const ctx = this.bctx;
    if (kind === 'alert') {
      ctx.fillStyle = '#e8734a';
      ctx.fillRect(x + 1, y, 1, 3);
      ctx.fillRect(x + 1, y + 4, 1, 1);
      return;
    }
    if (kind === 'check') {
      ctx.fillStyle = '#5fbf7c';
      ctx.fillRect(x, y + 2, 1, 1);
      ctx.fillRect(x + 1, y + 3, 1, 1);
      ctx.fillRect(x + 2, y + 2, 1, 1);
      ctx.fillRect(x + 3, y + 1, 1, 1);
      return;
    }
    // dusunuyor: sirayla yanan uc nokta
    const lit = Math.floor(phase * 6) % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i <= lit ? '#e6c67a' : '#6f6a60';
      ctx.fillRect(x + i * 2, y + 3, 1, 1);
    }
  }
}
