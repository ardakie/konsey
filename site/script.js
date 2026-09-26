(function () {
  "use strict";

  var DICT = {
    en: {
      "hero.tagline": "Your AI coding agents, working together on one project.",
      "hero.pitch": "Konsey turns one request into a plan, splits it into tasks, and hands each task to the cheapest agent that can do it — Claude Code, Codex, Antigravity, or any coding CLI you already use. Every agent works in its own isolated git worktree so they never collide. Results are merged, tested, reviewed, and only then applied to your folder.",
      "hero.download.macArm": "Download for macOS (Apple Silicon)",
      "hero.download.macArmShort": "macOS — Apple Silicon",
      "hero.download.macIntelShort": "macOS — Intel",
      "hero.download.winShort": "Windows (x64)",
      "hero.download.recommended": "Recommended for your Mac",
      "hero.download.all": "All releases on GitHub",
      "how.title": "How it works",
      "how.sub": "From one request to a tested, applied change.",
      "how.step1.title": "Pick a folder",
      "how.step1.body": "Point Konsey at any project folder — with or without git.",
      "how.step2.title": "Connect your agents",
      "how.step2.body": "Sign in to Claude Code, Codex, Antigravity, or any coding CLI you have installed.",
      "how.step3.title": "Describe the work",
      "how.step3.body": "Write one request in plain language, in the council's chat box.",
      "how.step4.title": "Tested, then applied",
      "how.step4.body": "Konsey plans, splits the work, runs agents in isolated worktrees, merges, tests, and reviews — then applies the result to your folder.",
      "agents.title": "Supported agents",
      "agents.sub": "Konsey drives your existing CLIs and auto-detects more as it finds them.",
      "agents.antigravity": "Google Antigravity (macOS only)",
      "agents.custom": "Custom CLI",
      "agents.apis": "OpenAI-compatible APIs (OpenRouter, DeepSeek, GLM…)",
      "features.title": "Features",
      "features.parallel.title": "Parallel, isolated agents",
      "features.parallel.body": "Each agent works in its own git worktree copy, so no two agents ever overwrite each other's changes.",
      "features.cost.title": "Cost-aware routing",
      "features.cost.body": "Konsey sends each task to the cheapest agent that can handle it, saving premium calls for the work that needs them.",
      "features.caps.title": "Usage caps",
      "features.caps.body": "Cap each agent at a share of your own plan limit — for example, “use at most 40% of my Claude limit.”",
      "features.chat.title": "Council chat",
      "features.chat.body": "Talk to one agent one-on-one, or ask the whole council at once. Chat is read-only — it never edits files.",
      "features.office.title": "Pixel office",
      "features.office.body": "A live pixel-art office shows which agent is working, reviewing, or resting — in real time.",
      "features.privacy.title": "Local & private",
      "features.privacy.body": "Konsey has no servers. Everything runs on your machine, using your own subscriptions and API keys.",
      "install.title": "Install",
      "install.sub": "Neither build is code-signed yet, so both platforms show a first-launch warning — here's how to get past it.",
      "install.mac.title": "macOS",
      "install.mac.step1": "Download the DMG for your Mac (Apple Silicon or Intel).",
      "install.mac.step2": "Open it and drag Konsey to Applications.",
      "install.mac.step3": "Launch Konsey from Applications or Spotlight.",
      "install.mac.warningTitle": "Unsigned app warning: ",
      "install.mac.warningBody": "Konsey isn't notarized by Apple, so the first launch is blocked. Fix it in System Settings → Privacy & Security → scroll down → “Open Anyway” (or right-click the app → Open).",
      "install.mac.altLabel": "Or skip the warning entirely — this downloads the zip with curl, which doesn't add the quarantine flag:",
      "install.copy": "Copy",
      "install.win.title": "Windows",
      "install.win.step1": "Download the setup .exe.",
      "install.win.step2": "Run it — it installs per-user (no admin rights needed) and launches automatically.",
      "install.win.step3": "Nothing else to do — Konsey opens when the install finishes.",
      "install.win.warningTitle": "SmartScreen warning: ",
      "install.win.warningBody": "The installer isn't code-signed, so Windows may show “Windows protected your PC.” Click “More info” → “Run anyway.”",
      "req.title": "Requirements",
      "req.os": "macOS 11+ (Apple Silicon or Intel) or Windows 10/11 x64",
      "req.git": "git — macOS: run “xcode-select --install”; Windows: install Git for Windows from git-scm.com",
      "req.cli": "At least one coding agent CLI — Konsey's “Connect agents” screen can install one and open its sign-in in a terminal",
      "req.node": "Many agent CLIs also need Node.js 20+ (nodejs.org)",
      "faq.title": "FAQ",
      "faq.q1": "Is it free?",
      "faq.a1": "Yes. Konsey is open source under the MIT license and free to use. You bring your own agent subscriptions and/or API keys — Konsey doesn't add any charge on top.",
      "faq.q2": "Does my code go to Konsey?",
      "faq.a2": "No. Konsey has no servers. Your code only goes to the AI services you connect — through your own CLI logins or your own API keys.",
      "faq.q3": "Which operating systems are supported?",
      "faq.a3": "macOS 11 or later (Apple Silicon and Intel) and Windows 10/11 (x64).",
      "footer.license": "MIT License",
      "footer.releases": "All releases",
      "footer.tagline": "Konsey — open source, local-first, MIT licensed."
    },
    tr: {
      "hero.tagline": "Yapay zeka kodlama ajanlarınız, aynı proje üzerinde birlikte çalışsın.",
      "hero.pitch": "Konsey tek bir isteği plana çevirir, görevlere böler ve her görevi yapabilecek en ucuz ajana verir — Claude Code, Codex, Antigravity ya da zaten kullandığınız herhangi bir CLI. Her ajan kendi izole git worktree'sinde çalışır, böylece hiçbiri birbirine karışmaz. Sonuçlar birleştirilir, test edilir, incelenir ve ancak o zaman klasörünüze uygulanır.",
      "hero.download.macArm": "macOS için indir (Apple Silicon)",
      "hero.download.macArmShort": "macOS — Apple Silicon",
      "hero.download.macIntelShort": "macOS — Intel",
      "hero.download.winShort": "Windows (x64)",
      "hero.download.recommended": "Mac'iniz için önerilen",
      "hero.download.all": "GitHub'daki tüm sürümler",
      "how.title": "Nasıl çalışır",
      "how.sub": "Tek bir istekten, test edilip uygulanmış bir değişikliğe.",
      "how.step1.title": "Bir klasör seçin",
      "how.step1.body": "Konsey'i herhangi bir proje klasörüne yönlendirin — git deposu olsun ya da olmasın.",
      "how.step2.title": "Ajanlarınızı bağlayın",
      "how.step2.body": "Claude Code, Codex, Antigravity ya da kurulu herhangi bir kodlama CLI'ına giriş yapın.",
      "how.step3.title": "İşi tanımlayın",
      "how.step3.body": "Konseyin sohbet kutusuna sade bir dille tek bir istek yazın.",
      "how.step4.title": "Test edilir, sonra uygulanır",
      "how.step4.body": "Konsey planlar, işi böler, ajanları izole worktree'lerde çalıştırır, birleştirir, test eder ve inceler — sonra sonucu klasörünüze uygular.",
      "agents.title": "Desteklenen ajanlar",
      "agents.sub": "Konsey elinizdeki CLI'ları yönetir ve buldukça yenilerini otomatik algılar.",
      "agents.antigravity": "Google Antigravity (yalnızca macOS)",
      "agents.custom": "Özel CLI",
      "agents.apis": "OpenAI-uyumlu API'ler (OpenRouter, DeepSeek, GLM…)",
      "features.title": "Özellikler",
      "features.parallel.title": "Paralel, izole ajanlar",
      "features.parallel.body": "Her ajan kendi git worktree kopyasında çalışır, bu yüzden hiçbiri diğerinin değişikliğinin üstüne yazmaz.",
      "features.cost.title": "Maliyete duyarlı yönlendirme",
      "features.cost.body": "Konsey her görevi yapabilecek en ucuz ajana gönderir, pahalı ajanları gerektiği işe saklar.",
      "features.caps.title": "Kullanım limitleri",
      "features.caps.body": "Her ajanı kendi abonelik limitinizin bir payıyla sınırlayın — örneğin “Claude limitimin en fazla yüzde 40'ını kullan.”",
      "features.chat.title": "Konsey masası",
      "features.chat.body": "Bir ajanla birebir ya da tüm konseyle aynı anda konuşun. Sohbet salt okunurdur — dosya değiştirmez.",
      "features.office.title": "Piksel ofis",
      "features.office.body": "Canlı bir piksel-art ofis, hangi ajanın çalıştığını, incelediğini ya da dinlendiğini gerçek zamanlı gösterir.",
      "features.privacy.title": "Yerel ve özel",
      "features.privacy.body": "Konseyin sunucusu yoktur. Her şey kendi makinenizde, kendi aboneliklerinizle ve API anahtarlarınızla çalışır.",
      "install.title": "Kurulum",
      "install.sub": "İki paket de henüz imzalı değil, bu yüzden ilk açılışta bir uyarı görürsünüz — nasıl geçeceğiniz aşağıda.",
      "install.mac.title": "macOS",
      "install.mac.step1": "Mac'iniz için DMG dosyasını indirin (Apple Silicon ya da Intel).",
      "install.mac.step2": "Açın ve Konsey'i Applications klasörüne sürükleyin.",
      "install.mac.step3": "Konsey'i Applications'tan ya da Spotlight ile açın.",
      "install.mac.warningTitle": "İmzasız uygulama uyarısı: ",
      "install.mac.warningBody": "Konsey Apple tarafından noter onaylı değil, bu yüzden ilk açılış engellenir. Çözüm: Sistem Ayarları → Gizlilik ve Güvenlik → aşağı kaydırın → “Yine de Aç” (ya da uygulamaya sağ tıklayıp Aç).",
      "install.mac.altLabel": "Ya da uyarıyı tamamen atlayın — bu, zip'i curl ile indirir ve karantina bayrağı eklemez:",
      "install.copy": "Kopyala",
      "install.win.title": "Windows",
      "install.win.step1": "Kurulum .exe dosyasını indirin.",
      "install.win.step2": "Çalıştırın — kullanıcı bazında kurulur (yönetici hakkı gerekmez) ve otomatik açılır.",
      "install.win.step3": "Başka bir şey yapmanıza gerek yok — kurulum bitince Konsey açılır.",
      "install.win.warningTitle": "SmartScreen uyarısı: ",
      "install.win.warningBody": "Kurulum dosyası imzalı değil, bu yüzden Windows “Windows bilgisayarınızı korudu” diyebilir. “Daha fazla bilgi” → “Yine de çalıştır”ı tıklayın.",
      "req.title": "Gereksinimler",
      "req.os": "macOS 11+ (Apple Silicon ya da Intel) veya Windows 10/11 x64",
      "req.git": "git — macOS: “xcode-select --install” çalıştırın; Windows: git-scm.com'dan Git for Windows kurun",
      "req.cli": "En az bir kodlama ajanı CLI'ı — Konseyin “Ajan bağla” ekranı birini kurup girişini bir terminalde açabilir",
      "req.node": "Birçok ajan CLI'ı ayrıca Node.js 20+ ister (nodejs.org)",
      "faq.title": "Sık sorulanlar",
      "faq.q1": "Ücretsiz mi?",
      "faq.a1": "Evet. Konsey MIT lisanslı açık kaynaktır ve kullanımı ücretsizdir. Kendi ajan aboneliklerinizi ve/veya API anahtarlarınızı kullanırsınız — Konsey bunun üstüne bir ücret eklemez.",
      "faq.q2": "Kodum Konsey'e mi gidiyor?",
      "faq.a2": "Hayır. Konseyin sunucusu yoktur. Kodunuz yalnızca bağladığınız yapay zeka servislerine gider — kendi CLI oturum açışlarınız ya da kendi API anahtarlarınız üzerinden.",
      "faq.q3": "Hangi işletim sistemleri destekleniyor?",
      "faq.a3": "macOS 11 ve sonrası (Apple Silicon ve Intel) ve Windows 10/11 (x64).",
      "footer.license": "MIT Lisansı",
      "footer.releases": "Tüm sürümler",
      "footer.tagline": "Konsey — açık kaynak, önce yerel, MIT lisanslı."
    }
  };

  var STORAGE_KEY = "konsey-site-lang";

  function detectLang() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "en" || stored === "tr") return stored;
    } catch (e) {}
    var nav = (navigator.language || "en").toLowerCase();
    return nav.indexOf("tr") === 0 ? "tr" : "en";
  }

  function applyLang(lang) {
    var dict = DICT[lang] || DICT.en;
    document.documentElement.lang = lang;
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      if (dict[key] !== undefined) {
        nodes[i].textContent = dict[key];
      }
    }
    var buttons = document.querySelectorAll("[data-lang-btn]");
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].classList.toggle("active", buttons[j].getAttribute("data-lang-btn") === lang);
    }
    var shot = document.getElementById("shot-img");
    if (shot) {
      shot.src = lang === "tr" ? "shot-tr.png" : "shot-en.png";
    }
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {}
  }

  function detectMacArch(callback) {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      navigator.userAgentData
        .getHighEntropyValues(["architecture"])
        .then(function (info) {
          callback(info && info.architecture === "x86" ? "x64" : "arm64");
        })
        .catch(function () {
          callback("arm64");
        });
    } else {
      callback(null); // unknown: show both, default to arm64 as primary
    }
  }

  function detectOS() {
    var ua = navigator.userAgent || "";
    var platform = navigator.platform || "";
    if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    return "other";
  }

  function setPrimaryDownload(lang, os, macArch) {
    var primary = document.getElementById("primary-download");
    var label = document.getElementById("primary-download-label");
    var sub = document.getElementById("primary-download-sub");
    var dict = DICT[lang] || DICT.en;
    if (!primary) return;

    if (os === "windows") {
      primary.href = "https://github.com/ardakie/konsey/releases/latest/download/Konsey-windows-x64-setup.exe";
      label.textContent = lang === "tr" ? "Windows için indir" : "Download for Windows";
      sub.textContent = dict["hero.download.recommended"];
    } else if (os === "mac" && macArch === "x64") {
      primary.href = "https://github.com/ardakie/konsey/releases/latest/download/Konsey-mac-x64.dmg";
      label.textContent = lang === "tr" ? "macOS için indir (Intel)" : "Download for macOS (Intel)";
      sub.textContent = dict["hero.download.recommended"];
    } else {
      // mac + arm64, mac + unknown arch, or non-mac/non-windows visitor: default to Apple Silicon
      primary.href = "https://github.com/ardakie/konsey/releases/latest/download/Konsey-mac-arm64.dmg";
      label.textContent = dict["hero.download.macArm"];
      sub.textContent = dict["hero.download.recommended"];
    }
  }

  function initCopyButtons() {
    var buttons = document.querySelectorAll("[data-copy]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener("click", function () {
        var text = this.getAttribute("data-copy");
        var original = this.textContent;
        var btn = this;
        var done = function () {
          btn.textContent = "✓";
          setTimeout(function () {
            btn.textContent = original;
          }, 1500);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, done);
        } else {
          done();
        }
      });
    }
  }

  var currentLang = detectLang();
  var currentOS = detectOS();

  applyLang(currentLang);
  setPrimaryDownload(currentLang, currentOS, null);
  initCopyButtons();

  if (currentOS === "mac") {
    detectMacArch(function (arch) {
      setPrimaryDownload(currentLang, currentOS, arch);
    });
  }

  var langButtons = document.querySelectorAll("[data-lang-btn]");
  for (var k = 0; k < langButtons.length; k++) {
    langButtons[k].addEventListener("click", function () {
      currentLang = this.getAttribute("data-lang-btn");
      applyLang(currentLang);
      if (currentOS === "mac") {
        detectMacArch(function (arch) {
          setPrimaryDownload(currentLang, currentOS, arch);
        });
      } else {
        setPrimaryDownload(currentLang, currentOS, null);
      }
    });
  }
})();
