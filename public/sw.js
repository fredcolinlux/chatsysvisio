// Service worker minimal : rend l'app installable et garde l'interface disponible hors ligne.
// Ne met jamais en cache l'API, les fichiers partagés ni le WebSocket.
// __ASSET_VERSION__ est remplacé par le serveur par le numéro de build : chaque mise à jour crée un nouveau cache,
// le nouveau service worker s'active aussitôt (skipWaiting + clients.claim) et supprime les anciens caches.
const V = '__ASSET_VERSION__';
const CACHE = 'cc-shell-' + V;
const SHELL = ['/', '/public', '/css/app.css', '/js/common.js', '/js/icons.js', '/js/home.js', '/js/e2ee.js', '/js/room-e2ee.js', '/js/public.js', '/js/plain.js', '/fonts/Inter.woff2', '/icons/icon-192.png', '/manifest.webmanifest'];
const withV = u => /^\/(js|css)\//.test(u) ? u + '?v=' + V : u;
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(withV))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', e => { if (e.data === 'purge') e.waitUntil(caches.keys().then(ks => Promise.all(ks.map(k => caches.delete(k))))); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/f/') || u.pathname.startsWith('/ws/') || u.pathname.startsWith('/vendor/')) return;
  // Réseau d'abord (mises à jour immédiates), cache en secours hors ligne.
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok && SHELL.includes(u.pathname)) { const c = r.clone(); caches.open(CACHE).then(x => x.put(e.request, c)); }
    return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('/'))));
});
