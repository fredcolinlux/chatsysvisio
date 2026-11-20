// Journal des connexions, blocages et actions d'administration : DATA_DIR/logs/events.jsonl, rotation par taille
// (1 Mo × 5 fichiers), 2000 derniers événements en mémoire pour l'affichage. Jamais de mot de passe, code ou jeton.
import fs from 'node:fs';
import path from 'node:path';

export const EVENT_TYPES = { connexion: 'Connexion', blocage: 'Blocage', refus: 'IP refusée', auth: 'Échec de connexion', admin: 'Action admin', compte: 'Compte', salon: 'Salon' };
const SECRET_KEYS = /pass|code|secret|token|csrf|cookie|hash|totp/i;

export class EventLog {
  constructor(dir, { maxBytes = 1024 * 1024, keep = 5, memory = 2000, quiet = false } = {}) {
    this.dir = path.join(dir, 'logs'); fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.file = path.join(this.dir, 'events.jsonl'); Object.assign(this, { maxBytes, keep, memory, quiet });
    this.ring = []; this.counts = {};
    try { // reprend les derniers événements au démarrage
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-memory);
      for (const l of lines) try { this.ring.push(JSON.parse(l)); } catch {}
    } catch {}
    try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
  }
  add(type, msg, data = {}) {
    const clean = {};
    for (const [k, v] of Object.entries(data)) if (!SECRET_KEYS.test(k) && v !== undefined) clean[k] = typeof v === 'string' ? v.slice(0, 200) : v;
    const e = { ts: Date.now(), type, msg: String(msg).slice(0, 300), ...clean };
    this.ring.push(e); if (this.ring.length > this.memory) this.ring.splice(0, this.ring.length - this.memory);
    this.counts[type] = (this.counts[type] || 0) + 1;
    const line = JSON.stringify(e) + '\n';
    try {
      if (this.size + line.length > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, line, { mode: 0o600 }); this.size += Buffer.byteLength(line);
    } catch {}
    return e;
  }
  rotate() {
    for (let i = this.keep - 1; i >= 1; i--) { try { fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch {} }
    try { fs.renameSync(this.file, `${this.file}.1`); } catch {}
    try { fs.rmSync(`${this.file}.${this.keep + 1}`, { force: true }); } catch {}
    this.size = 0;
  }
  query({ type = '', q = '', limit = 200, before = 0 } = {}) {
    q = String(q).toLowerCase().slice(0, 100); limit = Math.min(1000, Math.max(1, limit | 0));
    const out = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i];
      if (before && e.ts >= before) continue;
      if (type && e.type !== type) continue;
      if (q && !JSON.stringify(e).toLowerCase().includes(q)) continue;
      out.push(e);
    }
    return out;
  }
  files() { try { return fs.readdirSync(this.dir).filter(f => f.startsWith('events.jsonl')).map(f => ({ name: f, size: fs.statSync(path.join(this.dir, f)).size })); } catch { return []; } }
}

// IP partiellement masquée pour l'affichage : 203.0.113.•• / 2001:db8:1:…
export function maskIp(ip) {
  ip = String(ip || '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, '.••');
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + ':…';
  return ip ? '•••' : '';
}
