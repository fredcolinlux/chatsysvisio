// En-têtes de sécurité (objectif WebGuardian A+ 100/100), CSRF, limitation de débit, mots de passe scrypt.
import crypto from 'node:crypto';

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;

export function isHttps(req, cfg) {
  if (req.socket.encrypted) return true;
  if (isTrustedProxy(req, cfg)) {
    const p = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (p === 'https') return true;
  }
  return cfg.publicUrl.startsWith('https://') && !isLocalHost(req);
}
function isLocalHost(req) { return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || ''); }

export function isTrustedProxy(req, cfg) {
  const ra = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return cfg.trustedProxies.includes(ra);
}

export function clientIp(req, cfg) {
  const ra = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (cfg.trustedProxies.includes(ra)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1].replace(/^::ffff:/, '');
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
  }
  return ra || 'inconnu';
}

export function safeHost(req, cfg) {
  if (cfg.publicUrl) { try { return new URL(cfg.publicUrl).host; } catch {} }
  const h = String(req.headers.host || '');
  return HOST_RE.test(h) ? h : '';
}

export function csp(req, cfg, { wasm = false } = {}) {
  const https = isHttps(req, cfg);
  const host = safeHost(req, cfg);
  const ws = host ? ` ${https ? 'wss' : 'ws'}://${host}` : '';
  return [
    "default-src 'self'",
    `script-src 'self'${wasm ? " 'wasm-unsafe-eval'" : ''}`,
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    `connect-src 'self'${ws}`,
    "font-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export const PERMISSIONS_POLICY = [
  'camera=(self)', 'microphone=(self)', 'display-capture=(self)', 'fullscreen=(self)', 'picture-in-picture=(self)',
  'autoplay=(self)', 'screen-wake-lock=(self)', 'geolocation=()', 'payment=()', 'usb=()', 'serial=()',
  'midi=()', 'magnetometer=()', 'gyroscope=()', 'accelerometer=()', 'browsing-topics=()',
].join(', ');

export function securityHeaders(req, res, cfg, opts = {}) {
  res.setHeader('Content-Security-Policy', csp(req, cfg, opts));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (isHttps(req, cfg) || cfg.forceHsts) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.removeHeader('X-Powered-By');
}

// --- Mots de passe (scrypt, sel aléatoire, comparaison à temps constant) ---
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(pw).normalize('NFKC'), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  try {
    const h = crypto.scryptSync(String(pw ?? '').normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}

// Variante asynchrone (pool de threads) : ne bloque pas la boucle d'événements pendant le calcul scrypt.
export async function verifyPasswordAsync(pw, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  try {
    const h = await new Promise((resolve, reject) => crypto.scrypt(String(pw ?? '').normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
      { N: +N, r: +r, p: +p }, (e, k) => e ? reject(e) : resolve(k)));
    return crypto.timingSafeEqual(h, expected);
  } catch { return false; }
}

// --- Limitation de débit (seau à jetons par clé) ---
export class RateLimiter {
  constructor({ capacity, perSec }) { this.capacity = capacity; this.perSec = perSec; this.b = new Map(); }
  take(key, n = 1, now = Date.now()) {
    let e = this.b.get(key);
    if (!e) { e = { tokens: this.capacity, t: now }; this.b.set(key, e); }
    e.tokens = Math.min(this.capacity, e.tokens + (now - e.t) / 1000 * this.perSec); e.t = now;
    if (e.tokens >= n) { e.tokens -= n; return true; }
    return false;
  }
  retryAfter(key) { const e = this.b.get(key); if (!e) return 0; return Math.ceil((1 - e.tokens) / this.perSec); }
  sweep(now = Date.now()) { for (const [k, e] of this.b) if (now - e.t > 3600e3) this.b.delete(k); }
}

export function sameOrigin(req, cfg) {
  const o = req.headers.origin;
  if (!o) return req.headers['sec-fetch-site'] ? req.headers['sec-fetch-site'] === 'same-origin' : true;
  const host = safeHost(req, cfg);
  let oh; try { oh = new URL(o).host; } catch { return false; }
  if (oh === host) return true;
  // Accès local (tunnel SSH vers 127.0.0.1) : l'origine est http://localhost:PORT, pas l'adresse publique.
  // Accepté seulement si la connexion TCP vient elle-même de la boucle locale et que l'origine correspond au Host.
  const ra = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const loop = /^(127\.|::1$)/.test(ra) && !req.headers['x-forwarded-for'];
  return loop && isLocalHost(req) && oh === String(req.headers.host || '').toLowerCase();
}

export function randomId(bytes = 16) { return crypto.randomBytes(bytes).toString('base64url'); }
export function tokenEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
