import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateRecoveryCodes, generateSecret, hotp, normalizeRecoveryCode, otpauthUrl, timeStep, totp, verifyTotp } from '../src/core/modules/identity/domain/mfa.js';

describe('base32 (RFC 4648 vectors)', () => {
  const v: Array<[string, string]> = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  it('encodes (unpadded) and decodes', () => {
    for (const [plain, enc] of v) {
      expect(base32Encode(Buffer.from(plain))).toBe(enc);
      expect(base32Decode(enc).toString()).toBe(plain);
    }
  });
  it('tolerates lowercase, spaces and padding; rejects junk', () => {
    expect(base32Decode('mzxw 6ytb oi======').toString()).toBe('foobar');
    expect(() => base32Decode('MZ!W')).toThrow();
  });
});

describe('HOTP (RFC 4226 appendix D)', () => {
  const key = Buffer.from('12345678901234567890');
  const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it('matches the published vectors', () => expected.forEach((c, i) => expect(hotp(key, i)).toBe(c)));
});

describe('TOTP (RFC 6238 appendix B, 8 digits)', () => {
  const k1 = Buffer.from('12345678901234567890');
  const k256 = Buffer.from('12345678901234567890123456789012');
  const k512 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');
  const rows: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
  ];
  it('matches SHA1, SHA256 and SHA512 vectors', () => {
    for (const [t, a, b, c] of rows) {
      expect(totp(k1, t * 1000, 8, 'sha1')).toBe(a);
      expect(totp(k256, t * 1000, 8, 'sha256')).toBe(b);
      expect(totp(k512, t * 1000, 8, 'sha512')).toBe(c);
    }
  });
});

describe('verifyTotp drift window', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const raw = base32Decode(secret);
  const now = 1_700_000_000_000;
  const step = timeStep(now);
  it('accepts current and +-1 step and reports the step', () => {
    expect(verifyTotp(secret, hotp(raw, step), now)).toBe(step);
    expect(verifyTotp(secret, hotp(raw, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, hotp(raw, step + 1), now)).toBe(step + 1);
  });
  it('rejects +-2 steps, malformed and wrong codes', () => {
    expect(verifyTotp(secret, hotp(raw, step - 2), now)).toBeNull();
    expect(verifyTotp(secret, hotp(raw, step + 2), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});

describe('helpers', () => {
  it('generates a 32-char base32 secret and otpauth URL', () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    const u = otpauthUrl(s, 'a@b.test', 'Counsellor Platform');
    expect(u.startsWith('otpauth://totp/Counsellor%20Platform:a%40b.test?secret=' + s)).toBe(true);
    expect(u).toContain('period=30');
  });
  it('recovery codes: 10 unique, normalised', () => {
    const c = generateRecoveryCodes();
    expect(new Set(c).size).toBe(10);
    expect(c[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });
});
