// Bouchon du lecteur YouTube intégré (youtube-nocookie.com/embed/ID) : même protocole postMessage que le vrai
// (listening → onReady / initialDelivery / infoDelivery, commandes playVideo, seekTo…), horloge simulée.
// Identifiants spéciaux : NOEMBED0150 → erreur 150 (non intégrable) ; AUTOPLAYBLK → lecture avec son refusée sans geste.
// window.__stub (dans le cadre) expose l'état pour les tests.
export const STUB_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>stub</title>
<style>html,body{margin:0;height:100%;background:#111;color:#9dbfff;font:600 22px system-ui;display:grid;place-items:center;overflow:hidden}
#b{position:absolute;left:0;bottom:0;height:6px;background:#e5484d;width:0}#t{font-variant-numeric:tabular-nums}</style></head>
<body><div><div id="v"></div><div id="t"></div></div><div id="b"></div><script>
const q = new URLSearchParams(location.search), id0 = location.pathname.split('/').pop();
const parentOrigin = q.get('origin') || '*';
const S = window.__stub = { id: id0, t: +(q.get('start') || 0), state: -1, rate: 1, vol: 100, muted: false, at: performance.now(), commands: [], wid: null, events: [], controls: q.get('controls'), playsinline: q.get('playsinline'), duration: 600, allowUnlock: id0 !== 'AUTOPLAYBLK' };
const now = () => S.state === 1 ? S.t + (performance.now() - S.at) / 1000 * S.rate : S.t;
const fix = () => { S.t = Math.min(now(), S.duration); S.at = performance.now(); };
const send = (event, info) => parent.postMessage(JSON.stringify({ event, info, id: S.wid, channel: 'widget' }), parentOrigin);
const setState = st => { fix(); S.state = st; if (S.events.includes('onStateChange')) send('onStateChange', st); deliver(); };
const deliver = () => { fix(); send('infoDelivery', { currentTime: S.t, playerState: S.state, playbackRate: S.rate, volume: S.vol, muted: S.muted, duration: S.duration, videoData: { video_id: S.id } }); };
const err = () => { if (S.id === 'NOEMBED0150') { send('onError', 150); return true; } return false; };
const C = {
  playVideo() { if (err()) return; if (S.id === 'AUTOPLAYBLK' && !S.muted && !S.unlocked) { S.blocked = (S.blocked || 0) + 1; setState(2); return; } setState(1); },
  pauseVideo() { setState(2); },
  seekTo(s) { S.t = Math.max(0, +s); S.at = performance.now(); deliver(); },
  setPlaybackRate(r) { fix(); S.rate = +r; if (S.events.includes('onPlaybackRateChange')) send('onPlaybackRateChange', S.rate); deliver(); },
  setVolume(v) { S.vol = +v; deliver(); }, mute() { S.muted = true; deliver(); }, unMute() { S.muted = false; if (S.allowUnlock) S.unlocked = true; deliver(); },
  loadVideoById(o) { S.id = o.videoId; S.t = +o.startSeconds || 0; S.at = performance.now(); if (!err()) setState(1); },
  cueVideoById(o) { S.id = o.videoId; S.t = +o.startSeconds || 0; S.at = performance.now(); setState(5); },
  addEventListener(n) { if (!S.events.includes(n)) S.events.push(n); },
};
addEventListener('message', e => {
  let d; try { d = JSON.parse(e.data); } catch { return; }
  if (d.event === 'listening') { if (!S.wid) { S.wid = d.id; send('initialDelivery', { currentTime: S.t, playerState: -1, playbackRate: 1, volume: 100, muted: false }); send('onReady', null); if (S.id === 'NOEMBED0150') setTimeout(() => send('onError', 150), 50); } return; }
  if (d.event === 'command' && C[d.func]) { S.commands.push(d.func); C[d.func](...(d.args || [])); }
});
// interface simulée : clic = lecture / pause (comme le vrai lecteur, pour la personne qui partage)
document.addEventListener('click', () => S.state === 1 ? C.pauseVideo() : C.playVideo());
window.userSeek = s => { C.seekTo(s); }; window.userRate = r => C.setPlaybackRate(r); window.userPause = () => C.pauseVideo(); window.userPlay = () => C.playVideo();
setInterval(() => { if (S.wid) deliver(); document.getElementById('v').textContent = S.id; document.getElementById('t').textContent = now().toFixed(1) + ' s · ' + ({'-1':'non démarrée',0:'terminée',1:'lecture',2:'pause',3:'chargement',5:'prête'})[S.state]; document.getElementById('b').style.width = (now() / S.duration * 100) + '%'; }, 250);
</script></body></html>`;

export async function stubYouTube(context, { block = false } = {}) {
  await context.route(/^https:\/\/www\.youtube-nocookie\.com\//, route => {
    if (block) return route.abort('blockedbyclient');
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: STUB_HTML, headers: { 'cross-origin-resource-policy': 'cross-origin' } });
  });
}
export const ytFrame = page => page.frames().find(f => f.url().startsWith('https://www.youtube-nocookie.com/embed/'));
export const stubState = async page => { const f = ytFrame(page); return f ? f.evaluate(() => { const S = window.__stub; return { ...S, now: S.state === 1 ? S.t + (performance.now() - S.at) / 1000 * S.rate : S.t, commands: S.commands.slice() }; }) : null; };
