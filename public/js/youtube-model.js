// Lecteur YouTube partagé (1.13) : règles communes au navigateur et au serveur (aucune dépendance au DOM).
// Seul l'identifiant de vidéo (11 caractères) circule : jamais d'URL arbitraire.
export const ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const MAX_POS = 12 * 3600;         // 12 h : au-delà (direct très long), la position est bornée
export const DRIFT = 1.5;                 // écart (s) au-delà duquel un spectateur se recale
export const LIMITS = Object.freeze({ enc: 2000, rate: { state: 8, meta: 5 } });
export const ORIGIN = 'https://www.youtube-nocookie.com';
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

// « 1h2m3s », « 90 », « 1:02:03 » → secondes (entier, borné) ; null si illisible
export function parseTime(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase(); if (!s || s.length > 20) return null;
  let t = null;
  if (/^\d+(\.\d+)?s?$/.test(s)) t = parseFloat(s);
  else if (/^(\d+h)?(\d+m)?(\d+s)?$/.test(s)) { const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/); t = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); }
  else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(s)) t = s.split(':').reduce((a, x) => a * 60 + +x, 0);
  return t == null || !Number.isFinite(t) ? null : Math.min(MAX_POS, Math.floor(t));
}

// Lien collé (ou identifiant seul) → { id, t } ; null si ce n'est pas une vidéo YouTube reconnue.
// Formats : youtube.com/watch?v=, youtu.be/ID, /shorts/ID, /live/ID, /embed/ID, /v/ID, m. et music., youtube-nocookie.com.
export function parseYouTube(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 2048) return null;
  if (ID_RE.test(raw)) return { id: raw, t: 0 };
  let u; try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  let id = null;
  if (host === 'youtu.be') id = seg[0];
  else if (seg[0] === 'watch') id = u.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v', 'e'].includes(seg[0])) id = seg[1];
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const t = parseTime(u.searchParams.get('t') ?? u.searchParams.get('start') ?? (u.hash.match(/(?:^#|&)t=([^&]+)/)?.[1]));
  return { id, t: t || 0 };
}

const num = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
// État de lecture partagé : { id, pos (s), play (lecture en cours), rate, n (numéro d'ordre) }
export function validState(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (!Object.keys(s).every(k => ['id', 'pos', 'play', 'rate', 'n'].includes(k))) return false;
  return typeof s.id === 'string' && ID_RE.test(s.id) && num(s.pos, 0, MAX_POS) && typeof s.play === 'boolean'
    && RATES.includes(s.rate) && Number.isInteger(s.n) && s.n >= 0 && s.n < 2 ** 31;
}
export const cleanState = s => ({ id: s.id, pos: Math.round(s.pos * 100) / 100, play: s.play, rate: s.rate, n: s.n });
export const nearestRate = r => RATES.reduce((a, b) => Math.abs(b - r) < Math.abs(a - r) ? b : a, 1);

// Position attendue maintenant, pour un état reçu il y a ageMs millisecondes.
export function expectedPos(s, ageMs) {
  const p = s.play ? s.pos + Math.max(0, ageMs) / 1000 * s.rate : s.pos;
  return Math.min(MAX_POS, p);
}
// Correction de dérive d'un spectateur : 'seek' si l'écart dépasse DRIFT (hors mise en mémoire tampon / cooldown).
export function driftAction({ expected, actual, buffering = false, sinceSeekMs = Infinity, threshold = DRIFT }) {
  if (!Number.isFinite(actual) || buffering || sinceSeekMs < 2500) return 'none';
  return Math.abs(expected - actual) > threshold ? 'seek' : 'none';
}
// Droits : une seule personne partage à la fois ; elle seule pilote (lecture, pause, position, vitesse, changement, arrêt).
export const canControl = (share, peerId) => !!share && !!peerId && share.owner === peerId;
export function canOpen(share, peerId) {
  if (!share) return { ok: true };
  if (share.owner === peerId) return { ok: true, change: true };
  return { ok: false, message: `${share.ownerName || 'Quelqu\'un'} partage déjà une vidéo YouTube : il faut d'abord qu'il arrête son partage.` };
}

// Volume : strictement local à chaque participant (jamais envoyé au serveur).
export const VOL_KEY = 'csv-ytvol';
export function cleanVolume(v) {
  const o = v && typeof v === 'object' ? v : {};
  const vol = Number.isFinite(o.v) ? Math.max(0, Math.min(100, Math.round(o.v))) : 80;
  return { v: vol, m: o.m === true };
}
export function loadVolume(storage) { try { return cleanVolume(JSON.parse(storage.getItem(VOL_KEY) || 'null')); } catch { return cleanVolume(null); } }
export function saveVolume(storage, v) { const c = cleanVolume(v); try { storage.setItem(VOL_KEY, JSON.stringify(c)); } catch {} return c; }

// Erreurs du lecteur YouTube → message clair
export function errorMessage(code) {
  switch (+code) {
    case 2: return 'Identifiant de vidéo invalide.';
    case 5: return 'Cette vidéo ne peut pas être lue par le lecteur HTML5 de ce navigateur.';
    case 100: return 'Vidéo introuvable : elle a été supprimée ou rendue privée.';
    case 101: case 150: return 'Le propriétaire de cette vidéo n\'autorise pas sa lecture en dehors de YouTube : elle ne peut pas être intégrée au salon. Choisis une autre vidéo.';
    case 152: case 153: return 'YouTube a refusé d\'afficher le lecteur (configuration du lecteur). Recharge la page ; si ça persiste, une extension modifie peut-être les en-têtes Referer.';
    default: return `Le lecteur YouTube a signalé une erreur (code ${code | 0}).`;
  }
}
export const BLOCKED_MESSAGE = 'Le lecteur YouTube ne répond pas. Un bloqueur de publicités ou de contenu (uBlock, Brave, AdGuard, filtre réseau…) bloque peut-être youtube-nocookie.com : autorise-le pour ce site, ou ouvre la vidéo directement sur YouTube.';

// URL du lecteur intégré (identifiant validé uniquement) : API par postMessage, lecture en ligne (iPhone), sans vidéos d'autres chaînes.
export function embedUrl(id, { origin, start = 0, controls = true } = {}) {
  if (!ID_RE.test(id)) throw new Error('identifiant invalide');
  const q = new URLSearchParams({ enablejsapi: '1', playsinline: '1', rel: '0', iv_load_policy: '3', controls: controls ? '1' : '0', disablekb: controls ? '0' : '1', fs: '1' });
  if (origin) q.set('origin', origin);
  if (start > 0) q.set('start', String(Math.floor(start)));
  return `${ORIGIN}/embed/${id}?${q}`;
}
