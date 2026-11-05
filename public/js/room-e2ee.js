// Clé de salon côté navigateur : lecture du fragment #k=, mot de passe, cache local, vérification (kcv).
import { parseKeyFragment, keyFragment, passwordKey, accessToken, roomSecret, RoomKeys, MediaCrypto, KeyAgreement, b64u, unb64u } from './e2ee.js';

// Cache : le secret du lien en localStorage (c'est l'équivalent du lien, utile pour « Récents ») ;
// un secret issu d'un mot de passe seulement en sessionStorage (oublié à la fermeture de l'onglet).
export const keyCache = {
  get(slug) {
    const read = st => { try { return JSON.parse(st.getItem('cc-k:' + slug) || 'null'); } catch { return null; } };
    return { ...(read(localStorage) || {}), ...(read(sessionStorage) || {}) };
  },
  set(slug, { link, secret, pw }) {
    if (link) localStorage.setItem('cc-k:' + slug, JSON.stringify({ s: b64u(link) }));
    if (secret && pw) sessionStorage.setItem('cc-k:' + slug, JSON.stringify({ r: b64u(secret) }));
  },
  del(slug) { localStorage.removeItem('cc-k:' + slug); sessionStorage.removeItem('cc-k:' + slug); },
};

const needsLink = mode => mode === 'link' || mode === 'link+pw';
export const needsPw = mode => mode === 'pw' || mode === 'link+pw';

// État initial à l'ouverture d'un salon. Renvoie { status, e2 } :
//  'plain' (pas de chiffrement de bout en bout), 'ok' (clé prête), 'needpw', 'nolink', 'badlink', 'badkey'.
export async function prepare(info, slug, hash) {
  const e = info.e2ee; if (!e) return { status: 'plain' };
  const salt = unb64u(e.salt), cache = keyCache.get(slug);
  const e2 = { mode: e.mode, salt, iter: e.iter, link: null, secret: null, keys: null };
  if (needsLink(e.mode)) {
    const frag = parseKeyFragment(hash);
    if (frag === false) return { status: 'badlink', e2 };
    let link = frag;
    if (!link && cache.s) try { link = unb64u(cache.s); } catch {}
    if (!link) return { status: 'nolink', e2 };
    e2.link = link;
    if (frag && cache.s && cache.s !== b64u(frag)) keyCache.del(slug); // nouveau lien : on oublie l'ancien secret
  }
  if (e.mode === 'link') {
    e2.secret = await roomSecret({ link: e2.link, salt });
  } else {
    const c = keyCache.get(slug);
    if (c.r && info.authorized) try { e2.secret = unb64u(c.r); } catch {}
    if (!e2.secret) return { status: 'needpw', e2 };
  }
  return check(info, slug, e2);
}
async function check(info, slug, e2) {
  e2.keys = await RoomKeys.create(e2.secret, e2.salt);
  if (info.e2ee.kcv && info.e2ee.kcv !== e2.keys.kcv) { keyCache.del(slug); e2.keys = e2.secret = null; return { status: 'badkey', e2 }; }
  keyCache.set(slug, { link: e2.link, secret: e2.secret, pw: needsPw(e2.mode) });
  return { status: 'ok', e2 };
}
// Mot de passe saisi : clé (PBKDF2, dans le navigateur) et jeton d'accès envoyé au serveur à la place du mot de passe.
export async function fromPassword(e2, pw) {
  const pwKey = await passwordKey(pw, e2.salt, e2.iter);
  return { token: await accessToken(pwKey, e2.salt), secret: await roomSecret({ link: e2.link, pwKey, salt: e2.salt }) };
}
export async function finish(info, slug, e2, secret) { e2.secret = secret; return check(info, slug, e2); }

export async function startSession(e2) {
  const media = new MediaCrypto(e2.keys);
  const ka = await new KeyAgreement({ keys: e2.keys, media, send: () => {} }).init();
  return { media, ka };
}
export const inviteUrl = (origin, slug, e2) => `${origin}/r/${slug}` + (e2?.link ? '#' + keyFragment(e2.link) : '');
