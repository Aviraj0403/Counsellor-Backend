/** Pure business rules for the document vault. No database, no HTTP, no crypto library: unit-tested in tests/documents.domain.test.ts */

export type DocumentStatus = 'pending_review' | 'verified' | 'rejected';
export type DetectedType = { mime: 'application/pdf' | 'image/jpeg' | 'image/png'; ext: 'pdf' | 'jpg' | 'png' };

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((v, i) => b[at + i] === v);

/**
 * Detects the real file type from its first bytes. The type the browser declares is never trusted.
 * Only PDF, JPEG and PNG are accepted; anything else returns null.
 */
export const sniffFileType = (bytes: Uint8Array): DetectedType | null => {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: 'application/pdf', ext: 'pdf' }; // %PDF-
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: 'jpg' };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: 'png' };
  return null;
};

/** Returns a plain-language problem, or null when the upload is acceptable. */
export const uploadProblem = (bytes: Uint8Array, maxBytes: number): string | null => {
  if (!bytes || bytes.length === 0) return 'The file is empty. Choose a file and try again.';
  if (bytes.length > maxBytes) return `The file is too large. The limit is ${Math.floor(maxBytes / (1024 * 1024))} MB.`;
  if (!sniffFileType(bytes)) return 'Only PDF, JPEG or PNG files are accepted.';
  return null;
};

/** Makes a file name safe to show and to put in a Content-Disposition header (no path parts, no control or quote characters). */
export const safeFileName = (raw: string | undefined, fallbackExt: string): string => {
  let name = '';
  try {
    name = decodeURIComponent(raw ?? '');
  } catch {
    name = raw ?? '';
  }
  name = name.split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120);
  return name || `document.${fallbackExt}`;
};

export const documentKey = (tenantId: string, studentId: string, documentId: string): string => `${tenantId}/${studentId}/${documentId}`;

// ---- checklist
export interface RequiredItem {
  type: string;
  label: string;
  mandatory: boolean;
}
export interface UploadedDoc {
  _id?: unknown;
  type: string;
  status: DocumentStatus;
  rejectReason?: string;
  deletedAt?: Date | null;
  supersededBy?: unknown;
}
export type ChecklistState = 'missing' | 'pending_review' | 'verified' | 'rejected';
export interface ChecklistItem extends RequiredItem {
  state: ChecklistState;
  documentId?: string;
  rejectReason?: string;
}

/** For each required document: the state of its newest live (not deleted, not superseded) upload, or 'missing'. */
export const computeChecklist = (required: RequiredItem[], docs: UploadedDoc[]): ChecklistItem[] =>
  required.map((req) => {
    const live = docs.filter((d) => d.type === req.type && !d.deletedAt && !d.supersededBy);
    const d = live[live.length - 1];
    if (!d) return { ...req, state: 'missing' as const };
    return { ...req, state: d.status, documentId: d._id ? String(d._id) : undefined, rejectReason: d.rejectReason };
  });

export const missingMandatory = (items: ChecklistItem[]): ChecklistItem[] => items.filter((i) => i.mandatory && i.state !== 'verified');

export const blockMessage = (items: ChecklistItem[]): string | null => {
  const miss = missingMandatory(items);
  if (!miss.length) return null;
  return `Mandatory documents not verified yet: ${miss.map((m) => `${m.label || m.type} (${m.state.replace('_', ' ')})`).join(', ')}.`;
};

// ---- signed download token
export interface DownloadClaims {
  tenantId: string;
  documentId: string;
  userId: string;
  exp: number; // unix seconds
}
export type Signer = (data: string) => string;
export type Comparer = (a: string, b: string) => boolean;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** token = base64url(json claims) + '.' + signature. The signer is injected (HMAC with the server secret) so this stays pure. */
export const createDownloadToken = (claims: Omit<DownloadClaims, 'exp'>, ttlSeconds: number, nowMs: number, sign: Signer): string => {
  const body = b64(JSON.stringify({ ...claims, exp: Math.floor(nowMs / 1000) + ttlSeconds }));
  return `${body}.${sign(body)}`;
};

/** Returns the claims, or null for any tampered, malformed or expired token (never says which). */
export const verifyDownloadToken = (token: string, nowMs: number, sign: Signer, equal: Comparer): DownloadClaims | null => {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!equal(sign(parts[0]), parts[1])) return null;
  try {
    const c = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (typeof c?.tenantId !== 'string' || typeof c?.documentId !== 'string' || typeof c?.userId !== 'string' || typeof c?.exp !== 'number') return null;
    if (c.exp * 1000 <= nowMs) return null;
    return c as DownloadClaims;
  } catch {
    return null;
  }
};
