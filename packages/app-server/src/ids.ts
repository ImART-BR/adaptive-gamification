import { randomBytes } from 'node:crypto';

// No 0/O/1/I/L, to avoid confusion when someone types a code they were given.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomChars(n: number): string {
  const bytes = randomBytes(n);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Public handle of a user: what other users and the API see instead of the internal id. */
export function randomHandle(): string {
  return `h${randomChars(8).toLowerCase()}`;
}

/** Short code to invite someone to a group or a study pair. */
export function randomInviteCode(): string {
  return randomChars(6);
}
