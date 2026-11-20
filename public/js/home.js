import { $, h, api, toast, initChrome, session, recentRooms, whenAgo, toggleTheme, myName } from './common.js';
import { rand, b64u, keyFragment, passwordKey, accessToken, roomSecret, RoomKeys, modeFor, PBKDF2_ITER, E2EE_V } from './e2ee.js';
import { keyCache } from './room-e2ee.js';
initChrome();
document.querySelector('[data-theme-tab]')?.addEventListener('click', e => { e.preventDefault(); toggleTheme(); });

const hr = new Date().getHours();
$('#hello').textContent = (hr >= 18 || hr < 5 ? 'Bonsoir' : 'Bonjour') + (myName() ? ' ' + myName() : '');

const ta = $('#roomName'), go = $('#go'), form = $('#create');
let isPublic = false, wantPw = false, needCreatePw = false, wantE2ee = !!globalThis.crypto?.subtle;
const autosize = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
const goLabel = () => { const l = go.querySelector('span'); if (l) l.textContent = roomFromText(ta.value) ? 'Rejoindre' : 'Créer'; };
ta.addEventListener('input', () => { go.disabled = ta.value.trim().length < 2; autosize(); goLabel(); });
goLabel();
ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
if (location.hash === '#nouveau') setTimeout(() => ta.focus(), 50);
window.addEventListener('hashchange', () => { if (location.hash === '#nouveau') ta.focus(); });

const chipPrivate = $('#chipPrivate');
chipPrivate.addEventListener('click', () => {
  isPublic = !isPublic;
  chipPrivate.classList.toggle('on', !isPublic); chipPrivate.setAttribute('aria-pressed', String(!isPublic));
  chipPrivate.querySelector('span').textContent = isPublic ? 'Public' : 'Privé';
  chipPrivate.title = isPublic ? 'Visible dans « Salons publics » ; sans mot de passe, supprimé quand il reste vide après le départ du dernier participant' : 'Invisible : accessible seulement avec le lien';
  paintE2ee();
});
// Bout en bout : activé par défaut pour les salons privés ; un salon public n'est jamais chiffré de bout en bout.
const chipE2ee = $('#chipE2ee');
function paintE2ee() {
  const on = wantE2ee && !isPublic;
  chipE2ee.classList.toggle('on', on); chipE2ee.setAttribute('aria-pressed', String(on));
  chipE2ee.disabled = isPublic;
  chipE2ee.title = isPublic ? 'Salon public : pas de chiffrement de bout en bout (tout reste visible du serveur, chiffré en TLS seulement)'
    : on ? 'Chiffré de bout en bout : ton serveur relaie sans pouvoir lire ni voir. Assistant IA indisponible.' : 'Sans chiffrement de bout en bout : TLS jusqu\'au serveur, assistant IA possible';
  $('#e2eeNote').textContent = isPublic ? 'Salon public : pas de chiffrement de bout en bout (chiffré en TLS jusqu\'à ton serveur).'
    : on ? 'Chiffré de bout en bout : la clé sera dans le lien, ton serveur ne la verra jamais.' : 'Sans chiffrement de bout en bout : TLS jusqu\'à ton serveur seulement.';
  $('#e2eeNote').className = 'e2eenote ' + (on ? 'ok' : 'warn');
}
chipE2ee.addEventListener('click', () => { if (isPublic) return; wantE2ee = !wantE2ee; paintE2ee(); });
paintE2ee();
const chipPw = $('#chipPw');
chipPw.addEventListener('click', () => {
  wantPw = !wantPw; chipPw.classList.toggle('on', wantPw); chipPw.setAttribute('aria-pressed', String(wantPw));
  $('#roomPw').hidden = !wantPw; refreshExtra(); if (wantPw) $('#roomPw').focus();
});
function refreshExtra() { $('#extra').hidden = $('#roomPw').hidden && $('#createPw').hidden; }

session().then(s => {
  needCreatePw = s.needCreatePassword; $('#createPw').hidden = !needCreatePw; refreshExtra();
  if (s.account) $('#hello').textContent = (hr >= 18 || hr < 5 ? 'Bonsoir' : 'Bonjour') + ' ' + s.account.name;
  if (s.createForAccounts) { // création réservée aux comptes
    const n = h('p', { class: 'hint', id: 'accOnly' }, 'La création de salons est réservée aux comptes. ', h('a', { href: '/compte?retour=/' }, 'Se connecter'), ' — tu peux toujours rejoindre un salon avec un lien.');
    form.after(n);
  }
}).catch(() => {});

// Lien collé → chemin du salon, en gardant le fragment (#k=… : clé de chiffrement de bout en bout).
function roomFromText(t) {
  t = t.trim();
  const m = t.match(/(?:^|\/)(?:r|room|chat)\/([a-z0-9-]{1,48})\/?(?:\?[^#]*)?(#.*)?$/i);
  if (m && t.includes('/')) return `/r/${m[1].toLowerCase()}${m[2] || ''}`;
  return null;
}
// Paramètres de chiffrement générés dans le navigateur : seuls le sel, les itérations et une valeur de contrôle partent.
async function e2eeParams(pw) {
  const mode = wantE2ee ? modeFor({ isPublic, password: pw }) : null;
  if (!mode) return { password: pw };
  const salt = rand(16), link = rand(32);
  const pwKey = pw ? await passwordKey(pw, salt, PBKDF2_ITER) : null;
  const secret = await roomSecret({ link, pwKey, salt });
  const keys = await RoomKeys.create(secret, salt);
  return { password: pwKey ? await accessToken(pwKey, salt) : '', e2ee: { v: E2EE_V, mode, salt: b64u(salt), iter: PBKDF2_ITER, kcv: keys.kcv }, link, secret, pw: !!pwKey };
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = ta.value.trim(); if (text.length < 2) return;
  const dest = roomFromText(text);
  if (dest) { location.href = dest; return; }
  const pw = wantPw ? $('#roomPw').value : '';
  if (pw && pw.length < 4) { toast('Mot de passe trop court (4 caractères minimum).', { error: true }); return; }
  go.disabled = true;
  try {
    const e = await e2eeParams(pw);
    const r = await api('/api/rooms', { method: 'POST', body: { name: text, isPublic, password: e.password, e2ee: e.e2ee, limit: +$('#limit').value, createPassword: $('#createPw').value } });
    if (e.e2ee) { keyCache.set(r.slug, { link: e.link, secret: e.secret, pw: e.pw }); location.href = r.url + '#' + keyFragment(e.link); }
    else location.href = r.url;
  } catch (err) {
    go.disabled = false;
    if (err.status === 409) toast(err.message, { action: 'Rejoindre', onAction: () => { location.href = `/r/${err.data.slug}`; }, ms: 8000 });
    else toast(err.message, { error: true });
  }
});

$('#pasteLink').addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    const dest = roomFromText(t || '');
    if (dest) { location.href = dest; return; }
  } catch {}
  ta.value = ''; ta.placeholder = 'Colle ici le lien d\'invitation complet (…/r/nom-du-salon#k=…)'; ta.focus();
});

// Récents : liste sur la page d'accueil (la barre latérale n'existe pas ici)
const recents = recentRooms().slice(1, 6), rbox = $('#homeRecent');
if (rbox && recents.length) {
  $('#recentLabel').hidden = false;
  const items = new Map();
  for (const r of recents) {
    const it = h('a', { class: 'card', href: `/r/${r.slug}` }, h('div', { class: 'h' }, h('span', { class: 'dot' }), h('span', { class: 't' }, r.name || r.slug)), h('div', { class: 'd' }, whenAgo(r.t)));
    items.set(r.slug, it); rbox.append(it);
  }
  api('/api/rooms/status?slugs=' + encodeURIComponent(recents.map(r => r.slug).join(','))).then(st => {
    for (const [slug, v] of Object.entries(st)) {
      const it = items.get(slug); if (!it) continue;
      if (v === null) { it.remove(); continue; }
      if (v?.count > 0) { it.querySelector('.dot').className = 'live'; it.querySelector('.d').textContent = `${v.count} en ligne`; }
    }
    if (!rbox.children.length) $('#recentLabel').hidden = true;
  }).catch(() => {});
}
const last = recentRooms()[0];
if (last) {
  const c = $('#lastRoom'); c.hidden = false; c.href = `/r/${last.slug}`;
  c.querySelector('.t').textContent = last.name || last.slug;
  c.querySelector('.d').textContent = `Reprendre · dernière visite ${whenAgo(last.t)}`;
  api('/api/rooms/status?slugs=' + encodeURIComponent(last.slug)).then(st => {
    const v = st[last.slug]; if (v?.count) { c.querySelector('.dot').className = 'live'; c.querySelector('.d').textContent = `${v.count} personne${v.count > 1 ? 's' : ''} en ligne`; }
    if (v === null) c.hidden = true;
  }).catch(() => {});
}
api('/api/rooms/public').then(list => {
  const n = list.length, live = list.reduce((a, r) => a + r.count, 0);
  $('#pubInfo').textContent = n ? `${n} salon${n > 1 ? 's' : ''} public${n > 1 ? 's' : ''}${live ? ` · ${live} en ligne` : ''}` : 'Aucun salon public pour l\'instant.';
}).catch(() => {});
