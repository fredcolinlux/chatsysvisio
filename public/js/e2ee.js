// Chiffrement de bout en bout (E2EE) de ChatSysVisio — WebCrypto uniquement (navigateurs, et Node ≥ 20 pour les tests).
//
// Schéma (détails et modèle de menace : docs/ARCHITECTURE.md, « Chiffrement de bout en bout ») :
//  - Secret de salon : 32 octets tirés dans le navigateur du créateur, transmis seulement dans le fragment du lien
//    (#k=…, jamais envoyé au serveur), et/ou dérivé du mot de passe (PBKDF2-SHA-256, 600 000 itérations, sel du salon).
//  - Le serveur ne reçoit jamais le mot de passe : il reçoit un « jeton d'accès » = HKDF(clé du mot de passe, « access »),
//    étiquette différente de celle de la clé de chiffrement ; il le hache (scrypt) et s'en sert seulement pour l'accès.
//  - Clés dérivées (HKDF-SHA-256, étiquettes distinctes) : chat (+ réactions, + clés des fichiers), authentification des
//    annonces, code de sécurité, valeur de contrôle (« kcv » : détecte un lien ou un mot de passe faux), média époque 0.
//  - Média : AES-GCM 128 bits par trame, clé = HKDF(clé d'époque, sel = nonce aléatoire de l'émetteur) ; IV = compteur
//    de 48 bits de l'émetteur (jamais réutilisé : une clé par émetteur et par époque, compteur strictement croissant).
//    L'en-tête lu par le relais (type, couche, image clé, codec, horodatage, niveau sonore) reste en clair mais
//    authentifié (AAD). Rejeu refusé (fenêtre glissante).
//  - Rotation : chaque participant a une paire ECDH P-256 éphémère (annonce authentifiée par HMAC de la clé de salon).
//    Quand quelqu'un part ou est exclu, le « meneur » (plus petit sid) tire une nouvelle clé d'époque et l'envoie à chacun
//    des présents, chiffrée par ECDH : la personne partie ne reçoit pas la nouvelle clé média.
const C = globalThis.crypto, subtle = C.subtle;
const te = new TextEncoder(), td = new TextDecoder();
export const E2EE_V = 1;
export const PBKDF2_ITER = 600_000;
// Salons publics : jamais chiffrés de bout en bout (choix assumé : contenu visible, TLS jusqu'au serveur).
export const MODES = ['link', 'link+pw'];
export const HEADER = 12;                 // en-tête du protocole média (voir protocol.js)
export const FRAME_OVERHEAD = 1 + 6 + 16; // époque + compteur + étiquette GCM
export const FILE_MAGIC = 'CCE1';
// Préfixe fixé par le serveur (E2EE_LABEL, installations migrées) ; sinon celui de ChatSysVisio.
const PFX = globalThis.document?.documentElement?.dataset?.e2ee || 'chatsysvisio/e2ee/v1/';
const L = s => PFX + s;

// ---------- Outils ----------
export function rand(n) { const u = new Uint8Array(n); C.getRandomValues(u); return u; }
export function b64u(u8) {
  let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('base64url invalide');
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u;
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const eq = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; };
const err = (code, msg) => Object.assign(new Error(msg || code), { code });

// Fragment d'URL : #k=<32 octets base64url>. Renvoie le secret, null s'il n'y en a pas, false s'il est abîmé.
export function parseKeyFragment(hash) {
  const kv = String(hash || '').replace(/^#/, '').split('&').map(x => x.split('=')).find(([k]) => k === 'k');
  if (!kv) return null;
  try { const u = unb64u(kv[1] || ''); return u.length === 32 ? u : false; } catch { return false; }
}
export const keyFragment = secret => 'k=' + b64u(secret);

async function hkdf(ikm, salt, info, len = 32) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, len * 8));
}
const aesKey = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// ---------- Mot de passe → clé (côté client uniquement) ----------
export async function passwordKey(pw, salt, iterations = PBKDF2_ITER) {
  const k = await subtle.importKey('raw', te.encode(String(pw ?? '').normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, 256));
}
// Ce que le serveur reçoit à la place du mot de passe (il le hache en scrypt). Étiquette « access » ≠ « room ».
export async function accessToken(pwKey, salt) { return b64u(await hkdf(pwKey, salt, L('access'))); }

// Secret de salon : lien seul, mot de passe seul, ou les deux (il faut alors le lien ET le mot de passe).
export async function roomSecret({ link = null, pwKey = null, salt }) {
  if (!link && !pwKey) throw err('nokey', 'aucune clé');
  return hkdf(cat(new Uint8Array([(link ? 1 : 0) | (pwKey ? 2 : 0)]), link || new Uint8Array(0), pwKey || new Uint8Array(0)), salt, L('room'));
}
export function modeFor({ isPublic, password }) { return isPublic ? null : password ? 'link+pw' : 'link'; }

// Code de sécurité : 12 chiffres (3 groupes de 4) à comparer à voix haute.
export function safetyCode(bytes) {
  const g = []; for (let i = 0; i < 3; i++) g.push(String(((bytes[i * 3] << 16) | (bytes[i * 3 + 1] << 8) | bytes[i * 3 + 2]) % 10000).padStart(4, '0'));
  return g.join(' ');
}

// ---------- Clés d'un salon ----------
export class RoomKeys {
  static async create(secret, salt) {
    const k = new RoomKeys();
    const [kcv, safety, chat, auth, m0] = await Promise.all(['kcv', 'safety', 'chat', 'auth', 'media/0'].map((x, i) => hkdf(secret, salt, L(x), i < 2 ? 16 : 32)));
    k.kcv = b64u(kcv); k.safety = safetyCode(safety);
    k.chatKey = await aesKey(chat);
    k.authKey = await subtle.importKey('raw', auth, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    k.media0 = m0;
    return k;
  }
  // Objet JSON → chaîne opaque (IV aléatoire 96 bits ‖ chiffré). label = usage (chat, react:<id>, flash) : sert d'AAD.
  async seal(obj, label) {
    const iv = rand(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(L(label)) }, this.chatKey, te.encode(JSON.stringify(obj))));
    return b64u(cat(iv, ct));
  }
  async open(str, label) {
    let u; try { u = unb64u(str); } catch { throw err('auth', 'format'); }
    if (u.length < 12 + 16) throw err('auth', 'trop court');
    let pt; try { pt = await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12), additionalData: te.encode(L(label)) }, this.chatKey, u.subarray(12)); }
    catch { throw err('auth', 'déchiffrement impossible'); }
    return JSON.parse(td.decode(pt));
  }
  async mac(bytes) { return new Uint8Array(await subtle.sign('HMAC', this.authKey, bytes)); }
  async macOk(bytes, tag) { try { return await subtle.verify('HMAC', this.authKey, tag, bytes); } catch { return false; } }
}

// ---------- Fichiers : clé aléatoire par fichier (transmise dans le message chiffré) ----------
export async function encryptFile(data) {
  const raw = rand(32), iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(L('file')) }, await aesKey(raw), data));
  return { blob: cat(te.encode(FILE_MAGIC), iv, ct), key: b64u(raw) };
}
export async function decryptFile(buf, key) {
  const u = new Uint8Array(buf);
  if (u.length < 4 + 12 + 16 || td.decode(u.subarray(0, 4)) !== FILE_MAGIC) throw err('auth', 'fichier non chiffré ou abîmé');
  try { return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(4, 16), additionalData: te.encode(L('file')) }, await aesKey(unb64u(key)), u.subarray(16))); }
  catch { throw err('auth', 'déchiffrement du fichier impossible'); }
}
// Vérification de signature d'image, faite côté client après déchiffrement (le serveur ne voit que du chiffré).
export function sniffImage(u8, type) {
  const s = (a, b) => String.fromCharCode(...u8.subarray(a, b));
  if (type === 'image/png') return u8[0] === 0x89 && s(1, 4) === 'PNG';
  if (type === 'image/jpeg') return u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff;
  if (type === 'image/gif') return s(0, 4) === 'GIF8';
  if (type === 'image/webp') return s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP';
  return false;
}

// ---------- Trames média ----------
// AAD = ce que le relais lit (et ne doit pas pouvoir modifier) : type, couche, drapeaux, codec, horodatage, niveau
// + époque + compteur. Exclus : sid (réécrit par le serveur) et seq (posé à l'envoi).
function frameAad(u8, tag, ctr6) { const a = new Uint8Array(16); a[0] = u8[0]; a.set(u8.subarray(3, 11), 1); a[9] = tag; a.set(ctr6, 10); return a; }
const ctrBytes = c => { const b = new Uint8Array(6); for (let i = 5; i >= 0; i--) { b[i] = c % 256; c = Math.floor(c / 256); } return b; };
const ctrNum = b => { let c = 0; for (let i = 0; i < 6; i++) c = c * 256 + b[i]; return c; };

export class ReplayWindow {
  constructor(size = 2048) { this.size = size; this.max = -1; this.seen = new Set(); }
  accept(c) {
    if (c + this.size <= this.max || this.seen.has(c)) return false;
    this.seen.add(c); if (c > this.max) this.max = c;
    if (this.seen.size > this.size * 2) for (const x of this.seen) if (x + this.size <= this.max) this.seen.delete(x);
    return true;
  }
}

export class MediaCrypto {
  constructor(keys, { nonce = rand(16) } = {}) {
    this.nonce = nonce; this.ctr = 0; this.cur = 0;
    this.epochs = new Map([[0, keys.media0]]); this.kc = new Map(); this.windows = new Map();
    this.stats = { enc: 0, dec: 0, fail: 0, replay: 0, nokey: 0, encMs: 0, decMs: 0 };
  }
  addEpoch(tag, raw) {
    if (!(tag >= 1 && tag <= 255) || raw?.length !== 32) return false;
    const old = this.epochs.get(tag); if (old && !eq(old, raw)) for (const k of this.kc.keys()) if (k.startsWith(tag + ':')) this.kc.delete(k);
    this.epochs.delete(tag); this.epochs.set(tag, raw);
    while (this.epochs.size > 9) { const first = [...this.epochs.keys()].find(t => t !== 0 && t !== this.cur); this.epochs.delete(first); for (const k of this.kc.keys()) if (k.startsWith(first + ':')) this.kc.delete(k); }
    return true;
  }
  newTag() { let t; do t = 1 + (rand(1)[0] % 255); while (this.epochs.has(t)); return t; }
  key(tag, nonce) {
    const id = tag + ':' + b64u(nonce); let p = this.kc.get(id);
    if (!p) { const raw = this.epochs.get(tag); if (!raw) return null; p = hkdf(raw, nonce, L('media')).then(aesKey); this.kc.set(id, p); }
    return p;
  }
  // u8 = trame en clair (en-tête + charge utile) → trame chiffrée (même en-tête)
  async encrypt(u8) {
    const t0 = performance.now(), tag = this.cur, c = this.ctr++;
    if (c >= 2 ** 48) throw err('ctr', 'compteur épuisé');
    const ctr6 = ctrBytes(c), iv = new Uint8Array(12); iv.set(ctr6, 6);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: frameAad(u8, tag, ctr6) }, await this.key(tag, this.nonce), u8.subarray(HEADER)));
    const out = new Uint8Array(HEADER + 7 + ct.length);
    out.set(u8.subarray(0, HEADER)); out[HEADER] = tag; out.set(ctr6, HEADER + 1); out.set(ct, HEADER + 7);
    this.stats.enc++; this.stats.encMs += performance.now() - t0;
    return out;
  }
  // Renvoie la charge utile en clair ; lève une erreur { code: 'nokey' | 'auth' | 'replay' }.
  async decrypt(u8, nonce) {
    const t0 = performance.now();
    if (!nonce || u8.length < HEADER + FRAME_OVERHEAD) { this.stats.fail++; throw err('auth', 'trame non chiffrée'); }
    const tag = u8[HEADER], ctr6 = u8.subarray(HEADER + 1, HEADER + 7);
    const kp = this.key(tag, nonce); if (!kp) { this.stats.nokey++; throw Object.assign(err('nokey'), { tag }); }
    const iv = new Uint8Array(12); iv.set(ctr6, 6);
    let pt;
    try { pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: frameAad(u8, tag, ctr6) }, await kp, u8.subarray(HEADER + 7)); }
    catch { this.stats.fail++; throw err('auth', 'trame altérée ou mauvaise clé'); }
    const wid = b64u(nonce); let w = this.windows.get(wid); if (!w) this.windows.set(wid, w = new ReplayWindow());
    if (!w.accept(ctrNum(ctr6))) { this.stats.replay++; throw err('replay', 'trame rejouée'); }
    this.stats.dec++; this.stats.decMs += performance.now() - t0;
    return new Uint8Array(pt);
  }
}

// ---------- Accord de clés entre participants (rotation des clés média) ----------
const annBytes = (pub, nonce) => te.encode(L('ann') + '|' + pub + '|' + nonce);
export async function makeAnnouncement(keys, pubRaw, nonce) {
  const pub = b64u(pubRaw), n = b64u(nonce);
  return { pub, nonce: n, mac: b64u(await keys.mac(annBytes(pub, n))) };
}
export async function verifyAnnouncement(keys, a) {
  try {
    if (!a || typeof a.pub !== 'string' || typeof a.nonce !== 'string' || typeof a.mac !== 'string') return false;
    if (unb64u(a.pub).length !== 65 || unb64u(a.nonce).length !== 16) return false;
    return await keys.macOk(annBytes(a.pub, a.nonce), unb64u(a.mac));
  } catch { return false; }
}

export class KeyAgreement {
  // send(obj) : message de contrôle vers le serveur ; media : MediaCrypto ; onReady() : la clé courante est connue.
  constructor({ keys, media, send, onReady = () => {}, readyTimeout = 2500 }) {
    Object.assign(this, { keys, media, send, onReady, readyTimeout });
    this.peers = new Map(); this.me = null; this.ready = true; this.pk = new Map(); this.rotations = 0;
  }
  async init() {
    this.pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    this.pubRaw = new Uint8Array(await subtle.exportKey('raw', this.pair.publicKey));
    this.ann = await makeAnnouncement(this.keys, this.pubRaw, this.media.nonce);
    return this;
  }
  nonceOf(sid) { for (const p of this.peers.values()) if (p.sid === sid && p.ann) return p.nonceRaw; return null; }
  announced() { return [...this.peers.values()].filter(p => p.ann); }
  isLeader() { return this.announced().every(p => p.sid > this.me.sid); }
  canSend() { return this.ready || this.announced().length === 0; }
  async setAnn(p, a) {
    if (!(await verifyAnnouncement(this.keys, a))) { p.ann = null; return false; }
    p.ann = a; p.nonceRaw = unb64u(a.nonce); return true;
  }
  async onJson(m) {
    switch (m.t) {
      case 'welcome': {
        this.me = { id: m.you.id, sid: m.you.sid }; this.peers.clear();
        for (const x of m.peers) { const p = { id: x.id, sid: x.sid, ann: null }; this.peers.set(x.id, p); if (x.ann) await this.setAnn(p, x.ann); }
        this.ready = this.announced().length === 0;
        clearTimeout(this._rt);
        if (!this.ready) this._rt = setTimeout(() => { if (!this.ready) { this.ready = true; this.onReady(); } }, this.readyTimeout);
        this.send({ t: 'e2ee', op: 'ann', ann: this.ann });
        return;
      }
      case 'join': this.peers.set(m.peer.id, { id: m.peer.id, sid: m.peer.sid, ann: null }); return;
      case 'leave': {
        const had = this.peers.get(m.id)?.ann; this.peers.delete(m.id);
        // Départ ou exclusion : nouvelle clé média pour les présents (la personne partie ne la reçoit pas).
        if (had && this.me && this.isLeader() && this.announced().length) await this.rotate();
        return;
      }
      case 'e2ee': return this.onE2ee(m);
    }
  }
  async rotate() {
    const tag = this.media.newTag(), raw = rand(32);
    this.media.addEpoch(tag, raw); this.media.cur = tag; this.rotations++;
    await Promise.all(this.announced().map(p => this.sendBundle(p)));
  }
  async onE2ee(m) {
    const p = this.peers.get(m.from); if (!p) return;
    if (m.op === 'ann') { if (await this.setAnn(p, m.ann) && this.isLeader()) await this.sendBundle(p); return; }
    if (!p.ann) return;
    if (m.op === 'key') {
      let b; try { b = await this.unwrap(p, m.w); } catch { return; }
      for (const [tag, k] of b.keys || []) try { this.media.addEpoch(tag, unb64u(k)); } catch {}
      if (b.cur === 0 || this.media.epochs.has(b.cur)) this.media.cur = b.cur;
      if (!this.ready) { this.ready = true; clearTimeout(this._rt); this.onReady(); }
      return;
    }
    if (m.op === 'keyreq' && this.media.epochs.has(m.tag)) await this.sendBundle(p);
  }
  async pairKey(p) {
    let k = this.pk.get(p.ann.pub);
    if (!k) {
      k = (async () => {
        const pub = await subtle.importKey('raw', unb64u(p.ann.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const bits = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, this.pair.privateKey, 256));
        const [a, b] = [this.ann.pub, p.ann.pub].sort();
        return aesKey(await hkdf(bits, te.encode(a + '|' + b), L('wrap')));
      })();
      this.pk.set(p.ann.pub, k);
    }
    return k;
  }
  async sendBundle(p) {
    const keys = [...this.media.epochs].filter(([t]) => t !== 0).map(([t, raw]) => [t, b64u(raw)]);
    const iv = rand(12), aad = te.encode(L('wrap') + '|' + this.ann.pub + '>' + p.ann.pub);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await this.pairKey(p), te.encode(JSON.stringify({ cur: this.media.cur, keys }))));
    this.send({ t: 'e2ee', op: 'key', to: p.id, w: b64u(cat(iv, ct)) });
  }
  async unwrap(p, w) {
    const u = unb64u(w), aad = te.encode(L('wrap') + '|' + p.ann.pub + '>' + this.ann.pub);
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: u.subarray(0, 12), additionalData: aad }, await this.pairKey(p), u.subarray(12));
    return JSON.parse(td.decode(pt));
  }
  requestKey(tag) {
    const now = Date.now(); if (now - (this._kr || 0) < 3000) return; this._kr = now;
    this.send({ t: 'e2ee', op: 'keyreq', tag });
  }
}

// Niveau sonore arrondi (16 paliers) : suffisant pour choisir les 4 voix les plus fortes, moins précis à observer.
export const roundLevel = l => Math.min(255, Math.round(l / 16) * 16);
