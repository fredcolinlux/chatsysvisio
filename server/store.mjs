// Persistance simple (fichiers JSON/JSONL dans DATA_DIR) : salons, messages, fichiers partagés.
// Pas de dépendance native : fonctionne avec le Node.js de Debian 13.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function slugify(name) {
  return String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
}

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export const MAX_HISTORY = 300;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.msgDir = path.join(dir, 'messages');
    this.fileDir = path.join(dir, 'files');
    for (const d of [dir, this.msgDir, this.fileDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    this.roomsFile = path.join(dir, 'rooms.json');
    this.rooms = new Map();
    try {
      const arr = JSON.parse(fs.readFileSync(this.roomsFile, 'utf8'));
      for (const r of arr) this.rooms.set(r.slug, r);
    } catch {}
    this.history = new Map();
    this.usage = null; // octets de fichiers par salon (calculé à la première demande)
    this._saveTimer = null;
  }

  saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveNow(); }, 500);
    this._saveTimer.unref?.();
  }
  saveNow() { atomicWrite(this.roomsFile, JSON.stringify([...this.rooms.values()], null, 1)); }

  getRoom(slug) { return this.rooms.get(String(slug || '')) || null; }
  // Les salons privés reçoivent un suffixe aléatoire : leur lien n'est pas devinable à partir du nom.
  createRoom({ name, passwordHash = null, isPublic = false, limit = 0, e2ee = null }) {
    let slug = slugify(name);
    if (slug && !isPublic) {
      const A = 'abcdefghjkmnpqrstuvwxyz23456789';
      do slug = slugify(name).slice(0, 40) + '-' + [...crypto.randomBytes(6)].map(b => A[b % A.length]).join('');
      while (this.rooms.has(slug));
    }
    if (!slug) throw Object.assign(new Error('Nom de salon invalide'), { code: 'invalid' });
    if (this.rooms.has(slug)) throw Object.assign(new Error('Ce salon existe déjà'), { code: 'exists', slug });
    const now = Date.now();
    const room = { id: crypto.randomBytes(9).toString('hex'), slug, name: String(name).trim().slice(0, 64),
      passwordHash, isPublic: !!isPublic, limit: limit | 0, created: now, active: now, ...(e2ee ? { e2ee } : {}) };
    this.rooms.set(slug, room); this.saveNow();
    return room;
  }
  // Salon toujours présent (pas supprimé entre-temps) : rien n'est écrit sur le disque pour un salon supprimé.
  live(room) { return !!room && this.rooms.get(room.slug) === room; }
  touch(room) { room.active = Date.now(); this.saveSoon(); }
  publicRooms() { return [...this.rooms.values()].filter(r => r.isPublic).sort((a, b) => b.active - a.active); }

  deleteRoom(room) {
    if (this.rooms.get(room.slug) === room) this.rooms.delete(room.slug);
    this.history.delete(room.id); this.saveNow();
    try { fs.rmSync(path.join(this.msgDir, `${room.id}.jsonl`), { force: true }); } catch {}
    for (const f of fs.readdirSync(this.fileDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.fileDir, f), 'utf8'));
        if (m.roomId === room.id) this.deleteFile(m.id);
      } catch {}
    }
    this.usage?.delete(room.id);
  }

  expire(ttlDays, isActive = () => false) {
    const lim = Date.now() - ttlDays * 86400e3; let n = 0;
    for (const r of [...this.rooms.values()]) if (r.active < lim && !isActive(r)) { this.deleteRoom(r); n++; }
    return n;
  }

  // --- messages ---
  messages(room) {
    let h = this.history.get(room.id);
    if (h) return h;
    h = [];
    const f = path.join(this.msgDir, `${room.id}.jsonl`);
    try {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      const byId = new Map();
      for (const l of lines) {
        try { const m = JSON.parse(l); if (m.op === 'react') { const t = byId.get(m.id); if (t) { t.reactions = m.reactions; if (m.rx) t.rx = m.rx; if (m.erx) t.erx = m.erx; } } else { byId.set(m.id, m); } } catch {}
      }
      h = [...byId.values()].slice(-MAX_HISTORY);
      if (lines.length > MAX_HISTORY * 3) atomicWrite(f, h.map(m => JSON.stringify(m)).join('\n') + '\n');
    } catch {}
    this.history.set(room.id, h);
    return h;
  }
  addMessage(room, msg) {
    const h = this.messages(room);
    h.push(msg); if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
    if (!this.live(room)) { this.history.delete(room.id); return msg; }
    fs.appendFileSync(path.join(this.msgDir, `${room.id}.jsonl`), JSON.stringify(msg) + '\n', { mode: 0o600 });
    return msg;
  }
  setReactions(room, id, reactions, rx, erx) {
    const m = this.messages(room).find(x => x.id === id);
    if (!m) return null;
    m.reactions = reactions; if (rx) m.rx = rx; if (erx) m.erx = erx;
    if (!this.live(room)) return m;
    fs.appendFileSync(path.join(this.msgDir, `${room.id}.jsonl`), JSON.stringify({ op: 'react', id, reactions, rx, erx }) + '\n', { mode: 0o600 });
    return m;
  }

  // --- fichiers ---
  saveFile(room, { name, type, data }) {
    if (!this.live(room)) throw Object.assign(new Error('Ce salon n\'existe plus.'), { status: 404 });
    const id = crypto.randomBytes(12).toString('base64url');
    const meta = { id, roomId: room.id, name: String(name).slice(0, 120), type, size: data.length, created: Date.now() };
    fs.writeFileSync(path.join(this.fileDir, id), data, { mode: 0o600 });
    atomicWrite(path.join(this.fileDir, `${id}.json`), JSON.stringify(meta));
    if (this.usage) this.usage.set(room.id, (this.usage.get(room.id) || 0) + data.length);
    return meta;
  }
  roomUsage(roomId) {
    if (!this.usage) {
      this.usage = new Map();
      for (const f of fs.readdirSync(this.fileDir)) {
        if (!f.endsWith('.json')) continue;
        try { const m = JSON.parse(fs.readFileSync(path.join(this.fileDir, f), 'utf8')); this.usage.set(m.roomId, (this.usage.get(m.roomId) || 0) + (m.size || 0)); } catch {}
      }
    }
    return this.usage.get(roomId) || 0;
  }
  fileMeta(id) {
    if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.fileDir, `${id}.json`), 'utf8')); } catch { return null; }
  }
  filePath(id) { return path.join(this.fileDir, id); }
  deleteFile(id) {
    if (this.usage) { const m = this.fileMeta(id); if (m) this.usage.set(m.roomId, Math.max(0, (this.usage.get(m.roomId) || 0) - (m.size || 0))); }
    for (const f of [id, `${id}.json`]) try { fs.rmSync(path.join(this.fileDir, f), { force: true }); } catch {} }
}
