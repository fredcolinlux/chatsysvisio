// Administration et comptes de bout en bout (HTTP + WebSocket, sans navigateur).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../../server/app.mjs';
import { loadConfig } from '../../server/config.mjs';
import { Admins } from '../../server/accounts.mjs';
import { newSecret, newBackupCodes, totp } from '../../server/totp.mjs';

let app, base, origin, dir, secret, codes;
const PW = 'phrase-de-passe-admin';
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-adm-'));
  secret = newSecret(); codes = newBackupCodes();
  new Admins(dir).upsert({ user: 'admin', password: PW, totpSecret: secret, backupCodes: codes });
  const cfg = loadConfig({ dataDir: dir, publicUrl: '', quiet: true, maxParticipants: 25 });
  app = createApp(cfg);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  origin = base = `http://127.0.0.1:${app.server.address().port}`;
});
const sockets = [];
after(() => { for (const w of sockets) w.terminate(); app.server.closeAllConnections?.(); app.server.close(); });

class Client {
  constructor(xff) { this.jar = {}; this.csrf = ''; this.xff = xff; }
  get cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body, headers = {} } = {}) {
    const h = { ...(this.xff ? { 'x-forwarded-proto': 'https' } : {}), ...headers }; if (this.cookie) h.cookie = this.cookie; if (this.xff) h['x-forwarded-for'] = this.xff;
    if (method !== 'GET') { h.origin ??= origin; if (this.csrf) h['x-csrf-token'] ??= this.csrf; }
    if (body !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); const v = kv.slice(i + 1); if (v) this.jar[kv.slice(0, i)] = v; else delete this.jar[kv.slice(0, i)]; }
    return r;
  }
  async init() { this.csrf = (await (await this.req('/api/session')).json()).csrf; return this; }
  async adminInit() { await this.req('/admin/'); this.csrf = (await (await this.req('/admin/api/me')).json()).csrf; return this; }
  async adminLogin(code = totp(secret)) {
    await this.adminInit();
    const r = await this.req('/admin/api/login', { method: 'POST', body: { user: 'admin', password: PW, code } });
    const j = await r.json(); if (j.csrf) this.csrf = j.csrf; return { status: r.status, j };
  }
  ws(slug, name = 'x') {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${slug}`, { headers: { cookie: this.cookie, origin } });
      sockets.push(ws); ws.msgs = []; ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d)); });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name, caps: { venc: ['vp8'], vdec: ['vp8'], aenc: ['opus'], adec: ['opus'] }, state: {} })));
      ws.on('message', (d, bin) => { if (!bin && JSON.parse(d).t === 'welcome') resolve({ ws, ok: true }); });
      ws.on('close', code => { ws.closeCode = code; resolve({ ws, ok: false, code }); });
      ws.on('unexpected-response', (_q, res) => resolve({ ws, ok: false, status: res.statusCode }));
      ws.on('error', () => {});
    });
  }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(20); } return false; };

// Le serveur de test est en HTTP : on simule HTTPS derrière le proxy de confiance (127.0.0.1) quand il le faut.
test('administration invisible hors du réseau autorisé (404 identique), en-têtes stricts sinon', async () => {
  const out = new Client('203.0.113.9');
  for (const p of ['/admin/', '/admin', '/admin/api/me', '/admin/admin.js']) {
    const r = await out.req(p); assert.equal(r.status, 404, p);
  }
  const notfound = await (await fetch(base + '/nexiste-pas')).text();
  assert.equal(await (await out.req('/admin/')).text(), notfound, 'même page que n\'importe quel 404');
  // une chaîne X-Forwarded-For forgée par le client : c'est l'adresse vue par le proxy (la dernière) qui compte
  assert.equal((await new Client('10.0.0.5, 203.0.113.9').req('/admin/')).status, 404);
  const lan = new Client('10.0.0.20');
  const r = await lan.req('/admin/', { headers: { 'x-forwarded-proto': 'http' } }); assert.equal(r.status, 404, 'HTTP en clair refusé hors boucle locale');
  const r2 = await lan.req('/admin/', { headers: { 'x-forwarded-proto': 'https' } }); assert.equal(r2.status, 200);
  const csp = r2.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/); assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(r2.headers.get('x-frame-options'), 'DENY'); assert.match(r2.headers.get('x-robots-tag'), /noindex/);
  assert.match(r2.headers.get('set-cookie'), /^__Host-csv_admin=[^;]+; Path=\/; .*Secure.*HttpOnly|^__Host-csv_admin=.*HttpOnly.*Secure/);
  assert.match(r2.headers.get('set-cookie'), /SameSite=Strict/);
  const html = await r2.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i); assert.doesNotMatch(html, /\sstyle=/i);
  // ADMIN_PATH invalide refusé au démarrage
  assert.throws(() => createApp(loadConfig({ dataDir: dir, quiet: true, adminPath: '/api' })), /ADMIN_PATH/);
});

test('connexion admin : mot de passe + TOTP obligatoires, CSRF, anti-rejeu, code de secours', async () => {
  const c = await new Client().adminInit();
  assert.equal((await c.req('/admin/api/overview')).status, 401);
  assert.equal((await c.req('/admin/api/login', { method: 'POST', body: { user: 'admin', password: PW, code: totp(secret) }, headers: { 'x-csrf-token': 'faux' } })).status, 403);
  assert.equal((await c.req('/admin/api/login', { method: 'POST', body: { user: 'admin', password: PW, code: '000000' } })).status, 401, 'sans bon code TOTP');
  assert.equal((await c.req('/admin/api/login', { method: 'POST', body: { user: 'admin', password: 'mauvais', code: totp(secret) } })).status, 401);
  const before = c.jar.csv_admin;
  const ok = await c.adminLogin(); assert.equal(ok.status, 200); assert.equal(ok.j.user, 'admin');
  assert.notEqual(c.jar.csv_admin, before, 'identifiant de session renouvelé');
  assert.equal((await c.req('/admin/api/overview')).status, 200);
  assert.equal((await new Client().adminLogin()).status, 401, 'le même code TOTP ne sert qu\'une fois');
  const b = await new Client().adminLogin(codes[0]); assert.equal(b.status, 200); assert.equal(b.j.backupLeft, 9);
  assert.equal((await new Client().adminLogin(codes[0])).status, 401, 'code de secours à usage unique');
  // action POST sans jeton CSRF refusée
  assert.equal((await c.req('/admin/api/backup', { method: 'POST', body: {}, headers: { 'x-csrf-token': '' } })).status, 403);
  assert.equal((await c.req('/admin/api/logout', { method: 'POST', body: {} })).status, 200);
  assert.equal((await c.req('/admin/api/overview')).status, 401);
  // aucun secret dans le fichier admin ni dans le journal
  const adm = fs.readFileSync(path.join(dir, 'admin.json'), 'utf8'); assert.ok(!adm.includes(PW) && !adm.includes(codes[1]));
  const log = fs.readFileSync(path.join(dir, 'logs', 'events.jsonl'), 'utf8');
  assert.ok(!log.includes(PW) && !log.includes(secret) && !log.includes(codes[0]));
  assert.match(log, /Connexion admin/); assert.match(log, /Échec de connexion admin/);
});

test('verrouillage après échecs répétés (IP)', async () => {
  const c = await new Client('10.9.9.9').adminInit();
  const st = [];
  for (let i = 0; i < 6; i++) st.push((await c.req('/admin/api/login', { method: 'POST', body: { user: 'personne', password: 'x', code: '123456' } })).status);
  assert.deepEqual(st.slice(0, 5), [401, 401, 401, 401, 401]); assert.equal(st[5], 429);
});

test('réglages, salons, exclusion avec bannissement, fermeture de salon', async () => {
  const a = new Client(); assert.equal((await a.adminLogin(codes[2])).status, 200);
  assert.equal((await a.req('/admin/api/settings', { method: 'POST', body: { maxParticipants: 30 } })).status, 400);
  const s = await a.req('/admin/api/settings', { method: 'POST', body: { createPer10Min: 50, maxParticipants: 20 } });
  assert.equal(s.status, 200); assert.equal(app.cfg.maxParticipants, 20);
  assert.ok(!fs.existsSync(path.join(dir, '.env')));

  const owner = await new Client().init();
  const { slug } = await (await owner.req('/api/rooms', { method: 'POST', body: { name: 'Admin test' } })).json();
  const g = await new Client().init();
  assert.equal((await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Gêneur' } })).status, 200);
  const w = await g.ws(slug, 'Gêneur'); assert.ok(w.ok);
  const rooms = await (await a.req('/admin/api/rooms')).json();
  const live = rooms.live.find(r => r.slug === slug); assert.ok(live);
  const peer = live.people.find(p => p.name === 'Gêneur'); assert.ok(peer);
  assert.match(peer.ip, /••|…/, 'IP masquée'); assert.ok(!JSON.stringify(rooms).includes('sessionId'));
  assert.equal((await a.req('/admin/api/kick', { method: 'POST', body: { roomId: live.id, peerId: peer.id, banMinutes: 10 } })).status, 200);
  assert.ok(await waitFor(() => w.ws.closeCode === 4004));
  assert.equal((await g.ws(slug)).status, 403, 'plus de WebSocket sans repasser par /join');
  const j = await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Gêneur' } });
  assert.equal(j.status, 403); assert.equal((await j.json()).code, 'banned');
  const bans = (await (await a.req('/admin/api/rooms')).json()).bans; assert.equal(bans.length, 1);
  await a.req('/admin/api/bans/remove', { method: 'POST', body: { id: bans[0].id } });
  assert.equal((await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Gêneur' } })).status, 200);
  const w2 = await g.ws(slug, 'Gêneur'); assert.ok(w2.ok);
  assert.equal((await a.req('/admin/api/rooms/close', { method: 'POST', body: { roomId: live.id } })).status, 200);
  assert.ok(await waitFor(() => w2.ws.closeCode === 4005));
  const ev = await (await a.req('/admin/api/events?type=admin')).json();
  assert.ok(ev.events.some(e => /exclu et banni 10 min/.test(e.msg))); assert.ok(ev.events.some(e => /fermé/.test(e.msg)));
  assert.equal((await a.req('/admin/api/backup', { method: 'POST', body: {} })).status, 202);
  assert.ok(fs.existsSync(path.join(dir, 'requests', 'backup')));
  const sys = await (await a.req('/admin/api/system')).json(); assert.equal(sys.pendingBackup, true); assert.ok('version' in sys && 'build' in sys);
  const ov = await (await a.req('/admin/api/overview')).json(); assert.ok(ov.stats.series); assert.ok(ov.stats.uptime >= 0);
  await a.req('/admin/api/settings', { method: 'POST', body: { maxParticipants: 25 } });
});

test('comptes : inscriptions selon le mode, pseudo réservé, création réservée aux comptes, validation', async () => {
  const a = new Client(); assert.equal((await a.adminLogin(codes[3])).status, 200);
  const u = await new Client().init();
  assert.equal((await u.req('/api/account/signup', { method: 'POST', body: { name: 'Claire', password: 'mot-de-passe-1' } })).status, 403, 'fermé par défaut');
  await a.req('/admin/api/settings', { method: 'POST', body: { signupMode: 'open' } });
  const r = await u.req('/api/account/signup', { method: 'POST', body: { name: 'Claire', password: 'mot-de-passe-1' } });
  assert.equal(r.status, 201); u.csrf = (await r.json()).csrf;
  const ses = await (await u.req('/api/session')).json(); assert.equal(ses.account.name, 'Claire');

  // pseudo réservé : un invité ne peut pas le prendre, le compte si (nom imposé)
  const owner = await new Client().init();
  const { slug } = await (await owner.req('/api/rooms', { method: 'POST', body: { name: 'Pseudo' } })).json();
  const g = await new Client().init();
  assert.equal((await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'claire' } })).status, 409);
  assert.equal((await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Invité' } })).status, 200);
  assert.equal((await u.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'autre' } })).status, 200);
  const wu = await u.ws(slug, 'autre'); const wg = await g.ws(slug, 'Claire');
  assert.ok(wu.ok && wg.ok);
  assert.equal(wu.ws.msgs.find(m => m.t === 'welcome').you?.name ?? 'Claire', 'Claire');
  assert.ok(await waitFor(() => wg.ws.msgs.some(m => m.t === 'error' && m.code === 'reserved')), 'renommage en pseudo réservé refusé');

  // réactions par personne et non par pseudo
  wu.ws.send(JSON.stringify({ t: 'chat', text: 'bonjour' }));
  await waitFor(() => wg.ws.msgs.some(m => m.t === 'chat'));
  const id = wg.ws.msgs.find(m => m.t === 'chat').msg.id;
  wu.ws.send(JSON.stringify({ t: 'msgreact', id, emoji: '👍' }));
  wg.ws.send(JSON.stringify({ t: 'msgreact', id, emoji: '👍' }));
  assert.ok(await waitFor(() => wu.ws.msgs.filter(m => m.t === 'msgreact').some(m => (m.reactions?.['👍'] || []).length === 2)));
  const last = wu.ws.msgs.filter(m => m.t === 'msgreact').at(-1); assert.ok(!JSON.stringify(last).includes('u:') && !JSON.stringify(last).includes('g:'));
  wu.ws.close(); wg.ws.close();

  // création de salons réservée aux comptes
  await a.req('/admin/api/settings', { method: 'POST', body: { accountsOnlyCreate: true } });
  const cr = await g.req('/api/rooms', { method: 'POST', body: { name: 'Interdit' } });
  assert.equal(cr.status, 403); assert.equal((await cr.json()).code, 'account');
  assert.equal((await u.req('/api/rooms', { method: 'POST', body: { name: 'Permis' } })).status, 201);
  await a.req('/admin/api/settings', { method: 'POST', body: { accountsOnlyCreate: false } });

  // mode validation : compte en attente, validé par l'admin
  await a.req('/admin/api/settings', { method: 'POST', body: { signupMode: 'approval' } });
  const p = await new Client().init();
  const pr = await p.req('/api/account/signup', { method: 'POST', body: { name: 'Dominique', password: 'mot-de-passe-2' } });
  assert.equal(pr.status, 201); assert.equal((await pr.json()).pending, true);
  assert.equal((await p.req('/api/account/login', { method: 'POST', body: { name: 'Dominique', password: 'mot-de-passe-2' } })).status, 403);
  const list = await (await a.req('/admin/api/accounts')).json();
  const dom = list.users.find(x => x.name === 'Dominique'); assert.equal(dom.status, 'pending'); assert.ok(!('hash' in dom));
  await a.req('/admin/api/accounts/action', { method: 'POST', body: { id: dom.id, action: 'approve' } });
  assert.equal((await p.req('/api/account/login', { method: 'POST', body: { name: 'Dominique', password: 'mot-de-passe-2' } })).status, 200);

  // mode invitation
  await a.req('/admin/api/settings', { method: 'POST', body: { signupMode: 'invite' } });
  const inv = await (await a.req('/admin/api/invites/new', { method: 'POST', body: { days: 1, uses: 1 } })).json();
  const q = await new Client().init();
  assert.equal((await q.req('/api/account/signup', { method: 'POST', body: { name: 'Sacha', password: 'mot-de-passe-3', invite: 'faux-code' } })).status, 403);
  assert.equal((await q.req('/api/account/signup', { method: 'POST', body: { name: 'Sacha', password: 'mot-de-passe-3', invite: inv.code } })).status, 201);
  // désactivation : déconnexion immédiate
  const cam = list.users.find(x => x.name === 'Claire');
  await a.req('/admin/api/accounts/action', { method: 'POST', body: { id: cam.id, action: 'disable' } });
  assert.equal((await (await u.req('/api/session')).json()).account, null);
  // invités interdits
  await a.req('/admin/api/settings', { method: 'POST', body: { guestJoin: false, signupMode: 'closed' } });
  const gj = await new Client().init(); const jr = await gj.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Nouveau' } });
  assert.equal(jr.status, 403); assert.equal((await jr.json()).code, 'account');
  await a.req('/admin/api/settings', { method: 'POST', body: { guestJoin: true } });
  const raw = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'); assert.ok(!raw.includes('mot-de-passe-') && !raw.includes(inv.code));
});
