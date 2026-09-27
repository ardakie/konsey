/* Konsey indirme sitesi: dil, isletim sistemi algilama, surum, etkilesimler. */
(() => {
  const REPO = 'ardakie/konsey';
  const DL = `https://github.com/${REPO}/releases/latest/download`;

  // Ingilizce metinler HTML'dedir; Turkce karsiliklar burada.
  const TR = {
    'nav.how': 'Nasıl çalışır',
    'nav.features': 'Özellikler',
    'nav.agents': 'Ajanlar',
    'nav.install': 'Kurulum',
    'nav.faq': 'SSS',
    'nav.download': 'İndir',
    'hero.pill': 'Ücretsiz ve açık kaynak · macOS ve Windows',
    'hero.title': 'Yapay zekâ ajanların,<br />aynı masada.',
    'hero.lead': 'Tek bir istek yaz. Konsey işi planlar, parçalara böler ve her parçayı yapabilecek en ucuz ajana verir. Her ajan kendi kopyasında çalışır; sonuç birleştirilir, test edilir, incelenir ve ancak o zaman klasörüne uygulanır.',
    'hero.other': 'Diğer indirmeler',
    'float.a': 'Plan hazır · 3 görev',
    'float.b': 'Testler geçti ✓',
    'float.c': 'index.html yazılıyor…',
    'how.eyebrow': 'Nasıl çalışır',
    'how.title': 'Tek cümleden test edilmiş bir değişikliğe.',
    'how.1.t': 'Bir klasör seç',
    'how.1.d': 'Boş ya da mevcut bir proje. Henüz git deposu değilse Konsey hazırlar.',
    'how.2.t': 'Ajanlarını bağla',
    'how.2.d': 'Konsey bilgisayarındaki CLI’ları bulur. Eksik olan tek tıkla kurulur, giriş ekranı senin için açılır.',
    'how.3.t': 'İşi yaz',
    'how.3.d': 'Ajanlar en iyi yaptıkları görevleri üstlenir. Her biri kendi git kopyasında çalışır; kimse kimsenin işini ezmez.',
    'how.4.t': 'Test edilir, uygulanır',
    'how.4.d': 'Parçalar birleşir, testlerin çalışır, başka bir ajan inceler. Ancak ondan sonra klasörüne iner.',
    'feat.eyebrow': 'Özellikler',
    'feat.title': 'Koca bir ekip, kaos olmadan.',
    'feat.parallel.t': 'Paralel, izole ajanlar',
    'feat.parallel.d': 'Her ajan projenin kendi kopyasını alır. Konsey sonuçları birleştirir ve klasörüne bir şey inmeden kontrollerini çalıştırır.',
    'feat.cost.t': 'Maliyete göre dağıtım',
    'feat.cost.d': 'Basit işler ucuz modellere gider; pahalı abonelikler zor kısımlara saklanır.',
    'feat.cost.cheap': 'Ucuz',
    'feat.cost.mid': 'Orta',
    'feat.cost.premium': 'Pahalı',
    'feat.caps.t': 'Kullanım payları',
    'feat.caps.d': '“Claude limitimin en fazla %40’ını kullan.” Gerisi sende kalır.',
    'feat.office.t': 'Canlı piksel ofis',
    'feat.office.d': 'Kim masada plan yapıyor, kim masasında kod yazıyor, kimin kotası uyuyor — hepsini izle.',
    'feat.chat.t': 'Konsey masası',
    'feat.chat.d': 'Bir ajana sor ya da hepsine birden. Birbirlerinin fikrine katılır, itiraz eder.',
    'feat.chat.b1': 'Durumu tek bir dizide tutalım.',
    'feat.chat.b2': 'Katılıyorum — render()’ı ben yazarım.',
    'feat.int.t': 'Entegrasyonlar',
    'feat.int.d': 'GitHub, Supabase, Sentry, Stripe, PostHog ya da Notion’u bir kez bağla; ajanlar çalışırken kullanır.',
    'feat.private.t': 'Yerel ve gizli',
    'feat.private.d': 'Konsey’in sunucusu yok. Kodun yalnızca bağladığın yapay zekâ hizmetlerine gider; anahtarlar sistemin anahtar zincirinde durur.',
    'agents.eyebrow': 'Ajanlar',
    'agents.title': 'Zaten ödediğin ajanları getir.',
    'agents.lead': 'Konsey resmi CLI’ları senin aboneliklerinle çalıştırır. Kurulu olanlar kendiliğinden bulunur, diğerleri tek tıkla kurulur.',
    'agents.mac': 'macOS',
    'agents.api': 'OpenAI uyumlu her API',
    'agents.custom': 'Kendi CLI’ın',
    'install.eyebrow': 'Kurulum',
    'install.title': 'İlk göreve iki dakika.',
    'install.arm': 'M1, M2, M3, M4 · .dmg',
    'install.intel': 'Eski Mac’ler · .dmg',
    'install.mac.1': 'DMG’yi aç, Konsey’i Uygulamalar klasörüne sürükle.',
    'install.mac.2': 'Uygulama henüz Apple tarafından onaylanmadığı için ilk açılışta uyarı çıkar. Sistem Ayarları → Gizlilik ve Güvenlik’i açıp “Yine de Aç”a bas.',
    'install.mac.3': 'Konsey kısa bir rehberle açılır: git’i denetler, ajanlarını bulur ve gereken izinleri ister — her biri tek düğme.',
    'install.oneliner': 'Ya da Terminal’den kur (uyarı çıkmaz):',
    'install.copy': 'Kopyala',
    'install.win': '64 bit kurulum · .exe',
    'install.win.1': 'Kurulumu çalıştır. Yalnızca senin kullanıcına kurulur — yönetici izni gerekmez — ve Konsey’i açar.',
    'install.win.2': 'SmartScreen “Windows bilgisayarınızı korudu” derse “Ek bilgi” → “Yine de çalıştır”a bas. Kurulum dosyası henüz imzalı değil.',
    'install.win.3': 'Konsey’in rehberi git’i ve ajanlarını senin için tek tıkla kurar (winget ile).',
    'install.req': 'Git gerekir. Birçok ajan CLI’ı Node.js 20+ ister — Konsey ikisini de kurmayı önerir.',
    'faq.eyebrow': 'SSS',
    'faq.title': 'Sorular',
    'faq.1.q': 'Ücretsiz mi?',
    'faq.1.a': 'Evet. Konsey ücretsiz ve açık kaynaklı (MIT). Kendi aboneliklerini ve API anahtarlarını kullanırsın; Konsey token satmaz.',
    'faq.2.q': 'Kodum Konsey’e gider mi?',
    'faq.2.a': 'Hayır. Konsey’in sunucusu da takibi de yok. Kodun yalnızca bağladığın yapay zekâ hizmetlerine gider.',
    'faq.3.q': 'Ajanlar projemi bozabilir mi?',
    'faq.3.a': 'İzole kopyalarda çalışırlar. Değişiklikler ancak kontrollerden ve incelemeden geçince klasörüne iner; otomatik uygulamayı kapatabilirsin de.',
    'faq.4.q': 'Hangi izinleri ister?',
    'faq.4.a': 'macOS’ta: seçtiğin proje klasörüne erişim ve ajanları kurup giriş yapmak için Terminal’i açma izni. Konsey her birini hazırlık listesinde tek düğmeyle gösterir.',
    'faq.5.q': 'Hangi sistemlerde çalışır?',
    'faq.5.a': 'macOS 11+ (Apple Silicon ve Intel) ve Windows 10/11 (64 bit). Antigravity yalnızca macOS’ta.',
    'faq.6.q': 'Türkçe mi?',
    'faq.6.a': 'Evet. Konsey sistem dilini izler: Türkçe sistemde Türkçe, diğerlerinde İngilizce. Ayarlardan değiştirebilirsin.',
    'cta.title': 'Ajanlarına bir masa ver.',
    'cta.lead': 'Ücretsiz, açık kaynak ve kendi bilgisayarında çalışır.',
    'cta.button': 'Konsey’i indir',
    'footer.releases': 'Sürümler',
    'footer.issues': 'Sorun bildir',
  };

  const HTML_KEYS = new Set(['hero.title']);
  const EN = {};
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    EN[el.dataset.i18n] = HTML_KEYS.has(el.dataset.i18n) ? el.innerHTML : el.textContent;
  });

  const APPLE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.8-2-1.6-.2-3.1.9-3.9.9-.8 0-2.1-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.6-1-2.6-4.1ZM13.9 4.9c.7-.9 1.2-2 1.1-3.2-1 .1-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.1.1 2.3-.6 3-1.5Z"/></svg>';
  const WINDOWS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5.5 10.4 4.5v7H3zM11.4 4.4 21 3v8.5h-9.6zM3 12.5h7.4v7L3 18.5zM11.4 12.5H21V21l-9.6-1.4z"/></svg>';

  let lang = 'en';
  let os = 'mac';
  let arch = 'arm64';

  function t(key) {
    return lang === 'tr' ? TR[key] ?? EN[key] : EN[key];
  }

  function detectLang() {
    try {
      const saved = localStorage.getItem('konsey-lang');
      if (saved === 'tr' || saved === 'en') return saved;
    } catch {
      /* depolama kapali olabilir */
    }
    return (navigator.language || '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
  }

  function applyLang(next) {
    lang = next;
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const value = t(el.dataset.i18n);
      if (value === undefined) return;
      if (HTML_KEYS.has(el.dataset.i18n)) el.innerHTML = value;
      else el.textContent = value;
    });
    document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('is-on', b.dataset.lang === lang));
    const shot = document.getElementById('shot');
    if (shot) shot.src = lang === 'tr' ? 'shot-tr.png' : 'shot-en.png';
    document.title = lang === 'tr' ? 'Konsey — Yapay zekâ ajanların, aynı masada' : 'Konsey — AI coding agents, at one table';
    updatePrimary();
    updateVersion();
  }

  // ---------------------------------------------------------------- isletim sistemi

  function detectOs() {
    const ua = navigator.userAgent;
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    if (/win/i.test(platform) || /Windows/.test(ua)) return 'win';
    if (/mac/i.test(platform) || /Mac OS X/.test(ua)) return 'mac';
    return 'other';
  }

  async function detectArch() {
    try {
      const data = await navigator.userAgentData?.getHighEntropyValues?.(['architecture']);
      if (data?.architecture) return data.architecture === 'arm' ? 'arm64' : 'x64';
    } catch {
      /* desteklenmiyor */
    }
    // Safari bilgi vermez; yeni Mac'lerin buyuk cogunlugu Apple Silicon.
    return 'arm64';
  }

  function updatePrimary() {
    const link = document.getElementById('primary-download');
    const label = document.getElementById('primary-label');
    const sub = document.getElementById('primary-sub');
    const icon = document.getElementById('primary-icon');
    if (!link) return;
    if (os === 'win') {
      link.href = `${DL}/Konsey-windows-x64-setup.exe`;
      label.textContent = lang === 'tr' ? 'Windows için indir' : 'Download for Windows';
      sub.textContent = 'Windows 10 / 11 · 64-bit';
      icon.innerHTML = WINDOWS;
    } else if (os === 'mac') {
      link.href = `${DL}/Konsey-mac-${arch}.dmg`;
      label.textContent = lang === 'tr' ? 'Mac için indir' : 'Download for Mac';
      sub.textContent = arch === 'arm64' ? 'Apple Silicon' : 'Intel';
      icon.innerHTML = APPLE;
    } else {
      link.href = '#install';
      label.textContent = lang === 'tr' ? 'İndir' : 'Download';
      sub.textContent = 'macOS · Windows';
      icon.innerHTML = '';
    }
    document.getElementById('dl-arm')?.classList.toggle('is-suggested', os === 'mac' && arch === 'arm64');
    document.getElementById('dl-intel')?.classList.toggle('is-suggested', os === 'mac' && arch === 'x64');
  }

  // ---------------------------------------------------------------- surum

  let release = null;
  function updateVersion() {
    const node = document.getElementById('version');
    if (!node || !release) return;
    const date = new Date(release.published_at).toLocaleDateString(lang === 'tr' ? 'tr-TR' : 'en-US', { day: 'numeric', month: 'long', year: 'numeric' });
    node.textContent = `${release.tag_name} · ${date}`;
  }

  async function loadVersion() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (res.ok) {
        release = await res.json();
        updateVersion();
      }
    } catch {
      /* cevrimdisi */
    }
  }

  // ---------------------------------------------------------------- kurulum sekmeleri

  function showOs(which) {
    document.querySelectorAll('.seg [data-os]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.os === which)));
    document.querySelectorAll('[data-pane]').forEach((p) => {
      p.hidden = p.dataset.pane !== which;
    });
  }

  document.querySelectorAll('.seg [data-os]').forEach((b) => b.addEventListener('click', () => showOs(b.dataset.os)));

  document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    try {
      localStorage.setItem('konsey-lang', b.dataset.lang);
    } catch {
      /* yok say */
    }
    applyLang(b.dataset.lang);
  }));

  document.querySelectorAll('.copy').forEach((button) => button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.classList.add('is-done');
      button.textContent = lang === 'tr' ? 'Kopyalandı' : 'Copied';
      setTimeout(() => {
        button.classList.remove('is-done');
        button.textContent = t('install.copy');
      }, 1800);
    } catch {
      /* izin yok */
    }
  }));

  // ---------------------------------------------------------------- hareket

  const nav = document.getElementById('nav');
  const win = document.getElementById('window');
  const onScroll = () => {
    nav.classList.toggle('is-scrolled', window.scrollY > 12);
    if (win) win.classList.toggle('is-flat', window.scrollY > 80);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-in');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach((el, i) => {
    if (reduced) {
      el.classList.add('is-in');
      return;
    }
    el.style.transitionDelay = `${Math.min(i % 4, 3) * 70}ms`;
    observer.observe(el);
  });

  // Yuzen kartlar fareyi hafifce izler.
  if (!reduced && window.matchMedia('(pointer: fine)').matches) {
    const floats = [...document.querySelectorAll('.float')];
    window.addEventListener('pointermove', (event) => {
      const x = event.clientX / window.innerWidth - 0.5;
      const y = event.clientY / window.innerHeight - 0.5;
      for (const el of floats) {
        const depth = Number(el.dataset.depth || 16);
        el.style.transform = `translate3d(${x * depth}px, ${y * depth}px, 0)`;
      }
    }, { passive: true });
  }

  // Serit kesintisiz donsun diye icerik iki kez yazilir.
  const marquee = document.getElementById('marquee');
  if (marquee) marquee.innerHTML += marquee.innerHTML;

  // ---------------------------------------------------------------- baslangic

  os = detectOs();
  showOs(os === 'win' ? 'win' : 'mac');
  applyLang(detectLang());
  detectArch().then((a) => {
    arch = a;
    updatePrimary();
  });
  loadVersion();
})();
