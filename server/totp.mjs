// TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 chiffres) et codes de secours. Aucune dépendance.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const s = String(str).toUpperCase().replace(/[\s=-]/g, ''); let bits = 0, val = 0; const out = [];
  for (const c of s) { const i = B32.indexOf(c); if (i < 0) throw new Error('base32 invalide'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export function newSecret() { return base32Encode(crypto.randomBytes(20)); } // 160 bits, comme recommandé par la RFC 4226

export function hotp(secret, counter, digits = 6) {
  const key = base32Decode(secret), msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 10 ** digits).padStart(digits, '0');
}
export const step = (t = Date.now(), period = 30) => Math.floor(t / 1000 / period);
export function totp(secret, t = Date.now()) { return hotp(secret, step(t)); }

// Vérifie un code (fenêtre ±1 pas pour la dérive d'horloge) ; refuse un pas déjà utilisé (anti-rejeu).
// Renvoie le pas accepté, ou -1.
export function verifyTotp(secret, code, { t = Date.now(), lastStep = -1, window = 1 } = {}) {
  code = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code) || !secret) return -1;
  const s = step(t); let ok = -1;
  for (let i = -window; i <= window; i++) {
    const c = hotp(secret, s + i);
    if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code)) && s + i > lastStep) ok = s + i;
  }
  return ok;
}

export function otpauthUri({ secret, account, issuer = 'ChatSysVisio' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Codes de secours : 10 codes à usage unique (format xxxx-xxxx), stockés hachés (SHA-256 : ~40 bits d'aléa chacun,
// tentatives bornées par le verrouillage de connexion).
const BA = 'abcdefghjkmnpqrstuvwxyz23456789';
export function newBackupCodes(n = 10) {
  return Array.from({ length: n }, () => { const r = crypto.randomBytes(8); const s = [...r].map(b => BA[b % BA.length]).join(''); return s.slice(0, 4) + '-' + s.slice(4); });
}
export const hashBackup = c => crypto.createHash('sha256').update('cc-backup:' + String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('base64');
