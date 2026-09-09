# Konsey

Claude Code, Codex ve Antigravity'yi tek bir chat kutusundan, **aynı proje üzerinde**
koordine eden bir Mac uygulaması. API anahtarı gerekmez — üçü de kendi aboneliğinle
çalışır. İstersen kendi OpenAI-uyumlu uçlarını dördüncü, beşinci ajan olarak eklersin.

## Nasıl çalışıyor

Tek bir istek yazarsın. Konsey altı aşamadan geçer:

| Aşama | Ne olur |
|---|---|
| **Plan** | Bir ajan isteği bağımsız görevlere böler (en fazla 6), her görevin dokunacağı dosyaları işaretler. |
| **Paylaşım** | Her ajan görev listesini görür ve *hangisini üstlendiğini* 0–100 güven puanıyla bildirir. |
| **Hakem** | Çakışan talepleri bir hakem çözer; her görev tam olarak bir sahibe bağlanır, yük dengelenir. |
| **Çalışma** | Ajanlar **kendi git worktree'lerinde paralel** çalışır. Birbirlerinin dosyasını göremezler. |
| **Birleştirme** | Her ajanın dalı tek bir entegrasyon dalında birleştirilir. Çakışma çıkarsa geri alınır ve raporlanır. |
| **İnceleme** | En az iş yapan ajan birleşik sonucu denetler — kendi işini onaylamaz. |

İzolasyonun sebebi basit: üç ajan aynı dosyaya aynı anda yazarsa birbirini ezer.
Ayrı worktree + sonda merge, çakışmayı görünür ve çözülebilir kılar.

### Model yönlendirme politikası

Konsey yalnızca ajanı değil, turun önemine göre modeli ve muhakeme eforunu da seçer:

- Claude planlama ve mimari işlerde `opus` kullanır; normalde `medium`, yalnızca
  güvenlik/veri kaybı riski taşıyan kritik işlerde `high` efor. Gerekirse `sonnet`e düşer.
- Codex günlük kod işlerinde `gpt-5.6-sol` kullanır. Çok pahalı `gpt-6-astra`
  yalnızca `critical` olarak sınıflanan zor görevlerde açılır.
- Antigravity görevin ağırlığına göre `pro` veya `flash` ile başlar; model kotası
  biterse aynı uygulama içinde `pro → flash → flash_lite` sırasını izler.
- Yeni raster görsel/illüstrasyon isteyen görevler planda ayrıca işaretlenir ve
  ChatGPT/ImageGen yeteneği olan Codex rotasına verilir. SVG, CSS ve canvas gibi
  kod tabanlı görseller bu pahalı rotayı gerektirmez.

Claim turları ucuz model/eforla yapılır. Plan, hakemlik ve inceleme cevaplarından
biri bozuk veya kullanılamazsa sıradaki koordinatör otomatik devralır.

## Piksel ofis

Uygulamanın merkezinde, ajanların ne yaptığını canlı gösteren tepeden bakışlı
bir ofis var. Her ajanın bir masası olur; iş aldıkça kapıdan girip masasına
yürür, kod yazarken klavyeye vurur ve monitörü canlanır, salt okunur turlarda
okur. Kotası dolan ajan masasından kalkıp sağda açılan **Token Uyku Odası**na
yürür ve yatağına uzanır. Üstünde yükselen `Z Z Z`, yenilenme saati ve saniyelik
geri sayım görünür. Adı başının üstünde yarı saydam bir piksel
etikette görünür; etiketin sağındaki küçük simge durumu söyler (`!` engellendi,
`✓` bitti, `···` düşünüyor).

Masa sayısı ajan sayısıyla büyür — beşten fazlası alt sıraya taşar. Aşağıda
kanepeler, sehpa ve bitkilerden oluşan bir dinlenme alanı, duvarda tablolar,
saat, kitaplık ve beyaz tahta vardır.

### Görsel varlıklar ve lisans

Karakterler, mobilya ve zemin karoları
[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) projesinden
alınmıştır (MIT). Karakter sprite'ları JIK-A-4'ün
[Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)
ücretsiz paketine dayanır. MIT lisans metni
`ui/pixel/assets/LICENSE-pixel-agents.txt` içinde korunmaktadır.

Sprite sayfası düzeni de aynıdır: `char_N.png` 112×96, 16×32'lik kareler,
3 satır (aşağı, yukarı, sağ); yürüme `[0,1,2,1]`, yazma `[3,4]`, okuma `[5,6]`,
sola bakış sağın yansımasıdır.

Sahne önce mantıksal çözünürlükte bir ara tuvale çizilir, sonra tam sayı
katıyla büyütülür — böylece pikseller ve `ui/pixel/pixelFont.ts` içindeki
3×5 bitmap yazı tipi net kalır.

## Gereksinimler

- macOS (Apple Silicon)
- Proje bir **git deposu** olmalı ve en az bir commit içermeli (`git init` + ilk commit yeterli)
- Kullanmak istediğin ajanlar kurulu olmalı:
  - **Claude Code** — `claude` CLI
  - **Codex** — ChatGPT.app ile birlikte gelir (`ChatGPT.app/Contents/Resources/codex`)
  - **Antigravity** — uygulama **açık olmalı**; ajan arayüzü onun içindeki language server'da yaşar

## Kurulum

```bash
npm install
npm run package
```

`release/mac-arm64/Konsey.app` çıkar — Applications klasörüne sürükle.
`release/Konsey-0.1.0-arm64.dmg` de üretilir.

Geliştirirken paketlemeden çalıştırmak için:

```bash
npm start
```

Arayüzü Electron açmadan denemek için (sahte ajan verisiyle):

```bash
npm run ui
```

Tip kontrolü, kota-zamanı birim testleri ve tam derlemeyi birlikte çalıştırmak için:

```bash
npm run verify
```

## Terminal kullanımı

Arayüz olmadan da çalışır:

```bash
npm run doctor
```

Üç ajanın da bulunup bulunmadığını, Antigravity'nin hangi porta bağlı olduğunu gösterir.

```bash
npm run cli -- run /yol/projeye "kullanıcı girişi ekle ve testlerini yaz"
```

## Kendi API anahtarların

Uygulamada **Sağlayıcı ekle** ile OpenAI-uyumlu herhangi bir uç eklenebilir
(NVIDIA, kendi proxy'in, yerel bir sunucu…).

Anahtarlar **macOS Keychain'de** saklanır (`konsey-provider` servisi altında),
ayar dosyasına asla yazılmaz.

İki türlü kullanılabilirler:

- **Yalnızca koordinasyon** (`Kod da yazabilsin` kapalı) — planlama, hakemlik ve
  inceleme turlarını üstlenir. Bir çalışmadaki ~8 çağrının yarısı bunlar; üç
  aboneliğinin kotasını yalnızca gerçek kod yazmaya harcamış olursun.
- **Tam ajan** (açık) — kendi araç döngüsüyle dosya okur, yazar, komut çalıştırır.
  Bu döngü `src/core/providers/agent.ts` içinde; tüm dosya yolları çalışma dizinine
  hapsedilir.

## Kota ve oturum düşmeleri

Üç ayrı abonelikle çalışırken birinin kotasının dolması olağan. Konsey bunu
genel bir hatadan ayırır: o ajanı devre dışı bırakır, üstlendiği görevleri
sağlam ajanlara yeniden dağıtır ve çalışmayı sürdürür. Devralan da kotaya girerse
görev üçüncü adaya geçer; sağlıklı aday kalana kadar zincir devam eder. Başarısız
turda yarım kalmış dosyalar commit edilmez ve entegrasyon dalına karışmaz.

Kota uykusu uygulama açık kaldığı sürece yeni çalışmalar arasında korunur.
Sağlayıcı kesin bir reset zamanı verdiyse sayaç sıfırlandığında rota yeniden
uygun hale gelir; saat bilinmiyorsa arayüz bunu uydurmak yerine `BILINMIYOR`
olarak gösterir.

## Ayarlar ve dosyalar

| Yol | İçerik |
|---|---|
| `~/.konsey/config.json` | Sağlayıcı tanımları, ajan profilleri, son projeler. **Anahtar içermez.** |
| `~/.konsey/ag-projects.json` | Klasör → Antigravity proje kimliği eşlemesi (önbellek). |
| Keychain (`konsey-provider`) | API anahtarları. |
| `.konsey-worktrees-<proje>/` | Ajanların izole çalışma kopyaları, projenin kardeşi olarak. |

Dallar `konsey/<çalışma-id>/<ajan>` ve `konsey/<çalışma-id>/integration` olarak
kalır — inceleyip merge edebilir ya da silebilirsin.

## Bilinen sınırlar

- **Antigravity'nin `agentapi`'si resmi bir arayüz değil.** Çalışıyor, ama bir
  güncellemeyle değişebilir. Kırılırsa yalnızca `src/core/adapters/antigravity.ts`
  güncellenmeli. Claude ve Codex tarafı resmi non-interactive modları kullanır
  (`claude -p`, `codex exec`) ve sağlamdır.
- **Antigravity uygulaması açık olmak zorunda** — language server onun alt süreci.
  Port ve CSRF token her yeniden başlatmada değişir; Konsey bunları her çalışmada
  `ps` çıktısından yeniden keşfeder.
- Antigravity, kendisinde açık olan klasöre bağlı çalışır. Bir worktree'ye tam
  izole etmek diğer ikisi kadar doğrudan değil.
- Uygulama imzasız paketlenir. Kendi makinende derlediğin için Gatekeeper
  karışmaz; başka bir makineye kopyalarsan sağ tık → Aç gerekir.

## Kaynak düzeni

```
src/core/
  discovery.ts        üç ajanı runtime'da bulur (AG portu/token'ı dahil)
  orchestrator.ts     altı aşamalı boru hattı
  prompts.ts          tüm istem şablonları — davranışı buradan ayarla
  git.ts              worktree, commit, merge
  adapters/           her ajan için ince sarmalayıcı + hata sınıflandırma
  providers/          OpenAI-uyumlu istemci ve araç döngüsü
electron/             ana süreç ve preload köprüsü
ui/
  index.html          uygulama kabuğu
  styles.css          Claude'un koyu temasına yakın palet
  renderer.ts         olayları ekrana yansıtır
  devMock.ts          Electron olmadan denemek için sahte köprü
  pixel/
    office.ts         piksel ofis sahnesi ve ajan durum makinesi
    pixelFont.ts      3x5 bitmap yazı tipi (isim etiketleri)
    assets/           pixel-agents görselleri + MIT lisansı
```

Ajanların hangi işte kullanılacağını değiştirmek için `src/core/prompts.ts`
içindeki `DEFAULT_PROFILES` yeterli — planlayıcı ve hakem bu tanımları okur.
