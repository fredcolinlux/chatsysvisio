// Tableau blanc : format des traits et règles communes au navigateur et au serveur (aucune dépendance au DOM).
// Coordonnées entières normalisées sur une feuille 16:9 de W × H unités, indépendantes de la taille d'écran.
export const W = 10000, H = 5625;
export const TOOLS = ['pen', 'eraser', 'line', 'rect', 'ellipse', 'arrow'];
export const SHAPES = new Set(['line', 'rect', 'ellipse', 'arrow']);
export const COLORS = ['#1b1f26', '#2f6fe4', '#e5484d', '#2f9e5b', '#8e4ec6'];
export const WIDTHS = [2, 5, 12];          // épaisseurs proposées, en millièmes de la largeur de la feuille
export const MAX_W = 60;
export const MAX_PTS = 400;                // points par trait (un trait plus long est découpé en plusieurs)
export const LIMITS = Object.freeze({
  items: 5000,            // traits conservés par tableau
  bytes: 4_000_000,       // taille cumulée des traits conservés
  enc: 12000,             // taille d'un trait chiffré (base64url)
  undo: 40,               // traits retirés par message « annuler »
  rate: { live: 40, add: 20, undo: 10, meta: 3 }, // messages par seconde et par personne
});
export const ID_RE = /^[a-z0-9]{8,16}$/;

export function newId() {
  const a = new Uint8Array(8); crypto.getRandomValues(a);
  return [...a].map(b => (b % 36).toString(36)).join('') + Date.now().toString(36).slice(-4);
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
// Trait : { id, k (outil), c (couleur), w (épaisseur), pr (pression : points x,y,p), p: [x, y(, p), …] }
// live : fragment en cours de tracé ({ n } = indice du premier point du fragment), non conservé par le serveur.
export function validStroke(s, { live = false } = {}) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) return false;
  if (!TOOLS.includes(s.k) || !isInt(s.c, 0, COLORS.length - 1) || !isInt(s.w, 1, MAX_W)) return false;
  if (s.pr !== undefined && typeof s.pr !== 'boolean') return false;
  const st = s.pr ? 3 : 2, p = s.p;
  if (!Array.isArray(p) || p.length === 0 || p.length % st || p.length / st > MAX_PTS) return false;
  if (SHAPES.has(s.k) && p.length / st !== 2) return false;
  for (let i = 0; i < p.length; i += st) {
    if (!isInt(p[i], 0, W) || !isInt(p[i + 1], 0, H)) return false;
    if (st === 3 && !isInt(p[i + 2], 0, 100)) return false;
  }
  if (live) { if (!isInt(s.n, 0, MAX_PTS)) return false; } else if (s.n !== undefined) return false;
  const allowed = live ? ['id', 'k', 'c', 'w', 'pr', 'p', 'n'] : ['id', 'k', 'c', 'w', 'pr', 'p'];
  return Object.keys(s).every(k => allowed.includes(k));
}

// Copie propre (champs connus seulement) : ce qui est conservé et rediffusé.
export const cleanStroke = s => ({ id: s.id, k: s.k, c: s.c, w: s.w, ...(s.pr ? { pr: true } : {}), p: s.p.slice() });

// Lissage léger à la saisie : un point n'est gardé que s'il s'éloigne assez du précédent.
export function keepPoint(pts, x, y, st, minDist = 12) {
  const n = pts.length; if (n < st) return true;
  const dx = x - pts[n - st], dy = y - pts[n - st + 1];
  return dx * dx + dy * dy >= minDist * minDist;
}
