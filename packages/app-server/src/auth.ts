import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { one, run } from './db.ts';
import type { Db } from './db.ts';
import { randomChars } from './ids.ts';

// Pseudonymous login: the participant gets a generated code (no e-mail stored); a password is optional.

const WORDS = ['caramelo', 'vira-lata', 'tapioca', 'pipoca', 'bolinha', 'fofura', 'biscoito', 'pamonha', 'brigadeiro', 'cuscuz'];

export function generateCode(): string {
  const word = WORDS[randomBytes(1)[0]! % WORDS.length];
  return `${word}-${randomChars(4)}-${randomChars(4)}`;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function newToken(db: Db, userId: number, now: number): string {
  const token = randomBytes(32).toString('hex');
  run(db, 'INSERT INTO auth_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)', sha256(token), userId, now);
  return token;
}

export function userIdForToken(db: Db, token: string): number | undefined {
  return one<{ user_id: number }>(db, 'SELECT user_id FROM auth_tokens WHERE token_hash = ?', sha256(token))?.user_id;
}

export function revokeToken(db: Db, token: string): void {
  run(db, 'DELETE FROM auth_tokens WHERE token_hash = ?', sha256(token));
}
