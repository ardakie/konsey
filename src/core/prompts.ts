/** Ajanlara gonderilen istem sablonlari. Tek yerde tutuluyor ki ayarlamak kolay olsun. */
import type { AgentId, AgentProfile, CostTier, Task, ValidationOutcome } from '../shared/types';
import { replyLanguage } from '../shared/i18n';

export const DEFAULT_PROFILES: AgentProfile[] = [
  {
    agent: 'claude',
    label: 'Claude',
    strengths:
      'Genis capli refactor, mimari kararlar, karmasik is mantigi, cok dosyaya yayilan degisiklikler, ' +
      'test yazimi ve kod incelemesi.',
    enabled: true,
    costTier: 'premium',
  },
  {
    agent: 'codex',
    label: 'Codex',
    strengths:
      'Kesin ve dar kapsamli kod degisiklikleri, algoritma ve veri yapisi isleri, hata ayiklama, ' +
      'betik yazimi, mevcut testleri gecirme.',
    enabled: true,
    costTier: 'premium',
  },
  {
    agent: 'antigravity',
    label: 'Antigravity',
    strengths:
      'Arayuz ve on yuz calismasi, tarayicida dogrulama, gorsel kontrol, dokumantasyon, ' +
      'genis kod tabaninda kesif.',
    enabled: false,
    costTier: 'standard',
  },
];

const TIER_LABEL: Record<CostTier, string> = {
  cheap: 'UCUZ',
  standard: 'ORTA',
  premium: 'PAHALI',
};

export function tierOf(profile: AgentProfile): CostTier {
  return profile.costTier ?? (profile.agent.startsWith('provider:') ? 'cheap' : 'premium');
}

function profileBlock(profiles: AgentProfile[]): string {
  return profiles
    .filter((p) => p.enabled)
    .map((p) => `- ${p.agent} (${p.label}) [maliyet: ${TIER_LABEL[tierOf(p)]}]: ${p.strengths}`)
    .join('\n');
}

/** Her iki koordinasyon isteminde de ayni maliyet kurali gecerli. */
const COST_RULE = `MALIYET KURALI (en onemli kural):
- PAHALI ajanlar sinirli abonelik kotasi harciyor; onlari yalnizca gercekten gerektiginde kullan.
- Basit, mekanik, tek dosyalik isler (dosya olusturma, metin/README duzenlemesi, yeniden
  adlandirma, sabit degisikligi, kucuk yapilandirma dokunuslari) UCUZ ajana verilir.
  Bunun icin PAHALI ajan kullanmak acik bir hatadir.
- ORTA maliyetli ajan, ucuz ajanin zorlanacagi ama pahali ajani hak etmeyen orta isler icindir.
- PAHALI ajanlari sakla: cok dosyaya yayilan refactor, mimari kararlar, karmasik hata ayiklama,
  guvenlik ve veri butunlugu isleri, zor algoritmalar.
- Kisacasi: isi yapabilecek EN UCUZ ajani sec. Yetenek esitse maliyet belirleyicidir.`;

/** Adim 1 — gorevi bagimsiz parcalara bolen planlayici istemi. */
export function plannerPrompt(
  userRequest: string,
  profiles: AgentProfile[],
  projectContext: string,
): string {
  return `Sen bir yazilim ekibinin teknik liderisin. Elinde ayni proje uzerinde calisabilecek ${
    profiles.filter((p) => p.enabled).length
  } farkli yapay zeka ajani var:

${profileBlock(profiles)}

PROJE BAGLAMI:
${projectContext}

KULLANICININ ISTEGI:
${userRequest}

Bu istegi, ajanlarin AYNI ANDA ve BIRBIRINDEN BAGIMSIZ calisabilecegi gorevlere bol.

Kurallar:
- En fazla 6 gorev uret. Az sayida anlamli gorev, cok sayida kucuk gorevden iyidir.
- Gorevler mumkun oldugunca FARKLI dosyalara dokunmali. Ayni dosyaya dokunan iki gorev
  varsa bunlari tek gorevde birlestir ya da aralarina dependsOn bagi koy.
- "scope" alanina gorevin dokunacagi dosya/klasor yollarini yaz. Bu, catisma tahmini icin kullanilir.
- Istek tek bir ajanla yapilacak kadar kucukse tek gorev uret; yapay olarak bolme.
- suggestedAgent alanini ajanlarin guclu yanlarina VE maliyetine gore doldur.
- complexity alanini low, medium, high veya critical olarak doldur. low = tek dosyalik,
  mekanik, dusunmeden yapilabilecek is. critical yalnizca guvenlik, veri kaybi riski veya
  gercekten zor mimari kararlar icindir. Bu alan hangi ajanin secilecegini dogrudan belirler,
  bu yuzden abartma: basit ise "low" yaz.
- Yeni bir raster gorsel/illustrasyon uretilmesi gerekiyorsa requiresVisual=true yap ve Codex'i
  oner; Codex bu durumda ChatGPT'nin gorsel uretim aracini kullanir. Mevcut SVG/CSS/canvas
  varliklarini kodla duzenlemek gorsel uretim sayilmaz.
- "summary" ve gorevlerin "title"/"detail" alanlari kullaniciya gosterilir: ${replyLanguage()}

${COST_RULE}

Cevabini SADECE su bicimde, tek bir JSON kod blogu olarak ver. Baska hicbir sey yazma:

\`\`\`json
{
  "summary": "Plani bir cumleyle ozetle",
  "tasks": [
    {
      "id": "t1",
      "title": "Kisa baslik",
      "detail": "Ajanin tek basina uygulayabilecegi acik ve eksiksiz talimat",
      "scope": ["src/foo.ts", "src/bar/"],
      "dependsOn": [],
      "complexity": "medium",
      "requiresVisual": false,
      "suggestedAgent": "claude"
    }
  ]
}
\`\`\``;
}

/** Adim 2 — her ajana "hangisini sen ustlenirsin" diye soran claim istemi. */
export function claimPrompt(agent: AgentId, tasks: Task[], projectContext: string): string {
  const list = tasks
    .map(
      (t) =>
        `- ${t.id}: ${t.title} [zorluk: ${t.complexity}]\n  Detay: ${t.detail}\n  Kapsam: ${t.scope.join(', ') || '(belirtilmemis)'}`,
    )
    .join('\n');

  return `Bir yazilim ekibinde ${agent} olarak calisiyorsun. Ekipte senden baska iki ajan daha var
ve asagidaki gorev listesini onlar da ayni anda goruyor. Gorevler paylastirilacak.

PROJE BAGLAMI:
${projectContext}

GOREV LISTESI:
${list}

Projeye bak ve hangi gorevleri USTLENMEK istedigini bildir. Durust ol: senin icin uygun
olmayan gorevleri baskasina birak. Her gorev icin 0-100 arasi bir guven puani ver
(100 = "bunu kesinlikle ben yapmaliyim", 0 = "bana gore degil").

"rationale" ve "reason" alanlari kullaniciya gosterilir: ${replyLanguage()}

Cevabini SADECE su bicimde, tek bir JSON kod blogu olarak ver. Baska hicbir sey yazma:

\`\`\`json
{
  "claims": [
    { "taskId": "t1", "confidence": 85, "rationale": "Neden bu gorevi ustlenmelisin, tek cumle" }
  ],
  "declines": [
    { "taskId": "t2", "reason": "Neden bu gorevi baskasina biraktigin, tek cumle" }
  ]
}
\`\`\``;
}

/** Adim 3 — cakisan taleplerin hakemi. */
export function arbitrationPrompt(
  tasks: Task[],
  claimsText: string,
  profiles: AgentProfile[],
): string {
  const list = tasks
    .map((t) => `- ${t.id}: ${t.title} [zorluk: ${t.complexity}] (kapsam: ${t.scope.join(', ') || 'yok'})`)
    .join('\n');

  return `Sen bir yazilim ekibinin teknik liderisin. Uc ajan asagidaki gorevleri paylasmak icin
talepte bulundu. Her gorevi TAM OLARAK BIR ajana ata.

AJANLARIN GUCLU YANLARI:
${profileBlock(profiles)}

GOREVLER:
${list}

AJANLARIN TALEPLERI:
${claimsText}

Kurallar:
- Her gorev tam olarak bir ajana atanmali; hicbir gorev atanmadan kalmamali.
- Isi ajanlar arasinda dengeli dagit. Bir ajana her seyi yukleme.
- Guven puani yuksek olani tercih et, ama denge, uzmanlik ve MALIYET daha onemli.
- Bir gorevi hicbir ajan istemiyorsa yine de en uygun olana ata.

${COST_RULE}

Cevabini SADECE su bicimde, tek bir JSON kod blogu olarak ver. Baska hicbir sey yazma:

\`\`\`json
{
  "assignments": [
    { "taskId": "t1", "agent": "claude", "reason": "Tek cumle gerekce" }
  ]
}
\`\`\``;
}

/** Adim 4 — atanan gorevi uygulama istemi. */
export function executionPrompt(agent: AgentId, tasks: Task[], allTasks: Task[]): string {
  const mine = tasks
    .map((t) => `### ${t.id}: ${t.title}\n${t.detail}\n\nZorluk: ${t.complexity}\n` +
      `Beklenen kapsam: ${t.scope.join(', ') || 'serbest'}\n` +
      (t.requiresVisual
        ? 'Bu gorev yeni bir gorsel varlik gerektiriyor: varsa ChatGPT/ImageGen gorsel aracini kullan; yoksa bunu acikca raporla.\n'
        : ''))
    .join('\n\n');

  const others = allTasks
    .filter((t) => !tasks.some((m) => m.id === t.id))
    .map((t) => `- ${t.id}: ${t.title} -> ${t.assignedTo ?? 'atanmadi'} (kapsam: ${t.scope.join(', ') || 'yok'})`)
    .join('\n');

  return `Sen ${agent} ajanisin ve bir ekip calismasinin parcasisin. Kendi izole calisma
kopyanda (git worktree) bulunuyorsun; degisikliklerin sonunda digerlerininkiyle birlestirilecek.

SANA ATANAN GOREVLER:
${mine}

BASKA AJANLARIN USTLENDIGI GOREVLER (bunlara DOKUNMA):
${others || '(yok)'}

Kurallar:
- Yalnizca sana atanan gorevleri yap. Baska ajanlarin kapsamindaki dosyalari degistirme.
- Degisikliklerini dogrudan calisma dizinine yaz. Commit ATMA; birlestirmeyi sistem yapacak.
- Kapsamin disina cikman gerekiyorsa, yapma; bunun yerine cevabinda belirt.
- Isin bitince ne yaptigini kisaca ozetle: hangi dosyalari degistirdin ve neden.
- Ozetin kullaniciya gosterilir: ${replyLanguage()}

Isin bitiminde cevabinin sonuna su bloklari ekle:

DEGISEN DOSYALAR:
- yol/dosya.ts — tek cumleyle ne degisti

OZET:
Iki uc cumlelik ozet.`;
}

/** Adim 5 — birlestirilmis sonucu kontrol eden inceleme istemi. */
export function reviewPrompt(
  tasks: Task[],
  diffStat: string,
  agentSummaries: string,
  conflictNote: string,
  validation?: ValidationOutcome,
): string {
  const list = tasks
    .map((t) => `- ${t.id} (${t.assignedTo}): ${t.title} — ${t.status}`)
    .join('\n');

  return `Sen bagimsiz bir kod inceleyicisin. Bir ya da birden fazla ajan bir projede calisti ve
calismalari tek bir dala birlestirildi. Bu birlesik sonucu incele.

PLANLANAN GOREVLER:
${list}

AJANLARIN KENDI OZETLERI:
${agentSummaries}

BIRLESIK DEGISIKLIKLER (ozet ve varsa tam kod farki):
${diffStat || '(diff bos)'}
${conflictNote}

OTOMATIK KALITE KAPISI:
${validation?.summary ?? 'Calistirilmadi.'}
${validation?.commands.map((command) =>
    `\n--- ${command.command} (${command.ok ? 'gecti' : 'kaldi'}) ---\n${command.output.slice(-5000)}`,
  ).join('') ?? ''}

Su sorulara cevap ver:
1. Planlanan gorevler gercekten yapilmis mi?
2. Ajanlarin degisiklikleri birbiriyle celisiyor mu? (ayni islevin iki kez yazilmasi,
   uyumsuz arayuzler, birbirini bozan degisiklikler)
3. Acikca bozuk, eksik ya da tehlikeli bir sey var mi?

Kodu OKU ve gercekten kontrol et; ajanlarin ozetlerine korukorune guvenme. Dosya okuyamiyorsan
yukaridaki KOD FARKI senin kanitindir; kucuk uslup tercihleri icin degil, yalnizca gercek hata,
eksik is veya tehlike icin "changes-requested" ver.
Hicbir dosyayi DEGISTIRME; sadece rapor et. summary ve findings alanlari kullaniciya gosterilir: ${replyLanguage()}

Cevabini SADECE su bicimde, tek bir JSON kod blogu olarak ver. Baska hicbir sey yazma:

\`\`\`json
{
  "verdict": "approved",
  "summary": "Genel degerlendirme, iki uc cumle",
  "findings": ["Bulgu 1", "Bulgu 2"]
}
\`\`\`

verdict yalnizca "approved" ya da "changes-requested" olabilir.`;
}

/** Kalite kapisi veya inceleyici hata buldugunda tek kontrollu duzeltme turu. */
export function repairPrompt(
  tasks: Task[],
  findings: string[],
  validation?: ValidationOutcome,
): string {
  return `Sen entegrasyon dalindaki kalite sorumlususun. Ajanlarin birlestirilmis calismasini
duzeltmen gerekiyor. Yeni ozellik ekleme; yalnizca planlanan isi tamamla ve asagidaki
somut hatalari gider.

PLANLANAN GOREVLER:
${tasks.map((task) => `- ${task.id}: ${task.title} — ${task.status}`).join('\n')}

INCELEME BULGULARI:
${findings.length ? findings.map((finding) => `- ${finding}`).join('\n') : '- Inceleyici bulgusu yok; kalite komutu basarisiz.'}

KALITE KOMUTLARI:
${validation?.commands.map((command) =>
    `\n--- ${command.command} (${command.ok ? 'gecti' : 'kaldi'}) ---\n${command.output.slice(-6000)}`,
  ).join('') || 'Otomatik komut yok.'}

Kurallar:
- Once ilgili dosyalari ve hatayi gercekten incele.
- En kucuk guvenli duzeltmeyi yap.
- Testleri calistir; var olan davranisi gereksiz yere degistirme.
- Commit atma; sistemi bunu kendisi yapacak.
- Sonunda degisen dosyalari ve dogrulamayi kisaca ozetle.`;
}
