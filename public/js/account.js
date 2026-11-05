// Page « Compte » : connexion, inscription (selon le mode choisi par l'administrateur), changement de mot de passe.
import { $, h, icon, api, toast, initChrome, session, resetSession, setMyName } from './common.js';
initChrome();
document.querySelector('[data-theme-tab]')?.addEventListener('click', e => { e.preventDefault(); import('./common.js').then(m => m.toggleTheme()); });

const box = $('#acct');
const ret = (() => { const r = new URLSearchParams(location.search).get('retour') || ''; return /^\/(?!\/)[A-Za-z0-9/_\-#.]*$/.test(r) ? r : ''; })();
const MODES = { open: 'Inscription libre', invite: 'Inscription sur invitation', approval: 'Inscription validée par l\'administrateur' };

function field(id, label, ic, attrs) {
  return h('div', { class: 'field' }, h('label', { for: id }, label), h('div', { class: 'inp' }, icon(ic), h('input', { id, name: id, ...attrs })));
}
function done(acc, csrf) {
  resetSession(csrf); setMyName(acc.name);
  if (ret) location.href = ret; else render();
}

async function render() {
  let s; try { s = await session(); } catch { box.replaceChildren(h('p', { class: 'sub' }, 'Serveur injoignable.')); return; }
  const link = $('#accLink .t'); if (link) link.textContent = s.account ? s.account.name : 'Se connecter';
  if (s.account) return renderMe(s);
  const canSignup = s.signupMode !== 'closed';
  let tab = location.hash === '#inscription' && canSignup ? 'signup' : 'login';
  const head = h('div', { class: 'acct-head' }, h('span', { class: 'logo' }, icon('user')), h('h2', {}, 'Ton compte'),
    h('p', { class: 'sub' }, 'Un compte réserve ton pseudo dans tous les salons. Il reste facultatif' + (s.guestJoin ? ' : on peut toujours rejoindre un salon avec un lien.' : '.')));
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const body = h('div', {});
  const paint = () => {
    tabs.replaceChildren(...[
      h('button', { type: 'button', class: 'tab' + (tab === 'login' ? ' on' : ''), role: 'tab', 'aria-selected': String(tab === 'login'), onclick: () => { tab = 'login'; paint(); } }, 'Connexion'),
      canSignup ? h('button', { type: 'button', class: 'tab' + (tab === 'signup' ? ' on' : ''), role: 'tab', id: 'tabSignup', 'aria-selected': String(tab === 'signup'), onclick: () => { tab = 'signup'; paint(); } }, 'Inscription') : null].filter(Boolean));
    body.replaceChildren(tab === 'login' ? loginForm() : signupForm(s));
    setTimeout(() => body.querySelector('input')?.focus(), 30);
  };
  paint();
  box.replaceChildren(...[head, tabs, body, canSignup ? null : h('p', { class: 'hint' }, icon('lock'), 'Les inscriptions sont fermées sur ce serveur.')].filter(Boolean));
}

function loginForm() {
  const err = h('div', { class: 'formerr', role: 'alert' });
  const f = h('form', { class: 'acct-form', id: 'loginForm' },
    field('lname', 'Pseudo', 'user', { autocomplete: 'username', maxlength: 32, required: true }),
    field('lpw', 'Mot de passe', 'lock', { type: 'password', autocomplete: 'current-password', maxlength: 200, required: true }),
    err, h('button', { class: 'btn pri wide', type: 'submit' }, 'Se connecter'));
  f.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    try { const r = await api('/api/account/login', { method: 'POST', body: { name: $('#lname').value, password: $('#lpw').value } }); done(r.account, r.csrf); }
    catch (x) { err.textContent = x.message; $('#lpw').select(); }
  });
  return f;
}

function signupForm(s) {
  const err = h('div', { class: 'formerr', role: 'alert' });
  const f = h('form', { class: 'acct-form', id: 'signupForm' },
    h('div', { class: 'badge acc mode' }, icon('shield'), MODES[s.signupMode] || ''),
    field('sname', 'Pseudo (2 à 32 caractères)', 'user', { autocomplete: 'username', maxlength: 32, minlength: 2, required: true }),
    field('spw', 'Mot de passe (10 caractères minimum)', 'lock', { type: 'password', autocomplete: 'new-password', minlength: 10, maxlength: 200, required: true }),
    field('spw2', 'Confirmation', 'lock', { type: 'password', autocomplete: 'new-password', minlength: 10, maxlength: 200, required: true }),
    s.signupMode === 'invite' ? field('sinv', 'Code d\'invitation', 'link', { autocomplete: 'off', maxlength: 64, required: true }) : null,
    s.signupMode === 'approval' ? h('p', { class: 'hint' }, icon('clock'), 'Ton compte sera utilisable après validation par l\'administrateur.') : null,
    err, h('button', { class: 'btn pri wide', type: 'submit' }, 'Créer mon compte'));
  f.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    if ($('#spw').value !== $('#spw2').value) { err.textContent = 'Les deux mots de passe ne correspondent pas.'; return; }
    try {
      const r = await api('/api/account/signup', { method: 'POST', body: { name: $('#sname').value, password: $('#spw').value, invite: $('#sinv')?.value || '' } });
      if (r.pending) { box.replaceChildren(h('div', { class: 'acct-head' }, h('span', { class: 'logo' }, icon('clock')), h('h2', {}, 'Demande envoyée'), h('p', { class: 'sub' }, 'Ton compte attend la validation de l\'administrateur. Tu pourras te connecter dès qu\'il sera validé.'))); return; }
      toast('Compte créé, bienvenue !'); done(r.account, r.csrf);
    } catch (x) { err.textContent = x.message; }
  });
  return f;
}

function renderMe(s) {
  const err = h('div', { class: 'formerr', role: 'alert' });
  const f = h('form', { class: 'acct-form', id: 'pwForm' },
    h('h3', {}, 'Changer de mot de passe'),
    field('opw', 'Mot de passe actuel', 'lock', { type: 'password', autocomplete: 'current-password', maxlength: 200, required: true }),
    field('npw', 'Nouveau mot de passe (10 caractères minimum)', 'lock', { type: 'password', autocomplete: 'new-password', minlength: 10, maxlength: 200, required: true }),
    err, h('button', { class: 'btn wide', type: 'submit' }, 'Changer'));
  f.addEventListener('submit', async e => {
    e.preventDefault(); err.textContent = '';
    try { await api('/api/account/password', { method: 'POST', body: { old: $('#opw').value, password: $('#npw').value } }); toast('Mot de passe changé.'); f.reset(); }
    catch (x) { err.textContent = x.message; }
  });
  box.replaceChildren(
    h('div', { class: 'acct-head' }, h('span', { class: 'logo' }, icon('user')), h('h2', {}, s.account.name),
      h('p', { class: 'sub' }, 'Tu es connecté. Ton pseudo t\'est réservé : personne d\'autre ne peut le prendre dans un salon.')),
    h('div', { class: 'crow acct-actions' }, h('a', { class: 'btn pri', href: ret || '/' }, icon(ret ? 'left' : 'home'), ret ? 'Revenir au salon' : 'Accueil'),
      h('button', { class: 'btn', id: 'logout', onclick: async () => { const r = await api('/api/account/logout', { method: 'POST' }); resetSession(r.csrf); toast('Déconnecté.'); render(); } }, 'Se déconnecter')),
    f);
}
render();
