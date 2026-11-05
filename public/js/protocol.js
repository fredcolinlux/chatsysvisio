// Format binaire des paquets média (partagé client/serveur).
// En-tête 12 octets : type u8 | sid u16 | layer u8 | flags u8 | codec u8 | ts u32 | level u8 | seq u8
// type : 1 = vidéo, 2 = audio. sid : identifiant numérique de l'émetteur (rempli par le serveur).
// layer : 0 = caméra vignette (144p), 1 = caméra 360p, 2 = partage d'écran, 3 = caméra HD (720p/1080p) ; 0 pour l'audio.
// flags : bit0 = image clé ; vidéo : bit1 = plage pleine (0-255), bit2 = matrice BT.601 (sinon BT.709) — VP8 ne transporte pas son espace colorimétrique. level : niveau audio 0..255 (audio) ou 0.
export const HEADER = 12;
export const T_VIDEO = 1, T_AUDIO = 2;
export const L_LO = 0, L_HI = 1, L_SCREEN = 2, L_HD = 3;
export const LAYERS = [L_LO, L_HI, L_SCREEN, L_HD];
export const F_KEY = 1, F_FULL = 2, F_BT601 = 4, F_CS = 8; // F_CS : bits 1-2 renseignés
// Espace colorimétrique ↔ bits de l'en-tête (null = inconnu : on laisse le décodeur décider, comme avant 1.5.1)
export const csFlags = cs => !cs || !cs.matrix ? 0 : (cs.fullRange ? F_FULL : 0) | (/smpte170m|bt470bg/.test(cs.matrix) ? F_BT601 : 0) | F_CS;
export function flagsCs(f) {
  if (!(f & F_CS)) return null;
  const p = f & F_BT601 ? 'smpte170m' : 'bt709';
  return { fullRange: !!(f & F_FULL), matrix: p, primaries: p, transfer: f & F_FULL && !(f & F_BT601) ? 'iec61966-2-1' : p };
}
export const CODECS = { vp8: 1, avc: 2, jpeg: 3, opus: 10, adpcm: 11 };
export const CODEC_NAMES = Object.fromEntries(Object.entries(CODECS).map(([k, v]) => [v, k]));
export const MAX_PARTICIPANTS = 25;

export function pack(h, payload) {
  const p = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  const out = new Uint8Array(HEADER + p.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, h.type); dv.setUint16(1, h.sid || 0); dv.setUint8(3, h.layer || 0);
  dv.setUint8(4, h.flags || 0); dv.setUint8(5, h.codec || 0); dv.setUint32(6, (h.ts >>> 0) || 0);
  dv.setUint8(10, Math.max(0, Math.min(255, h.level | 0))); dv.setUint8(11, (h.seq || 0) & 255);
  out.set(p, HEADER);
  return out;
}

export function unpack(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < HEADER) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return {
    type: dv.getUint8(0), sid: dv.getUint16(1), layer: dv.getUint8(3), flags: dv.getUint8(4),
    codec: dv.getUint8(5), ts: dv.getUint32(6), level: dv.getUint8(10), seq: dv.getUint8(11),
    payload: u8.subarray(HEADER),
  };
}

// Réécrit l'identifiant d'émetteur dans un paquet (côté serveur, sans copie).
export function setSid(u8, sid) { u8[1] = (sid >> 8) & 255; u8[2] = sid & 255; }
export function peekType(u8) { return u8[0]; }
export function peekLayer(u8) { return u8[3]; }
export function peekKey(u8) { return (u8[4] & F_KEY) !== 0; }
export function peekLevel(u8) { return u8[10]; }

// Version du protocole client ↔ serveur. 2 : salons chiffrés de bout en bout (1.3). Un client qui ne l'annonce pas
// (1.2 ou plus ancien, resté en cache) est refusé dans un salon chiffré : il enverrait du son et des images en clair
// que les autres ne savent pas lire (« pas de son »).
export const PROTO = 2;
