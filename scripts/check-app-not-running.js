/**
 * electron-builder release/mac-arm64 dizinini yerinde yeniler. Konsey bu
 * dizinden calisirken app.asar degisirse acik Electron sureci eski ASAR
 * indeksini kullanip HTML yerine baska bir dosyanin byte'larini okuyabilir.
 */
const { execFileSync } = require('node:child_process');

if (process.platform !== 'darwin') process.exit(0);

try {
  const pids = execFileSync('/usr/bin/pgrep', ['-x', 'Konsey'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (pids) {
    console.error(
      'Konsey su anda acik. Paket yenilenirken app.asar bozuk okunmasin diye ' +
      'uygulamayi kapatip komutu yeniden calistirin.',
    );
    process.exit(1);
  }
} catch (error) {
  // pgrep eslesme bulamazsa 1 ile cikar; bu beklenen ve guvenli durumdur.
  // Kisitli build ortamlarinda surec listesi okunamayabilir (pgrep=3); paket
  // yine calisabilsin, normal Terminal/Finder kullaniminda koruma aktiftir.
  if (error?.status !== 1 && error?.status !== 3) throw error;
}
