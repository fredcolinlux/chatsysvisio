// Administration de ChatSysVisio : page réservée au réseau local (ADMIN_ALLOW_CIDR), compte créé en ligne de commande,
// mot de passe scrypt + TOTP obligatoire, session séparée courte, CSRF, journal de chaque action.
// Toute requête refusée reçoit la même réponse 404 que n'importe quelle page inexistante.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientIp, isHttps, sameOrigin, randomId, tokenEq, verifyPasswordAsync, hashPassword, RateLimiter, securityHeaders } from './security.mjs';
import { verifyTotp, hashBackup } from './totp.mjs';
import { maskIp } from './events.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin-ui');
const UI_FILES = { 'admin.js': 'text/javascript; charset=utf-8', 'admin.css': 'text/css; charset=utf-8' };
const COOKIE = '__Host-csv_admin', DEV_COOKIE = 'csv_admin';
const IDLE = 15 * 60e3, ABSOLUTE = 2 * 3600e3, ROTATE = 10 * 60e3, GRACE = 30e3, PRE_TTL = 15 * 60e3;
const LOCK_FAILS = 5, LOCK_MS = 15 * 60e3;
const DUMMY = hashPassword(randomId(12));

export function validAdminPath(p, publicDir) {
  if (!/^\/[A-Za-z0-9_-]{2,64}$/.test(p)) return false;
  const seg = p.slice(1).toLowerCase();
  if (['api', 'r', 'f', 'ws', 'room', 'chat', 'public', 'about', 'healthz', 'compte', 'source.tar.gz'].includes(seg)) return false;
  try { if (fs.existsSync(path.join(publicDir, seg))) return false; } catch {}
  return true;
}

export function buildBlockList(cidrs) {
  const bl = new net.BlockList();
  for (const c of cidrs) {
    const [addr, bits] = c.split('/'); const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!type) throw new Error(`ADMIN_ALLOW_CIDR : adresse invalide « ${c} »`);
    const max = type === 'ipv4' ? 32 : 128, n = bits === undefined ? max : parseInt(bits, 10);
    if (!(n >= 0 && n <= max)) throw new Error(`ADMIN_ALLOW_CIDR : préfixe invalide « ${c} »`);
    bl.addSubnet(addr, n, type);
  }
  return bl;
}
export function ipAllowed(bl, ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  if (net.isIPv4(ip)) return bl.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return bl.check(ip.replace(/%.*$/, ''), 'ipv6');
  return false;
}
const isLoopback = ra => /^(127\.|::1$|::ffff:127\.)/.test(ra || '');

export function createAdmin(ctx) {
  const { cfg, hub, store, reaper, accounts, admins, settings, events, stats, sessions, bans, json, err, readJson, notFound, log } = ctx;
  const base = cfg.adminPath;
  const allow = buildBlockList(cfg.adminAllowCidr);
  const asess = new Map(), grace = new Map();
  const ipFails = new Map(); // ip → { n, until }
  const loginLimit = new RateLimiter({ capacity: 10, perSec: 10 / 300 });
  const backupLimit = new RateLimiter({ capacity: 2, perSec: 1 / 600 });
  const statusFile = path.join(cfg.dataDir, 'system-status.json');
  const reqDir = path.join(cfg.dataDir, 'requests');
  const refusedSeen = new Map();

  function cookieOf(req) {
    const jar = {}; for (const part of String(req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) jar[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
    return isHttps(req, cfg) ? jar[COOKIE] : (jar[DEV_COOKIE] || jar[COOKIE]);
  }
  function setCookie(req, res, id) {
    // __Host- : Secure, Path=/, pas de Domain. Cookie de session (pas de Max-Age), SameSite=Strict.
    const c = isHttps(req, cfg) ? `${COOKIE}=${id}; Path=/; Secure; HttpOnly; SameSite=Strict`
      : `${DEV_COOKIE}=${id}; Path=${base}; HttpOnly; SameSite=Strict`;
    res.appendHeader ? res.appendHeader('Set-Cookie', c) : res.setHeader('Set-Cookie', c);
  }
  function clearCookie(req, res) {
    const c = isHttps(req, cfg) ? `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` : `${DEV_COOKIE}=; Path=${base}; HttpOnly; SameSite=Strict; Max-Age=0`;
    res.appendHeader ? res.appendHeader('Set-Cookie', c) : res.setHeader('Set-Cookie', c);
  }
  function sweep(now = Date.now()) {
    for (const [k, s] of asess) if (now - s.last > (s.user ? IDLE : PRE_TTL) || now - s.created > ABSOLUTE) asess.delete(k);
    for (const [k, g] of grace) if (g.until < now) grace.delete(k);
    for (const [k, f] of ipFails) if (f.until < now && now - f.t > LOCK_MS) ipFails.delete(k);
    for (const [k, t] of refusedSeen) if (now - t > 60e3) refusedSeen.delete(k);
    loginLimit.sweep(now); backupLimit.sweep(now);
  }
  const sweeper = setInterval(sweep, 60e3); sweeper.unref?.();

  function getAdminSession(req, res, create) {
    const now = Date.now(); let id = cookieOf(req), s = id && asess.get(id);
    if (!s && id && grace.has(id)) s = asess.get(grace.get(id).to);
    if (s && (now - s.last > (s.user ? IDLE : PRE_TTL) || now - s.created > ABSOLUTE)) { asess.delete(s.id); s = null; }
    if (s) {
      s.last = now;
      if (s.user && now - s.rotated > ROTATE) rotate(req, res, s);
      return s;
    }
    if (!create) return null;
    if (asess.size > 500) { const first = asess.keys().next().value; asess.delete(first); }
    s = { id: randomId(24), csrf: randomId(24), user: null, created: now, last: now, rotated: now };
    asess.set(s.id, s); setCookie(req, res, s.id); return s;
  }
  function rotate(req, res, s) {
    const old = s.id; asess.delete(old);
    s.id = randomId(24); s.rotated = Date.now(); asess.set(s.id, s);
    grace.set(old, { to: s.id, until: Date.now() + GRACE }); // requêtes déjà parties avec l'ancien cookie
    setCookie(req, res, s.id);
  }

  function refused(req, ip, why) {
    const k = ip + why;
    if (!refusedSeen.has(k)) { refusedSeen.set(k, Date.now()); events.add('refus', `Accès admin refusé (${why})`, { ip: maskIp(ip) }); }
  }

  // ---- interface (fichiers statiques de server/admin-ui) ----
  function serveUi(req, res, file, type) {
    securityHeaders(req, res, cfg);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    let buf; try { buf = fs.readFileSync(path.join(UI_DIR, file)); } catch { return notFound(req, res); }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  async function login(req, res, s, ip) {
    const now = Date.now();
    const f = ipFails.get(ip);
    if ((f && f.until > now) || !loginLimit.take(ip)) {
      events.add('blocage', 'Connexion admin bloquée (trop d\'essais)', { ip: maskIp(ip) });
      return err(res, 429, 'Trop d\'essais : réessaie dans 15 minutes.');
    }
    const b = await readJson(req);
    const user = String(b.user || '').toLowerCase().slice(0, 64);
    const rec = admins.get(user);
    const locked = rec && rec.lockUntil > now;
    const pwOk = await verifyPasswordAsync(String(b.password || ''), rec ? rec.hash : DUMMY);
    let factor = false, viaBackup = false;
    if (rec && pwOk && !locked) {
      const code = String(b.code || '').trim();
      const st = verifyTotp(rec.totp, code, { lastStep: rec.lastStep ?? -1 });
      if (st >= 0) { rec.lastStep = st; factor = true; }
      else if (/^[a-z0-9]{4}-?[a-z0-9]{4}$/i.test(code)) {
        const h = hashBackup(code), i = (rec.backup || []).indexOf(h);
        if (i >= 0) { rec.backup.splice(i, 1); factor = true; viaBackup = true; }
      }
    }
    if (!factor) {
      const ff = ipFails.get(ip) || { n: 0, until: 0, t: now }; ff.n++; ff.t = now;
      if (ff.n >= LOCK_FAILS) { ff.until = now + LOCK_MS; ff.n = 0; events.add('blocage', 'IP verrouillée 15 min (échecs de connexion admin)', { ip: maskIp(ip) }); }
      ipFails.set(ip, ff);
      if (rec) { rec.fails = (rec.fails || 0) + 1; if (rec.fails >= LOCK_FAILS) { rec.lockUntil = now + LOCK_MS; rec.fails = 0; events.add('blocage', `Compte admin « ${rec.user} » verrouillé 15 min`, {}); } admins.update(rec); }
      events.add('auth', 'Échec de connexion admin', { ip: maskIp(ip), user: user.slice(0, 32) });
      log('échec de connexion admin');
      return err(res, locked ? 429 : 401, locked ? 'Compte verrouillé temporairement : réessaie dans 15 minutes.' : 'Identifiant, mot de passe ou code incorrect.');
    }
    rec.fails = 0; rec.lockUntil = 0; rec.lastLogin = now; admins.update(rec); ipFails.delete(ip);
    // nouvel identifiant de session à la connexion (anti-fixation), nouveau jeton CSRF
    asess.delete(s.id); s.id = randomId(24); s.csrf = randomId(24); s.user = rec.user; s.created = now; s.rotated = now; s.last = now; s.ip = ip;
    asess.set(s.id, s); setCookie(req, res, s.id);
    events.add('admin', `Connexion admin « ${rec.user} »${viaBackup ? ' (code de secours)' : ''}`, { ip: maskIp(ip) });
    return json(res, 200, { ok: true, user: rec.user, csrf: s.csrf, backupLeft: rec.backup.length });
  }

  function readStatus() { try { return JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { return null; } }
  function requestFile(name) {
    fs.mkdirSync(reqDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(reqDir, name), String(Date.now()), { mode: 0o600 });
  }
  function storedRooms() {
    return [...store.rooms.values()].map(r => ({ id: r.id, slug: r.slug, name: r.name, isPublic: r.isPublic, hasPassword: !!r.passwordHash, e2ee: !!r.e2ee,
      created: r.created, active: r.active, people: hub.count(r), expiresIn: reaper?.remaining(r) ?? null, usageMb: Math.round(store.roomUsage(r.id) / 1048576 * 10) / 10 })).sort((a, b) => b.active - a.active);
  }

  async function apiCall(req, res, sub, s, ip) {
    const m = req.method;
    if (sub === 'me' && m === 'GET') return json(res, 200, { user: s.user, csrf: s.csrf, hasAdmin: admins.count() > 0, version: cfg.version, build: cfg.build, idleMin: IDLE / 60e3 });
    if (m === 'POST') {
      if (!sameOrigin(req, cfg) || !tokenEq(String(req.headers['x-csrf-token'] || ''), s.csrf)) return err(res, 403, 'Jeton CSRF invalide : recharge la page.');
    } else if (m !== 'GET') return err(res, 405, 'Méthode non autorisée');
    if (sub === 'login' && m === 'POST') return login(req, res, s, ip);
    if (!s.user) return err(res, 401, 'Session expirée : reconnecte-toi.');
    const act = (msg, data = {}) => events.add('admin', msg, { by: s.user, ...data });

    if (sub === 'logout' && m === 'POST') { asess.delete(s.id); clearCookie(req, res); act('Déconnexion admin'); return json(res, 200, { ok: true }); }
    if (sub === 'overview' && m === 'GET') return json(res, 200, { stats: stats.snapshot(), live: hub.roomsView(maskIp), counts: events.counts, accounts: accounts.users.size, pending: accounts.list().filter(u => u.status === 'pending').length });
    if (sub === 'rooms' && m === 'GET') return json(res, 200, { live: hub.roomsView(maskIp), stored: storedRooms(), bans: bans.list() });
    if (sub === 'rooms/close' && m === 'POST') {
      const b = await readJson(req); const r = [...store.rooms.values()].find(x => x.id === b.roomId); if (!r) return err(res, 404, 'Salon introuvable.');
      const n = hub.closeRoom(r.id); for (const ss of sessions.values()) ss.rooms.delete(r.id);
      if (b.delete) { store.deleteRoom(r); act(`Salon « ${r.name} » supprimé (${n} déconnecté·s)`, { room: r.slug }); }
      else act(`Salon « ${r.name} » fermé (${n} déconnecté·s)`, { room: r.slug });
      return json(res, 200, { ok: true, disconnected: n });
    }
    if (sub === 'kick' && m === 'POST') {
      const b = await readJson(req); const p = hub.peerById(b.roomId, b.peerId); if (!p) return err(res, 404, 'Participant introuvable.');
      const minutes = Math.min(7 * 1440, Math.max(0, parseInt(b.banMinutes, 10) || 0));
      const ss = [...sessions.values()].find(x => x.id === p.sessionId); ss?.rooms.delete(b.roomId);
      if (minutes) bans.add(b.roomId, { ip: p.ip, sessionId: p.sessionId, account: p.account, name: p.name }, minutes);
      hub.kick(b.roomId, p.id, minutes ? 'banned' : 'kicked');
      act(`${p.name} exclu${minutes ? ` et banni ${minutes} min` : ''}`, { room: p.rs?.room?.slug, ip: maskIp(p.ip) });
      return json(res, 200, { ok: true });
    }
    if (sub === 'bans/remove' && m === 'POST') { const b = await readJson(req); bans.remove(String(b.id || '')); act('Bannissement levé'); return json(res, 200, { ok: true }); }
    if (sub === 'settings' && m === 'GET') return json(res, 200, settings.view());
    if (sub === 'settings' && m === 'POST') {
      const b = await readJson(req);
      const { changed } = settings.apply(b);
      if (changed.length) act(`Réglages modifiés : ${changed.join(', ')}`);
      return json(res, 200, { ok: true, changed, settings: settings.view() });
    }
    if (sub === 'events' && m === 'GET') {
      const u = new URL(req.url, 'http://x');
      return json(res, 200, { events: events.query({ type: u.searchParams.get('type') || '', q: u.searchParams.get('q') || '', limit: +u.searchParams.get('limit') || 200 }), files: events.files() });
    }
    if (sub === 'system' && m === 'GET') {
      const st = readStatus();
      return json(res, 200, { version: cfg.version, build: cfg.build, node: process.version, status: st,
        pendingBackup: fs.existsSync(path.join(reqDir, 'backup')), pendingStatus: fs.existsSync(path.join(reqDir, 'status')) });
    }
    if (sub === 'backup' && m === 'POST') {
      if (!backupLimit.take('all')) return err(res, 429, 'Une sauvegarde a déjà été demandée récemment.');
      requestFile('backup'); act('Sauvegarde demandée'); return json(res, 202, { ok: true });
    }
    if (sub === 'status-refresh' && m === 'POST') { requestFile('status'); return json(res, 202, { ok: true }); }
    if (sub === 'accounts' && m === 'GET') return json(res, 200, { users: accounts.list().map(u => accounts.public(u)), invites: accounts.listInvites(), signupMode: cfg.signupMode });
    if (sub === 'accounts/action' && m === 'POST') {
      const b = await readJson(req); const u = accounts.get(String(b.id || '')); if (!u) return err(res, 404, 'Compte introuvable.');
      const name = u.name;
      switch (b.action) {
        case 'approve': case 'enable': accounts.setStatus(u.id, 'active'); act(`Compte « ${name} » ${b.action === 'approve' ? 'validé' : 'réactivé'}`); break;
        case 'disable': accounts.setStatus(u.id, 'disabled'); ctx.logoutAccount(u.id); act(`Compte « ${name} » désactivé`); break;
        case 'delete': accounts.remove(u.id); ctx.logoutAccount(u.id); act(`Compte « ${name} » supprimé`); break;
        case 'reset': { const pw = accounts.resetPassword(u.id); ctx.logoutAccount(u.id); act(`Mot de passe du compte « ${name} » réinitialisé`); return json(res, 200, { ok: true, password: pw }); }
        default: return err(res, 400, 'Action inconnue.');
      }
      return json(res, 200, { ok: true });
    }
    if (sub === 'invites/new' && m === 'POST') {
      const b = await readJson(req); const { code, invite } = accounts.newInvite(b);
      act(`Invitation créée (${invite.maxUses} utilisation·s, ${Math.round((invite.expires - invite.created) / 864e5)} j)`);
      return json(res, 201, { ok: true, code, invite: { ...invite, hash: undefined } });
    }
    if (sub === 'invites/revoke' && m === 'POST') { const b = await readJson(req); accounts.revokeInvite(String(b.id || '')); act('Invitation révoquée'); return json(res, 200, { ok: true }); }
    return err(res, 404, 'Introuvable');
  }

  // Renvoie true si la requête concernait l'administration (traitée ou refusée en 404).
  async function handle(req, res, url) {
    const p = url.pathname;
    if (!cfg.adminEnabled || !(p === base || p.startsWith(base + '/'))) return false;
    const ip = clientIp(req, cfg);
    if (!ipAllowed(allow, ip)) { refused(req, ip, 'hors réseau autorisé'); notFound(req, res); return true; }
    if (!isHttps(req, cfg) && !isLoopback(ip) && !cfg.adminAllowHttp) { refused(req, ip, 'HTTP en clair'); notFound(req, res); return true; }
    const rest = p.slice(base.length);
    if (rest === '') { securityHeaders(req, res, cfg); res.writeHead(302, { Location: base + '/', 'Cache-Control': 'no-store' }); res.end(); return true; }
    if (rest === '/') { getAdminSession(req, res, true); serveUi(req, res, 'admin.html', 'text/html; charset=utf-8'); return true; }
    const f = rest.slice(1);
    if (UI_FILES[f] && (req.method === 'GET' || req.method === 'HEAD')) { serveUi(req, res, f, UI_FILES[f]); return true; }
    if (rest.startsWith('/api/')) {
      securityHeaders(req, res, cfg); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      const s = getAdminSession(req, res, false);
      if (!s) { err(res, 401, 'Session expirée : recharge la page.'); return true; }
      await apiCall(req, res, rest.slice(5), s, ip); return true;
    }
    notFound(req, res); return true;
  }
  return { handle, close: () => clearInterval(sweeper), _sessions: asess };
}

// Bannissements temporaires par salon (en mémoire) : IP, session et compte.
export class Bans {
  constructor() { this.items = new Map(); }
  add(roomId, { ip, sessionId, account, name }, minutes, now = Date.now()) {
    const id = randomId(6);
    this.items.set(id, { id, roomId, ip, sessionId, account, name, until: now + minutes * 60e3 });
    return id;
  }
  remove(id) { this.items.delete(id); }
  removeRoom(roomId) { for (const [k, b] of this.items) if (b.roomId === roomId) this.items.delete(k); }
  isBanned(roomId, { ip, sessionId, account }, now = Date.now()) {
    for (const [k, b] of this.items) {
      if (b.until < now) { this.items.delete(k); continue; }
      if (b.roomId !== roomId) continue;
      if ((ip && b.ip === ip) || (sessionId && b.sessionId === sessionId) || (account && b.account === account)) return b;
    }
    return null;
  }
  list(now = Date.now()) { return [...this.items.values()].filter(b => b.until > now).map(b => ({ id: b.id, roomId: b.roomId, name: b.name, ip: maskIp(b.ip), until: b.until })); }
}
