import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../kernel/errors.js';

/**
 * Encryption and signing helpers.
 *  - encryptBuffer / decryptBuffer: AES-256-GCM (authenticated). Used for admission documents and stored integration tokens.
 *    Layout: [version 1 byte][iv 12 bytes][auth tag 16 bytes][ciphertext]
 *  - hmacHex / safeEqual: signing of download links and webhook payloads.
 * The key comes from ENCRYPTION_KEY (64 hex characters). Without it, anything that needs encryption refuses to run, loudly.
 */
const VERSION = 1;

const key = (): Buffer => {
  if (!env.ENCRYPTION_KEY) {
    throw new AppError(503, 'ENCRYPTION_NOT_CONFIGURED', 'File and secret storage is not configured on this server (ENCRYPTION_KEY is missing). Ask your administrator.');
  }
  return Buffer.from(env.ENCRYPTION_KEY, 'hex');
};

export const encryptBuffer = (plain: Buffer): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), enc]);
};

export const decryptBuffer = (blob: Buffer): Buffer => {
  if (blob.length < 30 || blob[0] !== VERSION) throw new AppError(500, 'DECRYPT_FAILED', 'Stored data is not in a readable format.');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const data = blob.subarray(29);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new AppError(500, 'DECRYPT_FAILED', 'Stored data could not be decrypted (wrong key or the data was modified).');
  }
};

export const encryptString = (plain: string): string => encryptBuffer(Buffer.from(plain, 'utf8')).toString('base64');
export const decryptString = (b64: string): string => decryptBuffer(Buffer.from(b64, 'base64')).toString('utf8');

export const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const hmacHex = (secret: string, data: string | Buffer): string => createHmac('sha256', secret).update(data).digest('hex');
export const randomToken = (bytes = 24): string => randomBytes(bytes).toString('hex');

/** Constant-time string comparison (never use === on secrets or signatures). */
export const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
