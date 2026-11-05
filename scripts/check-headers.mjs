#!/usr/bin/env node
// Liste de contrôle des en-têtes, calquée sur les critères de WebGuardian (https://webguardian.cloud).
// Usage : node scripts/check-headers.mjs [http://127.0.0.1:8790] [--https]
//   --https : simule NPM (X-Forwarded-Proto: https ; à lancer depuis la machine elle-même, proxy de confiance 127.0.0.1)
// Code de sortie 0 si tout est conforme, 1 sinon. N'affiche jamais la valeur des cookies.
const base = (process.argv.slice(2).find(a => !a.startsWith('--')) || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const https = process.argv.includes('--https') || base.startsWith('https:');
const H = https && !base.startsWith('https:') ? { 'x-forwarded-proto': 'https' } : {};
let fail = 0, total = 0;
const ok = (cond, label, detail = '') => { total++; if (!cond) fail++; console.log(`  ${cond ? '✔' : '✘'} ${label}${!cond && detail ? ' — ' + detail : ''}`); };

async function page(path) { const r = await fetch(base + path, { headers: H, redirect: 'manual' }); return { r, g: k => r.headers.get(k) || '', body: await r.text() }; }

const home = await page('/');
const { g } = home;
console.log(`Contrôle des en-têtes : ${base}/ ${https ? (base.startsWith('https:') ? '(HTTPS)' : '(HTTPS simulé)') : ''}`);
const csp = g('content-security-policy');
ok(!!csp, 'Content-Security-Policy présente');
const d = Object.fromEntries(csp.split(';').map(x => x.trim().split(/\s+/)).filter(x => x[0]).map(([k, ...v]) => [k, v]));
ok(d['default-src']?.join(' ') === "'self'", "CSP default-src 'self'", d['default-src']?.join(' '));
ok(d['script-src'] && !d['script-src'].some(v => /unsafe-inline|unsafe-eval'|^\*|^https?:|^data:/.test(v)), 'CSP script-src sans inline / eval / origine externe', d['script-src']?.join(' '));
ok(d['style-src'] && !d['style-src'].some(v => /unsafe-inline|^https?:|^\*/.test(v)), 'CSP style-src sans inline / origine externe', d['style-src']?.join(' '));
ok(d['object-src']?.join(' ') === "'none'", "CSP object-src 'none'");
ok(d['base-uri']?.length > 0, 'CSP base-uri'); ok(d['form-action']?.length > 0, 'CSP form-action');
ok(d['frame-ancestors']?.join(' ') === "'none'", "CSP frame-ancestors 'none'");
ok(!/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(csp.replace(/wss?:\/\/\S+/g, '')), 'CSP : aucune origine externe');
ok(!/wasm-unsafe-eval/.test(csp), "CSP de l'accueil sans 'wasm-unsafe-eval' (réservé à la page d'appel)");
ok(g('x-frame-options') === 'DENY', 'X-Frame-Options: DENY', g('x-frame-options'));
ok(g('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
ok(/^(strict-origin-when-cross-origin|no-referrer|same-origin|strict-origin)$/.test(g('referrer-policy')), 'Referrer-Policy stricte', g('referrer-policy'));
const pp = g('permissions-policy');
ok(/camera=\(self\)/.test(pp) && /microphone=\(self\)/.test(pp) && /display-capture=\(self\)/.test(pp), 'Permissions-Policy : caméra, micro, capture d\'écran = self');
ok(/geolocation=\(\)/.test(pp) && /payment=\(\)/.test(pp), 'Permissions-Policy : géolocalisation, paiement interdits');
ok(g('cross-origin-opener-policy') === 'same-origin', 'Cross-Origin-Opener-Policy: same-origin');
ok(g('cross-origin-embedder-policy') === 'require-corp', 'Cross-Origin-Embedder-Policy: require-corp');
ok(g('cross-origin-resource-policy') === 'same-origin', 'Cross-Origin-Resource-Policy: same-origin');
ok(!g('x-powered-by') && !/\d/.test(g('server')), 'Pas de bannière serveur (X-Powered-By / version)');
ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(home.body) && !/\son[a-z]+=/i.test(home.body) && !/\sstyle=/i.test(home.body), 'HTML sans script, gestionnaire ni style inline');
if (https) {
  ok(/max-age=(\d+)/.test(g('strict-transport-security')) && +g('strict-transport-security').match(/max-age=(\d+)/)[1] >= 31536000 && /includeSubDomains/.test(g('strict-transport-security')),
    'Strict-Transport-Security ≥ 1 an + includeSubDomains', g('strict-transport-security'));
  const s = await fetch(base + '/api/session', { headers: H });
  const c = (s.headers.getSetCookie?.() || []).find(x => /csv_sid=/.test(x)) || '';
  ok(c.startsWith('__Host-') && /;\s*Secure/i.test(c) && /;\s*HttpOnly/i.test(c) && /;\s*SameSite=Strict/i.test(c), 'Cookie de session __Host-, Secure, HttpOnly, SameSite=Strict');
} else console.log('  · HSTS et cookie Secure : vérifiés avec --https (servis seulement derrière HTTPS)');
const room = await page('/r/controle-entetes');
const rc = room.g('content-security-policy');
ok(/script-src 'self' 'wasm-unsafe-eval'/.test(rc) && !/unsafe-inline|unsafe-eval'/.test(rc.replace("'wasm-unsafe-eval'", '')), "Page d'appel : seul ajout 'wasm-unsafe-eval' (détourage local)");
const f = await page('/f/AAAAAAAAAAAAAAAA/x');
ok([403, 404].includes(f.r.status) && f.g('x-content-type-options') === 'nosniff', 'Fichiers partagés : accès refusé sans session, nosniff');
const t = await fetch(base + '/', { method: 'TRACE', headers: H }).catch(() => ({ status: 0 }));
ok(t.status === 405 || t.status === 0, 'Méthode TRACE refusée');
const o = await fetch(base + '/', { method: 'OPTIONS', headers: H }).catch(() => null);
ok(o && o.status === 405 && o.headers.get('allow') === 'GET, HEAD, POST', 'Méthodes HTTP limitées (OPTIONS → 405 + Allow: GET, HEAD, POST)');
ok(!home.g('access-control-allow-origin'), 'Pas de CORS ouvert (Access-Control-Allow-Origin absent)');
const bad = await page('/%E0%A4%A');
ok(bad.r.status === 400 && !!bad.g('content-security-policy') && !/at\s+\S+\s+\(|node:internal/.test(bad.body), 'Erreurs sans trace interne et avec en-têtes de sécurité');
if (https) {
  const hz = await page('/healthz');
  ok(!/version/.test(hz.body), '/healthz via le proxy : aucune version divulguée', hz.body);
  ok(/;\s*preload/.test(g('strict-transport-security')), 'HSTS avec preload');
}
const st = await page('/.well-known/security.txt');
console.log(`  · security.txt : ${st.r.status === 200 ? 'publié' : 'non publié (définir SECURITY_CONTACT, recommandé, non noté par WebGuardian)'}`);
console.log(`Résultat : ${total - fail}/${total} contrôles OK`);
process.exit(fail ? 1 : 0);
