/**
 * API anahtarlari isletim sisteminin guvenli deposunda tutulur.
 *
 * - macOS: Keychain (security araci).
 * - Windows/Linux: Electron safeStorage ile sifrelenip ~/.konsey/secrets.json
 *   dosyasina yazilir (Windows'ta DPAPI, Linux'ta libsecret anahtari).
 *
 * Duz metin config dosyasi kullanilmaz: dosya yedeklere, git'e ve ekran
 * paylasimina sizabilir.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { L } from '../shared/i18n';

const execFileAsync = promisify(execFile);
const SERVICE = 'konsey-provider';
const IS_MAC = process.platform === 'darwin';
const FILE = path.join(os.homedir(), '.konsey', 'secrets.json');

// ------------------------------------------------------------------ macOS

async function keychainSet(account: string, secret: string): Promise<void> {
  // -U mevcut girdiyi gunceller. Deger kisa omurlu bir argv ile gecer ve
  // hemen Keychain'e yazilir.
  await execFileAsync('/usr/bin/security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret]);
}

async function keychainGet(account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

async function keychainDelete(account: string): Promise<void> {
  try {
    await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
  } catch {
    /* zaten yok */
  }
}

// ------------------------------------------------------------------ digerleri

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
}

function safeStorage(): SafeStorage | null {
  try {
    // Yalnizca Electron ana surecinde vardir; komut satiri araci icin null.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { safeStorage?: SafeStorage };
    return electron.safeStorage?.isEncryptionAvailable() ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

async function readStore(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(FILE, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeStore(store: Record<string, string>): Promise<void> {
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ------------------------------------------------------------------ ortak

export async function setSecret(account: string, secret: string): Promise<void> {
  if (IS_MAC) return keychainSet(account, secret);
  const storage = safeStorage();
  if (!storage) {
    throw new Error(L(
      'Bu sistemde anahtar güvenli saklanamıyor. Anahtarı ortam değişkeniyle ver.',
      'Keys cannot be stored securely on this system. Provide the key with an environment variable.',
    ));
  }
  const store = await readStore();
  store[account] = storage.encryptString(secret).toString('base64');
  await writeStore(store);
}

export async function getSecret(account: string): Promise<string | null> {
  if (IS_MAC) return keychainGet(account);
  const storage = safeStorage();
  const value = (await readStore())[account];
  if (!storage || !value) return null;
  try {
    return storage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

export async function deleteSecret(account: string): Promise<void> {
  if (IS_MAC) return keychainDelete(account);
  const store = await readStore();
  if (!(account in store)) return;
  delete store[account];
  await writeStore(store);
}

export async function hasSecret(account: string): Promise<boolean> {
  return (await getSecret(account)) !== null;
}
