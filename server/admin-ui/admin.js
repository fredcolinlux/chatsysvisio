// Interface d'administration de ChatSysVisio (aucune bibliothèque externe ; graphiques SVG construits en JS).
import { h, $, $$, toast, avatar, toggleTheme, fmtSize } from '/js/common.js';
import { icon, hydrateIcons } from '/js/icons.js';

const BASE = location.pathname.replace(/\/+$/, '');
let csrf = '', me = null, timer = null, section = 'overview', lastOverview = null;

async function call(path, { method = 'GET', body } = {}) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') { opt.headers['X-CSRF-Token'] = csrf; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
  const r = await fetch(`${BASE}/api/${path}`, opt);
  let d = null; try { d = await r.json(); } catch {}
  if (r.status === 401 && path !== 'login') { showLogin('Session expirée : reconnecte-toi.'); throw new Error('Session expirée'); }
  if (!r.ok) { const e = new Error(d?.error || `Erreur ${r.status}`); e.status = r.status; throw e; }
  return d;
}

// ---------- formats ----------
const n0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }), n1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const kbps = k => k >= 1000 ? `${n1.format(k / 1000)} Mbit/s` : `${n0.format(k)} kbit/s`;
const bytes = b => b >= 1073741824 ? `${n1.format(b / 1073741824)} Go` : fmtSize(b);
const dur = s => { const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d} j ${hh} h` : hh ? `${hh} h ${m} min` : `${m} min`; };
const dt = t => t ? new Date(t).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
const tm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

// ---------- modale de confirmation ----------
function modal(title, ...content) {
  const bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => bg.remove();
  bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.append(h('div', { class: 'modal' }, h('h3', {}, title, h('button', { class: 'iconbtn', title: 'Fermer', onclick: close }, icon('x'))), ...content));
  document.body.append(bg); return close;
}
function confirmBox(title, text, okLabel, { danger = true, extra = null } = {}) {
  return new Promise(res => {
    let done = false;
    const close = modal(title, h('p', { class: 'sub' }, text), extra,
      h('div', { class: 'crow mend' }, h('button', { class: 'btn', onclick: () => { done = true; close(); res(false); } }, 'Annuler'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'pri'), id: 'confirmOk', onclick: () => { done = true; close(); res(true); } }, okLabel)));
  });
}

// ---------- connexion ----------
function showLogin(msg = '') {
  clearInterval(timer); $('#shell').hidden = true; $('#tabbar').hidden = true; $('#login').hidden = false;
  $('#loginErr').textContent = msg; setTimeout(() => $('#user').focus(), 30);
}
$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault(); $('#loginErr').textContent = '';
  const btn = e.submitter || $('#loginForm button'); btn.disabled = true;
  try {
    const r = await call('login', { method: 'POST', body: { user: $('#user').value, password: $('#password').value, code: $('#code').value } });
    csrf = r.csrf; me = r.user; $('#password').value = ''; $('#code').value = '';
    if (r.backupLeft < 3) toast(`Attention : il ne reste que ${r.backupLeft} code(s) de secours.`, { error: true, ms: 8000 });
    start();
  } catch (x) { $('#loginErr').textContent = x.message; $('#code').value = ''; $('#code').focus(); }
  finally { btn.disabled = false; }
});

// ---------- navigation ----------
const SECTIONS = [
  ['overview', 'Vue d\'ensemble', 'grid', 'Vue'], ['rooms', 'Salons', 'users', 'Salons'], ['settings', 'Réglages', 'gear', 'Réglages'],
  ['accounts', 'Comptes', 'user', 'Comptes'], ['events', 'Journal', 'file', 'Journal'], ['system', 'Système', 'shield', 'Système'],
];
function nav() {
  const mk = (cls) => SECTIONS.map(([id, label, ic, short]) => {
    const a = h('a', { class: cls + (section === id ? ' on' : ''), href: '#' + id, dataset: { s: id } }, icon(ic), cls === 'sitem' ? h('span', { class: 't' }, label) : short);
    if (id === 'accounts' && lastOverview?.pending) a.append(h('span', { class: 'n' }, String(lastOverview.pending)));
    return a;
  });
  $('#nav').replaceChildren(...mk('sitem')); $('#tabbar').replaceChildren(...mk(''));
}
window.addEventListener('hashchange', () => { const s = location.hash.slice(1); if (SECTIONS.some(x => x[0] === s)) { section = s; render(); } });

function start() {
  $('#login').hidden = true; $('#shell').hidden = false; $('#tabbar').hidden = false;
  $('#who').textContent = me; $('#who').prepend(icon('user'));
  const s = location.hash.slice(1); if (SECTIONS.some(x => x[0] === s)) section = s;
  render();
  clearInterval(timer); timer = setInterval(() => { if (!document.hidden && ['overview', 'rooms', 'events', 'system'].includes(section) && !$('.modal-bg')) render(true); }, 10000);
}
async function render(refresh = false) {
  const t = SECTIONS.find(x => x[0] === section); $('#title').textContent = t[1]; document.title = `${t[1]} · Administration · ChatSysVisio`;
  nav();
  const page = $('#page');
  try {
    const content = await VIEWS[section](refresh);
    if (content) { const y = page.scrollTop; page.replaceChildren(content); if (refresh) page.scrollTop = y; }
  } catch (x) { if (!refresh) page.replaceChildren(h('div', { class: 'empty-box' }, x.message)); }
}

// ---------- graphiques SVG ----------
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
function chart(title, series, { fmt = x => x, legend = [], max = 0 } = {}) {
  const W = 600, H = 110, pts = series[0]?.data.length || 0;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': title });
  let top = max; for (const s of series) for (const v of s.data) top = Math.max(top, v);
  if (!top) top = 1;
  for (const f of [0, .5, 1]) svg.append(sv('line', { class: 'grid', x1: 0, x2: W, y1: H - f * (H - 14) - 1, y2: H - f * (H - 14) - 1 }));
  series.forEach((s, i) => {
    if (pts < 2) return;
    const xy = s.data.map((v, j) => [j / (pts - 1) * W, H - 1 - v / top * (H - 14)]);
    const d = xy.map(([x, y], j) => `${j ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    if (i === 0) svg.append(sv('path', { class: s.cls + 'f', d: `${d}L${W},${H}L0,${H}Z` }));
    svg.append(sv('path', { class: s.cls, d, 'vector-effect': 'non-scaling-stroke' }));
  });
  const lab = sv('text', { class: 'ax', x: 2, y: 10 }); lab.textContent = fmt(top); svg.append(lab);
  if (pts < 2) { const t = sv('text', { class: 'ax', x: W / 2, y: H / 2, 'text-anchor': 'middle' }); t.textContent = 'Collecte en cours (un point toutes les 10 s)…'; svg.append(t); }
  return h('div', { class: 'chart' }, h('div', { class: 'h' }, title, h('span', { class: 'leg' }, ...legend.map(([k, l]) => h('span', {}, h('b', { class: k }), l)))), svg);
}
function kpi(ic, label, value, sub = '', pct = null) {
  const k = h('div', { class: 'kpi' }, h('div', { class: 'l' }, icon(ic), label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
  if (pct !== null) { const i = h('i'); i.style.width = Math.min(100, Math.max(0, pct)) + '%'; k.append(h('div', { class: 'bar' + (pct > 90 ? ' bad' : pct > 75 ? ' warn' : '') }, i)); }
  return k;
}

// ---------- vues ----------
const VIEWS = {};
VIEWS.overview = async () => {
  const o = await call('overview'); lastOverview = o; const s = o.stats;
  const memUsed = s.mem.total - s.mem.free, last = s.series[s.series.length - 1] || {};
  const diskUsed = s.disk ? s.disk.total - s.disk.free : 0;
  const ser = k => s.series.map(p => p[k] || 0);
  return h('div', {},
    h('h2', {}, 'Vue d\'ensemble'), h('p', { class: 'sub' }, `ChatSysVisio ${s.version || '?'} · build ${s.build || '?'} · Node ${s.node} · ${s.cpus} cœur(s)`),
    h('div', { class: 'kpis' },
      kpi('users', 'Participants', String(s.people), `${s.rooms} salon(s) actif(s) · ${s.storedRooms} au total`),
      kpi('up', 'Débit entrant', kbps(last.inKbps || 0), `${bytes(s.totals.inBytes)} depuis le démarrage`),
      kpi('down', 'Débit sortant', kbps(last.outKbps || 0), `${bytes(s.totals.outBytes)} depuis le démarrage`),
      kpi('spark', 'Processeur', `${n0.format(last.cpu ?? 0)} %`, `ChatSysVisio : ${n1.format(last.proc ?? 0)} % · charge ${s.load.join(' / ')}`, last.cpu ?? 0),
      kpi('grid', 'Mémoire', `${n0.format(memUsed / s.mem.total * 100)} %`, `${bytes(memUsed)} / ${bytes(s.mem.total)} · ChatSysVisio ${bytes(s.mem.rss)}`, memUsed / s.mem.total * 100),
      kpi('file', 'Disque (données)', s.disk ? `${n0.format(diskUsed / s.disk.total * 100)} %` : '—', s.disk ? `${bytes(s.disk.free)} libres · données ${bytes(s.dataSize)}` : '', s.disk ? diskUsed / s.disk.total * 100 : null),
      kpi('clock', 'En service depuis', dur(s.uptime), `machine : ${dur(s.sysUptime)}`),
      kpi('user', 'Comptes', String(o.accounts), o.pending ? `${o.pending} en attente de validation` : 'aucun en attente'),
    ),
    h('h3', {}, icon('spark'), 'Dernière heure'),
    h('div', { class: 'charts' },
      chart('Débit du relais', [{ cls: 'c1', data: ser('outKbps') }, { cls: 'c2', data: ser('inKbps') }], { fmt: kbps, legend: [['k1', 'sortant'], ['k2', 'entrant']] }),
      chart('Processeur', [{ cls: 'c1', data: ser('cpu') }, { cls: 'c3', data: ser('proc') }], { fmt: v => `${n0.format(v)} %`, max: 100, legend: [['k1', 'machine'], ['k3', 'ChatSysVisio']] }),
      chart('Mémoire de ChatSysVisio', [{ cls: 'c2', data: s.series.map(p => p.rss / 1048576) }], { fmt: v => `${n0.format(v)} Mo` }),
      chart('Participants', [{ cls: 'c1', data: ser('people') }, { cls: 'c3', data: ser('rooms') }], { fmt: v => n0.format(v), max: 4, legend: [['k1', 'participants'], ['k3', 'salons']] }),
    ),
    h('h3', {}, icon('shield'), 'Événements depuis le démarrage'),
    h('div', { class: 'kpis' }, ...[['connexion', 'Connexions', 'door'], ['blocage', 'Blocages (429…)', 'x'], ['refus', 'IP refusées', 'lock'], ['auth', 'Échecs de connexion', 'shield']]
      .map(([k, l, ic]) => kpi(ic, l, String(o.counts[k] || 0)))));
};

VIEWS.rooms = async () => {
  const r = await call('rooms');
  const live = r.live.length ? r.live.map(room => h('div', { class: 'room' },
    h('div', { class: 'rh' }, icon(room.isPublic ? 'globe' : 'lock'), h('span', { class: 't' }, room.name), h('span', { class: 'badge' }, `${room.people.length} / ${room.limit}`),
      room.hasPassword ? h('span', { class: 'badge' }, icon('lock'), 'mot de passe') : null, room.e2ee ? h('span', { class: 'badge', title: 'Contenu illisible pour le serveur et l\'administration : seules les métadonnées (noms, heures, tailles) sont visibles.' }, icon('shield'), 'bout en bout') : null, h('span', { class: 'mono muted' }, '/r/' + room.slug),
      h('span', { class: 'ml' },
        h('button', { class: 'btn sm', onclick: () => closeRoom(room, false) }, icon('x'), 'Fermer'),
        h('button', { class: 'btn sm danger', onclick: () => closeRoom(room, true) }, 'Supprimer'))),
    h('div', { class: 'tblwrap' }, h('table', { class: 'tbl cards-m' },
      h('thead', {}, h('tr', {}, ...['Participant', 'Depuis', 'Qualité / couches', 'Médias', 'IP', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, ...room.people.map(p => h('tr', {},
        h('td', {}, h('span', { class: 'who' }, avatar(p.name), p.name, p.account ? h('span', { class: 'badge acc' }, 'compte') : h('span', { class: 'badge' }, 'invité'))),
        h('td', { class: 'num', 'data-l': 'Depuis' }, `${dt(p.since).split(' ')[1] || ''} · ${p.minutes} min`),
        h('td', { 'data-l': 'Qualité' }, h('span', { class: 'badge' + (p.vq >= 720 ? ' acc' : '') }, p.vq ? `${p.vq}p` : '—'), ' ',
          h('span', { class: 'muted' }, `${(p.codec || '?').toUpperCase()} · couches ${p.sends.length ? p.sends.join(',') : '—'} · reçoit ${p.subs}${p.hd ? ` (${p.hd} HD)` : ''}`),
          p.degraded ? h('span', { class: 'badge warn' }, `réseau lent −${p.degraded}`) : null),
        h('td', { 'data-l': 'Médias' }, h('span', { class: p.mic ? 'pill-ok' : 'muted' }, icon(p.mic ? 'mic' : 'micoff')), ' ', h('span', { class: p.cam ? 'pill-ok' : 'muted' }, icon('cam')), p.screen ? h('span', { class: 'pill-ok' }, ' ', icon('screen')) : null),
        h('td', { class: 'mono', 'data-l': 'IP' }, p.ip),
        h('td', {}, h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: () => kick(room, p) }, 'Exclure'))))))))))
    : [h('div', { class: 'empty-box' }, 'Aucun salon actif en ce moment.')];
  return h('div', {},
    h('h2', {}, 'Salons'), h('p', { class: 'sub' }, 'Salons en cours et participants (IP partiellement masquées). Fermer déconnecte tout le monde ; supprimer efface aussi messages et fichiers.'),
    ...live,
    r.bans.length ? h('div', {}, h('h3', {}, icon('lock'), 'Bannissements temporaires'), h('table', { class: 'tbl cards-m' }, h('tbody', {}, ...r.bans.map(b => h('tr', {},
      h('td', {}, b.name), h('td', { class: 'mono' }, b.ip), h('td', { class: 'num' }, `jusqu'à ${dt(b.until)}`),
      h('td', {}, h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: async () => { await call('bans/remove', { method: 'POST', body: { id: b.id } }); toast('Bannissement levé.'); render(); } }, 'Lever')))))))) : null,
    h('h3', {}, icon('grid'), `Tous les salons (${r.stored.length})`),
    h('div', { class: 'tblwrap' }, h('table', { class: 'tbl cards-m' },
      h('thead', {}, h('tr', {}, ...['Salon', 'Type', 'En ligne', 'Fichiers', 'Dernière activité', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, ...r.stored.slice(0, 200).map(x => h('tr', {},
        h('td', {}, h('b', {}, x.name), ' ', h('span', { class: 'mono muted' }, x.slug)),
        h('td', { 'data-l': 'Type' }, x.isPublic ? 'public' : 'privé', x.hasPassword ? ' · mot de passe' : '', x.e2ee ? ' · chiffré de bout en bout' : '',
          x.expiresIn != null ? h('div', { class: 'muted', title: 'Salon public vide : supprimé automatiquement si personne ne revient' }, x.expiresIn < 60e3 ? 'vide · suppression imminente' : `vide · supprimé dans ${Math.ceil(x.expiresIn / 60e3)} min`) : null),
        h('td', { class: 'num', 'data-l': 'En ligne' }, String(x.people)), h('td', { class: 'num', 'data-l': 'Fichiers' }, `${n1.format(x.usageMb)} Mo`),
        h('td', { class: 'num', 'data-l': 'Activité' }, dt(x.active)),
        h('td', {}, h('div', { class: 'acts' }, h('button', { class: 'btn sm danger', onclick: () => closeRoom(x, true) }, 'Supprimer')))))))));
};
async function closeRoom(room, del) {
  if (!(await confirmBox(del ? `Supprimer « ${room.name} » ?` : `Fermer « ${room.name} » ?`, del ? 'Tout le monde est déconnecté et le salon est effacé avec ses messages et fichiers. Irréversible.' : 'Tout le monde est déconnecté. Le salon reste disponible et on pourra le rejoindre à nouveau' + (room.isPublic ? ' (salon public : supprimé automatiquement s\'il reste vide).' : '.'), del ? 'Supprimer' : 'Fermer'))) return;
  try { const r = await call('rooms/close', { method: 'POST', body: { roomId: room.id, delete: del } }); toast(`${del ? 'Supprimé' : 'Fermé'} : ${r.disconnected} personne(s) déconnectée(s).`); render(); } catch (x) { toast(x.message, { error: true }); }
}
async function kick(room, p) {
  const sel = h('select', { class: 'adm-in', id: 'banMin' }, ...[['0', 'Sans bannissement'], ['10', 'Bannir 10 min'], ['60', 'Bannir 1 h'], ['1440', 'Bannir 24 h']].map(([v, l]) => h('option', { value: v }, l)));
  if (!(await confirmBox(`Exclure ${p.name} ?`, `${p.name} est déconnecté de « ${room.name} ». Avec un bannissement, son adresse et sa session ne peuvent plus revenir dans ce salon pendant la durée choisie.`, 'Exclure', { extra: h('div', { class: 'field' }, sel) }))) return;
  try { await call('kick', { method: 'POST', body: { roomId: room.id, peerId: p.id, banMinutes: +sel.value } }); toast(`${p.name} a été exclu.`); render(); } catch (x) { toast(x.message, { error: true }); }
}

const MODES = [['closed', 'Fermée'], ['open', 'Libre'], ['invite', 'Sur invitation'], ['approval', 'Validation par l\'admin']];
VIEWS.settings = async () => {
  const s = await call('settings'); const form = {};
  const tog = (k, label, desc) => { const b = h('button', { type: 'button', class: 'tg' + (s[k] ? ' on' : ''), id: 'set-' + k, 'aria-pressed': String(!!s[k]), onclick: () => { s[k] = !s[k]; b.classList.toggle('on', s[k]); b.setAttribute('aria-pressed', String(s[k])); form[k] = s[k]; } },
    h('span', { class: 'd' }, h('b', {}, label), h('small', {}, desc)), h('span', { class: 'sw' })); return b; };
  const num = (k, label, desc, min, max, unit = '') => { const i = h('input', { type: 'number', id: 'set-' + k, min, max, value: s[k], onchange: () => { form[k] = +i.value; } });
    return h('label', { class: 'numrow', for: 'set-' + k }, h('span', { class: 'd' }, h('b', {}, label), h('small', {}, desc)), i, unit ? h('span', { class: 'muted' }, unit) : null); };
  const mode = h('select', { id: 'set-signupMode', onchange: () => { form.signupMode = mode.value; } }, ...MODES.map(([v, l]) => h('option', { value: v, selected: s.signupMode === v }, l)));
  const code = h('input', { type: 'password', id: 'set-createCode', class: 'adm-in', placeholder: s.hasCreateCode ? '•••••• (défini)' : 'aucun', autocomplete: 'new-password', maxlength: 200 });
  const save = async () => {
    const body = { ...form }; if (code.value) body.createCode = code.value;
    if (!Object.keys(body).length) { toast('Rien à enregistrer.'); return; }
    try { const r = await call('settings', { method: 'POST', body }); toast(r.changed.length ? 'Réglages enregistrés et appliqués.' : 'Aucun changement.'); render(); } catch (x) { toast(x.message, { error: true }); }
  };
  return h('div', {},
    h('h2', {}, 'Réglages'), h('p', { class: 'sub' }, 'Appliqués immédiatement, sans redémarrage. Ils sont enregistrés dans les données (settings.json) et priment sur le fichier de configuration, qui n\'est jamais réécrit.'),
    h('h3', {}, icon('plus'), 'Création de salons'),
    h('div', { class: 'setgrid' },
      tog('allowAnonCreate', 'Création libre', 'Tout le monde peut créer un salon sans code.'),
      tog('accountsOnlyCreate', 'Réservée aux comptes', 'Seuls les comptes connectés peuvent créer un salon.'),
      h('label', { class: 'numrow', for: 'set-createCode' }, h('span', { class: 'd' }, h('b', {}, 'Code de création'), h('small', {}, 'Demandé si la création n\'est pas libre. Vide = inchangé.')), code,
        s.hasCreateCode ? h('button', { type: 'button', class: 'btn sm', onclick: async () => { await call('settings', { method: 'POST', body: { createCode: '' } }); toast('Code supprimé.'); render(); } }, 'Retirer') : null),
      num('createPer10Min', 'Créations / 10 min / IP', 'CREATE_PER_10MIN', 1, 1000),
      num('maxRooms', 'Salons au maximum', 'MAX_ROOMS', 10, 100000)),
    h('h3', {}, icon('users'), 'Salons'),
    h('div', { class: 'setgrid' },
      num('maxParticipants', 'Personnes par salon', 'Maximum 25', 2, 25),
      num('roomQuotaMb', 'Espace fichiers par salon', 'ROOM_QUOTA_MB', 1, 100000, 'Mo'),
      num('uploadMaxMb', 'Taille max d\'un fichier', 'UPLOAD_MAX_MB', 1, 2048, 'Mo'),
      tog('guestJoin', 'Invités autorisés', 'Rejoindre un salon par lien sans compte.')),
    h('h3', {}, icon('user'), 'Comptes'),
    h('div', { class: 'setgrid' }, h('label', { class: 'numrow', for: 'set-signupMode' }, h('span', { class: 'd' }, h('b', {}, 'Inscriptions'), h('small', {}, 'Fermée, libre, sur invitation ou validée par l\'admin.')), mode)),
    h('div', { class: 'savebar' }, h('button', { class: 'btn', onclick: () => render() }, 'Annuler'), h('button', { class: 'btn pri', id: 'saveSettings', onclick: save }, icon('check'), 'Enregistrer')));
};

const ST = { active: ['ok', 'actif'], pending: ['warn', 'en attente'], disabled: ['bad', 'désactivé'] };
VIEWS.accounts = async () => {
  const a = await call('accounts');
  const act = async (u, action, label) => {
    if (['delete', 'disable', 'reset'].includes(action) && !(await confirmBox(`${label} « ${u.name} » ?`, action === 'delete' ? 'Le compte est supprimé et son pseudo redevient libre.' : action === 'reset' ? 'Un mot de passe temporaire va être généré et affiché une seule fois.' : 'Le compte est déconnecté et ne peut plus se connecter.', label))) return;
    try {
      const r = await call('accounts/action', { method: 'POST', body: { id: u.id, action } });
      if (r.password) modal('Mot de passe temporaire', h('p', { class: 'sub' }, `À transmettre à ${u.name} par un canal sûr. Il ne sera plus affiché.`), h('div', { class: 'secret', id: 'tmpPw' }, r.password));
      else toast('C\'est fait.');
      render();
    } catch (x) { toast(x.message, { error: true }); }
  };
  const days = h('input', { type: 'number', class: 'adm-in', min: 1, max: 90, value: 7, id: 'invDays' }), uses = h('input', { type: 'number', class: 'adm-in', min: 1, max: 100, value: 1, id: 'invUses' });
  return h('div', {},
    h('h2', {}, 'Comptes'), h('p', { class: 'sub' }, `Inscriptions : ${MODES.find(m => m[0] === a.signupMode)?.[1] || a.signupMode} (modifiable dans Réglages). Un compte réserve son pseudo dans tous les salons.`),
    a.users.length ? h('div', { class: 'tblwrap' }, h('table', { class: 'tbl cards-m', id: 'accTable' },
      h('thead', {}, h('tr', {}, ...['Pseudo', 'État', 'Créé', 'Dernière connexion', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, ...a.users.map(u => h('tr', { dataset: { name: u.name } },
        h('td', {}, h('span', { class: 'who' }, avatar(u.name), u.name)),
        h('td', { 'data-l': 'État' }, h('span', { class: 'badge ' + ST[u.status][0] }, ST[u.status][1])),
        h('td', { class: 'num', 'data-l': 'Créé' }, dt(u.created)), h('td', { class: 'num', 'data-l': 'Connexion' }, dt(u.lastLogin)),
        h('td', {}, h('div', { class: 'acts' },
          u.status === 'pending' ? h('button', { class: 'btn sm pri', onclick: () => act(u, 'approve', 'Valider') }, 'Valider') : null,
          u.status === 'disabled' ? h('button', { class: 'btn sm', onclick: () => act(u, 'enable', 'Réactiver') }, 'Réactiver') : null,
          u.status === 'active' ? h('button', { class: 'btn sm', onclick: () => act(u, 'disable', 'Désactiver') }, 'Désactiver') : null,
          h('button', { class: 'btn sm', onclick: () => act(u, 'reset', 'Réinitialiser') }, 'Mot de passe'),
          h('button', { class: 'btn sm danger', onclick: () => act(u, 'delete', 'Supprimer') }, 'Supprimer')))))))) : h('div', { class: 'empty-box' }, 'Aucun compte pour l\'instant.'),
    h('h3', {}, icon('link'), 'Invitations'),
    h('div', { class: 'filters' }, h('span', { class: 'muted' }, 'Valable'), days, h('span', { class: 'muted' }, 'jour(s),'), uses, h('span', { class: 'muted' }, 'utilisation(s)'),
      h('button', { class: 'btn pri sm', id: 'newInvite', onclick: async () => {
        try { const r = await call('invites/new', { method: 'POST', body: { days: +days.value, uses: +uses.value } });
          modal('Code d\'invitation', h('p', { class: 'sub' }, 'À transmettre à la personne invitée (page Compte → Inscription). Il ne sera plus affiché.'), h('div', { class: 'secret', id: 'invCode' }, r.code)); render(); }
        catch (x) { toast(x.message, { error: true }); } } }, icon('plus'), 'Créer une invitation')),
    a.invites.length ? h('table', { class: 'tbl cards-m' }, h('tbody', {}, ...a.invites.slice().reverse().map(i => h('tr', {},
      h('td', { class: 'num' }, `créée ${dt(i.created)}`), h('td', { class: 'num' }, `${i.uses} / ${i.maxUses} utilisée(s)`),
      h('td', { class: 'num' }, i.expires < Date.now() ? h('span', { class: 'badge bad' }, 'expirée') : `expire ${dt(i.expires)}`),
      h('td', {}, h('div', { class: 'acts' }, h('button', { class: 'btn sm', onclick: async () => { await call('invites/revoke', { method: 'POST', body: { id: i.id } }); render(); } }, 'Révoquer'))))))) : null);
};

const TYPES = [['', 'Tous'], ['connexion', 'Connexions'], ['blocage', 'Blocages'], ['refus', 'IP refusées'], ['auth', 'Échecs de connexion'], ['admin', 'Actions admin'], ['compte', 'Comptes'], ['salon', 'Salons']];
const TCLS = { connexion: '', blocage: 'warn', refus: 'bad', auth: 'bad', admin: 'acc', compte: 'ok', salon: '' };
let evFilter = { type: '', q: '' };
VIEWS.events = async (refresh) => {
  if (refresh && document.activeElement?.id === 'evq') return null;
  const qs = new URLSearchParams({ type: evFilter.type, q: evFilter.q, limit: 300 });
  const r = await call('events?' + qs);
  const sel = h('select', { id: 'evtype', onchange: () => { evFilter.type = sel.value; render(); } }, ...TYPES.map(([v, l]) => h('option', { value: v, selected: v === evFilter.type }, l)));
  const q = h('input', { id: 'evq', placeholder: 'Filtrer (IP, salon, pseudo…)', value: evFilter.q, maxlength: 100 });
  let deb; q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { evFilter.q = q.value; render().then(() => { const e = $('#evq'); e.focus(); e.setSelectionRange(e.value.length, e.value.length); }); }, 350); });
  return h('div', {},
    h('h2', {}, 'Journal'), h('p', { class: 'sub' }, `Connexions, blocages (limites de débit, 429), IP refusées, échecs de connexion et actions d'administration. Rotation automatique : ${r.files.length} fichier(s), 1 Mo chacun, 5 conservés. Aucun mot de passe ni code n'y figure.`),
    h('div', { class: 'filters' }, h('div', { class: 'inp' }, icon('search'), q), sel),
    r.events.length ? h('div', { class: 'tblwrap' }, h('table', { class: 'tbl cards-m', id: 'evTable' },
      h('thead', {}, h('tr', {}, ...['Heure', 'Type', 'Événement', 'IP'].map(x => h('th', {}, x)))),
      h('tbody', {}, ...r.events.map(e => h('tr', {},
        h('td', { class: 'num' }, `${new Date(e.ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} ${tm(e.ts)}`),
        h('td', {}, h('span', { class: 'badge ' + (TCLS[e.type] || '') }, TYPES.find(t => t[0] === e.type)?.[1] || e.type)),
        h('td', {}, e.msg, e.by ? h('span', { class: 'muted' }, ` — ${e.by}`) : null, e.room ? h('span', { class: 'mono muted' }, ` /r/${e.room}`) : null),
        h('td', { class: 'mono', 'data-l': 'IP' }, e.ip || '')))))) : h('div', { class: 'empty-box' }, 'Aucun événement.'));
};

VIEWS.system = async () => {
  const r = await call('system'); const st = r.status;
  const upd = st?.updates;
  const backups = st?.backups || [];
  return h('div', {},
    h('h2', {}, 'Système'), h('p', { class: 'sub' }, 'Version installée, mises à jour Debian en attente et sauvegardes. Ces informations sont relevées par le service système chatsysvisio-status (toutes les heures et à la demande).'),
    h('div', { class: 'sysgrid' },
      kpi('shield', 'Version installée', `${r.version || '?'} · build ${r.build || '?'}`, st?.lastAppUpdate ? `mise à jour le ${dt(st.lastAppUpdate.at)}${st.lastAppUpdate.from ? ` (depuis ${st.lastAppUpdate.from})` : ''}` : `Node ${r.node}`),
      kpi('down', 'Mises à jour Debian', upd ? (upd.count ? `${upd.count} en attente` : 'à jour') : '—', upd ? `${upd.security || 0} de sécurité · vérifié ${dt(st.at)}` : 'état pas encore relevé'),
      kpi('clock', 'Dernières mises à jour auto', st?.unattended?.lastRun ? dt(st.unattended.lastRun) : '—', st?.unattended ? (st.unattended.enabled ? 'unattended-upgrades actif' : 'unattended-upgrades inactif') : ''),
      kpi('file', 'Dernière sauvegarde', backups[0] ? dt(backups[0].at) : 'aucune', backups[0] ? `${bytes(backups[0].size)} · ${backups.length} conservée(s)` : 'sauvegarde quotidienne à 03:40'),
    ),
    upd?.packages?.length ? h('div', {}, h('h3', {}, icon('down'), 'Paquets à mettre à jour'), h('p', { class: 'mono' }, upd.packages.slice(0, 40).join(', ') + (upd.packages.length > 40 ? '…' : ''))) : null,
    h('h3', {}, icon('file'), 'Sauvegardes'),
    h('div', { class: 'filters' },
      h('button', { class: 'btn pri sm', id: 'backupNow', disabled: r.pendingBackup, onclick: async () => { try { await call('backup', { method: 'POST' }); toast('Sauvegarde demandée : elle démarre dans quelques secondes.'); render(); } catch (x) { toast(x.message, { error: true }); } } }, icon('down'), r.pendingBackup ? 'Sauvegarde en cours…' : 'Sauvegarder maintenant'),
      h('button', { class: 'btn sm', disabled: r.pendingStatus, onclick: async () => { await call('status-refresh', { method: 'POST' }); toast('Actualisation demandée.'); setTimeout(() => render(), 4000); } }, icon('clock'), 'Actualiser l\'état'),
      h('span', { class: 'muted' }, st?.backupDir ? `Dossier : ${st.backupDir} (root, 0700) · ${st.keepDays || 14} jours conservés` : '')),
    backups.length ? h('table', { class: 'tbl cards-m', id: 'backupTable' }, h('thead', {}, h('tr', {}, h('th', {}, 'Fichier'), h('th', {}, 'Date'), h('th', {}, 'Taille'))),
      h('tbody', {}, ...backups.map(b => h('tr', {}, h('td', { class: 'mono' }, b.name), h('td', { class: 'num', 'data-l': 'Date' }, dt(b.at)), h('td', { class: 'num', 'data-l': 'Taille' }, bytes(b.size))))))
      : h('div', { class: 'empty-box' }, st ? 'Aucune sauvegarde pour l\'instant.' : 'État système pas encore relevé (le service chatsysvisio-status tourne au démarrage puis toutes les heures).'),
    h('p', { class: 'hint' }, icon('shield'), 'Restauration : voir README-INSTALL.md, section « Exploitation » (commande Restaurer). Les archives restent lisibles par root uniquement.'));
};

// ---------- démarrage ----------
hydrateIcons();
$$('[data-theme-toggle]').forEach(b => b.addEventListener('click', toggleTheme));
$('#logout').addEventListener('click', async () => { try { await call('logout', { method: 'POST' }); } catch {} me = null; location.reload(); });
(async () => {
  let r; try { r = await (await fetch(`${BASE}/api/me`, { credentials: 'same-origin' })).json(); } catch { document.body.textContent = 'Serveur injoignable.'; return; }
  csrf = r.csrf; $('#ver').textContent = `v${r.version || '?'} · b${r.build || '?'}`; $('#loginVer').textContent = `ChatSysVisio ${r.version || ''} · build ${r.build || ''} · session admin : ${r.idleMin} min d'inactivité max.`;
  $('#noAdmin').hidden = r.hasAdmin;
  if (r.user) { me = r.user; start(); } else showLogin();
})();
