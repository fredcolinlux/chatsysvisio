import { $, h, api, initChrome, icon, toggleTheme, whenAgo } from './common.js';
initChrome();
document.querySelector('[data-theme-tab]')?.addEventListener('click', e => { e.preventDefault(); toggleTheme(); });
async function load() {
  const box = $('#plist');
  try {
    const list = await api('/api/rooms/public');
    box.replaceChildren();
    if (!list.length) box.append(h('div', { class: 'card' }, h('div', { class: 'h' }, icon('globe'), 'Aucun salon public'), h('div', { class: 'd' }, 'Crée-en un depuis l\'accueil en choisissant « Public ».'), h('a', { class: 'btn sm', href: '/#nouveau' }, 'Créer un salon')));
    for (const r of list) {
      box.append(h('a', { class: 'card', href: `/r/${r.slug}` },
        h('div', { class: 'h' }, h('span', { class: r.count ? 'live' : 'dot' }), r.name, r.hasPassword ? icon('lock') : null),
        h('div', { class: 'd' }, r.count ? `${r.count} / ${r.limit} en ligne` : `Vide · actif ${whenAgo(Date.now() - r.activeAgo * 60000)}`),
        h('span', { class: 'btn sm' }, r.count >= r.limit ? 'Complet' : 'Rejoindre')));
    }
  } catch (e) { box.replaceChildren(h('div', { class: 'card' }, e.message)); }
}
load(); setInterval(load, 15000);
