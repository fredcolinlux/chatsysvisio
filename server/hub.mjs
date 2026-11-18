// Hub temps réel : signalisation, chat et routage média (SFU « WebSocket »).
// Tout passe par une seule connexion WSS par participant (port 443 via Nginx Proxy Manager).
// Routage : le serveur ne transmet à chacun que ce qu'il affiche (couches abonnées),
// abandonne les images quand la connexion d'un destinataire sature (puis redemande une image clé),
// et ne relaie l'audio que des N personnes qui parlent le plus fort.
import crypto from 'node:crypto';
import { T_VIDEO, T_AUDIO, LAYERS, HEADER, setSid, peekType, peekLayer, peekKey, peekLevel, PROTO } from '../public/js/protocol.js';
import { degradeLayer, HEIGHTS } from '../public/js/quality.js';
import { validStroke, cleanStroke, LIMITS as WB, ID_RE as WB_ID } from '../public/js/board-model.js';

export const VIDEO_HIGH_WATER = 768 * 1024;  // octets en attente sur la socket d'un destinataire
export const AUDIO_HIGH_WATER = 1536 * 1024;
export const MAX_MEDIA_MESSAGE = 1_500_000; // une image clé 1080p VP8/H.264 fait 50–400 Ko : large marge
const SPEAKER_MIN = 70;           // niveau (0..255) en dessous duquel personne ne « parle »
const VIDEO_PREFS = ['vp8', 'avc'];
const EMOJIS = new Set(['👍', '❤️', '😂', '🎉', '👏', '😮', '🔥', '🙏', '✋', '😢', '💯', '🤔']);

const clampStr = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
// Chaîne opaque (base64url) produite par le client : seule sa forme et sa taille sont vérifiées.
const isEnc = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
// Message tel qu'envoyé aux clients : sans les clés internes de réaction (rx, et les clés de erx).
const publicMsg = ({ rx, erx, ark, ...m }) => (erx ? { ...m, erx: Object.values(erx) } : m);
// Accusés de lecture : au plus SEEN_MSGS messages suivis par salon, en mémoire (oubliés quand le salon se vide).
const SEEN_MSGS = 400, SEEN_PER_MSG = 30;
const OWNER_GRACE_MS = 20000; // tableau blanc : délai pour que son ouvreur revienne après une coupure

class RoomState {
  constructor(room) { this.room = room; this.peers = new Map(); this.nextSid = 1; this.speaker = 0; this.speakerAt = 0; this.top = new Set(); this.seen = new Map(); this.board = null; }
  others(p) { return [...this.peers.values()].filter(x => x !== p); }
}

export class Hub {
  constructor({ store, cfg, log = () => {}, isReserved = () => false, onEvent = () => {} }) {
    this.store = store; this.cfg = cfg; this.log = log; this.isReserved = isReserved; this.onEvent = onEvent;
    this.rooms = new Map();
    this.bytesIn = 0; this.bytesOut = 0; // compteurs pour les statistiques d'administration
    this.timer = setInterval(() => this.tick(), 250); this.timer.unref?.();
  }
  close() { clearInterval(this.timer); for (const rs of this.rooms.values()) for (const p of rs.peers.values()) try { p.ws.close(1001); } catch {} }

  sessionConnections(room, sessionId) { let n = 0; for (const p of this.rooms.get(room.id)?.peers.values() || []) if (p.sessionId === sessionId) n++; return n; }
  count(room) { return this.rooms.get(room.id)?.peers.size || 0; }
  peopleCount() { let n = 0; for (const rs of this.rooms.values()) n += rs.peers.size; return n; }
  limitOf(room) { const l = room.limit > 0 ? room.limit : this.cfg.maxParticipants; return Math.min(l, this.cfg.maxParticipants); }
  isFull(room) { return this.count(room) >= this.limitOf(room); }

  attach(ws, { room, name, sessionId, ip = '', account = null }) {
    let rs = this.rooms.get(room.id);
    if (!rs) { rs = new RoomState(room); this.rooms.set(room.id, rs); }
    if (rs.peers.size >= this.limitOf(room)) { ws.close(4003, 'full'); return null; }
    let sid = rs.nextSid; while ([...rs.peers.values()].some(p => p.sid === sid)) sid = (sid % 65000) + 1;
    rs.nextSid = (sid % 65000) + 1;
    const p = {
      sid, ws, rs, sessionId, id: crypto.randomBytes(6).toString('hex'), name: clampStr(name, 40) || 'Invité',
      state: { mic: false, cam: false, screen: false, hand: false }, caps: { venc: [], vdec: ['jpeg'], aenc: [], adec: ['adpcm'] },
      subs: new Set(), eff: new Set(), needKey: new Set(), codecs: { video: 'jpeg', audio: 'adpcm' }, need: [],
      lvl: 0, lastAudio: 0, drops: [], degraded: 0, degradedAt: 0, lastKeyReq: new Map(), chatTimes: [], joined: Date.now(),
      hello: false, ip, account: account?.id || null,
      // clé de réaction : par compte, ou par session pour un invité (jamais diffusée)
      rk: account ? 'u:' + account.id : 'g:' + crypto.createHash('sha256').update(String(sessionId)).digest('base64url').slice(0, 16),
    };
    if (account) p.name = account.name; // un compte garde toujours son pseudo
    rs.peers.set(p.id, p);
    this.store.touch(room);
    ws.on('message', (data, isBinary) => {
      this.bytesIn += data.length || 0;
      try { isBinary ? this.onMedia(p, data) : this.onControl(p, data.toString()); } catch (e) { this.log('erreur message', e.message); }
    });
    ws.on('close', () => this.leave(p));
    ws.on('error', () => {});
    return p;
  }

  send(p, obj) { if (p.ws.readyState === 1) { const s = JSON.stringify(obj); this.bytesOut += s.length; p.ws.send(s); } }
  broadcast(rs, obj, except = null) { const s = JSON.stringify(obj); for (const p of rs.peers.values()) if (p !== except && p.ws.readyState === 1) { this.bytesOut += s.length; p.ws.send(s); } }
  // Pseudo effectif : un compte garde le sien ; un invité ne peut pas prendre celui d'un compte.
  nameFor(p, wanted) {
    if (p.account) return p.name;
    const n = clampStr(wanted, 40);
    if (!n) return p.name;
    if (this.isReserved(n)) { this.send(p, { t: 'error', code: 'reserved', message: `« ${n} » est réservé à un compte : connecte-toi ou choisis un autre nom.` }); return p.name; }
    return n;
  }
  peerInfo(p) { return { id: p.id, sid: p.sid, name: p.name, state: p.state, joined: p.joined, ...(p.ann ? { ann: p.ann } : {}) }; }

  leave(p) {
    const rs = p.rs;
    if (!rs.peers.delete(p.id)) return;
    if (p.hello) {
      this.broadcast(rs, { t: 'leave', id: p.id, sid: p.sid });
      this.system(rs, `${p.name} a quitté le salon`);
    }
    for (const o of rs.peers.values()) { o.subs.forEach(k => { if (k.startsWith(p.sid + ':')) o.subs.delete(k); }); this.recomputeEff(o); }
    // Ouvreur du tableau parti : on lui laisse un court délai pour revenir (coupure réseau), sinon le tableau se ferme.
    if (rs.board?.owner === p.id) { rs.board.owner = null; rs.board.orphanUntil = Date.now() + OWNER_GRACE_MS; this.broadcast(rs, { t: 'wb', op: 'meta', board: this.boardMeta(rs) }); }
    this.store.touch(rs.room);
    if (rs.peers.size === 0) this.rooms.delete(rs.room.id); else { this.recomputeCodecs(rs); this.recomputeNeeds(rs); }
  }

  system(rs, text) {
    const m = this.store.addMessage(rs.room, { id: crypto.randomBytes(8).toString('hex'), ts: Date.now(), kind: 'system', text });
    this.broadcast(rs, { t: 'chat', msg: m });
  }

  onControl(p, raw) {
    if (raw.length > 20000) return;
    if (!this.rate(p, 'ctl', 120)) return;              // plafond global : 120 messages de contrôle / s
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const rs = p.rs;
    // Débits par type (chaque message diffusé ou écrit sur disque est borné)
    const PER_SEC = { state: 10, name: 2, subs: 10, keyreq: 60, msgreact: 5, ping: 5, e2ee: 60 };
    if (PER_SEC[m.t] && !this.rate(p, m.t, PER_SEC[m.t])) return;
    switch (m.t) {
      case 'hello': {
        if (p.hello) return;
        // Client d'une autre version (fichiers restés en cache) : refus explicite plutôt qu'un appel sans son.
        if (rs.room.e2ee && !((m.proto | 0) >= PROTO)) {
          this.send(p, { t: 'error', code: 'version', message: 'Ton navigateur utilise une ancienne version de ChatSysVisio, incompatible avec ce salon chiffré de bout en bout. Recharge la page avec Ctrl+F5 (ou Cmd+Maj+R sur Mac).' });
          try { p.ws.close(1008, 'version'); } catch {}
          return;
        }
        if (m.build != null && this.cfg.build && String(m.build) !== String(this.cfg.build)) {
          this.send(p, { t: 'error', code: 'version', build: this.cfg.build, message: 'Nouvelle version de ChatSysVisio, rechargement…' });
          try { p.ws.close(4010, 'version'); } catch {}
          return;
        }
        p.proto = m.proto | 0;
        p.hello = true;
        if (m.name) p.name = this.nameFor(p, m.name);
        const arr = (v, allowed) => Array.isArray(v) ? v.filter(x => allowed.includes(x)) : [];
        const c = m.caps || {};
        p.caps = { venc: arr(c.venc, VIDEO_PREFS), vdec: [...new Set(['jpeg', ...arr(c.vdec, VIDEO_PREFS)])],
          aenc: arr(c.aenc, ['opus']), adec: [...new Set(['adpcm', ...arr(c.adec, ['opus'])])] };
        Object.assign(p.state, this.cleanState(m.state));
        this.send(p, { t: 'welcome', you: this.peerInfo(p), room: { name: rs.room.name, slug: rs.room.slug, isPublic: rs.room.isPublic, hasPassword: !!rs.room.passwordHash, limit: this.limitOf(rs.room), e2ee: rs.room.e2ee ? rs.room.e2ee.mode : null },
          peers: rs.others(p).filter(o => o.hello).map(o => this.peerInfo(o)), history: this.store.messages(rs.room).slice(-150).map(x => x.ark && x.ark === p.rk ? { ...publicMsg(x), own: true } : publicMsg(x)),
          bitrates: { hi: this.cfg.videoHiKbps, lo: this.cfg.videoLoKbps, screen: this.cfg.screenKbps, hd720: this.cfg.video720Kbps, hd1080: this.cfg.video1080Kbps, hd720max: Math.max(this.cfg.video720Kbps, this.cfg.video720MaxKbps ?? 0), hd1080max: Math.max(this.cfg.video1080Kbps, this.cfg.video1080MaxKbps ?? 0), screenHd: this.cfg.screenHdKbps },
          maxHeight: this.cfg.videoMaxHeight, ai: this.cfg.aiEnabled && !rs.room.e2ee, speaker: rs.speaker,
          server: { version: this.cfg.version, build: this.cfg.build, proto: PROTO } });
        this.sendOwnSeen(p);
        // Tableau blanc en cours : l'ouvreur qui revient le reprend ; tout arrivant reçoit l'état complet (rejoué).
        if (rs.board) {
          if (!rs.board.owner && rs.board.ownerRk === p.rk) { rs.board.owner = p.id; rs.board.orphanUntil = 0; this.broadcast(rs, { t: 'wb', op: 'meta', board: this.boardMeta(rs) }, p); }
          this.send(p, { t: 'wb', op: 'state', board: this.boardMeta(rs), items: rs.board.items.map(it => it.pub) });
        }
        this.broadcast(rs, { t: 'join', peer: this.peerInfo(p) }, p);
        this.system(rs, `${p.name} a rejoint le salon`);
        this.onEvent('connexion', `${p.name} a rejoint « ${rs.room.name} »`, { room: rs.room.slug, ip: p.ip, account: p.account ? p.name : undefined });
        this.recomputeCodecs(rs); this.recomputeNeeds(rs);
        return;
      }
      case 'state': {
        Object.assign(p.state, this.cleanState(m.state));
        this.broadcast(rs, { t: 'peer', id: p.id, state: p.state, name: p.name }, p);
        if (m.state && 'hand' in m.state && p.state.hand) this.broadcast(rs, { t: 'hand', id: p.id, name: p.name }, p);
        return;
      }
      case 'name': { p.name = this.nameFor(p, m.name); this.broadcast(rs, { t: 'peer', id: p.id, state: p.state, name: p.name }, p); return; }
      case 'subs': {
        const want = new Set();
        if (Array.isArray(m.want)) for (const w of m.want.slice(0, 80)) {
          if (!Array.isArray(w)) continue;
          const [sid, layer] = w; if (!LAYERS.includes(layer)) continue;
          if ([...rs.peers.values()].some(o => o.sid === sid && o !== p)) want.add(`${sid}:${layer}`);
        }
        p.subs = want; this.recomputeEff(p); this.recomputeNeeds(rs);
        return;
      }
      case 'keyreq': { const o = [...rs.peers.values()].find(x => x.sid === m.sid); if (o) { p.needKey.add(`${o.sid}:${m.layer | 0}`); this.requestKey(o, m.layer | 0); } return; }
      case 'chat': return this.onChat(p, m);
      case 'seen': return this.onSeen(p, m);
      case 'wb': return this.onBoard(p, m);
      case 'msgreact': {
        if (rs.room.e2ee) return this.onEncReact(p, m);
        if (!EMOJIS.has(m.emoji)) return;
        const msg = this.store.messages(rs.room).find(x => x.id === m.id); if (!msg) return;
        // Réactions indexées par personne (compte ou session), plus par pseudo : deux « Marie » ne s'annulent plus,
        // et un invité ne peut plus retirer la réaction d'un compte en prenant son nom.
        const rx = { ...(msg.rx || {}) };
        if (!msg.rx) for (const [e, names] of Object.entries(msg.reactions || {})) rx[e] = names.map(n => ['n:' + n, n]); // anciens messages
        const list = (rx[m.emoji] || []).filter(([k]) => k !== p.rk);
        if (list.length === (rx[m.emoji] || []).length) list.push([p.rk, p.name]);
        if (list.length) rx[m.emoji] = list.slice(-30); else delete rx[m.emoji];
        const r = Object.fromEntries(Object.entries(rx).map(([e, l]) => [e, l.map(x => x[1])]));
        this.store.setReactions(rs.room, m.id, r, rx);
        this.broadcast(rs, { t: 'msgreact', id: m.id, reactions: r });
        return;
      }
      case 'react': {
        if (rs.room.e2ee) { if (!isEnc(m.enc, 400) || !this.rate(p, 'react', 6)) return; this.broadcast(rs, { t: 'react', id: p.id, enc: m.enc }); return; }
        if (!EMOJIS.has(m.emoji)) return; if (!this.rate(p, 'react', 6)) return; this.broadcast(rs, { t: 'react', id: p.id, emoji: m.emoji }); return; }
      case 'typing': { if (!this.rate(p, 'typing', 3)) return; this.broadcast(rs, { t: 'typing', id: p.id, name: p.name }, p); return; }
      case 'e2ee': return this.onE2ee(p, m);
      case 'ping': { this.send(p, { t: 'pong', ts: Number.isFinite(m.ts) ? m.ts : 0 }); return; }
    }
  }

  rate(p, kind, perSec) {
    const now = Date.now(); p.rates ??= {}; const r = p.rates[kind] ??= { n: 0, t: now };
    if (now - r.t > 1000) { r.n = 0; r.t = now; }
    return ++r.n <= perSec;
  }

  cleanState(s) {
    const o = {}; if (!s || typeof s !== 'object') return o;
    for (const k of ['mic', 'cam', 'screen', 'hand']) if (k in s) o[k] = !!s[k];
    // vq : hauteur max que l'émetteur peut fournir (144 = vignette seule, 360, 720, 1080)
    if ('vq' in s && HEIGHTS.includes(s.vq)) o.vq = Math.min(s.vq, this.cfg.videoMaxHeight || 1080);
    return o;
  }

  // ---- Chiffrement de bout en bout : le serveur relaie des annonces de clés publiques et des clés « emballées »
  // (chiffrées pour un destinataire) sans pouvoir les lire. Il ne vérifie que la forme et la taille.
  onE2ee(p, m) {
    const rs = p.rs; if (!rs.room.e2ee) return;
    if (m.op === 'ann') {
      const a = m.ann;
      if (!a || !isEnc(a.pub, 100) || !isEnc(a.nonce, 30) || !isEnc(a.mac, 50)) return;
      p.ann = { pub: a.pub, nonce: a.nonce, mac: a.mac };
      this.broadcast(rs, { t: 'e2ee', op: 'ann', from: p.id, ann: p.ann }, p);
    } else if (m.op === 'key') {
      const o = rs.peers.get(String(m.to)); if (!o || o === p || !o.hello || !isEnc(m.w, 2000)) return;
      this.send(o, { t: 'e2ee', op: 'key', from: p.id, w: m.w });
    } else if (m.op === 'keyreq') {
      const tag = m.tag | 0; if (tag < 1 || tag > 255 || !this.rate(p, 'e2eeReq', 1)) return;
      this.broadcast(rs, { t: 'e2ee', op: 'keyreq', from: p.id, tag }, p);
    }
  }

  // Réactions chiffrées : une entrée opaque par personne (clé interne rk, jamais transmise) ; les clients agrègent.
  onEncReact(p, m) {
    const rs = p.rs;
    if (!isEnc(m.enc, 600)) return;
    const msg = this.store.messages(rs.room).find(x => x.id === m.id); if (!msg) return;
    const erx = { ...(msg.erx || {}) }; delete erx[p.rk]; erx[p.rk] = m.enc;
    const keys = Object.keys(erx); for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete erx[k];
    this.store.setReactions(rs.room, m.id, {}, undefined, erx);
    this.broadcast(rs, { t: 'msgreact', id: m.id, erx: Object.values(erx) });
  }

  onChat(p, m) {
    const rs = p.rs, now = Date.now();
    p.chatTimes = p.chatTimes.filter(t => now - t < 10000);
    if (p.chatTimes.length >= 12) return this.send(p, { t: 'error', code: 'rate', message: 'Doucement : trop de messages.' });
    if (rs.room.e2ee) {
      // Salon chiffré : texte, nom de fichier, citation et clé du fichier sont dans « enc », illisibles ici.
      // Un message en clair est refusé (ancien client ou client modifié) pour ne jamais stocker de texte lisible.
      if (!isEnc(m.enc, 18000) || (m.text != null && m.text !== '') || m.fileId) return this.send(p, { t: 'error', code: 'e2ee', message: 'Message non chiffré refusé dans un salon chiffré de bout en bout.' });
      p.chatTimes.push(now);
      const msg = this.store.addMessage(rs.room, { id: crypto.randomBytes(8).toString('hex'), ts: now, kind: 'user',
        from: { id: p.id, name: p.name }, enc: m.enc, reactions: {}, cid: clampStr(m.cid, 24) || undefined, ark: p.rk });
      this.store.touch(rs.room);
      this.broadcast(rs, { t: 'chat', msg: publicMsg(msg) });
      return;
    }
    const text = String(m.text ?? '').slice(0, 4000).replace(/\r/g, '');
    let file = null;
    if (m.fileId) {
      const meta = this.store.fileMeta(String(m.fileId));
      if (meta && meta.roomId === rs.room.id) file = { id: meta.id, name: meta.name, type: meta.type, size: meta.size, url: `/f/${meta.id}/${encodeURIComponent(meta.name)}` };
    }
    if (!text.trim() && !file) return;
    p.chatTimes.push(now);
    let replyTo = null;
    if (m.replyTo) {
      const t = this.store.messages(rs.room).find(x => x.id === m.replyTo);
      if (t) replyTo = { id: t.id, name: t.from?.name || 'Système', excerpt: (t.text || t.file?.name || '').slice(0, 80) };
    }
    const msg = this.store.addMessage(rs.room, { id: crypto.randomBytes(8).toString('hex'), ts: now, kind: 'user',
      from: { id: p.id, name: p.name }, text, file, replyTo, reactions: {}, cid: clampStr(m.cid, 24) || undefined, ark: p.rk });
    this.store.touch(rs.room);
    this.broadcast(rs, { t: 'chat', msg: publicMsg(msg) });
  }

  // ---- Accusés de lecture « Vu » ----
  // Le lecteur est toujours la connexion qui envoie (impossible d'accuser lecture au nom d'un autre) ; seuls les
  // messages existants, écrits par quelqu'un d'autre, sont acceptés. Le résultat n'est envoyé qu'à l'auteur.
  // Salon chiffré : le serveur ne voit que des identifiants de message opaques et le nom (déjà connu de lui) du lecteur.
  onSeen(p, m) {
    const rs = p.rs;
    if (!p.hello || !this.rate(p, 'seen', 4) || !Array.isArray(m.ids)) return;
    const ids = [...new Set(m.ids.filter(x => typeof x === 'string' && /^[0-9a-f]{16}$/.test(x)))].slice(0, 50);
    if (!ids.length) return;
    const byId = new Map(this.store.messages(rs.room).map(x => [x.id, x]));
    const out = new Map(); // auteur (rk) → [{ id, by }]
    for (const id of ids) {
      const msg = byId.get(id);
      if (!msg || msg.kind !== 'user' || !msg.ark || msg.ark === p.rk) continue;
      let who = rs.seen.get(id);
      if (!who) {
        who = new Map(); rs.seen.set(id, who);
        if (rs.seen.size > SEEN_MSGS) rs.seen.delete(rs.seen.keys().next().value);
      }
      if (who.get(p.rk) === p.name || (!who.has(p.rk) && who.size >= SEEN_PER_MSG)) continue;
      who.set(p.rk, p.name);
      const l = out.get(msg.ark) || []; l.push({ id, by: [...who.values()] }); out.set(msg.ark, l);
    }
    for (const [ark, items] of out) for (const o of rs.peers.values()) if (o.rk === ark && o.hello) this.send(o, { t: 'seen', items });
  }
  sendOwnSeen(p) {
    const rs = p.rs, items = [];
    for (const msg of this.store.messages(rs.room).slice(-150)) {
      if (msg.ark !== p.rk) continue;
      const who = rs.seen.get(msg.id); if (who?.size) items.push({ id: msg.id, by: [...who.values()] });
    }
    if (items.length) this.send(p, { t: 'seen', items });
  }

  // ---- Tableau blanc partagé ----
  // Traits vectoriels relayés par le WebSocket (aucun flux vidéo), conservés en mémoire tant que le tableau est ouvert,
  // et rejoués pour qui arrive. Salon chiffré : chaque trait est opaque (enc), seul son identifiant est visible.
  boardMeta(rs) {
    const b = rs.board; if (!b) return null;
    return { owner: b.owner, ownerName: b.ownerName, locked: b.locked, away: !b.owner, n: b.items.length };
  }
  onBoard(p, m) {
    const rs = p.rs, b = rs.board, e2 = !!rs.room.e2ee;
    if (!p.hello || typeof m.op !== 'string') return;
    const isOwner = b && b.owner === p.id;
    const canDraw = b && (!b.locked || isOwner);
    const lim = k => this.rate(p, 'wb-' + k, WB.rate[k]);
    switch (m.op) {
      case 'open': {
        if (!lim('meta')) return;
        if (b) return this.send(p, { t: 'error', code: 'wb', message: `Un tableau blanc est déjà ouvert par ${b.ownerName}.` });
        rs.board = { owner: p.id, ownerRk: p.rk, ownerName: p.name, locked: false, items: [], ids: new Set(), bytes: 0, orphanUntil: 0 };
        this.broadcast(rs, { t: 'wb', op: 'open', board: this.boardMeta(rs) });
        this.system(rs, `${p.name} a ouvert un tableau blanc`);
        return;
      }
      case 'close': case 'clear': case 'lock': {
        if (!isOwner || !lim('meta')) return;
        if (m.op === 'close') { rs.board = null; this.broadcast(rs, { t: 'wb', op: 'close' }); this.system(rs, `${p.name} a fermé le tableau blanc`); return; }
        if (m.op === 'clear') { b.items = []; b.ids.clear(); b.bytes = 0; this.broadcast(rs, { t: 'wb', op: 'clear' }); return; }
        b.locked = !!m.on; this.broadcast(rs, { t: 'wb', op: 'meta', board: this.boardMeta(rs) }); return;
      }
      case 'add': case 'live': {
        if (!canDraw || !lim(m.op)) return;
        let pub;
        if (e2) {
          if (typeof m.id !== 'string' || !WB_ID.test(m.id) || !isEnc(m.enc, WB.enc)) return;
          pub = { id: m.id, from: p.id, enc: m.enc, ...(m.op === 'live' ? { n: m.n | 0 } : {}) };
        } else {
          if (!validStroke(m.s, { live: m.op === 'live' })) return;
          pub = { id: m.s.id, from: p.id, s: m.op === 'live' ? { ...cleanStroke(m.s), n: m.s.n } : cleanStroke(m.s) };
        }
        if (m.op === 'live') { this.broadcast(rs, { t: 'wb', op: 'live', ...pub }, p); return; }
        if (b.ids.has(pub.id)) return;
        const size = JSON.stringify(pub).length;
        if (b.items.length >= WB.items || b.bytes + size > WB.bytes) return this.send(p, { t: 'error', code: 'wb-full', message: 'Tableau plein : efface-le (ou ouvre-en un nouveau) pour continuer.' });
        b.items.push({ id: pub.id, by: p.rk, size, pub }); b.ids.add(pub.id); b.bytes += size;
        this.broadcast(rs, { t: 'wb', op: 'add', ...pub }, p);
        return;
      }
      case 'undo': {
        if (!b || !lim('undo') || !Array.isArray(m.ids)) return;
        const want = new Set(m.ids.slice(0, WB.undo).filter(x => typeof x === 'string' && WB_ID.test(x)));
        const del = [];
        b.items = b.items.filter(it => { if (want.has(it.id) && it.by === p.rk) { del.push(it.id); b.ids.delete(it.id); b.bytes -= it.size; return false; } return true; });
        if (del.length) this.broadcast(rs, { t: 'wb', op: 'del', ids: del }, p);
        return;
      }
    }
  }

  postAi(room, text) {
    const rs = this.rooms.get(room.id);
    const msg = this.store.addMessage(room, { id: crypto.randomBytes(8).toString('hex'), ts: Date.now(), kind: 'ai', text, from: { name: 'Assistant local' }, reactions: {} });
    if (rs) this.broadcast(rs, { t: 'chat', msg });
    return msg;
  }

  // ---- Routage média ----
  onMedia(p, data) {
    if (!p.hello) return;
    if (p.rs.room.e2ee && !p.ann) return; // salon chiffré : rien n'est relayé avant l'annonce de clé de l'émetteur
    const u8 = data instanceof Buffer ? data : Buffer.from(data);
    if (u8.length <= HEADER || u8.length > MAX_MEDIA_MESSAGE) return;
    setSid(u8, p.sid);
    const rs = p.rs, type = peekType(u8);
    // Débit média borné par émetteur (seau à jetons : MEDIA_MAX_KBPS en continu, rafale de 3 s pour les images clés)
    if (!this.mediaBudget(p, u8.length)) {
      if (type === T_VIDEO) { const l = peekLayer(u8), k = `${p.sid}:${l}`; for (const o of rs.peers.values()) if (o.eff.has(k)) o.needKey.add(k); }
      return;
    }
    if (type === T_AUDIO) {
      const lvl = peekLevel(u8);
      p.lvl = Math.max(lvl, p.lvl * 0.85 + lvl * 0.15); p.lastAudio = Date.now();
      if (!p.state.mic) return;
      if (rs.top.size >= this.cfg.audioTopN && !rs.top.has(p.sid)) return;
      for (const o of rs.peers.values()) {
        if (o === p || !o.hello || o.ws.readyState !== 1) continue;
        if (o.ws.bufferedAmount > AUDIO_HIGH_WATER) { this.noteDrop(o); continue; }
        o.ws.send(u8, { binary: true }); this.bytesOut += u8.length;
      }
      return;
    }
    if (type !== T_VIDEO) return;
    const layer = peekLayer(u8), key = `${p.sid}:${layer}`, isKey = peekKey(u8);
    for (const o of rs.peers.values()) {
      if (o === p || !o.eff.has(key) || o.ws.readyState !== 1) continue;
      if (o.needKey.has(key)) { if (!isKey) continue; o.needKey.delete(key); }
      if (o.ws.bufferedAmount > VIDEO_HIGH_WATER) {
        o.needKey.add(key); this.requestKey(p, layer); this.noteDrop(o); continue;
      }
      o.ws.send(u8, { binary: true }); this.bytesOut += u8.length;
    }
  }

  mediaBudget(p, n) {
    const rate = (this.cfg.mediaMaxKbps || 20000) * 125, cap = rate * 3, now = Date.now(); // octets/s, rafale 3 s
    if (p.mb === undefined) { p.mb = cap; p.mbAt = now; }
    p.mb = Math.min(cap, p.mb + (now - p.mbAt) / 1000 * rate); p.mbAt = now;
    if (p.mb < n) return false;
    p.mb -= n; return true;
  }

  // Destinataire saturé : niveau 1 (HD → 360p, 360p → vignette), puis niveau 2 (vignettes seulement).
  noteDrop(o) {
    const now = Date.now(); o.drops.push(now); o.drops = o.drops.filter(t => now - t < 5000);
    if (o.degraded < 2 && o.drops.length > 8 && now - o.degradedAt > 2000) {
      o.degraded++; o.degradedAt = now; o.drops = []; this.recomputeEff(o); this.recomputeNeeds(o.rs);
      this.send(o, { t: 'quality', level: 'low', step: o.degraded });
    }
  }

  requestKey(p, layer) {
    const now = Date.now(), last = p.lastKeyReq.get(layer) || 0;
    if (now - last < 400) return;
    p.lastKeyReq.set(layer, now);
    this.send(p, { t: 'keyreq', layer });
  }

  // Couches réellement transmises : en mode dégradé, la haute définition caméra est remplacée par la basse.
  recomputeEff(p) {
    const eff = new Set();
    for (const k of p.subs) {
      const [sid, layer] = k.split(':').map(Number);
      eff.add(`${sid}:${degradeLayer(layer, p.degraded)}`);
    }
    for (const k of eff) if (!p.eff.has(k)) { p.needKey.add(k); const [sid, layer] = k.split(':').map(Number); const o = [...p.rs.peers.values()].find(x => x.sid === sid); if (o) this.requestKey(o, layer); }
    p.eff = eff;
  }

  recomputeNeeds(rs) {
    for (const s of rs.peers.values()) {
      const need = LAYERS.filter(l => [...rs.peers.values()].some(o => o !== s && o.eff.has(`${s.sid}:${l}`)));
      if (need.join() !== s.need.join()) { s.need = need; if (s.hello) this.send(s, { t: 'need', layers: need }); }
    }
  }

  // Codec par émetteur : le meilleur qu'il sait encoder et que TOUS les autres savent décoder.
  // L'ordre de venc envoyé par le client compte (ex. iPhone : H.264 matériel avant VP8 logiciel).
  recomputeCodecs(rs) {
    const ps = [...rs.peers.values()].filter(x => x.hello);
    for (const s of ps) {
      const others = ps.filter(o => o !== s);
      const video = s.caps.venc.find(c => others.every(o => o.caps.vdec.includes(c))) || 'jpeg';
      const audio = s.caps.aenc.includes('opus') && others.every(o => o.caps.adec.includes('opus')) ? 'opus' : 'adpcm';
      if (video !== s.codecs.video || audio !== s.codecs.audio || !s.codecsSent) {
        s.codecs = { video, audio }; s.codecsSent = true; this.send(s, { t: 'codec', ...s.codecs });
      }
    }
  }

  // ---- Administration ----
  roomsView(maskIp = x => x) {
    const now = Date.now();
    return [...this.rooms.values()].map(rs => ({
      id: rs.room.id, slug: rs.room.slug, name: rs.room.name, isPublic: rs.room.isPublic, hasPassword: !!rs.room.passwordHash, limit: this.limitOf(rs.room), e2ee: !!rs.room.e2ee,
      people: [...rs.peers.values()].map(p => ({
        id: p.id, name: p.name, account: !!p.account, since: p.joined, minutes: Math.round((now - p.joined) / 60000), ip: maskIp(p.ip),
        mic: p.state.mic, cam: p.state.cam, screen: p.state.screen, vq: p.state.vq || 0, codec: p.codecs.video, audio: p.codecs.audio,
        sends: p.need, subs: p.subs.size, hd: [...p.eff].filter(k => k.endsWith(':3')).length, degraded: p.degraded, buffered: p.ws.bufferedAmount || 0,
      })),
    }));
  }
  peerById(roomId, peerId) { return this.rooms.get(roomId)?.peers.get(peerId) || null; }
  kick(roomId, peerId, reason = 'kicked') {
    const p = this.peerById(roomId, peerId); if (!p) return null;
    this.send(p, { t: 'kicked', reason }); try { p.ws.close(4004, reason.slice(0, 60)); } catch {}
    this.leave(p); return p;
  }
  closeRoom(roomId) {
    const rs = this.rooms.get(roomId); if (!rs) return 0;
    const n = rs.peers.size;
    for (const p of [...rs.peers.values()]) { this.send(p, { t: 'closed' }); try { p.ws.close(4005, 'closed'); } catch {} rs.peers.delete(p.id); }
    this.rooms.delete(roomId); return n;
  }
  kickAccount(accountId) { for (const rs of this.rooms.values()) for (const p of [...rs.peers.values()]) if (p.account === accountId) this.kick(rs.room.id, p.id, 'account'); }

  tick() {
    const now = Date.now();
    for (const rs of this.rooms.values()) {
      if (rs.board && !rs.board.owner && rs.board.orphanUntil < now) {
        const n = rs.board.ownerName; rs.board = null;
        this.broadcast(rs, { t: 'wb', op: 'close' }); this.system(rs, `Tableau blanc de ${n} fermé (parti du salon)`);
      }
      const speaking = [...rs.peers.values()].filter(p => p.state.mic && now - p.lastAudio < 1000);
      for (const p of rs.peers.values()) if (now - p.lastAudio > 600) p.lvl *= 0.5;
      speaking.sort((a, b) => b.lvl - a.lvl);
      rs.top = new Set(speaking.slice(0, this.cfg.audioTopN).map(p => p.sid));
      const best = speaking[0];
      const cur = [...rs.peers.values()].find(p => p.sid === rs.speaker);
      if (best && best.lvl >= SPEAKER_MIN && best.sid !== rs.speaker) {
        const curLvl = cur && now - cur.lastAudio < 1000 ? cur.lvl : 0;
        if ((now - rs.speakerAt > 1200 && best.lvl > curLvl * 1.15) || curLvl < SPEAKER_MIN * 0.6) {
          rs.speaker = best.sid; rs.speakerAt = now; this.broadcast(rs, { t: 'speaker', sid: best.sid });
        }
      }
      for (const p of rs.peers.values()) {
        if (p.degraded && now - p.degradedAt > 15000 && p.drops.filter(t => now - t < 10000).length === 0) {
          p.degraded--; p.degradedAt = now; this.recomputeEff(p); this.recomputeNeeds(rs);
          this.send(p, { t: 'quality', level: p.degraded ? 'low' : 'ok', step: p.degraded });
        }
      }
      if (now % 2000 < 250) this.broadcast(rs, { t: 'levels', l: [...rs.peers.values()].filter(p => p.state.mic).map(p => [p.sid, Math.round(p.lvl)]) });
    }
  }
}
