/**
 * electron-builder afterPack: Mac paketini butunuyle ad-hoc imzalar.
 *
 * Apple Developer kimligi olmadan paketlenen uygulamada Electron'un ozgun
 * imzasi Info.plist degistigi icin bozulur; indirilen (karantinali) bozuk
 * imzali bir uygulamayi macOS "hasarli" diye acmaz. Gecerli bir ad-hoc imza
 * ile kullanici Gizlilik ve Guvenlik'ten "Yine de Ac" diyebilir.
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed ${app}`);
};
