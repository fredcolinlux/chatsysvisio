// Réglages modifiables à chaud depuis l'administration. Stockés dans DATA_DIR/settings.json (0600), appliqués sur la
// configuration en mémoire sans redémarrage ; /etc/chatsysvisio/chatsysvisio.env n'est jamais réécrit (il garde les
// valeurs par défaut, le fichier de réglages les surcharge).
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './accounts.mjs';
import { hashPassword } from './security.mjs';

export const SIGNUP_MODES = ['closed', 'open', 'invite', 'approval'];
// clé : [type, min, max]
export const SCHEMA = {
  allowAnonCreate: ['bool'],
  accountsOnlyCreate: ['bool'],
  guestJoin: ['bool'],
  createPer10Min: ['int', 1, 1000],
  maxParticipants: ['int', 2, 25],
  roomQuotaMb: ['int', 1, 100000],
  uploadMaxMb: ['int', 1, 2048],
  maxRooms: ['int', 10, 100000],
  signupMode: ['enum', SIGNUP_MODES],
};

export class Settings {
  constructor(dir, cfg) {
    this.file = path.join(dir, 'settings.json'); this.cfg = cfg;
    cfg.signupMode ??= 'closed'; cfg.accountsOnlyCreate ??= false; cfg.guestJoin ??= true;
    this.defaults = Object.fromEntries(Object.keys(SCHEMA).map(k => [k, cfg[k]]));
    this.defaults.createPasswordHash = cfg.createPasswordHash;
    let saved = {}; try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    this.values = {}; this.listeners = [];
    this.apply(saved, { save: false });
  }
  onChange(fn) { this.listeners.push(fn); }
  // Valide et applique ; renvoie { changed: [clés] } ou lève une erreur (status 400).
  apply(input, { save = true } = {}) {
    const changed = [];
    for (const [k, v] of Object.entries(input || {})) {
      if (k === 'createCode') { // code de création en clair → empreinte scrypt ; '' = supprimer
        const code = String(v ?? '');
        if (code && (code.length < 4 || code.length > 200)) throw Object.assign(new Error('Code de création : 4 à 200 caractères.'), { status: 400 });
        this.values.createPasswordHash = code ? hashPassword(code) : ''; this.cfg.createPasswordHash = this.values.createPasswordHash; changed.push('createCode'); continue;
      }
      if (k === 'createPasswordHash') { if (typeof v === 'string' && (v === '' || v.startsWith('scrypt$'))) { this.values.createPasswordHash = v; this.cfg.createPasswordHash = v; } continue; }
      const s = SCHEMA[k]; if (!s) continue;
      let val;
      if (s[0] === 'bool') val = v === true || v === 'true' || v === 1 || v === 'on';
      else if (s[0] === 'int') { val = parseInt(v, 10); if (!Number.isFinite(val) || val < s[1] || val > s[2]) throw Object.assign(new Error(`${k} : entre ${s[1]} et ${s[2]}.`), { status: 400 }); }
      else if (s[0] === 'enum') { if (!s[1].includes(v)) throw Object.assign(new Error(`${k} : valeur invalide.`), { status: 400 }); val = v; }
      if (this.cfg[k] !== val) changed.push(k);
      this.cfg[k] = val; this.values[k] = val;
    }
    if (save && changed.length) atomicWrite(this.file, JSON.stringify(this.values, null, 1));
    if (changed.length) for (const fn of this.listeners) fn(changed);
    return { changed };
  }
  // Vue pour l'administration (jamais l'empreinte du code)
  view() {
    const o = Object.fromEntries(Object.keys(SCHEMA).map(k => [k, this.cfg[k]]));
    o.hasCreateCode = !!this.cfg.createPasswordHash;
    o.overridden = Object.keys(this.values).filter(k => k !== 'createPasswordHash');
    return o;
  }
}
