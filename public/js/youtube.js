// Lecteur YouTube partagé (1.13) : cadre youtube-nocookie.com piloté par postMessage (enablejsapi=1).
// Aucun script YouTube n'est chargé dans la page : le protocole « widget » de l'API IFrame est parlé directement,
// en n'acceptant que les messages du cadre lui-même (origine + fenêtre source) et en n'en lisant que quelques nombres.
import { h, icon } from './common.js';
import { ORIGIN, ID_RE, embedUrl, errorMessage, BLOCKED_MESSAGE, nearestRate, expectedPos, driftAction, DRIFT } from './youtube-model.js';

export const PS = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };
let widgetSeq = 0;

// Pont postMessage vers un lecteur. Événements : onReady(), onInfo(info), onError(code).
export class YtPlayer {
  constructor({ id, start = 0, controls = true, origin = location.origin, onReady, onInfo, onError } = {}) {
    if (!ID_RE.test(id)) throw new Error('identifiant invalide');
    this.id = id; this.wid = 'csv-yt-' + (++widgetSeq); this.ready = false; this.heard = false; this.queue = [];
    this.info = { currentTime: start, playerState: PS.UNSTARTED, playbackRate: 1, muted: false, volume: 100, duration: 0, at: performance.now() };
    this.cb = { onReady, onInfo, onError };
    this.el = h('iframe', {
      class: 'ytif', title: 'Lecteur YouTube', src: embedUrl(id, { origin, start, controls }),
      // permissions minimales : lecture (automatique muette ou après un geste), contenu protégé, plein écran
      allow: 'autoplay; encrypted-media; fullscreen', referrerpolicy: 'strict-origin-when-cross-origin',
      // bac à sable : scripts du lecteur dans sa propre origine ; ni fenêtres surgissantes, ni formulaires, ni navigation de la page
      sandbox: 'allow-scripts allow-same-origin allow-presentation',
    });
    this.el.setAttribute('allowfullscreen', '');
    this.onMsg = e => this.receive(e);
    window.addEventListener('message', this.onMsg);
    const poll = () => { if (!this.heard) this.post({ event: 'listening' }); };
    this.el.addEventListener('load', () => { clearInterval(this.pollT); poll(); this.pollT = setInterval(poll, 250); });
  }
  post(obj) {
    const w = this.el.contentWindow; if (!w) return;
    try { w.postMessage(JSON.stringify({ ...obj, id: this.wid, channel: 'widget' }), ORIGIN); } catch {}
  }
  command(func, args = []) { const m = { event: 'command', func, args }; if (this.ready) this.post(m); else this.queue.push(m); }
  receive(e) {
    if (e.origin !== ORIGIN || e.source !== this.el.contentWindow || typeof e.data !== 'string' || e.data.length > 200_000) return;
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (!d || typeof d !== 'object' || (d.id !== undefined && d.id !== this.wid)) return;
    if (!this.heard) { this.heard = true; clearInterval(this.pollT); }
    const info = d.info;
    switch (d.event) {
      case 'onReady':
        if (this.ready) return;
        this.ready = true;
        for (const ev of ['onStateChange', 'onPlaybackRateChange', 'onError']) this.post({ event: 'command', func: 'addEventListener', args: [ev] });
        for (const m of this.queue.splice(0)) this.post(m);
        this.cb.onReady?.(); return;
      case 'initialDelivery': case 'infoDelivery': if (info && typeof info === 'object') this.merge(info); return;
      case 'onStateChange': if (Number.isInteger(info)) this.merge({ playerState: info }); return;
      case 'onPlaybackRateChange': if (typeof info === 'number') this.merge({ playbackRate: info }); return;
      case 'onError': this.cb.onError?.(Number.isInteger(+info) ? +info : 0); return;
    }
  }
  merge(info) {
    const i = this.info, now = performance.now(); let changed = false;
    const n = (k, lo, hi) => { const v = info[k]; if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi && v !== i[k]) { i[k] = v; changed = true; } };
    if ('currentTime' in info) { n('currentTime', 0, 1e6); i.at = now; }
    n('playerState', -1, 5); n('playbackRate', 0.0625, 16); n('volume', 0, 100); n('duration', 0, 1e7);
    if (typeof info.muted === 'boolean' && info.muted !== i.muted) { i.muted = info.muted; changed = true; }
    const vid = info.videoData?.video_id; if (typeof vid === 'string' && ID_RE.test(vid)) i.videoId = vid;
    this.cb.onInfo?.(i, changed);
  }
  // Position actuelle, extrapolée depuis le dernier relevé du lecteur (au plus 2 s)
  time() {
    const i = this.info;
    return i.playerState === PS.PLAYING ? i.currentTime + Math.min(2, (performance.now() - i.at) / 1000) * (i.playbackRate || 1) : i.currentTime;
  }
  load(id, start = 0, play = true) { if (!ID_RE.test(id)) return; this.id = id; this.command(play ? 'loadVideoById' : 'cueVideoById', [{ videoId: id, startSeconds: Math.max(0, start) }]); }
  destroy() { clearInterval(this.pollT); window.removeEventListener('message', this.onMsg); this.el.remove(); }
}

// Vue : cadre + écran de protection (spectateurs) + barre (volume personnel, commandes de la personne qui partage).
// ctx : { isOwner(), ownerName(), volume() → {v,m}, setVolume({v,m}), onState(state) (propriétaire), onClose(), onChange(), onError(msg) }
export class SharedVideo {
  constructor(ctx, state, { recvAt = performance.now() } = {}) {
    this.ctx = ctx; this.owner = ctx.isOwner();
    this.target = { ...state }; this.recvAt = recvAt; this.lastSeek = 0; this.n = state.n | 0; this.autoMuted = false; this.lastSent = null;
    this.status = h('div', { class: 'ytstatus', hidden: true, role: 'status', 'aria-live': 'polite' });
    this.shield = h('div', { class: 'ytshield', 'aria-hidden': 'true' });
    this.frame = h('div', { class: 'ytarea' });
    this.bar = h('div', { class: 'ytbar', role: 'toolbar', 'aria-label': 'Vidéo YouTube partagée' });
    this.el = h('div', { class: 'ytbox' + (this.owner ? ' owner' : '') }, this.frame, this.bar, this.status);
    this.unmuteBtn = h('button', { type: 'button', class: 'ytunmute', hidden: true, onclick: () => this.enableSound() }, icon('vol'), 'Activer le son');
    this.frame.append(this.shield, this.unmuteBtn);
    this.make(state.id, this.expected());
    this.renderBar();
    this.syncT = setInterval(() => this.tick(), 500);
  }
  expected() { return expectedPos(this.target, performance.now() - this.recvAt); }
  make(id, start) {
    this.player?.destroy();
    this.error = null; this.setStatus(null);
    this.player = new YtPlayer({ id, start: Math.floor(start), controls: this.owner,
      onReady: () => this.onReady(), onInfo: (i, ch) => this.onInfo(i, ch), onError: c => this.onError(c) });
    this.frame.prepend(this.player.el);
    clearTimeout(this.blockT);
    this.blockT = setTimeout(() => { if (!this.player.heard) this.setStatus(BLOCKED_MESSAGE, true); }, 12000);
  }
  onReady() {
    this.applyVolume();
    const t = this.target;
    if (t.rate !== 1) this.player.command('setPlaybackRate', [t.rate]);
    if (t.play) this.play(); else { this.player.command('seekTo', [this.expected(), true]); this.player.command('pauseVideo'); }
    this.ctx.onReadyHook?.();
  }
  // Lecture : si le navigateur refuse la lecture avec son (règle d'autoplay), on relance en muet et on propose « Activer le son ».
  play() {
    this.player.command('playVideo');
    if (this.apT) return; // vérification d'autoplay déjà en attente
    let tries = 0;
    const check = () => {
      this.apT = 0;
      const st = this.player.info.playerState;
      if (!this.target.play || st === PS.PLAYING || st === PS.BUFFERING || this.error) return;
      // encore « non démarrée » : peut-être un chargement lent ; on patiente un peu avant de conclure à un refus
      if (st === PS.UNSTARTED && ++tries < 3) { this.apT = setTimeout(check, 2500); return; }
      this.autoMuted = true; this.player.command('mute'); this.player.command('playVideo'); this.renderBar();
    };
    this.apT = setTimeout(check, 2500);
  }
  enableSound() {
    const v = this.ctx.volume();
    this.autoMuted = false; this.ctx.setVolume({ ...v, m: false });
    this.player.command('unMute'); this.player.command('setVolume', [v.v]); if (this.target.play) this.player.command('playVideo');
    this.renderBar();
    // iPhone : le son ne peut parfois être activé que par un toucher dans le lecteur lui-même
    setTimeout(() => {
      if (this.player.info.muted || (this.target.play && this.player.info.playerState !== PS.PLAYING)) {
        this.el.classList.add('touch'); this.setStatus('Touche la vidéo une fois pour activer le son.');
        clearTimeout(this.touchT); this.touchT = setTimeout(() => { this.el.classList.remove('touch'); this.setStatus(null); }, 8000);
      }
    }, 1500);
  }
  applyVolume() {
    const v = this.ctx.volume();
    this.player.command('setVolume', [v.v]);
    this.player.command(v.m || this.autoMuted ? 'mute' : 'unMute');
  }
  onInfo(i) {
    if (this.owner) return this.ownerReport(i);
    if (this.el.classList.contains('touch') && !i.muted && i.playerState === PS.PLAYING) { this.el.classList.remove('touch'); this.setStatus(null); }
  }
  onError(code) {
    this.error = code; const msg = errorMessage(code);
    this.setStatus(msg, true); this.ctx.onError?.(msg, code);
  }
  setStatus(text, link = false) {
    if (!text) { this.status.hidden = true; this.status.replaceChildren(); return; }
    const id = this.target.id;
    this.status.replaceChildren(h('span', {}, text), link && ID_RE.test(id) ? h('a', { href: 'https://www.youtube.com/watch?v=' + id, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir sur YouTube') : null);
    this.status.hidden = false;
  }

  // --- Personne qui partage : chaque action dans le lecteur devient un état envoyé aux autres ---
  ownerReport(i) {
    if (i.playerState === PS.PLAYING) this.everPlayed = true;
    // tant que la vidéo n'a jamais démarré (chargement, lecture refusée par le navigateur), on n'annonce pas de pause
    if (!this.everPlayed && this.target.play) return;
    const play = i.playerState === PS.PLAYING || i.playerState === PS.BUFFERING || (i.playerState === PS.UNSTARTED && this.target.play);
    const ended = i.playerState === PS.ENDED;
    const now = this.player.time(), rate = nearestRate(i.playbackRate || 1);
    const prev = this.lastSent;
    let why = null;
    if (!prev) why = 'init';
    else if ((ended ? false : play) !== prev.play) why = 'play';
    else if (rate !== prev.rate) why = 'rate';
    else if (Math.abs(now - expectedPos(prev, performance.now() - prev.at)) > 1.2) why = 'seek';
    if (why && i.playerState !== PS.UNSTARTED) this.sendState({ play: ended ? false : play, pos: now, rate });
  }
  sendState(part) {
    const s = { id: this.target.id, pos: Math.max(0, Math.min(part.pos ?? this.player.time(), 43200)), play: part.play ?? this.target.play, rate: part.rate ?? this.target.rate, n: ++this.n };
    this.target = s; this.recvAt = performance.now();
    this.lastSent = { ...s, at: performance.now() };
    this.ctx.onState?.(s);
  }

  // --- Spectateur : nouvel état reçu ---
  apply(state, recvAt) {
    const idChanged = state.id !== this.target.id;
    this.target = { ...state }; this.recvAt = recvAt; this.n = state.n | 0;
    if (this.owner) return;
    if (idChanged) { this.error = null; this.setStatus(null); this.player.load(state.id, this.expected(), state.play); this.renderBar(); return; }
    if (!this.player.ready) return;
    const p = this.player;
    if (nearestRate(p.info.playbackRate) !== state.rate) p.command('setPlaybackRate', [state.rate]);
    const exp = this.expected();
    // pause, reprise ou saut explicite : on se cale tout de suite (seuil plus fin que la correction de dérive)
    if (Math.abs(p.time() - exp) > (state.play ? DRIFT : 0.4)) { p.command('seekTo', [exp, true]); this.lastSeek = performance.now(); }
    if (state.play) { if (p.info.playerState !== PS.PLAYING && p.info.playerState !== PS.BUFFERING) this.play(); }
    else if (p.info.playerState === PS.PLAYING || p.info.playerState === PS.BUFFERING) p.command('pauseVideo');
  }
  tick() {
    const p = this.player; if (!p?.ready || this.error) return;
    if (this.owner) {
      // battement : la position de référence est renvoyée toutes les 4 s pendant la lecture (arrivants, dérive d'horloge)
      if (this.target.play && performance.now() - (this.lastSent?.at || 0) > 4000) this.sendState({ pos: p.time() });
      return;
    }
    const st = p.info.playerState;
    const act = driftAction({ expected: this.expected(), actual: p.time(), buffering: st === PS.BUFFERING || st === PS.UNSTARTED, sinceSeekMs: performance.now() - this.lastSeek });
    if (act === 'seek') { p.command('seekTo', [this.expected(), true]); this.lastSeek = performance.now(); }
    if (this.target.play && (st === PS.PAUSED || st === PS.CUED) && !this.autoMuted && performance.now() - this.lastSeek > 1500) this.play();
    if (!this.target.play && st === PS.PLAYING) p.command('pauseVideo');
  }

  renderBar() {
    const v = this.ctx.volume();
    const muted = v.m || this.autoMuted;
    this.unmuteBtn.hidden = !this.autoMuted;
    const range = h('input', { type: 'range', class: 'ytvol', min: '0', max: '100', step: '1', value: String(v.v), 'aria-label': 'Mon volume (personnel)',
      oninput: e => { const nv = { v: +e.target.value, m: false }; this.ctx.setVolume(nv); this.autoMuted = false; this.applyVolume(); this.paintVol(); } });
    this.volBtn = h('button', { type: 'button', class: 'ytb', 'aria-label': muted ? 'Réactiver le son (pour moi)' : 'Couper le son (pour moi)', 'aria-pressed': String(muted),
      onclick: () => { if (this.autoMuted) return this.enableSound(); const c = this.ctx.volume(); this.ctx.setVolume({ ...c, m: !c.m }); this.applyVolume(); this.paintVol(); } }, icon(muted ? 'voloff' : 'vol'));
    this.range = range;
    const who = h('span', { class: 'ytwho' }, icon('yt'), this.owner ? 'Tu partages cette vidéo' : `Partagée par ${this.ctx.ownerName()}`);
    const right = this.owner ? [
      h('button', { type: 'button', class: 'ytb txt', onclick: () => this.ctx.onChange?.() }, icon('link'), h('span', { class: 'hide-xs' }, 'Changer')),
      h('button', { type: 'button', class: 'ytb txt stop', onclick: () => this.ctx.onClose?.() }, icon('x'), h('span', {}, 'Arrêter')),
    ] : [];
    this.bar.replaceChildren(who, h('span', { class: 'ytgrp vol', title: 'Le volume ne change que chez toi' }, this.volBtn, range), ...right);
    this.paintVol();
  }
  paintVol() {
    const v = this.ctx.volume(), muted = v.m || this.autoMuted;
    if (this.range) { this.range.value = String(v.v); this.range.style.setProperty('--p', (muted ? 0 : v.v) + '%'); }
    if (this.volBtn) { this.volBtn.replaceChildren(icon(muted ? 'voloff' : 'vol')); this.volBtn.setAttribute('aria-pressed', String(muted)); this.volBtn.setAttribute('aria-label', muted ? 'Réactiver le son (pour moi)' : 'Couper le son (pour moi)'); }
    this.unmuteBtn.hidden = !this.autoMuted;
  }
  setOwner(isOwner) { if (isOwner === this.owner) return; this.owner = isOwner; this.el.classList.toggle('owner', isOwner); this.make(this.target.id, this.expected()); this.renderBar(); }
  destroy() { clearInterval(this.syncT); clearTimeout(this.apT); clearTimeout(this.blockT); clearTimeout(this.touchT); this.player?.destroy(); this.el.remove(); }
}
