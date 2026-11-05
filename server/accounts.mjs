// Comptes (facultatifs) et compte administrateur : fichiers JSON écrits de façon atomique (mode 0600) dans DATA_DIR,
// donc inclus dans les sauvegardes. Pas de dépendance native.
//   accounts.json : { users: [...], invites: [...] }      admin.json : { admins: [...] }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword, verifyPasswordAsync, randomId } from './security.mjs';
import { hashBackup } from './totp.mjs';

export function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function readJson(file, def) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; } }

// Clé de comparaison d'un pseudo : sans accents, minuscules, espaces simplifiés (« Élise » = « elise »).
export function nameKey(n) {
  return String(n || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
export function validNickname(n) {
  n = String(n || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 32) return { error: 'Pseudo : 2 à 32 caractères.' };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._'-]*$/u.test(n)) return { error: 'Pseudo : lettres, chiffres, espace, point, tiret, apostrophe.' };
  if (nameKey(n).length < 2) return { error: 'Pseudo trop court.' };
  return { name: n };
}
export function checkPassword(pw, min = 10) {
  pw = String(pw ?? '');
  if (pw.length < min) return `Mot de passe : ${min} caractères minimum.`;
  if (pw.length > 200) return 'Mot de passe trop long.';
  return '';
}
// Hachage « leurre » : même coût scrypt quand le compte n'existe pas (pas d'énumération par le temps de réponse).
const DUMMY = hashPassword(randomId(12));

export class Accounts {
  constructor(dir) {
    this.file = path.join(dir, 'accounts.json');
    const d = readJson(this.file, {});
    this.users = new Map((d.users || []).map(u => [u.id, u]));
    this.invites = d.invites || [];
  }
  save() { atomicWrite(this.file, JSON.stringify({ users: [...this.users.values()], invites: this.invites }, null, 1)); }
  list() { return [...this.users.values()].sort((a, b) => a.created - b.created); }
  get(id) { return this.users.get(id) || null; }
  byName(name) { const k = nameKey(name); for (const u of this.users.values()) if (u.key === k) return u; return null; }
  // Pseudo réservé par un compte (actif ou en attente) — un invité ne peut pas le prendre.
  isReserved(name, exceptId = null) { const u = this.byName(name); return !!u && u.id !== exceptId && u.status !== 'deleted'; }
  public(u) { return u && { id: u.id, name: u.name, status: u.status, created: u.created, lastLogin: u.lastLogin || 0 }; }

  create({ name, password, status = 'active' }) {
    const v = validNickname(name); if (v.error) throw Object.assign(new Error(v.error), { status: 400 });
    const e = checkPassword(password); if (e) throw Object.assign(new Error(e), { status: 400 });
    if (this.byName(v.name)) throw Object.assign(new Error('Ce pseudo est déjà pris.'), { status: 409 });
    if (this.users.size >= 5000) throw Object.assign(new Error('Nombre maximal de comptes atteint.'), { status: 503 });
    const u = { id: randomId(9), name: v.name, key: nameKey(v.name), hash: hashPassword(password), status, created: Date.now(), lastLogin: 0, fails: 0, lockUntil: 0 };
    this.users.set(u.id, u); this.save(); return u;
  }
  // Connexion : renvoie { user } ou { error, status }. Verrouillage temporaire après 8 échecs.
  async login(name, password, now = Date.now()) {
    const u = this.byName(name);
    if (u && u.lockUntil > now) { await verifyPasswordAsync(password, DUMMY); return { error: 'Compte temporairement verrouillé (trop d\'essais). Réessaie dans 15 minutes.', status: 429 }; }
    const ok = await verifyPasswordAsync(password, u ? u.hash : DUMMY);
    if (!u || !ok) {
      if (u) { u.fails = (u.fails || 0) + 1; if (u.fails >= 8) { u.lockUntil = now + 15 * 60e3; u.fails = 0; } this.save(); }
      return { error: 'Pseudo ou mot de passe incorrect.', status: 401, user: u };
    }
    if (u.status === 'pending') return { error: 'Ton compte attend la validation de l\'administrateur.', status: 403 };
    if (u.status !== 'active') return { error: 'Ce compte est désactivé.', status: 403 };
    u.fails = 0; u.lockUntil = 0; u.lastLogin = now; this.save();
    return { user: u };
  }
  async changePassword(u, oldPw, newPw) {
    if (!(await verifyPasswordAsync(oldPw, u.hash))) return 'Mot de passe actuel incorrect.';
    const e = checkPassword(newPw); if (e) return e;
    u.hash = hashPassword(newPw); this.save(); return '';
  }
  setStatus(id, status) { const u = this.get(id); if (!u) return null; u.status = status; u.lockUntil = 0; u.fails = 0; this.save(); return u; }
  remove(id) { const u = this.get(id); if (!u) return null; this.users.delete(id); this.save(); return u; }
  resetPassword(id) { const u = this.get(id); if (!u) return null; const pw = randomId(12); u.hash = hashPassword(pw); u.lockUntil = 0; u.fails = 0; this.save(); return pw; }

  // Invitations : code affiché une seule fois à l'administrateur, stocké haché.
  newInvite({ days = 7, uses = 1, note = '' } = {}) {
    const code = randomId(9);
    const inv = { id: randomId(6), hash: crypto.createHash('sha256').update(code).digest('base64'), created: Date.now(),
      expires: Date.now() + Math.min(90, Math.max(1, days | 0)) * 864e5, uses: 0, maxUses: Math.min(100, Math.max(1, uses | 0)), note: String(note).slice(0, 60) };
    this.invites.push(inv); this.invites = this.invites.slice(-200); this.save();
    return { code, invite: inv };
  }
  useInvite(code, now = Date.now()) {
    const h = crypto.createHash('sha256').update(String(code || '').trim()).digest('base64');
    const inv = this.invites.find(i => i.hash === h && i.expires > now && i.uses < i.maxUses);
    if (!inv) return false;
    inv.uses++; this.save(); return true;
  }
  listInvites() { return this.invites.map(({ hash, ...i }) => i); }
  revokeInvite(id) { const n = this.invites.length; this.invites = this.invites.filter(i => i.id !== id); if (this.invites.length !== n) this.save(); return this.invites.length !== n; }
}

// --- Administrateurs (admin.json, créé par la ligne de commande chatsysvisio-admin) ---
export class Admins {
  constructor(dir) { this.file = path.join(dir, 'admin.json'); this.mtime = -1; this.admins = []; this.reload(); }
  // Relu à chaque connexion si le fichier a changé (création par la ligne de commande sans redémarrage).
  reload() {
    let st; try { st = fs.statSync(this.file); } catch { this.admins = []; this.mtime = -1; return; }
    if (st.mtimeMs === this.mtime) return;
    this.mtime = st.mtimeMs; this.admins = readJson(this.file, {}).admins || [];
  }
  save() { atomicWrite(this.file, JSON.stringify({ admins: this.admins }, null, 1)); try { this.mtime = fs.statSync(this.file).mtimeMs; } catch {} }
  get(user) { this.reload(); return this.admins.find(a => a.user === String(user || '').toLowerCase()) || null; }
  count() { this.reload(); return this.admins.length; }
  upsert({ user, password, totpSecret, backupCodes }) {
    this.reload();
    user = String(user).toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(user)) throw new Error('Identifiant : 3 à 32 caractères a-z 0-9 . _ -');
    const e = checkPassword(password, 12); if (e) throw new Error(e);
    const rec = { user, hash: hashPassword(password), totp: totpSecret, backup: backupCodes.map(hashBackup), lastStep: -1, created: Date.now(), fails: 0, lockUntil: 0 };
    this.admins = this.admins.filter(a => a.user !== user).concat(rec); this.save(); return rec;
  }
  remove(user) { this.reload(); const n = this.admins.length; this.admins = this.admins.filter(a => a.user !== String(user).toLowerCase()); this.save(); return n !== this.admins.length; }
  update(rec) { this.reload(); const i = this.admins.findIndex(a => a.user === rec.user); if (i >= 0) { this.admins[i] = rec; this.save(); } }
}
