/**
 * API anahtarlari macOS Keychain'de tutulur.
 *
 * Duz metin config dosyasi kullanilmaz: dosya yedeklere, git'e ve ekran
 * paylasimina sizabilir. Keychain girdileri kullanicinin oturumuna baglidir.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SERVICE = 'konsey-provider';

export async function setSecret(account: string, secret: string): Promise<void> {
  // -U mevcut girdiyi gunceller. Anahtar argv yerine stdin'den verilemedigi
  // icin -w kullaniliyor; sureclerin argv'si ayni kullanicida gorunebilir,
  // bu yuzden yazma islemi kisa omurludur ve deger hemen Keychain'e gecer.
  await execFileAsync('/usr/bin/security', [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', account,
    '-w', secret,
  ]);
}

export async function getSecret(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', [
      'find-generic-password',
      '-s', SERVICE,
      '-a', account,
      '-w',
    ]);
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

export async function deleteSecret(account: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/security', [
      'delete-generic-password',
      '-s', SERVICE,
      '-a', account,
    ]);
  } catch {
    /* zaten yok */
  }
}

export async function hasSecret(account: string): Promise<boolean> {
  return (await getSecret(account)) !== null;
}
