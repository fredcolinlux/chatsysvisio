// Utilitaires partagés par toutes les pages (aucun script inline : compatible CSP stricte).
import { icon, hydrateIcons } from './icons.js';
export { icon, hydrateIcons };

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// ---- Thème ----
// Sans choix enregistré, on suit le système (prefers-color-scheme) ; un choix explicite pose .light ou .dark.
const THEME_COLORS = { light: '#fbfcfd', dark: '#16181d' };
const mqLight = window.matchMedia?.('(prefers-color-scheme: light)');
export function currentTheme() {
  const t = localStorage.getItem('cc-theme');
  return t === 'light' || t === 'dark' ? t : (mqLight?.matches ? 'light' : 'dark');
}
export function applyTheme() {
  const stored = localStorage.getItem('cc-theme'), t = currentTheme();
  document.documentElement.classList.toggle('light', t === 'light');
  document.documentElement.classList.toggle('dark', stored === 'dark');
  for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
    const m = meta.getAttribute('media') || '';
    // balises « media » : chacune garde sa couleur tant que l'utilisateur suit le système
    meta.setAttribute('content', stored || !m ? THEME_COLORS[t] : (m.includes('light') ? THEME_COLORS.light : THEME_COLORS.dark));
  }
}
export function toggleTheme() {
  localStorage.setItem('cc-theme', currentTheme() === 'light' ? 'dark' : 'light');
  applyTheme(); refreshThemeButtons();
}
function refreshThemeButtons() {
  const light = currentTheme() === 'light';
  $$('[data-theme-toggle]').forEach(b => { b.replaceChildren(icon(light ? 'moon' : 'sun')); b.title = light ? 'Thème sombre' : 'Thème clair'; b.setAttribute('aria-label', b.title); });
}
applyTheme();
mqLight?.addEventListener?.('change', () => { if (!localStorage.getItem('cc-theme')) { applyTheme(); refreshThemeButtons(); } });

// ---- API ----
let csrf = null, sessionInfo = null, sessionPending = null;
// ---- Version du code chargé ----
// Le serveur inscrit son numéro de build dans la page (data-build) et versionne les scripts (?v=build). Si la page
// vient d'un cache (navigateur, proxy, service worker) et ne correspond plus au serveur, on vide les caches et on
// recharge une fois ; si cela ne suffit pas, on demande un rechargement forcé (Ctrl+F5).
export const BUILD = document.documentElement.dataset.build || '';
export async function ensureFresh(serverBuild) {
  if (!serverBuild || !BUILD || String(serverBuild) === BUILD) return true;
  const key = 'cc-reloaded-' + serverBuild;
  let tried = false; try { tried = sessionStorage.getItem(key) === '1'; sessionStorage.setItem(key, '1'); } catch {}
  if (tried) { toast(`Nouvelle version de ChatSysVisio (build ${serverBuild}) : recharge la page avec Ctrl+F5.`, { error: true, ms: 15000 }); return false; }
  toast('Nouvelle version, rechargement…', { ms: 5000 });
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch {}
  try { const regs = await navigator.serviceWorker?.getRegistrations?.() || []; await Promise.all(regs.map(r => r.update().catch(() => {}))); } catch {}
  location.reload();
  return new Promise(() => {}); // la page se recharge
}
// Relit la session sans le cache local (après une coupure : le serveur a pu être mis à jour).
export async function freshSession() { sessionInfo = null; return session(); }

export async function session() {
  if (sessionInfo) return sessionInfo;
  // une seule requête même si plusieurs modules la demandent en même temps
  sessionPending ??= fetch('/api/session', { credentials: 'same-origin' }).then(r => r.json())
    .then(j => { sessionInfo = j; csrf = j.csrf; return j; }).finally(() => { sessionPending = null; });
  return sessionPending;
}
// Après connexion / déconnexion d'un compte : nouvel identifiant de session et nouveau jeton CSRF.
export function resetSession(newCsrf) { sessionInfo = null; sessionPending = null; csrf = newCsrf || null; }
export async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  if (method !== 'GET' && !csrf) await session();
  const opt = { method, credentials: 'same-origin', headers: { ...headers } };
  if (method !== 'GET') opt.headers['X-CSRF-Token'] = csrf;
  if (body !== undefined) {
    if (raw) opt.body = body; else { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(path, opt);
  let data = null; try { data = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(data?.error || `Erreur ${r.status}`); e.status = r.status; e.data = data; throw e; }
  return data;
}

// ---- Notifications ----
// Notifications (esprit Sonner) : entrée CSS (@starting-style), sortie animée plus courte, minuterie en pause
// quand l'onglet est masqué ou que le pointeur survole la notification (on ne rate pas un message).
export function toast(text, { error = false, action, onAction, ms = 3800 } = {}) {
  let w = $('.toast-wrap'); if (!w) { w = h('div', { class: 'toast-wrap', role: 'status', 'aria-live': 'polite' }); document.body.append(w); }
  const t = h('div', { class: 'toast' + (error ? ' err' : '') }, text);
  let left = ms, started = Date.now(), timer = null, gone = false;
  const dismiss = () => {
    if (gone) return; gone = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis);
    t.classList.add('out');
    const rm = () => t.remove();
    t.addEventListener('transitionend', rm, { once: true }); setTimeout(rm, 260);
  };
  const run = () => { if (gone || document.hidden || t.matches(':hover')) return; started = Date.now(); timer = setTimeout(dismiss, left); };
  const pause = () => { if (timer) { clearTimeout(timer); timer = null; left = Math.max(800, left - (Date.now() - started)); } };
  const vis = () => (document.hidden ? pause() : run());
  document.addEventListener('visibilitychange', vis);
  t.addEventListener('pointerenter', pause); t.addEventListener('pointerleave', run);
  if (action) t.append(h('button', { onclick: () => { onAction?.(); dismiss(); } }, action));
  w.append(t); run();
  while (w.children.length > 4) w.firstChild.remove();
}

// ---- Avatars ----
export function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0]?.[0] || '?') + (p.length > 1 ? p[p.length - 1][0] : (p[0]?.[1] || ''))).toUpperCase();
}
export function colorOf(name) { let x = 0; for (const c of String(name)) x = (x * 31 + c.codePointAt(0)) >>> 0; return 'c' + (x % 8); }
export function avatar(name, cls = '') { return h('span', { class: `av ${colorOf(name)} ${cls}`, 'aria-hidden': 'true' }, initials(name)); }

// ---- Salons récents (stockés localement) ----
export function recentRooms() { try { return JSON.parse(localStorage.getItem('cc-recent') || '[]'); } catch { return []; } }
export function rememberRoom(slug, name) {
  const list = recentRooms().filter(r => r.slug !== slug);
  list.unshift({ slug, name, t: Date.now() }); localStorage.setItem('cc-recent', JSON.stringify(list.slice(0, 12)));
}
export function forgetRoom(slug) { localStorage.setItem('cc-recent', JSON.stringify(recentRooms().filter(r => r.slug !== slug))); }
export function myName() { return localStorage.getItem('cc-name') || ''; }
export function setMyName(n) { localStorage.setItem('cc-name', String(n || '').slice(0, 40)); }

export function whenAgo(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'à l\'instant'; if (m < 60) return `il y a ${m} min`;
  const hh = Math.round(m / 60); if (hh < 24) return `il y a ${hh} h`;
  const d = Math.round(hh / 24); return d === 1 ? 'hier' : `il y a ${d} j`;
}

// ---- Barre latérale commune ----
export async function renderSidebar(activeSlug = '') {
  const side = $('#side'); if (!side) return;
  const list = recentRooms();
  const box = $('#recent', side); box.replaceChildren();
  if (!list.length) box.append(h('div', { class: 'empty' }, 'Tes salons apparaîtront ici.'));
  const items = new Map();
  for (const r of list) {
    const it = h('a', { class: 'sitem' + (r.slug === activeSlug ? ' on' : ''), href: `/r/${r.slug}` }, h('span', { class: 'dot' }), h('span', { class: 't' }, r.name || r.slug), h('span', { class: 'meta' }, whenAgo(r.t)));
    items.set(r.slug, it); box.append(it);
  }
  if (list.length) {
    try {
      const st = await api('/api/rooms/status?slugs=' + encodeURIComponent(list.map(r => r.slug).join(',')));
      for (const [slug, v] of Object.entries(st)) {
        const it = items.get(slug); if (!it) continue;
        if (v === null) { forgetRoom(slug); it.remove(); continue; }
        if (v?.count > 0) { it.firstChild.className = 'live'; it.lastChild.textContent = `${v.count} en ligne`; }
      }
    } catch {}
  }
}

export function initChrome({ activeSlug = '' } = {}) {
  hydrateIcons();
  refreshThemeButtons();
  $$('[data-theme-toggle]').forEach(b => b.addEventListener('click', toggleTheme));
  renderSidebar(activeSlug);
  session().then(s => {
    // lien « Compte » dans la barre latérale (connexion / inscription, ou pseudo du compte connecté)
    const side = $('#side'), scroll = side && $('.scroll', side);
    if (scroll && !$('#accLink') && (s.account || s.signupMode !== 'closed' || s.accountsOnly || !s.guestJoin || s.createForAccounts)) {
      scroll.before(h('a', { class: 'sitem' + (location.pathname.startsWith('/compte') ? ' on' : ''), id: 'accLink', href: '/compte' }, icon('user'),
        h('span', { class: 't' }, s.account ? s.account.name : 'Se connecter'), s.account ? h('span', { class: 'meta' }, 'compte') : null));
    }
  }).catch(() => {});
  session().then(s => ensureFresh(s.build)).catch(() => {});
  session().then(s => { const v = $('#version'); if (v && s.version) { v.textContent = 'v' + s.version + (s.build ? ' · b' + s.build : ''); v.title = `Version ${s.version}${s.build ? ', build ' + s.build : ''}`; } }).catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {});
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); location.href = '/#nouveau'; }
  });
}

export function fmtSize(n) { return n < 1024 ? `${n} o` : n < 1048576 ? `${Math.round(n / 1024)} Ko` : `${(n / 1048576).toFixed(1)} Mo`; }
