import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../../../../config/env.js';

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// Compared against when the email is unknown, so "no such user" and "wrong password" take the same time.
export const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

export interface TokenClaims {
  sub: string;
  role: string;
  tid: string | null;
  /** token version: must equal the user's current tokenVersion, else the session was revoked */
  tv: number;
}

export const signToken = (claims: TokenClaims) =>
  jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'], algorithm: 'HS256' });

export const verifyToken = (token: string): TokenClaims =>
  jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as unknown as TokenClaims;

/** Seconds until an access token expires (read from the token so it always matches ACCESS_TOKEN_TTL). */
export const tokenLifetimeSeconds = (token: string): number => {
  const d = jwt.decode(token) as { exp?: number; iat?: number } | null;
  return d?.exp && d.iat ? d.exp - d.iat : 900;
};

/** Short-lived token proving the password step passed; only good for /auth/mfa/verify. */
export const signMfaToken = (sub: string) => jwt.sign({ sub, typ: 'mfa' }, env.JWT_SECRET, { expiresIn: 300, algorithm: 'HS256' });
export const verifyMfaToken = (token: string): string => {
  const c = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as unknown as { sub: string; typ?: string };
  if (c.typ !== 'mfa') throw new Error('not an mfa token');
  return c.sub;
};
