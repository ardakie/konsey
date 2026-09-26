/**
 * Piksel ofis sahnesi — tepeden (3/4) bakis.
 *
 * Gorsel varliklar (karakterler, mobilya, zemin) pixel-agents projesinden
 * alinmistir (MIT). Karakter sprite'lari JIK-A-4'un "Metro City" ucretsiz
 * paketine dayanir. Lisans: ui/pixel/assets/LICENSE-pixel-agents.txt
 *
 * Sprite sayfasi duzeni (pixel-agents ile ayni):
 *   char_N.png = 112x96, 16x32'lik kareler, 3 satir (down, up, right)
 *   yurume  = [0, 1, 2, 1]
 *   yazma   = [3, 4]   (oturma pozu)
 *   okuma   = [5, 6]   (oturma pozu)
 *   sola bakis, saga bakisin yatay yansimasidir.
 *
 * Yerlesim tek siradir: solda toplanti masasi, ortada calisma masalari,
 * sagda dinlenme kosesi, en sagda uyku odasi. Boylece genis ve alcak bir
 * seritte bos zemin kalmaz.
 *
 * Derinlik: her sprite taban cizgisine (z) gore sirali cizilir. Oturan
 * karakterin onundeki sandalye/masa ondan sonra cizildigi icin karakter
 * mobilyanin "ustune cikmaz"; arkasindaki sandalye ise onun altinda kalir.
 *
 * Yollar: ajanlar mobilyanin icinden gecmez. Her oturma yerinin ana
 * koridordan (alttaki yurume yolu) baslayan bir rotasi vardir; ajan once
 * geldigi rotayi geri yurur, koridorda yatay ilerler, sonra yeni rotaya girer.
 *
 * Sahne once mantiksal cozunurlukte bir ara tuvale cizilir, sonra iki eksende
 * ayni oranla ve yumusatma kapali olarak ekrana basilir.
 */
import { drawText, fitText, measureText } from './pixelFont';
import { L } from '../../src/shared/i18n';

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
  /** Sprite sayfasi; verilmezse sira numarasindan secilir. */
  charIndex?: number;
}

// --- izgara ve yerlesim (mantiksal piksel) ---
const TILE = 16;
const WALL_H = 32;

/** Bir masa istasyonu: masa (48) + iki yaninda 8'er piksel. */
const STATION_W = 64;
const DESK_W = 48;
/** Bir sirada en fazla uc masa; dorduncu ajanla ikinci sira acilir. */
const DESKS_PER_ROW = 3;
/** Ilk masa sirasinin ust kenari. */
const DESK_Y = 40;
/** Birden fazla masa sirasi olursa aralarindaki mesafe. */
const ROW_H = 72;
/** Masanin ust kenarindan oturan karakterin cizim noktasina. */
const DESK_SEAT_DY = 16;
/** Masanin ust kenarindan sandalyeye. */
const DESK_CHAIR_DY = 15;
/** Son masa sirasindan ana koridora (karakterin ust kenari). */
const LANE_DY = 60;
/** Ana koridorun altinda kalan zemin. */
const FLOOR_BELOW_LANE = 46;

/** Toplanti masasi ve dinlenme kosesinde ust sira koltuklarin ust kenari. */
const ZONE_Y = 54;
/** Duvar ile ust sira koltuklar arasindaki arka yol (karakterin ust kenari). */
const BACK_LANE_Y = 36;

const MARGIN_L = 8;
/** Toplanti bolgesi: sol gecit (20) + masa (80) + bosluk (12). */
const MEET_W = 112;
const TABLE_W = 80;
const TABLE_H = 34;
const MEET_SPACING = 27;
/** Dinlenme bolgesi: koltuklar (80) + sag gecit. */
const LOUNGE_W = 100;
const LOUNGE_SPACING = 28;
const MARGIN_R = 4;

/** Tek sirali odada yataklar yan yana, iki sirali odada ust uste dizilir. */
const SLEEP_W_WIDE = 190;
const SLEEP_W_TALL = 82;
const SLEEP_BEDS = 3;
const BED_GAP = 58;
const BED_Y = 62;
const BED_GAP_TALL = 56;

const CHAR_FRAME_W = 16;
const CHAR_FRAME_H = 32;
const ROW_DOWN = 0;
const ROW_UP = 1;
const ROW_RIGHT = 2;

const WALK_FRAMES = [0, 1, 2, 1];
const TYPING_FRAMES = [3, 4];
const READING_FRAMES = [5, 6];

const CHAR_COUNT = 6;
/** Yurume hizi (mantiksal piksel / ms). */
const WALK_SPEED = 0.045;

/**
 * Alti koltuklu masalarda ajanlarin oturma sirasi: once ust koseler, sonra
 * alt koseler, en son ortalar. Etiketler boylece birbirine binmez.
 * 0..2 ust sira (soldan saga), 3..5 alt sira.
 */
const SEAT_ORDER = [0, 2, 3, 5, 1, 4];

type Facing = 'up' | 'down' | 'left' | 'right';
type Place = 'desk' | 'meet' | 'rest' | 'bed';

interface Pt {
  x: number;
  y: number;
}

interface Seat extends Pt {
  facing: Facing;
  /** Koridordan koltuga ara noktalar: ilki koridorun uzerinde, sonuncusu koltuk. */
  route: Pt[];
  /** Verilirse isim etiketi koltugun altinda bu y'de durur. */
  tagBelow?: number;
  /** Kafanin ustundeki etiketi komsusundan ayirmak icin ek yukseklik. */
  lift?: number;
}

interface Step extends Pt {
  kind: 'out' | 'lane' | 'in';
  /** 'out' adiminda geri yurunen iz noktasinin sirasi. */
  index?: number;
}

interface Runtime {
  agent: OfficeAgent;
  slot: number;
  charIndex: number;
  x: number;
  y: number;
  facing: Facing;
  activity: AgentActivity;
  phase: number;
  lastPulse: number;
  activitySince: number;
  /** Kapidan sirayla cikis icin: bu ana kadar bekle. */
  walkDelayUntil: number;
  /** Gidilen (ya da oturulan) yer. */
  dest: Place;
  path: Step[];
  /** Koridordan su anki konuma kadar gecilen rota noktalari; bos: koridorda. */
  trail: Pt[];
  seated: boolean;
  sleepSlot?: number;
  retryAt?: number;
  retryHint?: string;
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

interface Drawable {
  z: number;
  draw: () => void;
}

const PROP_FILES = [
  'PLANT', 'PLANT_2', 'LARGE_PLANT', 'CACTUS',
  'SOFA_BACK', 'SOFA_FRONT', 'COFFEE_TABLE', 'COFFEE',
  'BOOKSHELF', 'DOUBLE_BOOKSHELF', 'WHITEBOARD',
  'LARGE_PAINTING', 'SMALL_PAINTING', 'SMALL_PAINTING_2',
  'CLOCK', 'HANGING_PLANT', 'CUSHIONED_CHAIR_FRONT', 'CUSHIONED_CHAIR_BACK',
];

function loadImage(src: string, retries = 1): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    // Gecici bir okuma hatasi tum sahneyi bos birakmasin; bir kez daha denenir.
    img.onerror = () => {
      if (retries > 0) loadImage(src, retries - 1).then(resolve, reject);
      else reject(new Error(`Gorsel yuklenemedi: ${src}`));
    };
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

  private workWidth = 0;
  /** Masalarin gerektirdigi en dar calisma alani. */
  private naturalWorkWidth = 0;
  /** true: sahne kabin genisligini doldurur; artan genislik bolgeler arasina dagilir. */
  private fillWidth = false;
  private width = 0;
  private height = 0;
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

    this.measure(0);
    this.workWidth = this.naturalWorkWidth;
    this.width = this.workWidth + this.sleepW();

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

    this.agents = agents.map((agent, i) => {
      const existing = previous.find((r) => r.agent.id === agent.id);
      if (existing) {
        existing.agent = agent;
        existing.slot = i;
        if (agent.charIndex !== undefined) existing.charIndex = agent.charIndex % CHAR_COUNT;
        return existing;
      }
      return {
        agent,
        slot: i,
        charIndex: (agent.charIndex ?? i) % CHAR_COUNT,
        x: 0,
        y: 0,
        facing: 'down' as Facing,
        activity: 'idle' as AgentActivity,
        phase: Math.random(),
        lastPulse: 0,
        activitySince: now,
        walkDelayUntil: 0,
        // Bosta ajan bilgisayar basinda degil, dinlenme kosesinde baslar.
        dest: 'rest' as Place,
        path: [],
        trail: [],
        seated: false,
      };
    });

    this.measure(agents.length);
    this.workWidth = Math.max(this.fillWidth ? this.workWidth : 0, this.naturalWorkWidth);
    this.width = this.workWidth + this.sleepW();
    this.lastScale = 0;
    this.resize();
    // Kadro degisince masa yerleri kayar; herkes gittigi yere yerlestirilir.
    for (const r of this.agents) this.settle(r);
  }

  setActivity(id: string, activity: AgentActivity): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (!r) return;
    // Kota uykusu, gorev tamamlandi/stream geldi olaylarindan onceliklidir.
    if (r.sleepSlot !== undefined && activity !== 'offline') return;

    if (activity === 'offline') {
      r.activity = 'offline';
      r.path = [];
      return;
    }
    if (r.activity === 'offline') {
      // Yeniden gorunen ajan dinlenme kosesinde belirir.
      r.dest = 'rest';
      this.settle(r);
    }
    if (r.activity !== activity) {
      r.activity = activity;
      r.activitySince = performance.now();
    }
    const place = this.placeFor(activity);
    if (place && place !== r.dest) this.goTo(r, place);
  }

  /** Kullanilamaz durumdan donen ajani yeniden gorunur yapar. */
  setOnline(id: string): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (r?.activity === 'offline') this.setActivity(id, 'idle');
  }

  /** Kota dolan ajani sagdaki uyku odasina yollar ve reset sayacini yataginda gosterir. */
  setSleeping(id: string, retryAt?: number, retryHint?: string): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (!r) return;
    r.retryAt = retryAt;
    r.retryHint = retryHint;
    if (r.sleepSlot !== undefined) return;
    const used = new Set(this.agents.flatMap((a) => (a.sleepSlot === undefined ? [] : [a.sleepSlot])));
    let slot = 0;
    while (used.has(slot)) slot++;
    r.sleepSlot = slot;
    if (r.activity === 'offline') {
      r.dest = 'bed';
      this.settle(r);
      r.activity = 'sleeping';
      return;
    }
    r.activity = 'retiring';
    r.activitySince = performance.now();
    this.goTo(r, 'bed');
  }

  setAvailable(id: string): void {
    const r = this.agents.find((a) => a.agent.id === id);
    if (!r) return;
    r.retryAt = undefined;
    r.retryHint = undefined;
    r.activity = 'idle';
    r.activitySince = performance.now();
    // Yataktan kalkip dinlenme kosesine yurur; rota yataktan geri baslar.
    this.goTo(r, 'rest');
    r.sleepSlot = undefined;
  }

  /**
   * Yeni bir calisma basladi: ajanlar sirayla toplanti masasina yurur.
   * Kullanilamayan ajanlar disarida kalir.
   */
  enterOffice(): void {
    const now = performance.now();
    let order = 0;
    for (const r of this.agents) {
      if (r.activity === 'offline' || r.sleepSlot !== undefined) continue;
      r.activity = 'meeting';
      r.activitySince = now;
      r.walkDelayUntil = now + order++ * 350;
      this.goTo(r, 'meet', true);
    }
  }

  setTeamActivity(activity: AgentActivity): void {
    for (const r of this.agents) {
      if (r.activity === 'offline' || r.sleepSlot !== undefined) continue;
      this.setActivity(r.agent.id, activity);
    }
  }

  /** Sahnenin kabin genisligini tamamen doldurmasini ister (tam genislik serit). */
  setFillWidth(on: boolean): void {
    if (this.fillWidth === on) return;
    this.fillWidth = on;
    this.lastScale = 0;
    this.resize();
  }

  /**
   * Sahnenin ekranda kaplayabilecegi en fazla yuksekligi belirler.
   * Olcek hem genislige hem bu sinira gore secilir; boylece ofis
   * gorev ve akis panellerini asagi itmez.
   */
  setMaxHeight(px: number): void {
    const next = Math.max(100, Math.round(px));
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

  private measure(count: number): void {
    this.cols = Math.min(DESKS_PER_ROW, Math.max(2, count));
    this.rows = Math.max(1, Math.ceil(count / DESKS_PER_ROW));
    this.naturalWorkWidth = MARGIN_L + MEET_W + this.cols * STATION_W + LOUNGE_W + MARGIN_R;
    this.height = this.lane() + FLOOR_BELOW_LANE;
  }

  /** Ana koridor: son masa sirasinin sandalyelerinin altindan gecer. */
  private lane(): number {
    return this.rowY(this.rows - 1) + LANE_DY;
  }

  private rowY(row: number): number {
    return DESK_Y + row * ROW_H;
  }

  private meetX(): number {
    return MARGIN_L;
  }

  /** Masa blogu, toplanti ve dinlenme bolgeleri arasinda ortalanir. */
  private deskX(): number {
    const extra = this.workWidth - this.naturalWorkWidth;
    return MARGIN_L + MEET_W + Math.floor(extra / 2);
  }

  /**
   * Toplanti ve dinlenme bolgelerinin dikey kaydirmasi. Iki masa sirasinda
   * oda uzar; bu bolgeler ortalanir, ustte kalan alana dekor konur.
   */
  private zoneShift(): number {
    return this.rows > 1 ? Math.round((this.lane() - 100) / 2) : 0;
  }

  private zoneY(): number {
    return ZONE_Y + this.zoneShift();
  }

  private backLaneY(): number {
    return BACK_LANE_Y + this.zoneShift();
  }

  private tallSleep(): boolean {
    return this.rows > 1;
  }

  private sleepW(): number {
    return this.tallSleep() ? SLEEP_W_TALL : SLEEP_W_WIDE;
  }

  private loungeX(): number {
    return this.workWidth - MARGIN_R - LOUNGE_W;
  }

  /** Masanin sol ust kosesi. */
  private deskPos(slot: number): Pt {
    const col = slot % DESKS_PER_ROW;
    const row = Math.floor(slot / DESKS_PER_ROW);
    return { x: this.deskX() + col * STATION_W + (STATION_W - DESK_W) / 2, y: this.rowY(row) };
  }

  private tableRect(): { x: number; y: number; w: number; h: number } {
    return { x: this.meetX() + 20, y: this.zoneY() + 15, w: TABLE_W, h: TABLE_H };
  }

  private meetChairX(k: number): number {
    return this.tableRect().x + 5 + k * MEET_SPACING;
  }

  /** Toplanti masasinin alt sirasindaki sandalyelerin ust kenari. */
  private meetBottomChairY(): number {
    const t = this.tableRect();
    return t.y + t.h + 2;
  }

  private loungeSeatX(k: number): number {
    return this.loungeX() + 8 + k * LOUNGE_SPACING;
  }

  private loungeBottomY(): number {
    return this.zoneY() + 44;
  }

  private bedPos(slot: number): Pt {
    if (this.tallSleep()) {
      return { x: this.workWidth + 26, y: WALL_H + 26 + (slot % SLEEP_BEDS) * BED_GAP_TALL };
    }
    return { x: this.workWidth + 13 + (slot % SLEEP_BEDS) * BED_GAP, y: BED_Y };
  }

  private placeFor(activity: AgentActivity): Place | null {
    switch (activity) {
      case 'working':
      case 'reading':
      case 'thinking':
        return 'desk';
      case 'meeting':
        return 'meet';
      case 'idle':
        return 'rest';
      default:
        // Bitti/takildi: bulundugu yerde kalir.
        return null;
    }
  }

  private seatFor(r: Runtime, place: Place): Seat {
    const lane = this.lane();

    if (place === 'desk') {
      const desk = this.deskPos(r.slot);
      const row = Math.floor(r.slot / DESKS_PER_ROW);
      const x = desk.x + (DESK_W - CHAR_FRAME_W) / 2;
      const y = desk.y + DESK_SEAT_DY;
      const tagBelow = desk.y + DESK_CHAIR_DY + CHAR_FRAME_H + 2;
      if (row === this.rows - 1) {
        return { x, y, facing: 'up', route: [{ x, y: lane }, { x, y }], tagBelow };
      }
      // Ust siralar: masa blogunun solundaki gecitten kendi sirasinin koridoruna.
      const aisle = this.deskX() - 12;
      const rowLane = desk.y + 34;
      return {
        x, y, facing: 'up', tagBelow,
        route: [{ x: aisle, y: lane }, { x: aisle, y: rowLane }, { x, y: rowLane }, { x, y }],
      };
    }

    if (place === 'meet' || place === 'rest') {
      const seat = SEAT_ORDER[r.slot % SEAT_ORDER.length];
      const k = seat % 3;
      const top = seat < 3;
      const meet = place === 'meet';
      const x = meet ? this.meetChairX(k) : this.loungeSeatX(k);
      if (top) {
        // Ust sira: masaya bakar (asagi); duvar dibindeki arka yoldan girilir.
        const aisle = meet ? this.meetX() + 2 : this.loungeX() + 84;
        // Toplantida govde masanin ustunde gorunsun diye iki piksel daha dik oturur.
        const y = this.zoneY() - (meet ? 12 : 10);
        return {
          x, y, facing: 'down', lift: k === 1 ? 10 : 0,
          route: [{ x: aisle, y: lane }, { x: aisle, y: this.backLaneY() }, { x, y: this.backLaneY() }, { x, y }],
        };
      }
      // Alt sira: sirti bize donuk; koridordan dogrudan girilir.
      const chairY = meet ? this.meetBottomChairY() : this.loungeBottomY();
      const y = chairY - 10;
      return {
        x, y, facing: 'up',
        tagBelow: k === 1 ? undefined : chairY + 17,
        route: [{ x, y: lane }, { x, y }],
      };
    }

    // Uyku odasi: bolme kapisindan gecip yatagin yanina.
    const bed = this.bedPos(r.sleepSlot ?? 0);
    const x = bed.x + 15;
    const y = bed.y + 4;
    if (this.tallSleep()) {
      // Ust uste yataklar: soldaki gecitten yukari, sonra yatagin yanina.
      const aisle = this.workWidth + 6;
      return { x, y, facing: 'right', route: [{ x: aisle, y: lane }, { x: aisle, y }, { x, y }] };
    }
    return { x, y, facing: 'up', route: [{ x, y: lane }, { x, y }] };
  }

  /** Ajani yurutmeden gittigi yere yerlestirir (ilk acilis, yeniden yerlesim). */
  private settle(r: Runtime): void {
    const seat = this.seatFor(r, r.dest);
    r.x = seat.x;
    r.y = seat.y;
    r.facing = seat.facing;
    r.trail = seat.route.map((p) => ({ ...p }));
    r.path = [];
    r.seated = true;
    if (r.dest === 'bed' && r.sleepSlot !== undefined) r.activity = 'sleeping';
  }

  /** Once gelinen rota geri yurunur, sonra koridor, sonra yeni rota. */
  private goTo(r: Runtime, place: Place, force = false): void {
    if (!force && r.dest === place && (r.path.length || r.seated)) return;
    r.dest = place;
    const seat = this.seatFor(r, place);
    const steps: Step[] = [];
    for (let i = r.trail.length - 1; i >= 0; i--) {
      steps.push({ ...r.trail[i], kind: 'out', index: i });
    }
    const lane = this.lane();
    if (!r.trail.length && Math.abs(r.y - lane) > 0.5) steps.push({ x: r.x, y: lane, kind: 'lane' });
    steps.push({ ...seat.route[0], kind: 'lane' });
    for (const p of seat.route.slice(1)) steps.push({ ...p, kind: 'in' });
    r.path = steps;
    r.seated = false;
  }

  private resize(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const available = parent.clientWidth || this.width;
    const natural = this.naturalWorkWidth + this.sleepW();

    let scale: number;
    if (this.fillWidth) {
      // Olcek once dogal genislige, sonra yukseklik sinirina gore secilir;
      // kalan genislik bolgeler arasina dagitilir.
      scale = Math.max(0.4, Math.min(4, available / natural, this.maxHeight / this.height));
      const target = Math.max(this.naturalWorkWidth, Math.floor(available / scale) - this.sleepW());
      if (target !== this.workWidth) {
        this.workWidth = target;
        this.width = this.workWidth + this.sleepW();
        for (const r of this.agents) this.settle(r);
      }
    } else {
      scale = Math.max(0.4, Math.min(4, available / this.width, this.maxHeight / this.height));
    }

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(1, Math.round(this.width * scale));
    const cssHeight = Math.max(1, Math.round(this.height * scale));
    const pxWidth = Math.round(cssWidth * dpr);
    const pxHeight = Math.round(cssHeight * dpr);

    // Tuvali yeniden boyutlandirmak kabin genisligini degistirip gozlemciyi
    // tekrar tetikleyebiliyor; olcek degismediyse dokunma.
    if (
      Math.abs(scale - this.lastScale) < 0.001 &&
      this.canvas.width === pxWidth &&
      this.canvas.height === pxHeight &&
      this.buffer.width === this.width &&
      this.buffer.height === this.height
    ) return;
    this.lastScale = scale;

    this.buffer.width = this.width;
    this.buffer.height = this.height;
    this.bctx.imageSmoothingEnabled = false;

    this.canvas.width = pxWidth;
    this.canvas.height = pxHeight;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.imageSmoothingEnabled = false;
  }

  // ------------------------------------------------------------- guncelle

  private update(dt: number, now: number): void {
    for (const r of this.agents) {
      const walking = r.path.length > 0 && now >= r.walkDelayUntil;
      const speed = walking ? 0.007 : r.activity === 'working' ? 0.005 : 0.002;
      r.phase = (r.phase + dt * speed) % 1;
      if (r.activity === 'offline') continue;

      this.advance(r, dt, now);

      if (r.activity === 'done' && now - r.activitySince > 4500) this.setActivity(r.agent.id, 'idle');
    }
  }

  /** Rota adimlarini eksen hizali olarak yurur. */
  private advance(r: Runtime, dt: number, now: number): void {
    if (!r.path.length || now < r.walkDelayUntil) return;
    let budget = dt * WALK_SPEED;

    while (budget > 0 && r.path.length) {
      const step = r.path[0];
      // Geri yuruyuste terk edilen iz noktasi hemen silinir; yol ortasinda
      // yeni hedef gelirse ajan geldigi yone geri donmez.
      if (step.kind === 'out' && step.index !== undefined) r.trail.length = Math.min(r.trail.length, step.index + 1);

      const dx = step.x - r.x;
      const dy = step.y - r.y;
      if (Math.abs(dy) > 0.001) {
        const move = Math.min(Math.abs(dy), budget);
        r.y += Math.sign(dy) * move;
        r.facing = dy < 0 ? 'up' : 'down';
        budget -= move;
      } else if (Math.abs(dx) > 0.001) {
        const move = Math.min(Math.abs(dx), budget);
        r.x += Math.sign(dx) * move;
        r.facing = dx < 0 ? 'left' : 'right';
        budget -= move;
      }
      if (Math.abs(step.x - r.x) > 0.001 || Math.abs(step.y - r.y) > 0.001) break;

      r.x = step.x;
      r.y = step.y;
      r.path.shift();
      if (step.kind === 'out') {
        if (step.index === 0) r.trail = [];
      } else if (step.kind === 'lane') {
        r.trail = [{ x: step.x, y: step.y }];
      } else {
        r.trail.push({ x: step.x, y: step.y });
      }
    }

    if (!r.path.length) this.arrive(r, now);
  }

  private arrive(r: Runtime, now: number): void {
    const seat = this.seatFor(r, r.dest);
    r.seated = true;
    r.facing = seat.facing;
    if (r.dest === 'bed' && r.sleepSlot !== undefined) {
      r.activity = 'sleeping';
      r.activitySince = now;
    }
  }

  // --------------------------------------------------------------- cizim

  private frameFor(r: Runtime, now: number): { row: number; frame: number; flip: boolean } {
    const row = r.facing === 'up' ? ROW_UP : r.facing === 'down' ? ROW_DOWN : ROW_RIGHT;
    const flip = r.facing === 'left';
    const tick = Math.floor(r.phase * 8);

    if (r.path.length) {
      if (now < r.walkDelayUntil) return { row, flip, frame: 0 };
      return { row, flip, frame: WALK_FRAMES[tick % WALK_FRAMES.length] };
    }

    // Oturan karakter yalnizca oturma karelerini kullanir; ayakta durma
    // karesi koltugun ustunde dikiliyormus gibi gorunuyordu.
    switch (r.activity) {
      case 'working':
        // Cikti akmiyorsa yazmayi birakip ekrana bakar.
        return now - r.lastPulse < 2500
          ? { row, flip, frame: TYPING_FRAMES[tick % 2] }
          : { row, flip, frame: READING_FRAMES[0] };
      case 'reading':
      case 'thinking':
        return { row, flip, frame: READING_FRAMES[Math.floor(now / 700) % 2] };
      case 'meeting':
        return { row, flip, frame: READING_FRAMES[Math.floor(now / 850 + r.slot) % 2] };
      case 'idle': {
        // Koltukta kitap/telefon: uzun, sakin araliklarla sayfa cevirir.
        const flick = Math.floor(now / 3600 + r.slot * 0.7) % 3 === 0;
        return { row, flip, frame: flick ? READING_FRAMES[Math.floor(now / 500) % 2] : READING_FRAMES[0] };
      }
      default:
        return { row, flip, frame: READING_FRAMES[0] };
    }
  }

  private draw(now: number): void {
    const ctx = this.bctx;
    ctx.clearRect(0, 0, this.width, this.height);

    this.drawFloorAndWalls();
    this.drawWallDecor();
    this.drawRugs();
    this.drawSleepWing(now, false);

    const items: Drawable[] = [];
    this.collectFurniture(items, now);
    for (const r of this.agents) {
      if (r.activity === 'offline' || r.activity === 'sleeping') continue;
      // Oturan ve sirti bize donuk karakter, onundeki sandalyenin arkasinda kalir.
      const sittingUp = r.seated && r.facing === 'up';
      items.push({ z: r.y + (sittingUp ? 20 : 30), draw: () => this.drawAgent(r, now) });
    }
    items.sort((a, b) => a.z - b.z);
    for (const item of items) item.draw();

    this.drawSleepWing(now, true);
    // Etiketler en uste; hicbir mobilya ustunu ortmesin.
    for (const r of this.agents) {
      if (r.activity !== 'offline' && r.activity !== 'sleeping') this.drawNametag(r);
    }

    // Ara tuvali iki eksende ayni oranla ekrana bas; yumusatma kapali kalir.
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.drawImage(this.buffer, 0, 0, this.canvas.width, this.canvas.height);
  }

  private drawFloorAndWalls(): void {
    const ctx = this.bctx;
    const a = this.assets!;

    for (let y = WALL_H; y < this.height; y += TILE) {
      for (let x = 0; x < this.workWidth; x += TILE) ctx.drawImage(a.floor, x, y);
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

    const lane = this.lane();
    // Calisma alani ile uyku odasi arasinda, koridor hizasinda kapili bolme.
    ctx.fillStyle = '#242933';
    ctx.fillRect(this.workWidth - 3, 0, 6, this.height);
    ctx.fillStyle = '#a9764c';
    ctx.fillRect(this.workWidth - 3, lane - 2, 6, 34);
    ctx.fillStyle = '#171b22';
    ctx.fillRect(this.workWidth - 3, lane - 3, 6, 2);

    // giris kapisi, sol duvarda koridor hizasinda
    ctx.fillStyle = '#6b4f38';
    ctx.fillRect(0, lane - 2, 6, 32);
    ctx.fillStyle = '#8a6743';
    ctx.fillRect(0, lane - 2, 6, 2);
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(4, lane + 14, 1, 2);
  }

  /** Duvara asili tablolar, saat ve raflar — oda bos gorunmesin. */
  private drawWallDecor(): void {
    const ctx = this.bctx;
    const p = this.assets!.props;

    const order = [
      'WHITEBOARD', 'CLOCK', 'BOOKSHELF', 'LARGE_PAINTING', 'SMALL_PAINTING',
      'HANGING_PLANT', 'DOUBLE_BOOKSHELF', 'SMALL_PAINTING_2',
    ];

    let x = 22;
    let i = 0;
    while (x < this.workWidth - 44 && i < order.length * 3) {
      const img = p[order[i % order.length]];
      i++;
      if (!img) continue;
      const y = img.height >= WALL_H ? 0 : Math.floor((WALL_H - img.height) / 2);
      ctx.drawImage(img, x, y);
      x += img.width + 22;
    }
  }

  /** Dinlenme kosesinin halisi: zeminle birlikte, her seyin altinda. */
  private drawRugs(): void {
    const ctx = this.bctx;
    const x = this.loungeX() + 2;
    const y = this.zoneY() + 4;
    const w = 84;
    const h = 58;
    ctx.fillStyle = '#8f4b3a';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#a55a45';
    ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = '#8f4b3a';
    ctx.fillRect(x + 5, y + 5, w - 10, h - 10);
    ctx.fillStyle = '#b3664f';
    ctx.fillRect(x + 7, y + 7, w - 14, h - 14);
  }

  /** Masalar, sandalyeler, koltuklar ve bitkiler — taban cizgisiyle birlikte. */
  private collectFurniture(items: Drawable[], now: number): void {
    const ctx = this.bctx;
    const a = this.assets!;
    const p = a.props;
    const put = (name: string, x: number, y: number) => {
      const img = p[name];
      if (img) items.push({ z: y + img.height, draw: () => ctx.drawImage(img, Math.round(x), Math.round(y)) });
    };

    // Calisma masalari: masa + bilgisayar bir parca, sandalye onunde ayri parca.
    for (const r of this.agents) {
      const desk = this.deskPos(r.slot);
      items.push({
        z: desk.y + 32,
        draw: () => {
          ctx.drawImage(a.desk, desk.x, desk.y);
          const typing = r.activity === 'working' && r.seated && now - r.lastPulse < 2500;
          const pc = typing ? a.pcOn[Math.floor(r.phase * 6) % a.pcOn.length] : a.pcOff;
          ctx.drawImage(pc, desk.x + (DESK_W - 16) / 2, desk.y - 8);
        },
      });
      const chairX = desk.x + (DESK_W - 16) / 2;
      const chairY = desk.y + DESK_CHAIR_DY;
      items.push({ z: chairY + 32, draw: () => ctx.drawImage(a.chair, chairX, chairY) });
    }

    // Toplanti masasi: ust sirada masaya bakan, alt sirada sirti donuk koltuklar.
    const t = this.tableRect();
    for (let k = 0; k < 3; k++) {
      put('CUSHIONED_CHAIR_FRONT', this.meetChairX(k), this.zoneY());
      put('CUSHIONED_CHAIR_BACK', this.meetChairX(k), this.meetBottomChairY());
    }
    items.push({ z: t.y + t.h, draw: () => this.drawMeetingTable() });

    // Dinlenme kosesi: ustte iki berjer ve kanepe, ortada sehpa, altta kanepe ve berjerler.
    const bottom = this.loungeBottomY();
    put('CUSHIONED_CHAIR_FRONT', this.loungeSeatX(0), this.zoneY());
    put('SOFA_FRONT', this.loungeSeatX(1) - 8, this.zoneY());
    put('CUSHIONED_CHAIR_FRONT', this.loungeSeatX(2), this.zoneY());
    put('CUSHIONED_CHAIR_BACK', this.loungeSeatX(0), bottom);
    put('SOFA_BACK', this.loungeSeatX(1) - 8, bottom);
    put('CUSHIONED_CHAIR_BACK', this.loungeSeatX(2), bottom);
    const table = p['COFFEE_TABLE'];
    const coffee = p['COFFEE'];
    if (table) {
      const tx = this.loungeSeatX(1) - 8;
      const ty = this.zoneY() + 10;
      items.push({
        z: ty + table.height,
        draw: () => {
          ctx.drawImage(table, tx, ty);
          if (coffee) ctx.drawImage(coffee, tx + 6, ty + 8);
        },
      });
    }

    // Genis ekranda bolgeler arasi acilan bosluk bitkilerle dolar.
    const gap = Math.floor((this.workWidth - this.naturalWorkWidth) / 2);
    if (gap >= 40) {
      const leftGap = this.meetX() + MEET_W + gap / 2 - 8;
      const rightGap = this.deskX() + this.cols * STATION_W + gap / 2 - 8;
      put('PLANT', leftGap, DESK_Y - 4);
      put('LARGE_PLANT', rightGap - 8, DESK_Y - 6);
      if (gap >= 96) {
        put('CACTUS', leftGap, this.zoneY() + 30);
        put('PLANT_2', rightGap, this.zoneY() + 30);
      }
    }

    // Iki masa sirasinda toplanti ve dinlenme bolgeleri asagi kayar; duvar
    // dibinde kalan alan sunum tahtasi ve bitkilerle dolar. Gecitler bos kalir.
    if (this.zoneShift() >= 30) {
      const t = this.tableRect();
      put('PLANT', this.meetX() + 2, WALL_H + 2);
      put('WHITEBOARD', t.x + (t.w - 32) / 2, WALL_H + 2);
      put('PLANT_2', t.x + t.w - 14, WALL_H + 2);
      put('LARGE_PLANT', this.loungeX() + 2, WALL_H - 6);
      put('CACTUS', this.loungeX() + 40, WALL_H + 2);
      put('PLANT', this.loungeX() + 62, WALL_H + 2);
    }
  }

  /** Alti kisilik toplanti masasi: ust yuzey, on yuz ve bacaklar. */
  private drawMeetingTable(): void {
    const ctx = this.bctx;
    const { x, y, w, h } = this.tableRect();
    ctx.fillStyle = '#6e4d36';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#b58358';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 9);
    ctx.fillStyle = '#c99466';
    ctx.fillRect(x + 3, y + 3, w - 6, h - 13);
    // on yuz: derinlik hissi
    ctx.fillStyle = '#8a6545';
    ctx.fillRect(x + 1, y + h - 8, w - 2, 5);
    ctx.fillStyle = '#463429';
    ctx.fillRect(x + 3, y + h - 3, 3, 3);
    ctx.fillRect(x + w - 6, y + h - 3, 3, 3);
    // masadaki kagitlar ve dizustu
    ctx.fillStyle = '#efe5c9';
    ctx.fillRect(x + 12, y + 7, 9, 7);
    ctx.fillRect(x + 58, y + 9, 8, 6);
    ctx.fillStyle = '#3d4552';
    ctx.fillRect(x + 32, y + 6, 16, 10);
    ctx.fillStyle = '#7fb2d6';
    ctx.fillRect(x + 34, y + 7, 12, 6);
  }

  private countdown(retryAt?: number): string {
    if (!retryAt) return '--:--:--';
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /** Kota dolunca ajanlarin yattigi piksel uyku odasi. */
  private drawSleepWing(now: number, foreground: boolean): void {
    const sleeping = this.agents.filter((r) => r.sleepSlot !== undefined);
    const ctx = this.bctx;
    const roomX = this.workWidth + 3;

    if (!foreground) {
      // Isigi kapali oda: zemini de duvari da calisma alanindan belirgin koyu.
      ctx.fillStyle = '#11182b';
      ctx.fillRect(roomX, 0, this.sleepW() - 9, this.height);
      ctx.fillStyle = '#18223a';
      for (let y = WALL_H; y < this.height; y += TILE) ctx.fillRect(roomX, y, this.sleepW() - 9, 1);
      ctx.fillStyle = '#202d49';
      ctx.fillRect(roomX, 0, this.sleepW() - 9, WALL_H);
      drawText(ctx, L('TOKEN UYKU ODASI', 'TOKEN SLEEP ROOM'), this.workWidth + 10, 11, '#b8b4cc');
      drawText(ctx, L('ISIKLAR KAPALI', 'LIGHTS OFF'), this.workWidth + 10, 20, '#62708f');

      for (let slot = 0; slot < SLEEP_BEDS; slot++) {
        const bed = this.bedPos(slot);
        ctx.fillStyle = '#33405f';
        ctx.fillRect(bed.x, bed.y + 7, 46, 25);
        ctx.fillStyle = '#465779';
        ctx.fillRect(bed.x + 2, bed.y + 4, 44, 24);
        ctx.fillStyle = '#b8bfd0';
        ctx.fillRect(bed.x + 4, bed.y + 6, 11, 18);
        ctx.fillStyle = '#0d1322';
        ctx.fillRect(bed.x + 3, bed.y + 31, 3, 3);
        ctx.fillRect(bed.x + 40, bed.y + 31, 3, 3);
        if (!sleeping.some((agent) => agent.sleepSlot === slot && agent.activity === 'sleeping')) {
          drawText(ctx, L('BOS', 'EMPTY'), bed.x + 22, bed.y + 14, '#8e8aa6');
        }
      }
      return;
    }

    for (const r of sleeping) {
      const bed = this.bedPos(r.sleepSlot!);

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

        // Z'ler farkli fazlarda yukselir.
        for (let i = 0; i < 3; i++) {
          const phase = ((now / 1100) + i * 0.33) % 1;
          ctx.globalAlpha = 1 - phase * 0.65;
          drawText(ctx, 'Z', bed.x + 30 + i * 5, bed.y - 1 - Math.floor(phase * 6), '#e8df9a');
        }
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = 'rgba(18, 20, 28, 0.85)';
      const boxW = this.tallSleep() ? 52 : 56;
      ctx.fillRect(bed.x - 4, bed.y - 25, boxW, 19);
      drawText(ctx, fitText(r.agent.label.toUpperCase(), boxW - 6), bed.x - 1, bed.y - 22, r.agent.color);
      drawText(ctx, this.countdown(r.retryAt), bed.x - 1, bed.y - 14, '#f3efe6');
    }
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

    ctx.drawImage(
      sheet,
      col * CHAR_FRAME_W, row * CHAR_FRAME_H, CHAR_FRAME_W, CHAR_FRAME_H,
      Math.round(r.x), Math.round(r.y), CHAR_FRAME_W, CHAR_FRAME_H,
    );
  }

  /**
   * Karakterin basinin ustunde (ya da sirti donuk oturuyorsa koltugunun
   * altinda) yari saydam, piksel yazili isim etiketi.
   */
  private drawNametag(r: Runtime): void {
    const ctx = this.bctx;
    const label = fitText(r.agent.label, STATION_W - 20);
    const textW = measureText(label);

    const status = this.statusGlyph(r);
    const statusW = status ? 6 : 0;

    // yapi: 3 ic bosluk + 3 renk noktasi + 2 bosluk + metin + durum + 3
    const w = 3 + 3 + 2 + textW + statusW + 3;
    const h = 9;
    const x = Math.round(r.x) + Math.round((CHAR_FRAME_W - w) / 2);

    let y: number;
    const seat = r.seated && !r.path.length ? this.seatFor(r, r.dest) : null;
    if (seat?.tagBelow !== undefined) {
      y = seat.tagBelow;
    } else {
      // Sprite icinde kafanin ust kenari: ayakta 2, one bakan oturus 6, arkasi donuk oturus 3.
      const headTop = !seat ? 2 : seat.facing === 'down' ? 6 : 3;
      y = Math.round(r.y) + headTop - h - 3 - (seat?.lift ?? 0);
    }
    y = Math.max(1, Math.min(this.height - h - 1, y));

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
