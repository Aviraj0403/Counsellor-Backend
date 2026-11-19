import { describe, expect, it } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  blockMessage,
  computeChecklist,
  createDownloadToken,
  documentKey,
  safeFileName,
  sniffFileType,
  uploadProblem,
  verifyDownloadToken,
} from '../src/product/modules/documents/domain/document.domain.js';

const sign = (d: string) => createHmac('sha256', 'secret-secret-secret-secret-secret-1').update(d).digest('hex');
const otherSign = (d: string) => createHmac('sha256', 'another-secret-another-secret-0000').update(d).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

describe('sniffFileType (magic bytes)', () => {
  it('recognises PDF, JPEG and PNG by content', () => {
    expect(sniffFileType(PDF)?.mime).toBe('application/pdf');
    expect(sniffFileType(JPG)?.mime).toBe('image/jpeg');
    expect(sniffFileType(PNG)?.mime).toBe('image/png');
  });
  it('rejects everything else, including spoofed content', () => {
    expect(sniffFileType(Buffer.from('MZ\x90\x00 an exe renamed to pdf'))).toBeNull();
    expect(sniffFileType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffFileType(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffFileType(Buffer.from('PK\x03\x04'))).toBeNull();
    expect(sniffFileType(Buffer.from([0x89, 0x50]))).toBeNull(); // truncated PNG signature
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });
  it('a file with a .pdf name but PNG bytes is detected as PNG (declared type is irrelevant)', () => {
    expect(sniffFileType(PNG)?.ext).toBe('png');
  });
});

describe('uploadProblem', () => {
  it('accepts a normal file and refuses empty, oversized and wrong-type files', () => {
    expect(uploadProblem(PDF, 1024)).toBeNull();
    expect(uploadProblem(Buffer.alloc(0), 1024)).toMatch(/empty/i);
    expect(uploadProblem(Buffer.concat([PDF, Buffer.alloc(2000)]), 1024)).toMatch(/too large/i);
    expect(uploadProblem(Buffer.from('hello world'), 1024)).toMatch(/PDF, JPEG or PNG/);
  });
});

describe('safeFileName / key', () => {
  it('strips paths and dangerous characters', () => {
    expect(safeFileName('../../etc/passwd', 'pdf')).toBe('passwd');
    expect(safeFileName('C:\\x\\mark"sheet.pdf', 'pdf')).toBe('marksheet.pdf');
    expect(safeFileName('', 'png')).toBe('document.png');
    expect(safeFileName(undefined, 'jpg')).toBe('document.jpg');
    expect(safeFileName('a\r\nb.pdf', 'pdf')).toBe('ab.pdf');
  });
  it('builds a key from three ids', () => {
    expect(documentKey('t', 's', 'd')).toBe('t/s/d');
  });
});

describe('checklist', () => {
  const req = [
    { type: 'marksheet', label: '12th marksheet', mandatory: true },
    { type: 'photo', label: 'Photo', mandatory: false },
    { type: 'id', label: 'ID proof', mandatory: true },
  ];
  it('is missing when nothing is uploaded and blocks with a message naming the items', () => {
    const c = computeChecklist(req, []);
    expect(c.map((i) => i.state)).toEqual(['missing', 'missing', 'missing']);
    const msg = blockMessage(c)!;
    expect(msg).toContain('12th marksheet');
    expect(msg).toContain('ID proof');
    expect(msg).not.toContain('Photo');
  });
  it('uses the newest live upload and ignores superseded and deleted ones', () => {
    const c = computeChecklist(req, [
      { _id: 'a', type: 'marksheet', status: 'rejected', supersededBy: 'b' },
      { _id: 'b', type: 'marksheet', status: 'verified' },
      { _id: 'c', type: 'id', status: 'verified', deletedAt: new Date() },
      { _id: 'd', type: 'photo', status: 'pending_review' },
    ]);
    expect(c[0]).toMatchObject({ state: 'verified', documentId: 'b' });
    expect(c[1].state).toBe('pending_review');
    expect(c[2].state).toBe('missing');
  });
  it('pending_review and rejected do not satisfy a mandatory item; verified mandatory items pass', () => {
    const c = computeChecklist(req, [
      { type: 'marksheet', status: 'pending_review' },
      { type: 'id', status: 'rejected', rejectReason: 'blurred' },
    ]);
    expect(blockMessage(c)).toMatch(/marksheet.*pending review/);
    expect(c[2].rejectReason).toBe('blurred');
    const ok = computeChecklist(req, [
      { type: 'marksheet', status: 'verified' },
      { type: 'id', status: 'verified' },
    ]);
    expect(blockMessage(ok)).toBeNull();
  });
});

describe('download token', () => {
  const claims = { tenantId: 't1', documentId: 'd1', userId: 'u1' };
  const now = 1_700_000_000_000;
  it('round-trips and carries the claims', () => {
    const t = createDownloadToken(claims, 120, now, sign);
    const c = verifyDownloadToken(t, now + 1000, sign, equal)!;
    expect(c).toMatchObject(claims);
    expect(c.exp).toBe(now / 1000 + 120);
  });
  it('expires', () => {
    const t = createDownloadToken(claims, 120, now, sign);
    expect(verifyDownloadToken(t, now + 119_000, sign, equal)).not.toBeNull();
    expect(verifyDownloadToken(t, now + 121_000, sign, equal)).toBeNull();
  });
  it('rejects a tampered payload, a tampered signature, another secret and garbage', () => {
    const t = createDownloadToken(claims, 120, now, sign);
    const [body, sig] = t.split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, documentId: 'd2', exp: now / 1000 + 120 })).toString('base64url');
    expect(verifyDownloadToken(`${forged}.${sig}`, now, sign, equal)).toBeNull();
    expect(verifyDownloadToken(`${body}.${sig.slice(0, -1)}0`, now, sign, equal)).toBeNull();
    expect(verifyDownloadToken(t, now, otherSign, equal)).toBeNull();
    for (const bad of ['', 'abc', 'a.b.c', '.', `${body}.`, 'x'.repeat(5000)]) expect(verifyDownloadToken(bad, now, sign, equal)).toBeNull();
  });
  it('rejects a correctly signed token whose payload is not valid claims', () => {
    const body = Buffer.from(JSON.stringify({ tenantId: 1 })).toString('base64url');
    expect(verifyDownloadToken(`${body}.${sign(body)}`, now, sign, equal)).toBeNull();
    const nonJson = Buffer.from('not json').toString('base64url');
    expect(verifyDownloadToken(`${nonJson}.${sign(nonJson)}`, now, sign, equal)).toBeNull();
  });
});
