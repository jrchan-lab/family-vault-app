// 保险箱 · crypto.js
// Pure encryption helpers. No DOM, no storage, no network.
// Uses only the platform Web Crypto API (browser or Node 20+).
//
//   key  = PBKDF2-SHA256(master password, 16-byte random salt, 600 000 rounds) -> AES-256-GCM
//   blob = AES-GCM(key, fresh 12-byte IV, JSON data, AAD = format header)
//
// The same "envelope" object is what we keep in IndexedDB and what the
// backup file contains, so a backup opens with the same master password.

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const FORMAT = 'family-vault';
export const VERSION = 1;
export const DEFAULT_ITERATIONS = 600000; // OWASP 2023 figure for PBKDF2-HMAC-SHA256
export const MIN_ITERATIONS = 100000;     // refuse weaker files
export const MAX_ITERATIONS = 10000000;   // refuse files that would hang the phone
export const MIN_PASSWORD_LENGTH = 8;

export class VaultError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'VaultError';
    this.code = code; // WRONG_PASSWORD | BAD_FILE | WEAK_PASSWORD | EMPTY_PASSWORD
  }
}

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromB64(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) {
    throw new VaultError('BAD_FILE', 'not base64');
  }
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function checkNewPassword(password) {
  if (typeof password !== 'string' || [...password].length < MIN_PASSWORD_LENGTH) {
    throw new VaultError('WEAK_PASSWORD');
  }
}

export function newKdf(iterations = DEFAULT_ITERATIONS) {
  return {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations,
    salt: toB64(globalThis.crypto.getRandomValues(new Uint8Array(16))),
  };
}

export async function deriveKey(password, kdf) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new VaultError('EMPTY_PASSWORD');
  }
  const base = await subtle.importKey(
    'raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(kdf.salt), iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // key can never be exported out of Web Crypto
    ['encrypt', 'decrypt']);
}

// Everything outside the ciphertext is bound in as additional data,
// so changing the header (salt, rounds, version) makes decryption fail.
function aad(kdf) {
  return te.encode(`${FORMAT}|v${VERSION}|${kdf.name}-${kdf.hash}|${kdf.iterations}|${kdf.salt}`);
}

export async function seal(key, kdf, data) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const plain = te.encode(JSON.stringify(data));
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(kdf) }, key, plain));
  return { format: FORMAT, v: VERSION, kdf: { ...kdf }, iv: toB64(iv), ct: toB64(ct) };
}

export async function open(key, envelope) {
  const env = checkEnvelope(envelope);
  let plain;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(env.iv), additionalData: aad(env.kdf) },
      key, fromB64(env.ct));
  } catch {
    // GCM tag mismatch: wrong password, or the file was changed.
    throw new VaultError('WRONG_PASSWORD');
  }
  let data;
  try { data = JSON.parse(td.decode(plain)); } catch { throw new VaultError('BAD_FILE', 'bad json'); }
  return checkData(data);
}

// Validate an envelope read from IndexedDB or from a backup file.
export function checkEnvelope(input) {
  let env = input;
  if (typeof env === 'string') {
    try { env = JSON.parse(env); } catch { throw new VaultError('BAD_FILE', 'not json'); }
  }
  const k = env && env.kdf;
  const ok = env && typeof env === 'object'
    && env.format === FORMAT && env.v === VERSION
    && k && k.name === 'PBKDF2' && k.hash === 'SHA-256'
    && Number.isInteger(k.iterations)
    && k.iterations >= MIN_ITERATIONS && k.iterations <= MAX_ITERATIONS
    && typeof k.salt === 'string' && fromB64(k.salt).length === 16
    && typeof env.iv === 'string' && fromB64(env.iv).length === 12
    && typeof env.ct === 'string' && env.ct.length > 0;
  if (!ok) throw new VaultError('BAD_FILE', 'not a vault file');
  return {
    format: env.format, v: env.v,
    kdf: { name: k.name, hash: k.hash, iterations: k.iterations, salt: k.salt },
    iv: env.iv, ct: env.ct,
  };
}

function checkData(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
    throw new VaultError('BAD_FILE', 'bad vault data');
  }
  for (const e of data.entries) {
    if (!e || typeof e.id !== 'string' || typeof e.title !== 'string' || typeof e.body !== 'string') {
      throw new VaultError('BAD_FILE', 'bad entry');
    }
  }
  return data;
}

// Unlock an envelope with a typed password: derive key, decrypt.
export async function unlock(password, envelope) {
  const env = checkEnvelope(envelope);
  const key = await deriveKey(password, env.kdf);
  const data = await open(key, env);
  return { key, kdf: env.kdf, data };
}

// Create a brand-new vault (or re-key one) under a new password.
export async function createVault(password, data = { entries: [] }, iterations = DEFAULT_ITERATIONS) {
  checkNewPassword(password);
  const kdf = newKdf(iterations);
  const key = await deriveKey(password, kdf);
  const envelope = await seal(key, kdf, checkData(data));
  return { key, kdf, envelope };
}

// Backup file text. The envelope is already encrypted; we only add a
// human-readable note so nobody mistakes it for something else.
export function backupText(envelope) {
  const env = checkEnvelope(envelope);
  return JSON.stringify({
    note: '保险箱加密备份 · family-vault encrypted backup. 没有主密码打不开。',
    ...env,
  }, null, 1);
}

export function readBackupText(text) {
  if (typeof text !== 'string' || text.length > 20 * 1024 * 1024) {
    throw new VaultError('BAD_FILE', 'too big');
  }
  return checkEnvelope(text);
}
