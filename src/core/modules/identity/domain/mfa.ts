import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Pure TOTP helpers (RFC 4226 HOTP, RFC 6238 TOTP, RFC 4648 base32). No I/O. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const base32Encode = (buf: Buffer): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep the accumulator small
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string): Buffer => {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Buffer.from(out);
};

export const generateSecret = (bytes = 20): string => base32Encode(randomBytes(bytes));

type Algo = 'sha1' | 'sha256' | 'sha512';

export const hotp = (secret: Buffer, counter: number, digits = 6, algorithm: Algo = 'sha1'): string => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac(algorithm, secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
};

export const TOTP_PERIOD = 30;
export const timeStep = (nowMs: number, period = TOTP_PERIOD): number => Math.floor(nowMs / 1000 / period);

export const totp = (secret: Buffer, nowMs: number, digits = 6, algorithm: Algo = 'sha1', period = TOTP_PERIOD): string =>
  hotp(secret, timeStep(nowMs, period), digits, algorithm);

const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Returns the matched time step (so callers can refuse a replay of the same step) or null. Accepts +-`window` steps. */
export const verifyTotp = (secretBase32: string, code: string, nowMs: number, window = 1): number | null => {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = timeStep(nowMs);
  let hit: number | null = null;
  for (let d = -window; d <= window; d++) {
    if (eq(hotp(secret, now + d), code) && hit === null) hit = now + d; // no early exit
  }
  return hit;
};

export const otpauthUrl = (secretBase32: string, account: string, issuer: string): string =>
  'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(account) +
  '?secret=' + secretBase32 + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=' + TOTP_PERIOD;

const RC_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** 10 codes like ABCDE-FGHJK. */
export const generateRecoveryCodes = (count = 10): string[] =>
  Array.from({ length: count }, () => {
    const c = Array.from({ length: 10 }, () => RC_ALPHABET[randomInt(RC_ALPHABET.length)]).join('');
    return c.slice(0, 5) + '-' + c.slice(5);
  });

export const normalizeRecoveryCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');
