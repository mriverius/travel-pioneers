/**
 * Cryptographically-random one-time password for admin-created users.
 *
 * Produces a string that is guaranteed to satisfy the backend password
 * policy (≥1 lower, ≥1 upper, ≥1 digit, ≥1 special, length ≥ 8). Ambiguous
 * characters (0/O/1/I/l) are excluded so it's safer to paste / dictate.
 */
import crypto from "node:crypto";

const LOWER = "abcdefghijkmnpqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGITS = "23456789";
const SPECIALS = "!@#$%&*?";
const ALL = LOWER + UPPER + DIGITS + SPECIALS;

function pickFrom(chars: string, count: number): string {
  if (count <= 0) return "";
  const bytes = crypto.randomBytes(count);
  let out = "";
  for (let i = 0; i < count; i += 1) {
    // `readUInt8` is guaranteed to return a number; `charAt` returns "" for
    // out-of-range indices which we never hit because of the modulo.
    const byte = bytes.readUInt8(i);
    out += chars.charAt(byte % chars.length);
  }
  return out;
}

function shuffle(input: string): string {
  const chars = input.split("");
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }
  return chars.join("");
}

export function generateTempPassword(length = 14): string {
  const len = Math.max(length, 8);
  const required =
    pickFrom(LOWER, 1) +
    pickFrom(UPPER, 1) +
    pickFrom(DIGITS, 1) +
    pickFrom(SPECIALS, 1);
  const rest = pickFrom(ALL, len - required.length);
  return shuffle(required + rest);
}
