// TOTP (RFC 6238), comptes, réglages à chaud, journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, newSecret, newBackupCodes, hashBackup, otpauthUri } from '../../server/totp.mjs';
import { Accounts, Admins, nameKey, validNickname } from '../../server/accounts.mjs';
import { Settings } from '../../server/settings.mjs';
import { EventLog, maskIp } from '../../server/events.mjs';
import { buildBlockList, ipAllowed, validAdminPath, Bans } from '../../server/admin.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-u-'));

test('TOTP : vecteurs de la RFC 6238 (SHA-1) et base32', () => {
  const s = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(s, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(base32Decode(s).toString(), '12345678901234567890');
  for (const [t, code] of [[59, '94287082'], [1111111109, '07081804'], [1234567890, '89005924'], [2000000000, '69279037']])
    assert.equal(hotp(s, Math.floor(t / 30), 8), code);
});

test('TOTP : fenêtre ±30 s, anti-rejeu, format', () => {
  const s = newSecret(), t = Date.now();
  assert.equal(base32Decode(s).length, 20);
  const c = totp(s, t);
  const st = verifyTotp(s, c, { t });
  assert.ok(st > 0);
  assert.equal(verifyTotp(s, c, { t, lastStep: st }), -1, 'même code refusé une seconde fois');
  assert.ok(verifyTotp(s, totp(s, t - 30e3), { t }) > 0, 'dérive d\'un pas tolérée');
  assert.equal(verifyTotp(s, totp(s, t - 120e3), { t }), -1, 'code ancien refusé');
  assert.equal(verifyTotp(s, 'abcdef', { t }), -1);
  assert.equal(verifyTotp(s, '', { t }), -1);
  assert.match(otpauthUri({ secret: s, account: 'admin' }), /^otpauth:\/\/totp\/ChatSysVisio%3Aadmin\?secret=[A-Z2-7]+&issuer=ChatSysVisio/);
  const codes = newBackupCodes(); assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  assert.match(codes[0], /^[a-z0-9]{4}-[a-z0-9]{4}$/); assert.equal(hashBackup(codes[0]), hashBackup(codes[0].toUpperCase().replace('-', '')));
});

test('comptes : pseudo unique (accents, casse), mot de passe, verrouillage, statuts', async () => {
  const a = new Accounts(tmp());
  assert.equal(nameKey('Élise  Dupont'), 'elise dupont');
  assert.ok(validNickname('a').error); assert.ok(validNickname('<script>').error); assert.equal(validNickname(' Zoé ').name, 'Zoé');
  assert.throws(() => a.create({ name: 'Zoé', password: 'court' }), /10 caractères/);
  const u = a.create({ name: 'Zoé', password: 'un-mot-de-passe' });
  assert.throws(() => a.create({ name: 'ZOE', password: 'un-mot-de-passe' }), /déjà pris/);
  assert.ok(a.isReserved('zoe')); assert.ok(!a.isReserved('zoe', u.id)); assert.ok(!a.isReserved('Marc'));
  assert.ok(!u.hash.includes('un-mot-de-passe') && u.hash.startsWith('scrypt$'));
  assert.equal((await a.login('zoé', 'un-mot-de-passe')).user.id, u.id);
  assert.equal((await a.login('zoé', 'mauvais')).status, 401);
  assert.equal((await a.login('inconnu', 'x')).status, 401);
  for (let i = 0; i < 8; i++) await a.login('zoé', 'mauvais');
  assert.equal((await a.login('zoé', 'un-mot-de-passe')).status, 429, 'verrouillé après 8 échecs');
  a.setStatus(u.id, 'active'); // la levée de statut remet le compteur
  a.setStatus(u.id, 'disabled'); assert.equal((await a.login('zoé', 'un-mot-de-passe')).status, 403);
  const p = a.create({ name: 'Paul', password: 'un-mot-de-passe', status: 'pending' });
  assert.match((await a.login('paul', 'un-mot-de-passe')).error, /validation/);
  const pw = a.resetPassword(p.id); a.setStatus(p.id, 'active'); assert.ok((await a.login('paul', pw)).user);
  // persistance atomique, fichier 0600
  const b = new Accounts(path.dirname(a.file)); assert.equal(b.users.size, 2);
  assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(a.file, 'utf8').includes('un-mot-de-passe'));
});

test('invitations : code haché, usage limité, expiration', () => {
  const a = new Accounts(tmp());
  const { code, invite } = a.newInvite({ days: 1, uses: 2 });
  assert.ok(!JSON.stringify(a.listInvites()).includes(code) && !fs.readFileSync(a.file, 'utf8').includes(code));
  assert.ok(a.useInvite(code)); assert.ok(a.useInvite(code)); assert.ok(!a.useInvite(code));
  const c2 = a.newInvite({ days: 1 }).code; assert.ok(!a.useInvite(c2, Date.now() + 2 * 864e5));
  assert.ok(a.revokeInvite(invite.id));
});

test('administrateurs : pas de compte par défaut, mot de passe de 12 caractères min., rechargement à chaud', () => {
  const dir = tmp(), ad = new Admins(dir);
  assert.equal(ad.count(), 0);
  assert.throws(() => ad.upsert({ user: 'admin', password: 'court', totpSecret: newSecret(), backupCodes: [] }), /12 caractères/);
  ad.upsert({ user: 'Admin', password: 'mot-de-passe-solide', totpSecret: newSecret(), backupCodes: newBackupCodes() });
  assert.equal(fs.statSync(path.join(dir, 'admin.json')).mode & 0o777, 0o600);
  const other = new Admins(dir); assert.ok(other.get('admin'));
  assert.ok(!fs.readFileSync(path.join(dir, 'admin.json'), 'utf8').includes('mot-de-passe-solide'));
});

test('réglages à chaud : validation, persistance 0600, sans toucher au .env', () => {
  const dir = tmp(), cfg = { allowAnonCreate: true, createPer10Min: 10, maxParticipants: 25, roomQuotaMb: 200, uploadMaxMb: 10, maxRooms: 5000, createPasswordHash: '' };
  const s = new Settings(dir, cfg); let seen = null; s.onChange(c => { seen = c; });
  assert.equal(cfg.signupMode, 'closed');
  assert.throws(() => s.apply({ maxParticipants: 26 }), /entre 2 et 25/);
  assert.throws(() => s.apply({ signupMode: 'tous' }), /invalide/);
  s.apply({ maxParticipants: 12, allowAnonCreate: false, signupMode: 'invite', createCode: 'code-secret', inconnu: 1 });
  assert.equal(cfg.maxParticipants, 12); assert.equal(cfg.allowAnonCreate, false); assert.match(cfg.createPasswordHash, /^scrypt\$/);
  assert.deepEqual(seen.sort(), ['allowAnonCreate', 'createCode', 'maxParticipants', 'signupMode']);
  const raw = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  assert.ok(!raw.includes('code-secret') && !raw.includes('inconnu'));
  assert.equal(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777, 0o600);
  assert.equal(s.view().hasCreateCode, true); assert.ok(!JSON.stringify(s.view()).includes('scrypt'));
  const cfg2 = { ...cfg, maxParticipants: 25 }; new Settings(dir, cfg2); assert.equal(cfg2.maxParticipants, 12, 'rechargé au démarrage');
});

test('journal : filtre, rotation, aucun secret', () => {
  const dir = tmp(), ev = new EventLog(dir, { maxBytes: 2000, keep: 2 });
  for (let i = 0; i < 60; i++) ev.add(i % 2 ? 'blocage' : 'auth', `événement ${i}`, { ip: '203.0.113.' + i, password: 'xx', code: '123456', csrf: 'tok' });
  assert.equal(ev.query({ type: 'auth' }).length, 30);
  assert.equal(ev.query({ q: 'événement 59' }).length, 1);
  const files = fs.readdirSync(path.join(dir, 'logs')); assert.ok(files.includes('events.jsonl.1') && files.includes('events.jsonl.2') && !files.includes('events.jsonl.3'));
  const all = files.map(f => fs.readFileSync(path.join(dir, 'logs', f), 'utf8')).join('');
  assert.ok(!all.includes('"password"') && !all.includes('123456') && !all.includes('"csrf"'));
  assert.equal(maskIp('203.0.113.54'), '203.0.113.••'); assert.equal(maskIp('2001:db8:1:2::5'), '2001:db8:1:…');
});

test('administration : réseaux autorisés et chemin', () => {
  const bl = buildBlockList(['127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7', 'fe80::/10']);
  for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '172.20.0.1', '192.168.7.12', '::ffff:192.168.1.1', 'fd12::1']) assert.ok(ipAllowed(bl, ip), ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1', '', 'inconnu', '192.0.2.1, 8.8.8.8']) assert.ok(!ipAllowed(bl, ip), ip);
  assert.throws(() => buildBlockList(['pas-une-ip/8']));
  const pub = path.resolve('public');
  assert.ok(validAdminPath('/admin', pub)); assert.ok(validAdminPath('/gestion-42', pub));
  for (const p of ['/api', '/r', '/js', '/css', '/vendor', '/compte', 'admin', '/a', '/admin/x', '/ad min']) assert.ok(!validAdminPath(p, pub), p);
  const b = new Bans(); b.add('room1', { ip: '1.2.3.4', sessionId: 's1' }, 10);
  assert.ok(b.isBanned('room1', { ip: '1.2.3.4' })); assert.ok(b.isBanned('room1', { sessionId: 's1', ip: '9.9.9.9' }));
  assert.ok(!b.isBanned('room2', { ip: '1.2.3.4' })); assert.ok(!b.isBanned('room1', { ip: '1.2.3.4' }, Date.now() + 11 * 60e3));
});
