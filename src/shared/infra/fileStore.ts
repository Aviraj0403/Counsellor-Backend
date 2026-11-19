import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { env } from '../../config/env.js';
import { AppError, notFound } from '../kernel/errors.js';

/**
 * Where uploaded files live. The app only ever talks to this interface, so moving from local disk to S3 / Azure Blob is one
 * new class and one line in getFileStore(). Callers store ALREADY-ENCRYPTED bytes (see shared/infra/crypto.ts): the store
 * never sees a readable document.
 *   production: LocalFileStore(FILE_STORAGE_DIR)
 *   tests:      setFileStore(new MemoryFileStore())
 */
export interface FileStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/;
const checkKey = (key: string) => {
  if (!KEY_RE.test(key) || key.includes('..')) throw new AppError(400, 'BAD_FILE_KEY', 'Invalid file reference.');
};

export class LocalFileStore implements FileStore {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string): string {
    checkKey(key);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new AppError(400, 'BAD_FILE_KEY', 'Invalid file reference.'); // never leave the storage folder
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data, { mode: 0o600 });
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch (e: any) {
      if (e?.code === 'ENOENT') throw notFound('File');
      throw e;
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
  async exists(key: string) {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }
}

export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    checkKey(key);
    this.files.set(key, Buffer.from(data));
  }
  async get(key: string) {
    checkKey(key);
    const f = this.files.get(key);
    if (!f) throw notFound('File');
    return Buffer.from(f);
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async exists(key: string) {
    return this.files.has(key);
  }
}

let store: FileStore | null = null;
export const getFileStore = (): FileStore => (store ??= new LocalFileStore(env.FILE_STORAGE_DIR));
export const setFileStore = (s: FileStore | null): void => {
  store = s;
};
