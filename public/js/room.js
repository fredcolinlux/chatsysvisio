// Page salon : lobby (aperçu caméra, micro, appareils, arrière-plan), appel (grille, orateur actif, pagination),
// chat (réponses, markdown, réactions, fichiers), participants, invitation (lien + QR local).
import { $, $$, h, icon, api, toast, initChrome, renderSidebar, session, freshSession, ensureFresh, avatar, rememberRoom, myName, setMyName, fmtSize } from './common.js';
import { Engine, AudioIO, detectCaps, stats } from './media.js';
import { loadFx, saveFx, noiseSuppressionSupported, autotuneSupported, isolatorSupported, isoLoad } from './micfx.js';
import { NOTE_NAMES } from './autotune.js';
import { Effects, PRESETS, drawPreset } from './effects.js';
import { renderMarkdown } from './markdown.js';
import { L_LO, L_HI, L_SCREEN, L_HD } from './protocol.js';
import { QUALITY_OPTIONS, RATE_OPTIONS, normalizeQuality, ceilingFor, pickLayer, hdKbps } from './quality.js';
import { loadCam, saveCam, frameRateFor, controlsOf, hasControls, advancedFor, resetAdvanced, clampCap, pick, fmtExposure, fmtZoom, zoomed, resizeModeFor } from './camera.js';
import { Rehausse } from './rehausse.js';
import { prepare, fromPassword, finish, startSession, inviteUrl, needsPw } from './room-e2ee.js';
import { encryptFile, decryptFile, sniffImage, b64u, rand } from './e2ee.js';
import { BoardView } from './board.js';
import { validStroke } from './board-model.js';

const slug = decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase();
initChrome({ activeSlug: slug });
const view = $('#view');
const isMobile = () => matchMedia('(max-width:760px)').matches;
// Appareil mobile (CPU/batterie), indépendamment de la largeur de fenêtre
const isMobileDevice = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const EMOJIS = ['👍', '❤️', '😂', '🎉', '👏', '😮', '🔥', '🙏', '✋', '😢', '💯', '🤔'];

const S = {
  dropped: 0,
  info: null, stream: null, video: null, effects: null, audio: null, engine: null, caps: null,
  mic: true, cam: true, quality: normalizeQuality(localStorage.getItem('cc-quality')), noHd: new Map(),
  bg: localStorage.getItem('cc-bg') || 'none', facing: 'user', fx: loadFx(),
  peers: new Map(), bySid: new Map(), me: null, speakerSid: 0, order: [], page: 0, pinned: null,
  tiles: new Map(), msgs: new Map(), replyTo: null, panel: !isMobile(), view: localStorage.getItem('cc-view') === 'speaker' ? 'speaker' : 'grid', tab: 'chat', unread: 0, joinedAt: 0, typing: new Map(),
  seen: new Map(), wb: null, camfx: loadCam(),
};
window.__ccState = S; // inspection (tests)

// ---------------- Rehaussement faible lumière (1.11) ----------------
function ensureEnh() {
  S.enh ||= new Rehausse({ onFallback: msg => { toast(msg, { ms: 6000 }); S.camfx.enh.on = false; saveCam(S.camfx); refreshSelf(); paintCam(); } });
  S.enh.set(S.camfx.enh); return S.enh;
}
function setEnh(part) {
  S.camfx.enh = { ...S.camfx.enh, ...part }; saveCam(S.camfx);
  ensureEnh(); lastCam.t = 0; refreshSelf(); paintCam(); paintQuality();
  if ('on' in part) applyCameraSize(); // sur mobile, le rehaussement limite à 720p comme le flou
}
// Aperçu de soi : miroir (caméra avant, option), champ complet (contain) ou rempli (cover). L'envoi n'est jamais inversé.
const selfMirror = () => S.facing === 'user' && S.camfx.mirror;
function paintSelfView() {
  $$('.tile.me, #selfPreview').forEach(t => { t.classList.toggle('mirror', selfMirror()); t.classList.toggle('fit', !S.camfx.fill); });
}
function setSelfView(part) { Object.assign(S.camfx, part); saveCam(S.camfx); paintSelfView(); paintCam(); }

// ---------------- Caméra locale + effets ----------------
let lastCam = { t: 0, v: null };
function camSource(wantH = S.engine?.wantH || 360) {
  // WebKit/iOS ne décode pas une <video> détachée du DOM : on préfère une vignette visible, sinon la source cachée (attachée).
  let v = S.video; if (!v?.videoWidth) v = [...document.querySelectorAll('video.selfvid')].find(x => x.videoWidth) || v;
  if (!v || !v.videoWidth) return null;
  const now = performance.now();
  // Composition de l'arrière-plan à la taille réellement demandée (640 px pour 360p … 1920 px pour 1080p)
  const side = wantH >= 1080 ? 1920 : wantH >= 720 ? 1280 : 640;
  if (now - lastCam.t < 25 && lastCam.v && lastCam.side >= side) return lastCam.v;
  // 1.11 : rehaussement faible lumière d'abord (WebGL2), puis le flou / fond travaille sur l'image rehaussée
  // (segmentation et composition partagent ce même canvas : pas de copie supplémentaire de la vidéo).
  const enh = S.enh?.active ? S.enh.render(v, side) : null;
  const base = enh || v;
  const out = S.effects?.active ? S.effects.render(base, side) : enh;
  lastCam = { t: now, side, v: out ? { el: out, w: out.width, h: out.height } : { el: v, w: v.videoWidth, h: v.videoHeight } };
  return lastCam.v;
}
// Image traitée (rehaussement ou arrière-plan) : l'aperçu de soi affiche le canvas plutôt que la vidéo brute.
const processing = () => !!(S.effects?.active || S.enh?.active);
// Taille à traiter pour l'aperçu : assez grande pour une grande vignette, sans dépasser ce qui part vraiment.
function previewH() {
  let need = 360;
  for (const c of previews) { if (!c.isConnected) continue; const r = c.parentElement?.getBoundingClientRect(); if (r && r.width * devicePixelRatio > 900) need = 720; }
  return Math.max(S.engine?.wantH || 360, need);
}
const previews = new Set(); // canvas d'aperçu (lobby, vignette perso) à rafraîchir quand un effet est actif
function previewLoop() {
  if (processing() && S.cam) {
    const src = camSource(previewH());
    if (src) for (const c of previews) { if (c.width !== src.w || c.height !== src.h) { c.width = src.w; c.height = src.h; } c.getContext('2d').drawImage(src.el, 0, 0); }
  }
  for (const c of previews) c.hidden = !(processing() && S.cam);
  requestAnimationFrame(previewLoop);
}
requestAnimationFrame(previewLoop);

async function getMedia({ audio = true, video = true } = {}) {
  const a = audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(localStorage.getItem('cc-mic') ? { deviceId: { ideal: localStorage.getItem('cc-mic') } } : {}) } : false;
  const camId = localStorage.getItem('cc-camid');
  const v = video ? { ...camSize(), ...resizeModeFor(), frameRate: frameRateFor(S.camfx), ...(S.camfx.ptz ? { zoom: true } : {}), ...(camId && S.facing === 'user' ? { deviceId: { ideal: camId } } : { facingMode: S.facing }) } : false;
  try { return await navigator.mediaDevices.getUserMedia({ audio: a, video: v }); }
  catch (e) {
    // navigateur qui refuse resizeMode / zoom : nouvel essai avec les seules contraintes historiques
    if (!v || e?.name === 'NotAllowedError' || e?.name === 'NotFoundError') throw e;
    const { resizeMode, zoom, ...v0 } = v; return navigator.mediaDevices.getUserMedia({ audio: a, video: v0 });
  }
}

// ---------------- Qualité d'envoi (Auto / 360p / 720p / 1080p / Éco) ----------------
function wantedCeiling() {
  const c = S.engine?.codecs.video;
  const max = S.caps ? Math.max(0, ...Object.values(S.caps.vmax || {})) : 1080;
  return ceilingFor(S.quality, { mobile: isMobileDevice(), effects: S.bg !== 'none' || S.camfx.enh.on, codec: c, deviceMax: max || 360, serverMax: S.engine?.maxHeight || 1080 });
}
// Résolution demandée à la caméra : 1080p seulement si on peut l'envoyer, sinon 720p (aperçu net, coût modéré).
function camSize() { return wantedCeiling() >= 1080 ? { width: { ideal: 1920 }, height: { ideal: 1080 } } : { width: { ideal: 1280 }, height: { ideal: 720 } }; }
async function applyCameraSize() {
  const vt = S.stream?.getVideoTracks()[0]; if (!vt || vt.readyState !== 'live') return;
  const want = camSize(), st = vt.getSettings();
  if (Math.max(st.width || 0, st.height || 0) === want.width.ideal) return;
  await applyCamControls(advancedFor(camCaps(vt), camDev(vt).set)); // taille + réglages enregistrés
  await new Promise(r => setTimeout(r, 400)); paintQuality();
}
function setQuality(q) {
  S.quality = normalizeQuality(q); localStorage.setItem('cc-quality', S.quality);
  if (S.engine) S.engine.quality = S.quality;
  paintQuality(); applyCameraSize();
}
const RES_LABEL = h => h >= 1080 ? '1080p' : h >= 720 ? '720p' : h >= 360 ? '360p' : 'vignette';
// Texte d'état sous le sélecteur : ce qui partira vraiment, et pourquoi pas plus.
function qualityStatus() {
  const q = S.quality, vt = S.stream?.getVideoTracks()[0], st = vt?.getSettings?.() || {};
  const camShort = Math.min(st.width || 0, st.height || 0);
  if (q === 'eco') return 'Économie : seulement la vignette basse définition (~70 kbit/s).';
  const ceil = wantedCeiling(), send = S.engine?.sendStats;
  const parts = [];
  if (send?.sendH && S.engine?.need.has(L_HD)) parts.push(`Envoi actuel : ${RES_LABEL(send.sendH)}${send.adapt ? ' (réduit : réseau chargé)' : ''}.`);
  else parts.push(`Jusqu'à ${RES_LABEL(ceil)}, seulement quand quelqu'un t'affiche en grand ; sinon 360p ou vignette.`);
  if (q === '1080p' || (q === 'auto' && !isMobileDevice())) {
    if (S.caps && !Object.values(S.caps.vmax || {}).includes(1080)) parts.push('Encodeur 1080p indisponible : repli en 720p.');
    else if (camShort && camShort < 1026 && vt) parts.push(`Caméra limitée à ${st.width}×${st.height} : repli en ${RES_LABEL(camShort >= 684 ? 720 : 360)}.`);
  }
  if (q === '1080p' && isMobileDevice() && S.bg !== 'none') parts.push('Flou ou fond actif sur mobile : limité à 720p.');
  return parts.join(' ');
}
function paintQuality() {
  $$('.qseg button[data-q]').forEach(b => { const on = b.dataset.q === S.quality; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  const txt = qualityStatus(); $$('.qnow').forEach(e => { if (e.textContent !== txt) e.textContent = txt; });
}
function qualityPicker() {
  const seg = h('div', { class: 'qseg', role: 'group', 'aria-label': 'Qualité de ta vidéo' },
    QUALITY_OPTIONS.map(([v, label, title]) => h('button', { type: 'button', title, 'aria-label': title, dataset: { q: v }, onclick: () => setQuality(v) }, label)));
  const wrap = h('div', { class: 'field', id: 'qualityField' }, h('label', {}, 'Qualité de ta vidéo'), seg, h('div', { class: 'qnow', 'aria-live': 'polite' }));
  setTimeout(paintQuality, 0);
  return wrap;
}

async function startMedia() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('Ce navigateur ne donne pas accès à la caméra (HTTPS requis).', { error: true }); S.cam = S.mic = false; return; }
  let stream = null;
  try { stream = await getMedia({ audio: true, video: true }); }
  catch (e) {
    try { stream = await getMedia({ audio: true, video: false }); S.cam = false; toast('Caméra indisponible : tu rejoindras en audio.'); }
    catch { S.cam = S.mic = false; toast('Autorise l\'accès à la caméra et au micro pour être vu et entendu.', { error: true, ms: 7000 }); }
  }
  setStream(stream);
}
function setStream(stream) {
  const old = S.stream; S.stream = stream;
  if (old && old !== stream) old.getTracks().forEach(t => { if (!stream?.getTracks().includes(t)) t.stop(); });
  if (!S.video) { S.video = document.createElement('video'); S.video.muted = true; S.video.playsInline = true; S.video.autoplay = true; S.video.setAttribute('playsinline', ''); S.video.className = 'srcvid'; S.video.setAttribute('aria-hidden', 'true'); document.body.append(S.video); }
  S.video.srcObject = stream && stream.getVideoTracks().length ? new MediaStream(stream.getVideoTracks()) : null;
  S.video.play().catch(() => {});
  $$('video.selfvid').forEach(v => { v.srcObject = S.video.srcObject; v.play().catch(() => {}); });
  stream?.getAudioTracks().forEach(t => t.enabled = S.mic);
  if (S.audio?.ctx) S.audio.attachMic(stream, u8 => S.engine?.sendAudio(u8));
  if (S.audio) S.audio.muted = !S.mic;
  setupMeter(stream);
  refreshSelf();
  applyCamControls();
}

let meterCtx = null, meterSrc = null, meterRaf = 0;
function setupMeter(stream) {
  cancelAnimationFrame(meterRaf);
  if (!stream?.getAudioTracks().length) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = S.audio?.ctx || (meterCtx ||= new AC());
  try { meterSrc?.disconnect(); } catch {}
  const an = ctx.createAnalyser(); an.fftSize = 512; meterSrc = ctx.createMediaStreamSource(stream); meterSrc.connect(an);
  const buf = new Float32Array(an.fftSize);
  const loop = () => {
    an.getFloatTimeDomainData(buf); let s = 0; for (const x of buf) s += x * x;
    const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9), pct = Math.max(0, Math.min(100, (db + 60) * 1.9));
    $$('.meterbar i').forEach(i => i.style.width = (S.mic ? pct : 0) + '%');
    meterRaf = requestAnimationFrame(loop);
  };
  loop();
}

async function setCam(on) {
  S.cam = on;
  if (on) {
    const vt = S.stream?.getVideoTracks()[0];
    if (!vt || vt.readyState === 'ended') {
      try {
        const vs = await getMedia({ audio: false, video: true });
        const ns = new MediaStream([...(S.stream?.getAudioTracks() || []), ...vs.getVideoTracks()]);
        setStream(ns);
      } catch { S.cam = false; toast('Impossible d\'allumer la caméra.', { error: true }); }
    }
  } else {
    S.stream?.getVideoTracks().forEach(t => { t.stop(); S.stream.removeTrack(t); });
    if (S.video) S.video.srcObject = null;
  }
  S.engine?.setState({ cam: S.cam });
  refreshSelf(); refreshButtons();
}
function setMic(on) {
  if (on && !S.stream?.getAudioTracks().length) { toast('Aucun micro disponible.', { error: true }); on = false; }
  S.mic = on; S.stream?.getAudioTracks().forEach(t => t.enabled = on);
  if (S.audio) S.audio.muted = !on;
  S.engine?.setState({ mic: on });
  refreshSelf(); refreshButtons();
}

async function setBackground(id, { silent = false } = {}) {
  S.effects ||= new Effects({ onFallback: msg => { toast(msg); S.bg = 'none'; localStorage.setItem('cc-bg', 'none'); refreshBgButtons(); } });
  let src = null;
  if (id.startsWith('preset:')) src = drawPreset(id.slice(7));
  if (id === 'custom') {
    const data = localStorage.getItem('cc-bg-custom'); if (!data) return;
    const img = new Image(); img.src = data; await img.decode().catch(() => {}); src = img;
  }
  S.bg = id; localStorage.setItem('cc-bg', id); refreshBgButtons();
  if (id === 'none') { await S.effects.set('none'); return; }
  try { await S.effects.set(id === 'blur' ? 'blur' : 'image', src); }
  catch { S.bg = 'none'; refreshBgButtons(); if (!silent) toast('Effets d\'arrière-plan indisponibles sur cet appareil.', { error: true }); }
}
async function pickCustomBg() {
  const inp = h('input', { type: 'file', accept: 'image/*' });
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    try {
      const bmp = await createImageBitmap(f); const c = document.createElement('canvas');
      const k = Math.min(1, 1280 / bmp.width, 720 / bmp.height); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      localStorage.setItem('cc-bg-custom', c.toDataURL('image/jpeg', .82));
      await setBackground('custom');
      $$('.bgopt[data-bg=custom]').forEach(b => b.replaceChildren(h('img', { src: localStorage.getItem('cc-bg-custom'), alt: '' })));
    } catch { toast('Image illisible.', { error: true }); }
  });
  inp.click();
}
function bgPicker() {
  const opts = [['none', 'Aucun'], ['blur', 'Flou'], ...PRESETS.map(p => ['preset:' + p.id, p.label]), ['custom', 'Image']];
  return h('div', { class: 'bgs', role: 'group', 'aria-label': 'Arrière-plan' }, opts.map(([id, label]) => {
    const b = h('button', { type: 'button', class: 'bgopt', title: label, 'aria-label': label, dataset: { bg: id } });
    if (id === 'none') b.append(icon('x')); else if (id === 'blur') b.append(icon('blur'));
    else if (id === 'custom') b.append(localStorage.getItem('cc-bg-custom') ? h('img', { src: localStorage.getItem('cc-bg-custom'), alt: '' }) : icon('image'));
    else { const c = drawPreset(id.slice(7), 116, 76); b.append(c); }
    b.addEventListener('click', () => id === 'custom' && (!localStorage.getItem('cc-bg-custom') || S.bg === 'custom') ? pickCustomBg() : setBackground(id));
    return b;
  }));
}
function refreshBgButtons() { $$('.bgopt').forEach(b => b.classList.toggle('on', b.dataset.bg === S.bg)); paintQuality(); }

async function deviceSelects() {
  const wrap = h('div');
  let devs = []; try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const mk = (kind, label, key, ic) => {
    const list = devs.filter(d => d.kind === kind && d.deviceId); if (!list.length) return null;
    const cur = kind === 'videoinput' ? S.stream?.getVideoTracks()[0]?.getSettings().deviceId : kind === 'audioinput' ? S.stream?.getAudioTracks()[0]?.getSettings().deviceId : localStorage.getItem(key);
    const sel = h('select', { 'aria-label': label }, list.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || `${label} ${i + 1}`)));
    sel.addEventListener('change', async () => {
      localStorage.setItem(key, sel.value);
      if (kind === 'audiooutput') { S.audio?.setSink(sel.value); return; }
      try {
        const ns = await getMedia({ audio: S.stream?.getAudioTracks().length > 0 || kind === 'audioinput', video: S.cam });
        setStream(ns);
      } catch { toast('Impossible d\'utiliser cet appareil.', { error: true }); }
    });
    return h('div', { class: 'field' }, h('label', {}, label), h('div', { class: 'inp' }, icon(ic), sel, icon('down')));
  };
  wrap.append(...[mk('videoinput', 'Caméra', 'cc-camid', 'cam'), mk('audioinput', 'Micro', 'cc-mic', 'mic'),
    (window.AudioContext && 'setSinkId' in AudioContext.prototype) ? mk('audiooutput', 'Haut-parleur', 'cc-out', 'vol') : null].filter(Boolean));
  return wrap;
}

// ---------- Traitement du micro (réduction de bruit, isolateur de voix, autotune, compresseur, dé-esseur) ----------
// Cinq interrupteurs indépendants, enregistrés dans ce navigateur et appliqués à chaud (le micro n'est pas rouvert).
// Ordre de la chaîne : micro → isolateur de voix (ou, s'il est coupé, réduction de bruit) → autotune → compresseur →
// dé-esseur → Opus. L'isolateur inclut la réduction de bruit : RNNoise est alors mis en pause (pas de double traitement).
const FX_ITEMS = [
  ['ns', 'Réduction de bruit', 'Souffle, clavier, ventilation (RNNoise, calculé sur ton appareil)'],
  ['iso', 'Isolateur de voix', 'Garde ta voix : musique, télé, bruits et voix lointaines atténués (DeepFilterNet, calculé sur ton appareil)'],
  ['tune', 'Autotune', 'Ramène le chant sur la note juste la plus proche'],
  ['comp', 'Compresseur', 'Voix plus régulière : les passages faibles remontent, les forts sont tenus'],
  ['deess', 'Dé-esseur', 'Adoucit les « s » et « ch » qui sifflent (5–9 kHz)'],
];
async function setFx(k, on) {
  S.fx = { ...S.fx, [k]: on }; saveFx(S.fx); paintFx();
  const st = await S.audio?.setFx(S.fx);
  if (k === 'ns' && on && st?.ns === 'indisponible') toast('Réduction de bruit indisponible sur ce navigateur : seule celle du navigateur reste active.', { error: true });
  if (k === 'iso' && on && st?.iso === 'indisponible') toast(`Isolateur de voix indisponible : ${S.audio?.chain?.isoError || 'navigateur non compatible'}. Le son passe sans isolation${S.fx.ns ? ' (la réduction de bruit reste active)' : ''}.`, { error: true });
  if (k === 'tune' && on && st?.tune === 'indisponible') toast('Autotune indisponible sur ce navigateur : le son passe sans correction.', { error: true });
  paintFx();
}
// Réglages de l'autotune (vitesse, tonalité, mode) : enregistrés et transmis à chaud au module audio.
function setTune(part) {
  S.fx = { ...S.fx, ...part }; paintFx();
  S.audio?.setFx(S.fx);
  saveFx(S.fx); // écriture locale immédiate : rien n'est perdu si la page est fermée juste après
}
function tuneField() {
  const speed = h('input', { type: 'range', class: 'tspeed', min: 0, max: 100, step: 1, value: String(S.fx.tuneSpeed), 'aria-label': 'Vitesse de correction',
    oninput: e => setTune({ tuneSpeed: +e.target.value }) });
  const key = h('select', { class: 'tkey', 'aria-label': 'Tonalité', onchange: e => setTune({ tuneKey: +e.target.value }) },
    h('option', { value: '-1' }, 'Chromatique (toutes les notes)'), NOTE_NAMES.map((n, i) => h('option', { value: String(i) }, n)));
  key.value = String(S.fx.tuneKey);
  const mode = h('div', { class: 'seg tmode', role: 'radiogroup', 'aria-label': 'Mode' },
    [['Majeur', false], ['Mineur', true]].map(([l, minor]) => h('button', { type: 'button', role: 'radio', dataset: { minor: String(minor) }, onclick: () => setTune({ tuneMinor: minor }) }, l)));
  return h('div', { class: 'tuneset', hidden: true },
    h('div', { class: 'trow' }, h('span', { class: 'tl' }, 'Vitesse de correction'), h('span', { class: 'tval' })),
    speed, h('div', { class: 'tends' }, h('span', {}, 'Naturel'), h('span', {}, 'Robot')),
    h('div', { class: 'trow' }, h('span', { class: 'tl' }, 'Tonalité')),
    h('div', { class: 'tkeys' }, h('div', { class: 'inp' }, icon('note'), key, icon('down')), mode),
    h('div', { class: 'tunenow', 'aria-live': 'off' }));
}
function speedLabel(v) { return v >= 90 ? 'robot' : v >= 65 ? 'rapide' : v >= 35 ? 'moyenne' : 'naturelle'; }
function paintTune() {
  const on = !!S.fx.tune, st = S.audio?.chain?.status?.tune, info = S.audio?.chain?.meters?.()?.tune;
  $$('.tuneset').forEach(box => {
    box.hidden = !on;
    if (!on) return;
    const sp = box.querySelector('.tspeed'); if (document.activeElement !== sp && +sp.value !== S.fx.tuneSpeed) sp.value = String(S.fx.tuneSpeed);
    sp.style.setProperty('--v', S.fx.tuneSpeed + '%');
    box.querySelector('.tval').textContent = `${S.fx.tuneSpeed} · ${speedLabel(S.fx.tuneSpeed)}`;
    const k = box.querySelector('.tkey'); if (k.value !== String(S.fx.tuneKey)) k.value = String(S.fx.tuneKey);
    const m = box.querySelector('.tmode'); m.hidden = S.fx.tuneKey < 0;
    m.querySelectorAll('button').forEach(b => { const sel = b.dataset.minor === String(!!S.fx.tuneMinor); b.classList.toggle('on', sel); b.setAttribute('aria-checked', String(sel)); });
    const now = box.querySelector('.tunenow');
    let t, cls = '';
    if (st === 'indisponible' || (!autotuneSupported() && on)) t = 'Autotune indisponible sur ce navigateur (le son passe sans correction).';
    else if (!S.audio?.chain) t = 'La note chantée et la correction s\'afficheront ici pendant l\'appel.';
    else if (st === 'chargement') t = 'Chargement de l\'autotune…';
    else if (!info?.voiced) { t = 'Pas de voix chantée détectée : le son passe tel quel.'; cls = 'idle'; }
    else {
      const c = info.cents, sign = c > 0 ? '+' : c < 0 ? '−' : '±';
      t = `${info.note}${info.target && info.target !== info.note ? ' → ' + info.target : ''} · ${info.hz.toFixed(0)} Hz · correction ${sign}${Math.abs(c)} cents`;
      cls = 'tn-live';
    }
    if (now.textContent !== t) now.textContent = t;
    now.className = 'tunenow ' + cls;
  });
}
// Intensité de l'isolateur : transmise à chaud au module audio.
function isoField() {
  const lvl = h('input', { type: 'range', class: 'tspeed ilevel', min: 0, max: 100, step: 1, value: String(S.fx.isoLevel), 'aria-label': 'Intensité de l\'isolation',
    oninput: e => setTune({ isoLevel: +e.target.value }) });
  return h('div', { class: 'isoset', hidden: true },
    h('div', { class: 'trow' }, h('span', { class: 'tl' }, 'Intensité'), h('span', { class: 'tval' })),
    lvl, h('div', { class: 'tends' }, h('span', {}, 'Légère'), h('span', {}, 'Forte')),
    h('div', { class: 'isobar', hidden: true }, h('i')),
    h('div', { class: 'isonow', 'aria-live': 'polite' }),
    h('div', { class: 'isowarn', hidden: true }, 'Pour chanter, mieux vaut couper l\'isolateur : il est fait pour la parole et peut atténuer les notes tenues.'));
}
function levelLabel(v) { return v >= 80 ? 'forte' : v >= 45 ? 'moyenne' : v >= 15 ? 'douce' : 'légère'; }
const mo = b => (b / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
function paintIso() {
  const on = !!S.fx.iso, ch = S.audio?.chain, st = ch?.status?.iso, info = ch?.meters?.()?.iso;
  $$('.isoset').forEach(box => {
    box.hidden = !on;
    if (!on) return;
    const sp = box.querySelector('.ilevel'); if (document.activeElement !== sp && +sp.value !== S.fx.isoLevel) sp.value = String(S.fx.isoLevel);
    sp.style.setProperty('--v', S.fx.isoLevel + '%');
    box.querySelector('.tval').textContent = `${S.fx.isoLevel} · ${levelLabel(S.fx.isoLevel)}`;
    const bar = box.querySelector('.isobar'), now = box.querySelector('.isonow');
    let t, cls = '', prog = -1;
    if (st === 'indisponible' || (!isolatorSupported() && on)) { t = `Isolateur indisponible : ${ch?.isoError || 'navigateur non compatible'}. Le son passe sans isolation.`; cls = 'iso-na'; }
    else if (!ch) t = 'Le modèle (≈ 11 Mo, une seule fois) se télécharge quand tu rejoins l\'appel.';
    else if (st === 'chargement') {
      if (isoLoad.state === 'download' && isoLoad.total) { prog = Math.min(1, isoLoad.loaded / isoLoad.total); t = `Téléchargement du modèle… ${Math.round(prog * 100)} % (une seule fois)`; }
      else if (isoLoad.state === 'compile') { prog = 1; t = 'Préparation du modèle…'; }
      else t = 'Démarrage du modèle…';
      cls = 'iso-loading';
    } else if (st === 'on') {
      const g = info?.gateDb || 0;
      t = `Actif · ${ch.isoLatencyMs.toFixed(0)} ms de latence${g >= 1 ? ` · voix de second plan −${g.toFixed(0)} dB` : ''}${S.fx.ns ? ' · réduction de bruit incluse' : ''}`;
      cls = 'iso-live';
    }
    bar.hidden = prog < 0; if (prog >= 0) bar.firstChild.style.width = (prog * 100).toFixed(1) + '%';
    if (now.textContent !== t) now.textContent = t;
    now.className = 'isonow ' + cls;
    box.querySelector('.isowarn').hidden = !S.fx.tune;
  });
}
function fxStatus() {
  const st = S.audio?.chain?.status, parts = [];
  if (!S.audio?.chain) parts.push(S.engine ? 'Micro absent : réglages enregistrés.' : 'Appliqué dès que tu rejoins, puis modifiable pendant l\'appel sans coupure.');
  if (st?.ns === 'chargement') parts.push('Chargement de la réduction de bruit…');
  if (st?.ns === 'inclus') parts.push('Réduction de bruit : incluse dans l\'isolateur de voix (RNNoise en pause).');
  if (st?.ns === 'indisponible' || (!noiseSuppressionSupported() && S.fx.ns)) parts.push('Réduction de bruit indisponible sur ce navigateur.');
  else if (S.fx.ns && S.audio?.chain?.nsInfo) parts.push(S.audio.chain.nsInfo);
  const m = S.audio?.chain?.meters?.();
  if (m && (S.fx.comp || S.fx.deess)) parts.push([S.fx.comp ? `Compression : −${m.comp.toFixed(1)} dB` : '', S.fx.deess ? `Dé-esseur : −${m.deess.toFixed(1)} dB` : ''].filter(Boolean).join(' · '));
  return parts.join(' ');
}
function paintFx() {
  $$('.tg[data-fx]').forEach(b => {
    const k = b.dataset.fx, on = !!S.fx[k], na = S.audio?.chain?.status?.[k] === 'indisponible';
    b.classList.toggle('on', on); b.classList.toggle('na', na); b.setAttribute('aria-checked', String(on));
  });
  const t = fxStatus(); $$('.fxnow').forEach(e => { if (e.textContent !== t) e.textContent = t; });
  paintTune(); paintIso();
}
let fxTimer = 0;
function micFxField({ label = true } = {}) {
  const btns = FX_ITEMS.map(([k, label, desc]) => h('button', { type: 'button', class: 'tg', role: 'switch', 'aria-checked': 'false', dataset: { fx: k }, onclick: () => setFx(k, !S.fx[k]) },
    h('span', { class: 'tgt' }, h('b', {}, label), h('small', {}, desc)), h('span', { class: 'sw', 'aria-hidden': 'true' })));
  setTimeout(paintFx, 0);
  // valeurs en direct (réduction de gain) tant que les interrupteurs sont affichés
  clearInterval(fxTimer); fxTimer = setInterval(() => { if (!$('.fxnow')) { clearInterval(fxTimer); fxTimer = 0; return; } paintFx(); }, 200);
  // réglages de l'autotune et de l'isolateur juste sous leur interrupteur (masqués tant qu'ils sont coupés)
  const list = []; for (const b of btns) { list.push(b); if (b.dataset.fx === 'tune') list.push(tuneField()); if (b.dataset.fx === 'iso') list.push(isoField()); }
  return h('div', { class: 'field', id: 'micFxField' }, label ? h('label', {}, 'Traitement du micro') : null,
    h('div', { class: 'toggles fx', role: 'group', 'aria-label': 'Traitement du micro' }, list), h('div', { class: 'fxnow', 'aria-live': 'polite' }));
}
function openMicFx() {
  modal('Traitement du micro', micFxField({ label: false }),
    h('div', { class: 'hint' }, icon('mic'), 'Ordre : micro → isolateur de voix (ou réduction de bruit) → autotune → compresseur → dé-esseur → envoi. Tout est calculé sur ton appareil, avant le chiffrement : rien ne part vers un service extérieur. La réduction de bruit légère du navigateur reste toujours active ; l\'interrupteur ajoute RNNoise, nettement plus efficace. L\'isolateur va plus loin (musique, télé, voix lointaines) et inclut la réduction de bruit.'));
}

// ---------------- Réglages de la caméra (1.10) ----------------
// Luminosité, contraste, saturation, netteté, exposition, balance des blancs : seulement ceux que la caméra et le
// navigateur exposent (Chrome / Edge sur ordinateur ; Firefox et Safari n'en exposent pas). Mode faible lumière
// (15 i/s) et débit HD. Tout est appliqué à chaud sur la piste vidéo, sans rouvrir la caméra.
const camTrack = () => { const t = S.stream?.getVideoTracks()[0]; return t && t.readyState === 'live' ? t : null; };
const camCaps = t => { try { return t?.getCapabilities?.() || {}; } catch { return {}; } };
function camDev(t = camTrack()) {
  const id = t?.getSettings?.().deviceId || 'default';
  if (!S.camfx.dev[id]) {
    // première ouverture de cette caméra : valeurs d'origine (pilote / logiciel du fabricant) relevées pour « Réinitialiser »
    S.camfx.dev[id] = { set: {}, def: pick(t?.getSettings?.() || {}) };
    const ids = Object.keys(S.camfx.dev); if (ids.length > 8) delete S.camfx.dev[ids[0]];
    saveCam(S.camfx);
  }
  return S.camfx.dev[id];
}
function camConstraints(t = camTrack(), adv = null) {
  const c = { ...camSize(), ...resizeModeFor(), frameRate: frameRateFor(S.camfx) };
  const a = adv || (t ? advancedFor(camCaps(t), camDev(t).set) : []);
  return a.length ? { ...c, advanced: a } : c;
}
let camApplying = Promise.resolve();
function applyCamControls(adv) {
  const t = camTrack(); if (!t?.applyConstraints) return camApplying;
  camApplying = camApplying.then(async () => {
    if (!adv && !Object.keys(camDev(t).set).length && !S.camfx.lowLight) return; // rien de changé : on laisse le pilote
    // Deux temps : Chrome traite à part les contraintes d'image (luminosité, exposition…) et ignore alors la taille et
    // la cadence passées dans le même appel. On applique donc d'abord taille + cadence, puis le tout avec « advanced ».
    const base = { ...camSize(), ...resizeModeFor(), frameRate: frameRateFor(S.camfx) }, all = camConstraints(t, adv);
    try { await t.applyConstraints(base); } catch {}
    if (all.advanced) { try { await t.applyConstraints(all); } catch {} }
  }).then(() => paintCam()).catch(() => {});
  return camApplying;
}
let camTimer = 0;
function setCamCtl(part) {
  const t = camTrack(); if (!t) return;
  const d = camDev(t); Object.assign(d.set, part); saveCam(S.camfx);
  paintCam(); clearTimeout(camTimer); camTimer = setTimeout(() => applyCamControls(), 60);
}
function setLowLight(on) { S.camfx.lowLight = on; saveCam(S.camfx); paintCam(); applyCamControls(advancedFor(camCaps(camTrack()), camDev().set)); }
function setRate(r) { S.camfx.rate = r; saveCam(S.camfx); if (S.engine) S.engine.rate = r; paintCam(); }
async function resetCam() {
  const t = camTrack(); if (!t) return;
  const d = camDev(t); d.set = {}; S.camfx.lowLight = false; S.camfx.enh = { ...S.camfx.enh, on: false, k: 0.6, wb: false }; saveCam(S.camfx);
  ensureEnh(); refreshSelf();
  await applyCamControls(resetAdvanced(camCaps(t), d.def));
  toast('Réglages de la caméra réinitialisés');
}
// Exposition manuelle : curseur logarithmique (de 1/10 000 s à plusieurs centaines de ms, réparties lisiblement).
const LOG_STEPS = 1000;
const toLog = (cap, v) => Math.round(Math.log(Math.max(cap.min, v) / Math.max(cap.min, 1e-3)) / Math.log(cap.max / Math.max(cap.min, 1e-3)) * LOG_STEPS);
const fromLog = (cap, x) => clampCap(cap, Math.max(cap.min, 1e-3) * (cap.max / Math.max(cap.min, 1e-3)) ** (x / LOG_STEPS));
function camSlider(k, label, cap, { log = false, fmt = v => String(Math.round(v)) } = {}) {
  const inp = h('input', { type: 'range', class: 'tspeed camr', min: 0, max: log ? LOG_STEPS : cap.max, step: log ? 1 : (cap.step > 0 ? cap.step : 1), 'aria-label': label, dataset: { k, log: log ? '1' : '' },
    oninput: e => setCamCtl({ [k]: log ? fromLog(cap, +e.target.value) : +e.target.value }) });
  if (!log) inp.min = String(cap.min);
  inp._cap = cap; inp._fmt = fmt;
  return h('div', { class: 'camctl' }, h('div', { class: 'trow' }, h('span', { class: 'tl' }, label), h('span', { class: 'tval', dataset: { v: k } })), inp);
}
function camModeSeg(k, label) {
  return h('div', { class: 'trow camrow' }, h('span', { class: 'tl' }, label),
    h('div', { class: 'seg cammode', role: 'radiogroup', 'aria-label': label, dataset: { k } },
      [['continuous', 'Auto'], ['manual', 'Manuel']].map(([v, l]) => h('button', { type: 'button', role: 'radio', dataset: { m: v }, onclick: () => setCamCtl({ [k]: v }) }, l))));
}
function camField() {
  const t = camTrack(), caps = camCaps(t), c = controlsOf(caps), st = t?.getSettings?.() || {};
  const img = [];
  if (!t) img.push(h('div', { class: 'camna' }, 'Allume ta caméra pour la régler.'));
  else if (!hasControls(caps)) img.push(h('div', { class: 'camna' }, 'Ce navigateur ou cette caméra n\'expose pas de réglage d\'image (Chrome ou Edge sur ordinateur requis). Le mode faible lumière et le débit HD restent disponibles.'));
  else {
    for (const { k, label, cap } of c.sliders) img.push(camSlider(k, label, cap));
    if (c.exposure) {
      img.push(camModeSeg('exposureMode', 'Exposition'));
      img.push(h('div', { class: 'camsub', dataset: { when: 'exposureMode:manual' } }, camSlider('exposureTime', 'Temps d\'exposition', caps.exposureTime, { log: true, fmt: fmtExposure })));
    }
    if (c.exposureComp) img.push(h('div', { class: 'camsub', dataset: { when: 'exposureMode:continuous' } }, camSlider('exposureCompensation', 'Correction d\'exposition', caps.exposureCompensation, { fmt: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' IL' })));
    if (c.wb) {
      img.push(camModeSeg('whiteBalanceMode', 'Balance des blancs'));
      img.push(h('div', { class: 'camsub', dataset: { when: 'whiteBalanceMode:manual' } }, camSlider('colorTemperature', 'Température', caps.colorTemperature, { fmt: v => Math.round(v) + ' K' })));
    }
    if (c.zoom) {
      img.push(camSlider('zoom', 'Zoom', caps.zoom, { fmt: v => fmtZoom(v, caps.zoom) }));
      img.push(h('div', { class: 'crow camzoom' }, h('span', { class: 'camzoomhint' }),
        h('button', { type: 'button', class: 'btn sm', onclick: () => setCamCtl({ zoom: caps.zoom.min }) }, 'Champ complet')));
    }
  }
  // Zoom : Chrome ne l'expose qu'avec l'autorisation « déplacer la caméra » (PTZ), demandée seulement à la demande.
  let zoomAsk = null;
  if (t && !c.zoom) {
    if (!S.camfx.ptz && navigator.userAgentData) zoomAsk = h('div', { class: 'crow camzoom' }, h('span', { class: 'camzoomhint' }, 'Un logiciel du fabricant peut avoir laissé un zoom dans la caméra (image recadrée).'),
      h('button', { type: 'button', class: 'btn sm', id: 'camPtz', onclick: allowZoom }, 'Régler le zoom'));
    else if (S.camfx.ptz) zoomAsk = h('div', { class: 'camna' }, 'Cette caméra n\'expose pas de zoom au navigateur : le champ est celui du capteur.');
  }
  const low = h('button', { type: 'button', class: 'tg camlow', role: 'switch', 'aria-checked': 'false', onclick: () => setLowLight(!S.camfx.lowLight) },
    h('span', { class: 'tgt' }, h('b', {}, 'Faible lumière'), h('small', {}, '15 images/s : exposition plus longue, nettement moins de grain dans une pièce sombre')), h('span', { class: 'sw', 'aria-hidden': 'true' }));
  const rate = h('div', { class: 'seg camrate', role: 'radiogroup', 'aria-label': 'Débit HD' },
    RATE_OPTIONS.map(([v, l, title]) => h('button', { type: 'button', role: 'radio', title, 'aria-label': title, dataset: { r: v }, onclick: () => setRate(v) }, l)));
  const sw = (cls, title, sub, on) => h('button', { type: 'button', class: 'tg ' + cls, role: 'switch', 'aria-checked': 'false', onclick: on },
    h('span', { class: 'tgt' }, h('b', {}, title), h('small', {}, sub)), h('span', { class: 'sw', 'aria-hidden': 'true' }));
  const enh = sw('camenh', 'Rehaussement faible lumière', 'Éclaircit les ombres et lisse le grain sur la carte graphique, sans brûler les LED. Léger flou sur les mouvements rapides.', () => setEnh({ on: !S.camfx.enh.on }));
  const enhK = h('input', { type: 'range', class: 'tspeed enhk', min: 0, max: 100, step: 5, 'aria-label': 'Intensité du rehaussement', oninput: e => setEnh({ k: +e.target.value / 100 }) });
  const enhWb = sw('camenhwb', 'Balance des blancs auto', 'Atténue une dominante de couleur (limitée à ±25\u00a0% par couleur, les LED vives ne comptent pas).', () => setEnh({ wb: !S.camfx.enh.wb }));
  const enhBox = h('div', { class: 'camset enhset' },
    h('div', { class: 'camctl' }, h('div', { class: 'trow' }, h('span', { class: 'tl' }, 'Intensité'), h('span', { class: 'tval enhkval' })), enhK),
    h('div', { class: 'toggles fx' }, enhWb), h('div', { class: 'enhnow', 'aria-live': 'polite' }));
  const view = h('div', { class: 'toggles fx' },
    sw('cammirror', 'Aperçu en miroir', 'Comme dans une glace. Les autres te voient toujours à l\'endroit.', () => setSelfView({ mirror: !S.camfx.mirror })),
    sw('camfull', 'Champ complet', 'Toute l\'image de la caméra, sans rogner les bords de l\'aperçu.', () => setSelfView({ fill: !S.camfx.fill })));
  const box = h('div', { class: 'field', id: 'camField' },
    h('div', { class: 'camnow', 'aria-live': 'polite' }, st.width ? `${t.label || 'Caméra'} · ${st.width}×${st.height}` : ''),
    img.length ? h('div', { class: 'camset' }, img) : null, zoomAsk,
    h('div', { class: 'toggles fx' }, enh), enhBox,
    h('div', { class: 'toggles fx' }, low),
    h('div', { class: 'camset' }, h('div', { class: 'trow' }, h('span', { class: 'tl' }, 'Débit HD'), h('span', { class: 'tval camrateval' })), rate, h('div', { class: 'camratehint' })),
    h('div', { class: 'camsec' }, 'Aperçu de toi'), view,
    t ? h('div', { class: 'crow camfoot' }, h('button', { type: 'button', class: 'btn', onclick: resetCam }, 'Réinitialiser')) : null);
  setTimeout(paintCam, 0);
  return box;
}
async function allowZoom() {
  S.camfx.ptz = true; saveCam(S.camfx);
  try {
    const vs = await getMedia({ audio: false, video: true });
    setStream(new MediaStream([...(S.stream?.getAudioTracks() || []), ...vs.getVideoTracks()]));
    S.engine?.setState({ cam: true }); S.cam = true;
  } catch { S.camfx.ptz = false; saveCam(S.camfx); toast('Autorisation du zoom refusée : rien n\'a changé.', { error: true }); }
  await new Promise(r => setTimeout(r, 300));
  $$('#camField').forEach(b => b.replaceWith(camField()));
}
function enhStatus() {
  const e = S.enh, i = e?.info;
  if (!S.camfx.enh.on) return '';
  if (!i || i.mode === 'off' || i.failed) return 'Indisponible sur cet appareil.';
  if (!S.cam) return 'En attente de la caméra.';
  const how = i.mode === 'webgl2' ? 'Carte graphique (WebGL2)' : 'Mode simplifié (sans WebGL2) : éclaircissement seul';
  const res = i.side ? (i.side >= 1900 ? '1080p' : i.side >= 1270 ? '720p' : '360p') : '';
  const cost = i.cost ? `${i.cost.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}\u00a0ms par image` : '';
  const lite = i.level === 1 ? 'filtre allégé' : i.level >= 2 ? 'limité à 720p (appareil lent)' : '';
  return [how, res, cost, i.fps ? `${i.fps}\u00a0i/s` : '', lite].filter(Boolean).join(' · ');
}
function paintCam() {
  const t = camTrack(), caps = camCaps(t), st = t?.getSettings?.() || {}, set = t ? (S.camfx.dev[st.deviceId || 'default']?.set || {}) : {};
  const cur = k => set[k] ?? st[k];
  $$('#camField').forEach(box => {
    const now = box.querySelector('.camnow');
    if (now && st.width) { const x = `${t.label || 'Caméra'} · ${st.width}×${st.height} · ${Math.round(st.frameRate || 0)} i/s`; if (now.textContent !== x) now.textContent = x; }
    box.querySelectorAll('input.camr').forEach(inp => {
      const k = inp.dataset.k, v = cur(k); if (v == null) return;
      const pos = inp.dataset.log ? toLog(inp._cap, v) : v;
      if (document.activeElement !== inp && +inp.value !== pos) inp.value = String(pos);
      const span = inp.max - inp.min; inp.style.setProperty('--v', (span > 0 ? (inp.value - inp.min) / span * 100 : 0) + '%');
      const lab = box.querySelector(`.tval[data-v="${k}"]`); if (lab) lab.textContent = inp._fmt(v);
    });
    box.querySelectorAll('.cammode').forEach(sg => sg.querySelectorAll('button').forEach(b => { const on = (cur(sg.dataset.k) || 'continuous') === b.dataset.m; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }));
    box.querySelectorAll('.camsub').forEach(el => { const [k, v] = el.dataset.when.split(':'); el.hidden = (cur(k) || 'continuous') !== v; });
    const tgl = (sel, on) => { const b = box.querySelector(sel); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } };
    tgl('.camlow', S.camfx.lowLight); tgl('.camenh', S.camfx.enh.on); tgl('.camenhwb', S.camfx.enh.wb); tgl('.cammirror', S.camfx.mirror); tgl('.camfull', !S.camfx.fill);
    const es = box.querySelector('.enhset'); if (es) es.hidden = !S.camfx.enh.on;
    const ek = box.querySelector('input.enhk'); if (ek) { const v = Math.round(S.camfx.enh.k * 100); if (document.activeElement !== ek) ek.value = String(v); ek.style.setProperty('--v', v + '%'); }
    const ekv = box.querySelector('.enhkval'); if (ekv) ekv.textContent = Math.round(S.camfx.enh.k * 100) + ' %';
    const en = box.querySelector('.enhnow'); if (en) { const x = enhStatus(); if (en.textContent !== x) en.textContent = x; }
    const zh = box.querySelector('.camzoom .camzoomhint'); if (zh && t && controlsOf(caps).zoom) zh.textContent = zoomed(caps, { zoom: cur('zoom') }) ? 'Zoom actif : l\'image est recadrée.' : 'Champ complet du capteur.';
    const mir = box.querySelector('.cammirror'); if (mir) mir.disabled = S.facing !== 'user';
    box.querySelectorAll('.camrate button').forEach(b => { const on = b.dataset.r === S.camfx.rate; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    const br = S.engine?.bitrates || { hd1080: 2500, hd1080max: 4000, hd720: 1200, hd720max: 2000 }, n = S.engine ? S.engine.peersBySid.size + 1 : 0;
    const h1080 = wantedCeiling() >= 1080, kb = h1080 ? hdKbps(br.hd1080, br.hd1080max, { n, rate: S.camfx.rate }) : hdKbps(br.hd720, br.hd720max, { n, rate: S.camfx.rate });
    const fmt = k => (k / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' Mbit/s';
    const lo = h1080 ? br.hd1080 : br.hd720, hi = Math.max(lo, h1080 ? br.hd1080max : br.hd720max);
    const val = box.querySelector('.camrateval'); if (val) val.textContent = `${h1080 ? '1080p' : '720p'} · ${!n && S.camfx.rate === 'auto' && hi > lo ? `${fmt(lo).replace(' Mbit/s', '')} à ${fmt(hi)}` : fmt(kb)}`;
    const hint = box.querySelector('.camratehint');
    if (hint) hint.textContent = S.camfx.rate === 'auto' ? (n ? `Salon de ${n} : ${n <= 3 ? 'débit maximal' : n <= 6 ? 'débit intermédiaire' : 'débit standard'}. ` : 'Maximal à 2 ou 3 personnes, réduit au-delà. ') + 'Envoyé seulement à qui t\'affiche en grand.'
      : S.camfx.rate === 'high' ? 'Toujours au maximum : le plus net, mais plus lourd pour le réseau de chacun.' : 'Débit d\'avant la 1.10 : plus léger, image plus douce.';
  });
}
function camEntry() {
  return h('div', { class: 'field' }, h('label', {}, 'Image de la caméra'),
    h('button', { type: 'button', class: 'tg camopen', onclick: openCamera },
      h('span', { class: 'tgt' }, h('b', {}, 'Réglages de la caméra'), h('small', {}, 'Rehaussement faible lumière, luminosité, exposition, zoom, miroir, débit HD')), icon('cam')));
}
function openCamera() {
  const bg = modal('Réglages de la caméra', camField(),
    h('div', { class: 'hint' }, icon('cam'), 'Le navigateur n\'utilise pas les réglages du logiciel de ta webcam (Logi Tune, G HUB…) : RightLight, HDR ou réduction de bruit du fabricant ne s\'appliquent pas ici. Le rehaussement faible lumière fait un travail comparable dans le navigateur. Ferme ce logiciel pendant l\'appel (il peut garder la caméra) ; une lampe face à toi reste ce qui réduit le plus le grain.'));
  const tm = setInterval(() => { if (!bg?.isConnected) return clearInterval(tm); const en = $('.enhnow', bg); if (en) { const x = enhStatus(); if (en.textContent !== x) en.textContent = x; } }, 1000);
}

// ---------------- Démarrage ----------------
async function boot() {
  // Page restée en cache après une mise à jour du serveur : rechargement avant de rejoindre.
  try { await ensureFresh((await session()).build); } catch {}
  let info;
  try { info = await api(`/api/rooms/${encodeURIComponent(slug)}`); }
  catch (e) {
    view.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'logo' }, icon('cam')), h('h2', {}, 'Salon introuvable'),
      h('p', {}, e.status === 404 ? 'Ce salon n\'existe pas ou a expiré après une longue période d\'inactivité.' : e.message),
      h('a', { class: 'btn pri', href: '/#nouveau' }, icon('plus'), 'Créer un salon')));
    return;
  }
  S.info = info; document.title = `${info.name} · ChatSysVisio`; $('#roomTitle').textContent = info.name;
  // Chiffrement de bout en bout : la clé vient du fragment #k= (jamais envoyé au serveur) et/ou du mot de passe.
  const pre = await prepare(info, slug, location.hash).catch(() => ({ status: 'badlink' }));
  S.e2 = pre.e2 || null; S.e2status = pre.status;
  paintE2eeBadge();
  if (pre.status === 'nolink' || pre.status === 'badlink' || pre.status === 'badkey') { keyProblemView(pre.status); return; }
  const b = $('#roomBadge'); b.hidden = false; b.className = 'badge ' + (info.isPublic ? 'acc' : '');
  b.replaceChildren(icon(info.isPublic ? 'globe' : 'lock'), info.isPublic ? 'Public' : 'Privé');
  rememberRoom(info.slug, info.name); renderSidebar(info.slug);
  detectCaps().then(c => { S.caps = c; paintQuality(); applyCameraSize(); });
  renderLobby();
  await startMedia();
  if (S.bg !== 'none') setBackground(S.bg, { silent: true });
  if (S.camfx.enh.on) { ensureEnh(); refreshSelf(); }
  const ds = $('#devices'); if (ds) ds.replaceChildren(await deviceSelects());
  refreshButtons();
}

// ---------------- Lobby ----------------
function selfTileContent(cls = '') {
  const v = h('video', { class: 'selfvid', muted: true, playsinline: true, autoplay: true });
  v.muted = true; if (S.video?.srcObject) { v.srcObject = S.video.srcObject; v.play().catch(() => {}); }
  const c = h('canvas', { class: 'selfcanvas', hidden: true }); previews.add(c);
  return [v, c];
}
function renderLobby() {
  const i = S.info;
  const [v, c] = selfTileContent();
  const preview = h('div', { class: 'tile preview' + (selfMirror() ? ' mirror' : '') + (S.camfx.fill ? '' : ' fit'), id: 'selfPreview' }, v, c,
    h('div', { class: 'ph', id: 'lobbyPh', hidden: true }, avatar(myName() || 'Moi')),
    h('div', { class: 'meter' }, h('span', { class: 'pill' }, icon('mic'), h('span', { class: 'meterbar' }, h('i')))),
    h('div', { class: 'ctrl' },
      h('button', { class: 'rb', id: 'lMic', title: 'Micro', onclick: () => setMic(!S.mic) }, icon('mic')),
      h('button', { class: 'rb', id: 'lCam', title: 'Caméra', onclick: () => setCam(!S.cam) }, icon('cam'))));
  const nameIn = h('input', { id: 'name', maxlength: 40, placeholder: 'Ton prénom', autocomplete: 'nickname', value: myName() });
  const accHint = h('div', { class: 'hint', id: 'accHint', hidden: true });
  // Compte connecté : son pseudo est réservé et imposé. Invités refusés : lien vers la connexion.
  session().then(s => {
    const back = '/compte?retour=' + encodeURIComponent(location.pathname);
    if (s.account) { nameIn.value = s.account.name; nameIn.readOnly = true; accHint.hidden = false; accHint.replaceChildren(icon('user'), `Connecté avec le compte ${s.account.name} : ce pseudo t'est réservé.`); }
    else if (!s.guestJoin) { accHint.hidden = false; accHint.replaceChildren(icon('lock'), 'Ce serveur demande un compte pour rejoindre. ', h('a', { href: back }, 'Se connecter')); }
    else if (s.signupMode !== 'closed') { accHint.hidden = false; accHint.replaceChildren(icon('user'), 'Tu as un compte ? ', h('a', { href: back }, 'Connecte-toi'), ' pour réserver ton pseudo.'); }
  }).catch(() => {});
  const pwIn = (i.hasPassword && !i.authorized) || (S.e2 && needsPw(S.e2.mode) && !S.e2.keys) ? h('input', { id: 'pw', type: 'password', placeholder: 'Mot de passe du salon', autocomplete: 'current-password', maxlength: 200 }) : null;
  const errBox = h('div', { class: 'formerr', id: 'joinErr', role: 'alert' });
  const joinBtn = h('button', { class: 'btn pri big wide', id: 'joinBtn', type: 'submit' });
  const who = h('div', { class: 'who' });
  const paintWho = () => {
    const full = S.info.count >= S.info.limit, n = S.info.count;
    joinBtn.disabled = full; joinBtn.replaceChildren(icon('door'), full ? 'Salon complet' : 'Rejoindre le salon');
    if (n) who.replaceChildren(h('span', { class: 'live' }), `${n} personne${n > 1 ? 's' : ''} dans le salon · ${S.info.limit} max`);
    else who.replaceChildren(icon('users'), `Personne pour l'instant · ${S.info.limit} max`);
    if (full) errBox.textContent = `Salon complet (${S.info.limit} personnes maximum). Le bouton se réactivera dès qu'une place se libère.`;
    else if (/complet/i.test(errBox.textContent)) errBox.textContent = '';
  };
  paintWho();
  // rafraîchit le compteur tant qu'on est dans le salon d'attente
  clearInterval(S.lobbyTimer);
  S.lobbyTimer = setInterval(async () => {
    if (view.className !== 'lobby') { clearInterval(S.lobbyTimer); return; }
    try { const d = await api('/api/rooms/' + encodeURIComponent(slug)); S.info = { ...S.info, ...d }; paintWho(); } catch {}
  }, 5000);
  const form = h('form', { class: 'join', autocomplete: 'off' },
    h('h2', {}, i.name), who,
    h('div', { class: 'field' }, h('label', { for: 'name' }, 'Ton nom'), h('div', { class: 'inp' }, icon('user'), nameIn), accHint),
    pwIn ? h('div', { class: 'field' }, h('label', { for: 'pw' }, 'Mot de passe'), h('div', { class: 'inp' }, icon('lock'), pwIn)) : null,
    h('div', { id: 'devices' }),
    camEntry(),
    micFxField(),
    h('div', { class: 'field' }, h('label', {}, 'Arrière-plan'), bgPicker()),
    qualityPicker(),
    errBox, joinBtn,
    e2eeHint());
  form.addEventListener('submit', e => { e.preventDefault(); join(); });
  view.className = 'lobby'; view.replaceChildren(preview, form);
  refreshBgButtons(); refreshButtons(); refreshSelf();
  setTimeout(() => (pwIn && myName() ? pwIn : nameIn).focus(), 50);
}

function refreshSelf() {
  const camOn = S.cam && S.stream?.getVideoTracks().some(t => t.readyState === 'live');
  $$('.selfvid').forEach(v => v.hidden = !camOn || processing());
  paintSelfView();
  $$('#lobbyPh, .tile.me .ph').forEach(p => p.hidden = camOn);
  const t = S.tiles.get('p:me'); if (t) updateTile(t);
}
function refreshButtons() {
  const set = (el, on, ic, offIc) => { if (!el) return; el.classList.toggle('off', !on); el.replaceChildren(icon(on ? ic : offIc)); el.setAttribute('aria-pressed', String(on)); };
  set($('#lMic'), S.mic, 'mic', 'micoff'); set($('#lCam'), S.cam, 'cam', 'camoff');
  set($('#dMic'), S.mic, 'mic', 'micoff'); set($('#dCam'), S.cam, 'cam', 'camoff');
  const tip = (id, t) => { const b = $(id); if (b) { b.dataset.tip = t; b.setAttribute('aria-label', t); } };
  tip('#dMic', S.mic ? 'Couper le micro (M)' : 'Activer le micro (M)');
  tip('#dCam', S.cam ? 'Couper la caméra (V)' : 'Activer la caméra (V)');
  $('#dHand')?.classList.toggle('on', !!S.engine?.state.hand);
  $('#dScreen')?.classList.toggle('on', !!S.engine?.state.screen);
  $('#dChat')?.classList.toggle('on', S.panel && S.tab === 'chat');
  const bb = $('#dBoard'); if (bb) { bb.classList.toggle('on', !!S.wb); const t = !S.wb ? 'Tableau blanc' : isBoardOwner() ? 'Fermer le tableau blanc' : 'Afficher le tableau blanc'; bb.dataset.tip = t; bb.setAttribute('aria-label', t); }
}

// ---------------- Rejoindre ----------------
async function join() {
  const btn = $('#joinBtn'), errBox = $('#joinErr');
  const name = ($('#name').value || '').trim() || 'Invité';
  // L'audio doit démarrer dans le geste utilisateur (iPhone).
  if (!S.audio) { S.audio = new AudioIO(); S.audio.fx = { ...S.fx }; S.audioReady = S.audio.init().catch(e => { stats.errors.push('audio ' + e.message); }); }
  btn.disabled = true; errBox.textContent = '';
  let password = $('#pw')?.value || '', pwSecret = null;
  if (S.e2 && needsPw(S.e2.mode) && !S.e2.keys) {
    // Le mot de passe ne quitte pas le navigateur : on en dérive la clé et un jeton d'accès distinct (envoyé au serveur).
    if (!password) { btn.disabled = false; errBox.textContent = 'Entre le mot de passe du salon.'; $('#pw')?.focus(); return; }
    btn.replaceChildren(icon('lock'), 'Déverrouillage…');
    try { const r = await fromPassword(S.e2, password); password = r.token; pwSecret = r.secret; }
    catch { btn.disabled = false; btn.replaceChildren(icon('door'), 'Rejoindre le salon'); errBox.textContent = 'Ce navigateur ne sait pas dériver la clé (WebCrypto indisponible).'; return; }
  }
  try {
    await api(`/api/rooms/${encodeURIComponent(slug)}/join`, { method: 'POST', body: { name, password } });
    if (pwSecret) {
      // Vérifie que la clé obtenue est bien celle du salon (valeur de contrôle donnée après l'accès)
      const info = await api(`/api/rooms/${encodeURIComponent(slug)}`); S.info = { ...S.info, ...info };
      const r = await finish(info, slug, S.e2, pwSecret);
      if (r.status !== 'ok') throw Object.assign(new Error(S.e2.mode === 'pw' ? 'Ce mot de passe ne déverrouille pas le chiffrement du salon.' : 'Le lien ou le mot de passe ne correspond pas à la clé du salon.'), { status: 401 });
    }
  } catch (e) {
    btn.disabled = false; btn.replaceChildren(icon('door'), 'Rejoindre le salon'); errBox.textContent = e.message;
    if (e.data?.code === 'account') errBox.append(' ', h('a', { href: '/compte?retour=' + encodeURIComponent(location.pathname) }, 'Se connecter'));
    if (e.status === 401) $('#pw')?.select();
    return;
  }
  if (S.e2?.keys) { S.e2.session = await startSession(S.e2); paintE2eeBadge(); }
  setMyName(name);
  await S.audioReady;
  S.caps ||= await detectCaps();
  if (S.audio.ctx) { S.audio.attachMic(S.stream, u8 => S.engine?.sendAudio(u8)); S.audio.muted = !S.mic; setupMeter(S.stream); }
  if (S.audio.ctx && localStorage.getItem('cc-out')) S.audio.setSink(localStorage.getItem('cc-out'));
  S.audio.onLevel = lvl => { if (S.mic && lvl > 60) { const t = S.tiles.get('p:me'); if (t) t.speakUntil = performance.now() + 300; } };
  S.engine = new Engine({ slug, name, caps: S.caps, quality: S.quality, getCamSource: camSource, ui: UI,
    isMobile: isMobileDevice, effectsActive: () => !!S.effects?.active, e2ee: S.e2?.session || null,
    rate: S.camfx.rate, camFps: () => camTrack()?.getSettings?.().frameRate || 0 });
  if (S.e2?.session) S.e2.session.ka.send = m => S.engine?.send(m);
  S.engine.audio = S.audio;
  S.engine.state = { mic: S.mic, cam: S.cam, screen: false, hand: false };
  renderCall();
  S.engine.connect();
  S.joinedAt = Date.now();
  // Si le navigateur a bloqué le son (politique de lecture automatique), on propose de l'activer d'un geste.
  setTimeout(() => {
    if (S.audio?.ctx && S.audio.ctx.state !== 'running')
      toast('Le navigateur a mis le son en pause.', { action: 'Activer le son', ms: 15000, onAction: () => S.audio.ctx.resume().catch(() => {}) });
  }, 1200);
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
}

// ---------------- Vue appel ----------------
function renderCall() {
  view.className = 'callwrap';
  const grid = h('div', { class: 'grid', id: 'grid' });
  const stage = h('section', { class: 'stage', id: 'stage', 'aria-label': 'Vidéos' }, grid,
    h('div', { class: 'pager', id: 'pager', hidden: true }), dock());
  const panel = buildPanel();
  view.replaceChildren(stage, panel);
  $('#inviteBtn').hidden = false; $('#peopleBtn').hidden = false; $('#panelBtn').hidden = false; $('#timer').hidden = false;
  $('#inviteBtn').onclick = openInvite;
  $('#peopleBtn').onclick = () => togglePanel('people');
  $('#panelBtn').onclick = () => togglePanel(S.tab, !S.panel);
  $('#back').onclick = e => { e.preventDefault(); if (confirm('Quitter l\'appel ?')) { leave(); location.href = '/'; } };
  panel.hidden = !S.panel;
  // Appel : barre latérale repliée par défaut (la vidéo prend la place), en-tête et commandes qui s'effacent au repos
  document.body.classList.add('incall');
  const sideBtn = $('#sideBtn'), paintSide = () => { const o = document.body.classList.contains('side-open'); sideBtn.setAttribute('aria-pressed', String(o)); sideBtn.title = o ? 'Masquer la barre latérale' : 'Afficher la barre latérale'; };
  sideBtn.hidden = false; document.body.classList.toggle('side-open', localStorage.getItem('cc-side') === '1'); paintSide();
  sideBtn.onclick = () => { const o = document.body.classList.toggle('side-open'); localStorage.setItem('cc-side', o ? '1' : '0'); paintSide(); setTimeout(layout, 0); };
  const seg = $('#viewSeg'); seg.hidden = false;
  const paintView = () => $$('button', seg).forEach(b => { b.classList.toggle('on', b.dataset.view === S.view); b.setAttribute('aria-pressed', String(b.dataset.view === S.view)); });
  $$('button', seg).forEach(b => b.addEventListener('click', () => { S.view = b.dataset.view; localStorage.setItem('cc-view', S.view); if (S.view === 'grid') S.pinned = null; paintView(); layout(); }));
  paintView();
  let idleT = 0;
  const wake = () => {
    document.body.classList.remove('idle'); clearTimeout(idleT);
    idleT = setTimeout(() => {
      if (isMobile() || $('.popover') || $('.modal-bg') || $('.top :focus-visible, .dock :focus-visible')) return;
      document.body.classList.add('idle');
    }, 3500);
  };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'focusin', 'touchstart']) document.addEventListener(ev, wake, { passive: true });
  wake();
  S.tiles.clear();
  setInterval(tickUi, 200);
  layout(); refreshButtons();
  stage.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); } });
  stage.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) { e.preventDefault(); togglePanel('chat', true); uploadFiles(e.dataTransfer.files); } });
  window.addEventListener('resize', () => layout());
  document.addEventListener('fullscreenchange', () => setTimeout(layout, 100)); // plein écran → HD si la tuile grandit
  document.addEventListener('keydown', e => {
    if (e.target.closest('input,textarea,select')) return;
    if (e.key === 'm') setMic(!S.mic); else if (e.key === 'v') setCam(!S.cam); else if (e.key === 'h') toggleHand();
  });
}

function dock() {
  // info-bulles CSS (data-tip) plutôt que title : apparition retardée la première fois, immédiate ensuite (Emil Kowalski)
  const db = (id, ic, title, fn, cls = '') => h('button', { class: 'db ' + cls, id, 'data-tip': title, 'aria-label': title, onclick: fn }, icon(ic));
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia && !/iPhone|iPad|Android/i.test(navigator.userAgent);
  const chat = db('dChat', 'chat', 'Messages', () => togglePanel('chat', !(S.panel && S.tab === 'chat')));
  chat.append(h('span', { class: 'n', id: 'unread', hidden: true }));
  // première info-bulle après un court délai, les suivantes immédiatement tant que le pointeur reste sur le dock
  let warmT = 0;
  const el = h('div', { class: 'dock', id: 'dock', role: 'toolbar', 'aria-label': 'Commandes de l\'appel',
    onpointerover: e => { if (e.target.closest?.('.db') && !warmT) warmT = setTimeout(() => el.classList.add('warm'), 450); },
    onpointerleave: () => { clearTimeout(warmT); warmT = 0; el.classList.remove('warm'); } },
    db('dMic', 'mic', 'Micro', () => setMic(!S.mic)),
    db('dCam', 'cam', 'Caméra', () => setCam(!S.cam)),
    canScreen ? db('dScreen', 'screen', 'Partager l\'écran', toggleScreen, 'hide-m') : null,
    db('dBoard', 'board', 'Tableau blanc', toggleBoard, 'hide-m'),
    db('dHand', 'hand', 'Lever la main (H)', toggleHand),
    db('dReact', 'smile', 'Réagir', e => emojiPopover(e.currentTarget, em => sendFlash(em))),
    h('span', { class: 'sep hide-m' }),
    chat,
    db('dMore', 'more', 'Plus d\'options', e => moreMenu(e.currentTarget)),
    db('dLeave', 'phone', 'Quitter', () => leave(), 'leave'));
  return el;
}

function closePopovers() { $$('.popover').forEach(p => p.remove()); }
function placePopover(pop, anchor) {
  closePopovers(); (anchor.closest('.dock') || document.body).append(pop);
  if (!isMobile() && anchor.closest('.dock')) {
    const left = Math.max(0, anchor.offsetLeft - 80);
    pop.style.left = left + 'px';
    // le menu « naît » de son bouton : origine de la transformation sur le déclencheur
    pop.style.setProperty('--origin', `${Math.round(anchor.offsetLeft + anchor.offsetWidth / 2 - left)}px 100%`);
  }
  setTimeout(() => document.addEventListener('pointerdown', function off(e) { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function emojiPopover(anchor, pick) {
  const pop = h('div', { class: 'popover emojis', role: 'menu' }, EMOJIS.map(e => h('button', { role: 'menuitem', 'aria-label': e, onclick: () => { pick(e); pop.remove(); } }, e)));
  placePopover(pop, anchor);
}
function moreMenu(anchor) {
  const it = (ic, label, fn, k) => h('button', { class: 'menuitem', role: 'menuitem', onclick: () => { pop.remove(); fn(); } }, icon(ic), label, k ? h('span', { class: 'k' }, k) : null);
  const canScreen = !!navigator.mediaDevices?.getDisplayMedia && !/iPhone|iPad|Android/i.test(navigator.userAgent);
  const pop = h('div', { class: 'popover', role: 'menu' },
    it('sparkle', 'Arrière-plan et appareils', openSettings),
    it('mic', 'Traitement du micro', openMicFx),
    it('cam', 'Réglages de la caméra', openCamera),
    it('quality', 'Qualité vidéo : ' + QUALITY_OPTIONS.find(o => o[0] === S.quality)[1], openQuality),
    it('qr', 'Inviter (lien + QR code)', openInvite),
    it('users', 'Participants', () => togglePanel('people', true)),
    isMobile() && canScreen ? it('screen', 'Partager l\'écran', toggleScreen) : null,
    isMobile() ? it('board', !S.wb ? 'Tableau blanc' : isBoardOwner() ? 'Fermer le tableau blanc' : 'Afficher le tableau blanc', toggleBoard) : null,
    isMobile() ? it('flip', 'Changer de caméra', flipCamera) : null,
    document.pictureInPictureEnabled ? it('pip', 'Image dans l\'image', pip) : null,
    document.fullscreenEnabled ? it('full', document.fullscreenElement ? 'Quitter le plein écran' : 'Plein écran', fullscreen) : null,
    S.info?.ai ? it('sparkle', 'Résumer la discussion (IA locale)', summarize) : null,
    it('gear', 'Infos techniques', openTechInfo));
  placePopover(pop, anchor);
}

// Diagnostic discret : compteurs audio (envoyés, reçus, déchiffrés, rejetés), codec, état du son, versions.
function techInfo(srv) {
  const st = stats, e = st.e2ee || {}, sum = o => Object.values(o || {}).reduce((a, b) => a + b, 0);
  const name = sid => S.bySid.get(+sid)?.name || 'n°' + sid;
  const ctx = S.audio?.ctx?.state;
  const rows = [
    ['Version', `page ${document.documentElement.dataset.build ? 'build ' + document.documentElement.dataset.build : '?'} · serveur ${srv.version || '?'} build ${srv.build || '?'}`],
    ['Son du navigateur', ctx === 'running' ? 'actif' : ctx ? `${ctx} (touche la page pour l'activer)` : 'non démarré'],
    ['Codec audio', `${S.audio?.codec || '?'}${S.audio?.codec === 'opus' && st.opusMode ? ' (débit ' + st.opusMode + ')' : ''} · ${st.audioRate || '?'} Hz`],
    ['Micro', S.mic ? `ouvert · niveau ${Math.round(S.audio?.level || 0)}` : 'coupé'],
    ['Traitement du micro', (() => { const f = st.micfx; if (!f) return 'non démarré'; const w = v => v === 'on' ? 'oui' : v === 'off' ? 'non' : v;
      return `réduction de bruit ${w(f.ns)}${f.simd === true ? ' (SIMD)' : f.simd === false ? ' (sans SIMD)' : ''} · isolateur de voix ${w(f.iso)}${f.iso === 'on' && f.isoMs ? ` (${f.isoMs.toFixed(1)} ms)` : ''}${f.iso === 'indisponible' && f.isoError ? ` (${f.isoError})` : ''}${st.nativeIso ? ' (isolation du système demandée)' : ''} · autotune ${w(f.tune)}${f.tune === 'on' && f.tuneMs ? ` (${f.tuneMs.toFixed(1)} ms)` : ''} · compresseur ${w(f.comp)} · dé-esseur ${w(f.deess)} · ${f.rate / 1000} kHz`; })()],
    ['Paquets audio envoyés', String(st.sent.audio)],
    ['Paquets audio reçus', sum(st.recv.audio) ? Object.entries(st.recv.audio).map(([k, v]) => `${name(k)} : ${v}`).join(' · ') : '0'],
    ['Paquets audio décodés', String(sum(st.decoded.audio))],
    ['Sortie haut-parleur', (S.audio?.outputPeak?.() || 0).toFixed(3)],
  ];
  if (S.e2) rows.push(['Trames déchiffrées (son + image)', String(e.dec || 0)],
    ['Rejetés', `${(e.fail || 0) + (e.replay || 0) + (e.nokey || 0) + (e.noann || 0)} (authentification ${e.fail || 0} · rejeu ${e.replay || 0} · clé manquante ${e.nokey || 0} · émetteur inconnu ${e.noann || 0})`],
    ['Clé des flux', `époque ${S.e2.session?.media?.cur ?? '?'} · ${S.e2.session?.ka?.canSend?.() ? 'prête' : 'en attente'}`]);
  if (st.errors.length) rows.push(['Dernières erreurs', st.errors.slice(-3).join(' | ')]);
  return h('dl', { class: 'techinfo', id: 'techInfo' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
}
async function openTechInfo() {
  const srv = await session().catch(() => ({}));
  const bg = modal('Infos techniques', h('p', { class: 'sub' }, 'Utile pour un diagnostic : aucune donnée n\'est envoyée.'), techInfo(srv));
  const t = setInterval(() => { const d = $('#techInfo', bg); if (!bg.isConnected || !d) return clearInterval(t); d.replaceWith(techInfo(srv)); }, 1000);
}

async function flipCamera() {
  S.facing = S.facing === 'user' ? 'environment' : 'user';
  try { setStream(await getMedia({ audio: S.stream?.getAudioTracks().length > 0, video: true })); S.cam = true; S.engine?.setState({ cam: true }); }
  catch { toast('Pas d\'autre caméra.', { error: true }); }
  paintSelfView();
  refreshButtons();
}
async function toggleScreen() {
  if (S.engine.state.screen) { S.engine.stopScreen(); refreshButtons(); layout(); return; }
  try { await S.engine.startScreen(); toast('Tu partages ton écran.'); }
  catch (e) { if (e?.name !== 'NotAllowedError') toast('Partage d\'écran impossible sur cet appareil.', { error: true }); }
  refreshButtons(); layout();
}
function toggleHand() { const on = !S.engine.state.hand; S.engine.setState({ hand: on }); S.me.state.hand = on; updateTile(S.tiles.get('p:me')); refreshButtons(); renderPeople(); }
function fullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else $('#stage').requestFullscreen().catch(() => {}); }
let pipVideo = null;
async function pip() {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return; }
    const t = S.tiles.get('p:' + (S.bySid.get(S.speakerSid)?.id || [...S.peers.keys()].find(k => k !== S.me?.id)));
    if (!t?.canvas?.captureStream) { toast('Aucune vidéo à détacher.', { error: true }); return; }
    pipVideo ||= h('video', { muted: true, playsinline: true, hidden: true });
    pipVideo.muted = true; pipVideo.srcObject = t.canvas.captureStream(15); document.body.append(pipVideo);
    await pipVideo.play(); await pipVideo.requestPictureInPicture();
  } catch { toast('Image dans l\'image indisponible.', { error: true }); }
}
async function summarize() {
  try { toast('L\'assistant local prépare un résumé…'); await api(`/api/rooms/${encodeURIComponent(slug)}/summary`, { method: 'POST', body: {} }); togglePanel('chat', true); }
  catch (e) { toast(e.message, { error: true }); }
}

// ---------------- Modales ----------------
function modal(title, ...content) {
  const bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  let closed = false;
  const box = h('div', { class: 'modal' });
  const close = () => {
    if (closed) return; closed = true; document.removeEventListener('keydown', esc);
    // sortie plus courte que l'entrée ; retirée tout de suite si le mouvement est réduit
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { bg.remove(); return; }
    bg.style.pointerEvents = 'none'; bg.style.opacity = '0';
    box.style.transition = `transform ${isMobile() ? 260 : 150}ms cubic-bezier(.32,.72,0,1), opacity 150ms ease`;
    box.style.transform = isMobile() ? 'translateY(100%)' : 'scale(.98)';
    setTimeout(() => bg.remove(), isMobile() ? 260 : 160);
  };
  const grab = h('div', { class: 'grab', 'aria-hidden': 'true' });
  box.append(grab, h('h3', {}, title, h('button', { class: 'iconbtn', title: 'Fermer', 'aria-label': 'Fermer', onclick: close }, icon('x'))), ...content);
  bg.append(box);
  bg.addEventListener('pointerdown', e => { if (e.target === bg) close(); });
  function esc(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', esc);
  dragToClose(box, [grab, box.querySelector('h3')], close);
  document.body.append(bg); return bg;
}
// Mobile : tiroir que l'on fait glisser vers le bas pour fermer (esprit Vaul : résistance vers le haut,
// fermeture au-delà d'un quart de hauteur ou si le geste est rapide).
function dragToClose(box, zones, onClose) {
  let y0 = 0, t0 = 0, dy = 0, dragging = false;
  for (const z of zones) z.addEventListener('pointerdown', e => {
    if (!isMobile() || e.target.closest('button')) return;
    dragging = true; y0 = e.clientY; t0 = performance.now(); dy = 0;
    box.classList.add('dragging'); z.setPointerCapture?.(e.pointerId);
  });
  const move = e => {
    if (!dragging) return;
    const d = e.clientY - y0;
    dy = d > 0 ? d : -Math.sqrt(-d) * 2; // amortissement vers le haut
    box.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (!dragging) return; dragging = false; box.classList.remove('dragging');
    const v = dy / Math.max(1, performance.now() - t0);
    box.style.transform = '';
    if (dy > box.offsetHeight * 0.25 || (dy > 10 && v > 0.4)) onClose();
  };
  for (const z of zones) { z.addEventListener('pointermove', move); z.addEventListener('pointerup', end); z.addEventListener('pointercancel', end); }
}
async function openInvite() {
  const url = inviteUrl(location.origin, S.info.slug, S.e2);
  const { default: qrcode } = await import('/vendor/qrcode.mjs');
  const q = qrcode(0, 'M'); q.addData(url); q.make();
  const inp = h('input', { value: url, readonly: true, 'aria-label': 'Lien d\'invitation' });
  modal('Inviter dans le salon',
    h('p', { class: 'sub' }, S.info.hasPassword ? 'Partage le lien et, séparément, le mot de passe.' : 'Toute personne qui a ce lien peut rejoindre le salon.'),
    S.e2?.link ? h('p', { class: 'hint' }, icon('lock'), 'Le lien contient la clé de chiffrement (après « # ») : partage-le en entier, par un canal de confiance. Ton serveur ne la reçoit jamais.') : null,
    h('div', { class: 'qr' }, h('img', { src: q.createDataURL(6, 0), alt: 'QR code du lien d\'invitation' })),
    h('div', { class: 'field' }, h('div', { class: 'inp' }, icon('link'), inp)),
    h('div', { class: 'crow' },
      h('button', { class: 'btn pri', onclick: async () => { try { await navigator.clipboard.writeText(url); toast('Lien copié'); } catch { inp.select(); document.execCommand('copy'); toast('Lien copié'); } } }, icon('copy'), 'Copier le lien'),
      navigator.share ? h('button', { class: 'btn', onclick: () => navigator.share({ title: S.info.name, url }).catch(() => {}) }, icon('share'), 'Partager') : null));
}
function openQuality() {
  modal('Qualité vidéo', qualityPicker(),
    h('div', { class: 'hint' }, icon('quality'), 'La HD ne part que vers les personnes qui t\'affichent en grand (épinglé, plein écran ou 4 vignettes au plus). Si le réseau ou l\'appareil sature, la qualité redescend toute seule en 720p puis 360p.'));
}
async function openSettings() {
  modal('Arrière-plan et appareils',
    h('div', { class: 'field' }, h('label', {}, 'Arrière-plan'), bgPicker()),
    await deviceSelects(),
    micFxField(),
    qualityPicker(),
    h('div', { class: 'hint' }, icon('sparkle'), 'Le détourage tourne sur ton appareil (modèle hébergé sur ton serveur). Il se coupe tout seul si l\'appareil est trop lent.'));
  refreshBgButtons();
}

// ---------------- Panneau (chat + personnes) ----------------
function buildPanel() {
  const ta = h('textarea', { id: 'chatIn', rows: 1, maxlength: 4000, placeholder: 'Écris un message…', title: 'Markdown : **gras**, *italique*, `code`. Glisse ou colle un fichier pour l\'envoyer.', 'aria-label': 'Message' });
  const file = h('input', { type: 'file', multiple: true, hidden: true, id: 'fileIn' });
  file.addEventListener('change', () => { uploadFiles(file.files); file.value = ''; });
  const send = h('button', { class: 'send', title: 'Envoyer', id: 'chatSend', type: 'submit' }, icon('up'));
  const form = h('form', { class: 'pcomp', id: 'chatForm' }, h('div', { class: 'replybar', id: 'replyBar', hidden: true }), ta,
    h('div', { class: 'crow' }, h('button', { type: 'button', class: 'iconbtn', title: 'Joindre un fichier', onclick: () => file.click() }, icon('clip')),
      h('button', { type: 'button', class: 'iconbtn', title: 'Emoji', onclick: e => emojiPopoverAt(e.currentTarget, em => { ta.value += em; ta.focus(); }) }, icon('smile')),
      S.info?.ai ? h('button', { type: 'button', class: 'chip', title: 'Résumé par l\'IA locale', onclick: summarize }, icon('sparkle'), 'Résumer') : null,
      file, send));
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; typingPing(); });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } if (e.key === 'Escape') setReply(null); });
  ta.addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); uploadFiles(fs); } });
  form.addEventListener('submit', e => {
    e.preventDefault(); const text = ta.value.trim(); if (!text) return;
    if (S.e2?.keys) { sendEnc({ text }).then(ok => { if (ok) { ta.value = ''; ta.style.height = 'auto'; setReply(null); } }); return; }
    S.engine.send({ t: 'chat', text, replyTo: S.replyTo?.id, cid: Math.random().toString(36).slice(2, 10) });
    ta.value = ''; ta.style.height = 'auto'; setReply(null);
  });
  const tab = (id, label, ic) => h('button', { class: 'tab', id: 'tab-' + id, onclick: () => togglePanel(id, true) }, icon(ic), label);
  const tabs = h('div', { class: 'tabs' }, tab('chat', 'Messages', 'chat'), tab('people', 'Personnes', 'users'),
    h('button', { class: 'iconbtn ph-close', title: 'Fermer', onclick: () => togglePanel(S.tab, false) }, icon('x')));
  const msgs = h('div', { class: 'msgs', id: 'msgs', role: 'log', 'aria-live': 'polite' });
  msgs.addEventListener('dragover', e => e.preventDefault());
  msgs.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); });
  const chatPane = h('div', { id: 'chatPane', class: 'callwrap' }); chatPane.style.flexDirection = 'column';
  chatPane.append(msgs, h('div', { class: 'typing', id: 'typing' }), form);
  const peoplePane = h('div', { id: 'peoplePane', class: 'plist2', hidden: true });
  const grab = h('div', { class: 'grab', 'aria-hidden': 'true' });
  const panel = h('aside', { class: 'panel', id: 'panel', 'aria-label': 'Messages et participants' }, grab, tabs, chatPane, peoplePane);
  dragToClose(panel, [grab], () => togglePanel(S.tab, false));
  return panel;
}
function emojiPopoverAt(anchor, pick) {
  const pop = h('div', { class: 'popover emojis' }, EMOJIS.map(e => h('button', { onclick: () => { pick(e); pop.remove(); } }, e)));
  closePopovers(); $('#chatForm').append(pop); pop.style.bottom = '56px'; pop.style.left = '8px';
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function togglePanel(tab, show = true) {
  S.tab = tab; S.panel = show;
  const p = $('#panel'); if (!p) return;
  p.hidden = !show;
  $('#tab-chat').classList.toggle('on', tab === 'chat'); $('#tab-people').classList.toggle('on', tab === 'people');
  $('#chatPane').hidden = tab !== 'chat'; $('#peoplePane').hidden = tab !== 'people';
  if (show && tab === 'chat') { S.unread = 0; refreshUnread(); const m = $('#msgs'); m.scrollTop = m.scrollHeight; if (!isMobile()) $('#chatIn').focus(); }
  if (tab === 'people') renderPeople();
  refreshButtons(); setTimeout(layout, 0); setTimeout(checkSeen, 50);
}
function refreshUnread() { const u = $('#unread'); if (u) { u.hidden = !S.unread; u.textContent = S.unread > 9 ? '9+' : S.unread; } }
let lastTyping = 0;
function typingPing() { const n = Date.now(); if (n - lastTyping > 2500) { lastTyping = n; S.engine?.send({ t: 'typing' }); } }
function setReply(m) {
  S.replyTo = m; const bar = $('#replyBar'); if (!bar) return;
  bar.hidden = !m;
  if (m) { bar.replaceChildren(icon('reply'), 'Réponse à ', h('b', {}, m.from?.name || ''), h('span', { class: 'ml' }), h('button', { class: 'iconbtn', title: 'Annuler', onclick: () => setReply(null) }, icon('x'))); $('#chatIn').focus(); }
}
function hhmm(ts) { return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); }

function renderMsg(m) {
  if (m.kind === 'system') return h('div', { class: 'sysmsg', dataset: { id: m.id } }, `${m.text} · ${hhmm(m.ts)}`);
  if (m.kind === 'ai') return h('div', { class: 'ai', dataset: { id: m.id } }, h('div', { class: 'h' }, icon('sparkle'), 'Résumé · assistant local (Olla)'), h('div', { class: 'tx' }, renderMarkdown(m.text)));
  const mine = !!m.own || m.from?.id === S.me?.id;
  if (m.bad) return h('div', { class: 'sysmsg bad', dataset: { id: m.id } }, icon('lock'), ` Message de ${m.from?.name || '?'} illisible : il n'a pas été chiffré avec la clé de ce salon. · ${hhmm(m.ts)}`);
  const body = h('div', { class: 'b' }, h('div', { class: 'hd' }, h('b', {}, m.from?.name || '?'), h('span', {}, hhmm(m.ts))));
  if (m.replyTo) body.append(h('div', { class: 'quote' }, `${m.replyTo.name} : ${m.replyTo.excerpt}`));
  if (m.text) body.append(h('div', { class: 'tx' }, renderMarkdown(m.text)));
  if (m.file?.k) body.append(encFile(m.file));
  else if (m.file) {
    const f = m.file;
    if (/^image\/(png|jpeg|gif|webp)$/.test(f.type)) body.append(h('a', { href: f.url, target: '_blank', rel: 'noopener' }, h('img', { class: 'imgmsg', src: f.url, alt: f.name, loading: 'lazy' })));
    else body.append(h('a', { class: 'file', href: f.url, download: f.name }, h('span', { class: 'ic' }, icon('file')), h('span', {}, h('div', { class: 'fn' }, f.name), h('div', { class: 'fs' }, fmtSize(f.size))), icon('download')));
  }
  const rx = h('div', { class: 'rx' }); fillReactions(rx, m);
  body.append(rx);
  const acts = h('div', { class: 'acts' },
    ['👍', '❤️', '😂'].map(e => h('button', { title: 'Réagir ' + e, onclick: () => sendMsgReact(m, e) }, e)),
    h('button', { title: 'Répondre', onclick: () => setReply(m) }, icon('reply')),
    m.text ? h('button', { title: 'Copier', onclick: () => navigator.clipboard?.writeText(m.text).then(() => toast('Copié')) }, icon('copy')) : null);
  if (mine) body.append(seenLine(m.id));
  const el = h('div', { class: 'msg' + (mine ? ' mine' : ''), dataset: { id: m.id, author: m.from?.id || '', ts: String(m.ts || 0) } }, avatar(m.from?.name || '?'), body, acts);
  el.addEventListener('click', () => { $$('.msg.focus').forEach(x => x !== el && x.classList.remove('focus')); el.classList.toggle('focus'); });
  return el;
}
function fillReactions(rx, m) {
  rx.replaceChildren(...Object.entries(m.reactions || {}).map(([e, names]) => h('button', { class: (m.mine ? m.mine.has(e) : names.includes(S.me?.name)) ? 'me' : '', title: names.join(', '), onclick: ev => { ev.stopPropagation(); sendMsgReact(m, e); } }, `${e} ${names.length}`)));
}
function addMsg(m, { history = false } = {}) {
  S.msgs.set(m.id, m);
  const box = $('#msgs'); if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const el = renderMsg(m), prev = box.lastElementChild;
  // messages successifs d'une même personne (moins de 5 min) : un seul en-tête, bulles groupées
  if (el.classList.contains('msg') && prev?.classList.contains('msg') && prev.dataset.author && prev.dataset.author === el.dataset.author
    && Math.abs(+el.dataset.ts - +prev.dataset.ts) < 300000 && !m.replyTo) el.classList.add('cont');
  box.append(el);
  if (el.classList.contains('msg')) { if (el.classList.contains('mine')) refreshSeen(); else watchSeen(el); }
  if (nearBottom || m.from?.id === S.me?.id) box.scrollTop = box.scrollHeight;
  if (!history && m.kind !== 'system' && m.from?.id !== S.me?.id) {
    S.typing.delete(m.from?.id);
    if (!(S.panel && S.tab === 'chat') || document.hidden) {
      S.unread++; refreshUnread();
      if (!(S.panel && S.tab === 'chat')) toast(`${m.from?.name || 'Assistant'} : ${(m.text || m.file?.name || '').slice(0, 70)}`, { action: 'Ouvrir', onAction: () => togglePanel('chat', true) });
    }
  }
}

function uploadFiles(files) {
  if (S.e2?.keys) return uploadEncFiles(files);
  for (const f of [...files].slice(0, 5)) {
    const row = h('div', { class: 'sysmsg' }, `Envoi de ${f.name}… 0 %`); $('#msgs').append(row);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${encodeURIComponent(slug)}/files`);
    session().then(s => {
      xhr.setRequestHeader('X-CSRF-Token', s.csrf);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(f.name));
      xhr.setRequestHeader('Content-Type', f.type || 'application/octet-stream');
      xhr.upload.onprogress = e => { if (e.lengthComputable) row.textContent = `Envoi de ${f.name}… ${Math.round(e.loaded / e.total * 100)} %`; };
      xhr.onload = () => {
        row.remove();
        let r = {}; try { r = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status === 201) S.engine.send({ t: 'chat', text: '', fileId: r.id, replyTo: S.replyTo?.id });
        else toast(r.error || 'Envoi impossible.', { error: true });
      };
      xhr.onerror = () => { row.remove(); toast('Envoi interrompu.', { error: true }); };
      xhr.send(f);
    });
  }
}

function renderPeople() {
  const pane = $('#peoplePane'); if (!pane) return;
  const list = [...S.peers.values()].sort((a, b) => (b.id === S.me?.id) - (a.id === S.me?.id) || (b.state.hand - a.state.hand) || a.joined - b.joined);
  pane.replaceChildren(
    h('div', { class: 'crow' }, h('button', { class: 'btn wide', onclick: openInvite }, icon('qr'), 'Inviter quelqu\'un')),
    h('div', { class: 'sgroup' }, `Dans le salon · ${list.length} / ${S.info.limit}`),
    ...list.map(p => h('div', { class: 'prow' }, avatar(p.name),
      h('div', { class: 'nm' }, p.name, p.id === S.me?.id ? h('small', {}, ' (toi)') : null),
      h('div', { class: 'st' }, p.state.hand ? h('span', { class: 'handic', title: 'Main levée', 'aria-label': 'Main levée' }, icon('hand')) : null, p.state.screen ? icon('screen') : null,
        icon(p.state.mic ? 'mic' : 'micoff'), icon(p.state.cam ? 'cam' : 'camoff')))));
  $('#tab-people').replaceChildren(icon('users'), 'Personnes', h('span', { class: 'n' }, String(list.length)));
}

// ---------------- Accusés de lecture « Vu » ----------------
// Un message n'est déclaré lu que s'il est réellement visible : onglet au premier plan, panneau Messages ouvert
// (tiroir sur mobile) et message affiché à au moins 60 % (IntersectionObserver). Envois groupés, une fois par id.
const seenSent = new Set(), seenQ = new Set(), seenVis = new Set();
let seenObs = null, seenT = 0;
function chatVisible() { return !document.hidden && S.panel && S.tab === 'chat' && !$('#panel')?.hidden && !$('#chatPane')?.hidden; }
function watchSeen(el) {
  const id = el.dataset.id; if (!id || seenSent.has(id) || !('IntersectionObserver' in window)) return;
  seenObs ||= new IntersectionObserver(es => {
    for (const e of es) { if (e.isIntersecting && e.intersectionRatio >= 0.6) seenVis.add(e.target); else seenVis.delete(e.target); }
    checkSeen();
  }, { root: $('#msgs'), threshold: [0, 0.6] });
  seenObs.observe(el);
}
function checkSeen() {
  if (!seenObs || !chatVisible()) return;
  for (const el of seenVis) {
    seenVis.delete(el); seenObs.unobserve(el);
    const id = el.dataset.id; if (el.isConnected && !seenSent.has(id)) { seenSent.add(id); seenQ.add(id); }
  }
  if (seenQ.size && !seenT) seenT = setTimeout(flushSeen, 800);
}
function flushSeen() {
  seenT = 0; if (!seenQ.size) return;
  const ids = [...seenQ].slice(0, 50); ids.forEach(id => seenQ.delete(id));
  S.engine?.send({ t: 'seen', ids });
  if (seenQ.size) seenT = setTimeout(flushSeen, 800);
}
function resetSeen() { seenObs?.disconnect(); seenObs = null; seenVis.clear(); seenSent.clear(); seenQ.clear(); clearTimeout(seenT); seenT = 0; }
document.addEventListener('visibilitychange', () => checkSeen());
function seenLine(id) {
  const el = h('button', { type: 'button', class: 'seen', hidden: true, dataset: { seen: id }, onclick: e => { e.stopPropagation(); el.classList.toggle('open'); el.setAttribute('aria-expanded', String(el.classList.contains('open'))); } });
  return el;
}
// Sous ses propres messages : « Vu » sur le dernier message lu, et sur un message plus ancien seulement si ses lecteurs diffèrent.
function refreshSeen() {
  const lines = $$('#msgs .msg.mine .seen');
  let next = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const el = lines[i], names = S.seen.get(el.dataset.seen) || [];
    const key = [...names].sort().join('\u0001');
    const show = names.length > 0 && key !== next;
    if (names.length) next = key;
    if (!show) { el.hidden = true; continue; }
    const label = names.length === 1 ? `Vu par ${names[0]}` : `Vu par ${names.length}`;
    if (el.dataset.key !== key) {
      const was = !el.hidden && el.dataset.key;
      el.dataset.key = key; el.title = 'Vu par ' + names.join(', '); el.setAttribute('aria-label', el.title);
      el.replaceChildren(icon('checks'), h('span', { class: 'sl' }, label), h('span', { class: 'who' }, names.join(', ')));
      if (was) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
    }
    el.hidden = false;
  }
}

// ---------------- Tableau blanc ----------------
// Un seul tableau par salon, partagé comme un écran : il prend la grande vue (mode orateur) pour tout le monde,
// à côté des éventuels partages d'écran ; un double-clic sur une autre tuile l'épingle à sa place.
function isBoardOwner() { return !!S.wb && S.wb.meta?.owner === S.me?.id; }
let wbOut = Promise.resolve(), wbIn = Promise.resolve();
function boardSend(op, s, extra = {}) {
  const e2 = S.e2?.keys;
  if (!e2 || op === 'undo') { S.engine?.send({ t: 'wb', op, ...(s ? { s } : {}), ...extra }); return; }
  // chiffré : l'ordre des fragments est préservé (chaîne de promesses)
  wbOut = wbOut.then(async () => {
    const enc = await e2.seal(s, op === 'live' ? 'wbl' : 'wb:' + s.id);
    if (enc.length > 12000) return;
    S.engine?.send({ t: 'wb', op, id: s.id, enc, ...(op === 'live' ? { n: s.n } : {}) });
  }).catch(e => stats.errors.push('wb ' + e.message));
}
async function openStroke(it, live = false) {
  if (it.s) return validStroke(it.s, { live }) ? it.s : null;
  if (!S.e2?.keys || typeof it.enc !== 'string') return null;
  try { const d = await S.e2.keys.open(it.enc, live ? 'wbl' : 'wb:' + it.id); return validStroke(d, { live }) && d.id === it.id ? d : null; } catch { return null; }
}
function ensureBoardView() {
  if (S.wb.view) return S.wb.view;
  S.wb.view = new BoardView({
    send: boardSend, meta: () => S.wb?.meta, isOwner: isBoardOwner,
    name: id => S.peers.get(id)?.name || '?',
    onLock: on => S.engine?.send({ t: 'wb', op: 'lock', on }),
    onClear: () => confirmBoard('Tout effacer ?', 'Le dessin disparaît pour tout le monde. Pense à l\'exporter en PNG si tu veux le garder.', 'Tout effacer', () => S.engine?.send({ t: 'wb', op: 'clear' })),
    onClose: () => confirmBoard('Fermer le tableau blanc ?', 'Il disparaît pour tout le monde. Pense à l\'exporter en PNG si tu veux le garder.', 'Fermer', () => S.engine?.send({ t: 'wb', op: 'close' })),
  });
  return S.wb.view;
}
function confirmBoard(title, text, ok, fn) {
  const bg = modal(title, h('p', { class: 'muted' }, text),
    h('div', { class: 'crow end' }, h('button', { class: 'btn', onclick: () => bg.querySelector('h3 .iconbtn').click() }, 'Annuler'),
      h('button', { class: 'btn danger', onclick: () => { fn(); bg.querySelector('h3 .iconbtn').click(); } }, ok)));
}
function toggleBoard() {
  if (!S.wb) { S.pinned = null; S.engine?.send({ t: 'wb', op: 'open' }); return; }
  const spotted = !S.pinned || S.pinned === 'wb';
  if (!spotted) { S.pinned = null; layout(); return; }
  if (isBoardOwner()) S.wb.view?.ctx.onClose();
  else toast(`Seul ${S.wb.meta?.ownerName || 'son ouvreur'} peut fermer ce tableau blanc.`);
}
function closeBoardLocal() {
  S.wb?.view?.destroy(); const t = S.tiles.get('wb'); t?.el.remove(); S.tiles.delete('wb');
  if (S.pinned === 'wb') S.pinned = null; S.wb = null;
}
function onBoardMsg(m) {
  switch (m.op) {
    case 'open': case 'state': {
      closeBoardLocal();
      S.wb = { meta: m.board };
      const v = ensureBoardView();
      if (m.op === 'state' && m.items?.length) {
        const items = m.items;
        wbIn = wbIn.then(async () => { const list = (await Promise.all(items.map(it => openStroke(it)))).filter(Boolean); if (S.wb?.view === v) v.setAll(list); });
      }
      layout(); refreshButtons(); break;
    }
    case 'meta': if (S.wb) { S.wb.meta = m.board; S.wb.view?.paint(); updateBoardTile(); refreshButtons(); } break;
    case 'close': closeBoardLocal(); layout(); refreshButtons(); break;
    case 'clear': S.wb?.view?.clear(); break;
    case 'del': wbIn = wbIn.then(() => S.wb?.view?.removeIds(m.ids || [])); break;
    case 'add': case 'live': {
      const v = S.wb?.view; if (!v) return;
      wbIn = wbIn.then(async () => {
        const s = await openStroke(m, m.op === 'live'); if (!s || S.wb?.view !== v) return;
        if (m.op === 'add') v.addItem(s, m.from); else v.onLive(m.from, s);
      });
      break;
    }
  }
}
function boardTile() {
  const v = ensureBoardView();
  const lab = h('div', { class: 'lab' });
  const el = h('div', { class: 'tile board', dataset: { key: 'wb' } }, v.el, lab);
  el.addEventListener('click', () => { if (el.classList.contains('small')) { S.pinned = 'wb'; layout(); } });
  const t = { key: 'wb', el, lab, kind: 'board', peer: null, isMe: false };
  S.tiles.set('wb', t); updateBoardTile(); return t;
}
function updateBoardTile() {
  const t = S.tiles.get('wb'); if (!t || !S.wb) return;
  const m = S.wb.meta || {};
  t.lab.replaceChildren(icon(m.locked ? 'lock' : 'board'), isBoardOwner() ? 'Ton tableau blanc' : `Tableau blanc de ${m.ownerName || '?'}`);
  const small = t.el.classList.contains('small');
  if (S.wb.view) { S.wb.view.enabled = !small; S.wb.view.paint(); }
}

// ---------------- Tuiles ----------------
function makeTile(key, peer, kind) {
  const isMe = peer.id === S.me?.id;
  const canvas = h('canvas'); const ph = h('div', { class: 'ph' }, avatar(peer.name));
  const lab = h('div', { class: 'lab' }); const tr = h('div', { class: 'tr' });
  const el = h('div', { class: 'tile' + (kind === 'screen' ? ' contain' : '') + (isMe ? ' me' : ''), dataset: { key } });
  if (isMe && kind === 'cam') { const [v, c] = selfTileContent(); el.append(v, c); el.classList.toggle('mirror', selfMirror()); el.classList.toggle('fit', !S.camfx.fill); canvas.hidden = true; }
  el.append(canvas, ph, lab, tr);
  if (!isMe) el.addEventListener('dblclick', () => { S.pinned = S.pinned === key ? null : key; layout(); });
  const t = { key, el, canvas, ctx: canvas.getContext('2d'), ph, lab, tr, peer, kind, lastFrame: 0, lastHi: 0, speakUntil: 0, isMe };
  S.tiles.set(key, t); updateTile(t); return t;
}
function updateTile(t) {
  if (!t) return;
  if (t.kind === 'board') return updateBoardTile();
  const p = t.peer, live = performance.now() - t.lastFrame < 2500;
  if (t.isMe && t.kind === 'cam') { t.ph.hidden = !!(S.cam && S.stream?.getVideoTracks().length); }
  else t.ph.hidden = t.kind === 'screen' || (p.state.cam && live);
  t.canvas.hidden = t.isMe && t.kind === 'cam' ? true : !live;
  const speaking = performance.now() < t.speakUntil && (t.isMe ? S.mic : p.state.mic);
  t.lab.replaceChildren(
    t.kind === 'screen' ? icon('screen') : !(t.isMe ? S.mic : p.state.mic) ? h('span', { class: 'muted-ic' }, icon('micoff')) : speaking ? h('span', { class: 'bars' }, h('i'), h('i'), h('i')) : icon('mic'),
    t.kind === 'screen' ? `Écran de ${p.name}` : t.isMe ? `${p.name} (toi)` : p.name);
  t.tr.replaceChildren(...[p.decryptFail ? h('span', { class: 'pill bad' }, icon('lock'), 'Déchiffrement impossible') : null, p.state.hand ? h('span', { class: 'pill' }, icon('hand'), 'Main levée') : null, S.pinned === t.key ? h('span', { class: 'pill' }, icon('pin'), 'Épinglé') : null].filter(Boolean));
  t.el.classList.toggle('speak', t.kind === 'cam' && S.peers.size > 2 && (p.sid === S.speakerSid || speaking));
}

function layout() {
  const grid = $('#grid'); if (!grid || !S.me) return;
  const mobile = isMobile();
  // tuiles nécessaires
  const want = new Set();
  for (const p of S.peers.values()) { want.add('p:' + p.id); if (p.state.screen && p.id !== S.me.id) want.add('s:' + p.id); }
  if (S.wb) want.add('wb');
  for (const [k, t] of S.tiles) if (!want.has(k)) { t.el.remove(); S.tiles.delete(k); }
  for (const k of want) if (!S.tiles.has(k)) { if (k === 'wb') { boardTile(); continue; } const p = S.peers.get(k.slice(2)); makeTile(k, p, k[0] === 's' ? 'screen' : 'cam'); }
  // ordre stable des personnes distantes ; les orateurs récents remontent en première page
  const remote = [...S.peers.values()].filter(p => p.id !== S.me.id);
  S.order = S.order.filter(id => S.peers.has(id) && id !== S.me.id);
  for (const p of remote) if (!S.order.includes(p.id)) S.order.push(p.id);
  const me = S.tiles.get('p:' + S.me.id);
  const screens = [...S.tiles.values()].filter(t => t.kind === 'screen');
  const board = S.tiles.get('wb');
  let spotKey = S.pinned && S.tiles.has(S.pinned) ? S.pinned : board ? 'wb' : screens[0]?.key || null;
  // Mode « orateur » : la personne qui parle (ou la première) en grand, les autres en bande dessous
  if (!spotKey && S.view === 'speaker' && remote.length) {
    const sp = S.bySid.get(S.speakerSid);
    spotKey = sp && sp.id !== S.me.id && S.tiles.has('p:' + sp.id) ? 'p:' + sp.id : (S.lastSpot && S.tiles.has(S.lastSpot) ? S.lastSpot : 'p:' + S.order[0]);
    S.lastSpot = spotKey;
  }
  document.body.classList.toggle('speakerview', !!spotKey);
  const subs = [];
  const sub = (t, layer) => { if (!t.isMe && (t.peer.state.cam || layer === L_SCREEN)) subs.push([t.peer.sid, layer]); t.layer = layer; };
  // Grande tuile caméra : 360p ou HD (720p/1080p) selon la taille réellement affichée et ce que l'émetteur propose.
  const big = (t, isBig) => {
    if (t.isMe) return;
    const r = t.el.getBoundingClientRect(), now = performance.now();
    if ((S.noHd.get(t.peer.sid) || 0) < now) S.noHd.delete(t.peer.sid);
    sub(t, pickLayer({ big: isBig, w: r.width, h: r.height, dpr: devicePixelRatio, vq: t.peer.state.vq ?? 360, noHd: S.noHd.has(t.peer.sid) || S.lowLink }));
  };
  let visible = [];
  grid.replaceChildren(); grid.className = 'grid'; grid.style.gridTemplateColumns = grid.style.gridTemplateRows = '';
  me.el.classList.remove('selfpip', 'small');
  $('#pager').hidden = true;
  if (spotKey) {
    const spot = S.tiles.get(spotKey);
    grid.className = 'grid spot'; $('#waitHint')?.remove();
    const strip = h('div', { class: 'strip' });
    const others = [board, me, ...S.order.map(id => S.tiles.get('p:' + id))].filter(t => t && t !== spot);
    others.slice(0, 12).forEach(t => { t.el.classList.add('small'); strip.append(t.el); if (t.kind !== 'board') sub(t, L_LO); });
    grid.append(spot.el, strip); spot.el.classList.remove('small');
    if (spot.kind === 'screen') sub(spot, L_SCREEN); else if (spot.kind !== 'board') big(spot, true);
    visible = [spot, ...others];
  } else if (remote.length === 0) {
    grid.append(me.el); grid.style.gridTemplateColumns = '1fr'; visible = [me];
    if (!$('#waitHint')) $('#stage').append(h('div', { class: 'pager', id: 'waitHint' }, h('button', { class: 'pill', onclick: openInvite }, icon('qr'), 'En attente des autres · inviter')));
  } else {
    $('#waitHint')?.remove();
    const items = mobile || remote.length === 1 ? S.order.map(id => S.tiles.get('p:' + id)) : [me, ...S.order.map(id => S.tiles.get('p:' + id))];
    if (mobile || remote.length === 1) { me.el.classList.add('selfpip'); $('#stage').append(me.el); }
    const per = mobile ? 4 : 9, pages = Math.ceil(items.length / per);
    S.page = Math.min(S.page, pages - 1);
    const pageItems = items.slice(S.page * per, S.page * per + per);
    const n = pageItems.length;
    const cols = mobile ? (n <= 2 ? 1 : 2) : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    grid.style.gridTemplateColumns = `repeat(${cols},1fr)`;
    grid.style.gridTemplateRows = `repeat(${Math.ceil(n / cols)},1fr)`;
    for (const t of pageItems) { t.el.classList.toggle('small', n > 4); grid.append(t.el); }
    const remoteVisible = pageItems.filter(t => !t.isMe);
    for (const t of remoteVisible) big(t, remoteVisible.length <= 4 || (t.peer.sid === S.speakerSid && !mobile));
    visible = pageItems;
    if (pages > 1) {
      const pg = $('#pager'); pg.hidden = false;
      pg.replaceChildren(h('button', { class: 'pill', disabled: S.page === 0, onclick: () => { S.page--; layout(); }, 'aria-label': 'Page précédente' }, icon('left')),
        h('span', { class: 'pill' }, `${S.page + 1} / ${pages} · ${S.peers.size} personnes`),
        h('button', { class: 'pill', disabled: S.page >= pages - 1, onclick: () => { S.page++; layout(); }, 'aria-label': 'Page suivante' }, icon('right')));
    }
  }
  for (const t of S.tiles.values()) updateTile(t);
  S.engine?.subscribe(subs);
}

// Remonte l'orateur actif en première page s'il n'y est pas.
function promoteSpeaker(sid) {
  const p = S.bySid.get(sid); if (!p || p.id === S.me?.id) return;
  const per = isMobile() ? 4 : 8, idx = S.order.indexOf(p.id);
  if (idx >= per) { S.order.splice(idx, 1); S.order.splice(per - 1, 0, p.id); }
}

const UI = {
  onMessage(m) {
    switch (m.t) {
      case 'welcome': {
        S.dropped = 0;
        S.me = { ...m.you }; S.peers.clear(); S.bySid.clear();
        for (const p of [m.you, ...m.peers]) { S.peers.set(p.id, { ...p }); S.bySid.set(p.sid, S.peers.get(p.id)); }
        S.me = S.peers.get(m.you.id); S.speakerSid = m.speaker; S.info.limit = m.room.limit; S.info.ai = m.ai;
        closeBoardLocal(); resetSeen();
        for (const t of S.tiles.values()) t.el.remove(); S.tiles.clear();
        const box = $('#msgs'); box.replaceChildren(); S.msgs.clear();
        if (!m.history.length) box.append(h('div', { class: 'sysmsg' }, 'Début de la discussion. Les messages restent dans le salon pour les prochaines visites.'));
        if (S.e2?.keys) { const hist = m.history; queueMsg(async () => { for (const x of await Promise.all(hist.map(openMsg))) addMsg(x, { history: true }); }); }
        else for (const x of m.history) addMsg(x, { history: true });
        $('#qualityBadge').hidden = true;
        layout(); renderPeople(); refreshButtons();
        break;
      }
      case 'join': {
        const p = { ...m.peer }; S.peers.set(p.id, p); S.bySid.set(p.sid, p);
        layout(); renderPeople(); break;
      }
      case 'leave': {
        S.peers.delete(m.id); S.bySid.delete(m.sid); S.typing.delete(m.id);
        if (S.pinned?.endsWith(m.id)) S.pinned = null;
        layout(); renderPeople(); break;
      }
      case 'peer': {
        const p = S.peers.get(m.id); if (!p) return;
        const scr = p.state.screen; p.state = m.state; p.name = m.name;
        if (scr !== p.state.screen) layout(); else { for (const t of S.tiles.values()) if (t.peer === p) updateTile(t); layout(); }
        renderPeople(); break;
      }
      case 'seen': {
        for (const it of Array.isArray(m.items) ? m.items : []) {
          if (typeof it?.id !== 'string' || !Array.isArray(it.by)) continue;
          S.seen.delete(it.id); S.seen.set(it.id, it.by.filter(x => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 40)));
          if (S.seen.size > 400) S.seen.delete(S.seen.keys().next().value);
        }
        refreshSeen(); break;
      }
      case 'wb': onBoardMsg(m); break;
      case 'hand': toast([icon('hand'), `${m.name} lève la main`]); break;
      case 'chat': if (m.msg.enc) { const x = m.msg; queueMsg(async () => addMsg(await openMsg(x))); } else addMsg(m.msg); break;
      case 'msgreact': {
        if (m.erx) { queueMsg(async () => { const msg = S.msgs.get(m.id); if (!msg) return; await openReactions(msg, m.erx); const el = $(`.msg[data-id="${CSS.escape(m.id)}"] .rx`); if (el) fillReactions(el, msg); }); return; }
        const msg = S.msgs.get(m.id); if (!msg) return; msg.reactions = m.reactions;
        const el = $(`.msg[data-id="${CSS.escape(m.id)}"] .rx`); if (el) fillReactions(el, msg); break;
      }
      case 'react': {
        if (m.enc) { S.e2?.keys?.open(m.enc, 'flash').then(d => { if (EMOJIS.includes(d?.e)) UI.onMessage({ t: 'react', id: m.id, emoji: d.e }); }).catch(() => {}); return; }
        const t = S.tiles.get('p:' + m.id); if (!t) return;
        const r = h('div', { class: 'react' }, m.emoji); t.el.append(r); setTimeout(() => r.remove(), 2700);
        break;
      }
      case 'typing': S.typing.set(m.id, { name: m.name, until: Date.now() + 3500 }); break;
      case 'speaker': S.speakerSid = m.sid; { const before = S.order.join(); promoteSpeaker(m.sid); if (before !== S.order.join() || !isMobile() || S.view === 'speaker') layout(); } break;
      case 'quality':
        $('#qualityBadge').hidden = m.level !== 'low'; S.lowLink = m.level === 'low';
        if (m.level === 'low') toast(m.step >= 2 ? 'Connexion lente : vidéos en basse définition.' : 'Connexion chargée : vidéos HD réduites.');
        layout(); break;
      case 'error':
        if (m.code === 'version') { if (m.build) break; S.versionRefused = true; }
        toast(m.message, { error: true }); break;
    }
  },
  onFrame(sid, layer, img) {
    const p = S.bySid.get(sid); if (!p) return;
    const t = S.tiles.get((layer === L_SCREEN ? 's:' : 'p:') + p.id); if (!t) return;
    const now = performance.now();
    // Pendant un changement de couche, on garde la meilleure qui arrive encore (vignette < 360p < HD).
    const rank = layer === L_HD ? 2 : layer === L_HI ? 1 : 0;
    t.rankAt ||= [0, 0, 0]; t.rankAt[rank] = now;
    if (layer !== L_SCREEN && t.rankAt.some((at, i) => i > rank && now - at < 1000)) return;
    const w = img.displayWidth || img.width, hh = img.displayHeight || img.height;
    if (t.canvas.width !== w || t.canvas.height !== hh) { t.canvas.width = w; t.canvas.height = hh; }
    t.ctx.drawImage(img, 0, 0, w, hh);
    const was = now - t.lastFrame < 2500; t.lastFrame = now; if (!was) updateTile(t);
  },
  onDecryptFail(sid, on) {
    const p = S.bySid.get(sid); if (!p) return; p.decryptFail = on;
    for (const t of S.tiles.values()) if (t.peer === p) updateTile(t);
    if (on) toast(`Impossible de déchiffrer le flux de ${p.name} : sa clé ne correspond pas (lien ou mot de passe différent).`, { error: true, ms: 7000 });
  },
  onDecodeLag(sid) { // décodeur HD débordé (téléphone modeste) : 360p pendant 30 s pour cette personne
    if (S.noHd.has(sid)) return; S.noHd.set(sid, performance.now() + 30000); layout(); setTimeout(layout, 30500);
  },
  onSendQuality(st) { S.engine.sendStats = st; if ($('.qnow')) paintQuality(); },
  onLevel(sid, level) { const p = S.bySid.get(sid); const t = p && S.tiles.get('p:' + p.id); if (t && level > 60) t.speakUntil = performance.now() + 350; },
  onDisconnect(code, fatal) {
    if (code === 4003) { endView('Salon complet', `Ce salon accueille ${S.info.limit} personnes au maximum. Réessaie dans un moment.`); return; }
    if (code === 4004) { endView('Tu as quitté le salon', 'L\'administrateur t\'a retiré de ce salon.'); return; }
    if (code === 4005) { endView('Salon fermé', 'L\'administrateur a fermé ce salon.'); return; }
    if (code === 4010) { freshSession().then(s => ensureFresh(s.build)).catch(() => {}); endView('Nouvelle version', 'Le serveur a été mis à jour : rechargement de la page…'); return; }
    if (code === 1008 && S.versionRefused) { endView('Version obsolète', 'Recharge la page avec Ctrl+F5 (ou Cmd+Maj+R sur Mac) pour charger la nouvelle version.'); return; }
    if (fatal) { if (!S.left) endView('Connexion perdue', 'La connexion au salon a été fermée.'); return; }
    toast('Connexion perdue, reconnexion…');
    // Coupures répétées : le serveur a peut-être été mis à jour (nouvelle version, ou session effacée au redémarrage).
    if (++S.dropped >= 2 && !S.checkingServer) {
      S.checkingServer = true;
      (async () => {
        const s = await freshSession(); await ensureFresh(s.build);
        const info = await api(`/api/rooms/${encodeURIComponent(slug)}`);
        if (!info.authorized && !S.left) { toast('Le serveur a redémarré : rechargement…'); setTimeout(() => location.reload(), 800); }
      })().catch(() => {}).finally(() => { S.checkingServer = false; });
    }
  },
  onScreenStopped() { refreshButtons(); layout(); },
};

let lastTick = 0;
function tickUi() {
  const now = Date.now();
  if (S.joinedAt) { const s = Math.floor((now - S.joinedAt) / 1000); $('#timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  for (const t of S.tiles.values()) {
    const sp = performance.now() < t.speakUntil, live = performance.now() - t.lastFrame < 2500;
    if (sp !== t._sp || live !== t._live) { t._sp = sp; t._live = live; updateTile(t); }
  }
  const typers = [...S.typing.entries()].filter(([, v]) => v.until > now).map(([, v]) => v.name);
  const ty = $('#typing');
  if (ty && ty.dataset.v !== typers.join()) {
    ty.dataset.v = typers.join();
    ty.replaceChildren(...(typers.length ? [h('span', { class: 'tdots' }, h('i'), h('i'), h('i')), `${typers.slice(0, 2).join(' et ')} ${typers.length > 1 ? 'écrivent' : 'écrit'}…`] : []));
  }
  if (now - lastTick > 3000) { lastTick = now; }
}

function leave() {
  S.left = true;
  S.engine?.leave(); S.audio?.close(); S.stream?.getTracks().forEach(t => t.stop()); S.wake?.release?.().catch(() => {});
  endView('Tu as quitté le salon', `À bientôt dans « ${S.info.name} ».`);
}
function endView(title, text) {
  S.left = true; S.engine?.leave();
  $('#inviteBtn').hidden = $('#peopleBtn').hidden = $('#panelBtn').hidden = $('#timer').hidden = true; $('#qualityBadge').hidden = true;
  view.className = 'callwrap';
  view.replaceChildren(h('div', { class: 'center' }, h('span', { class: 'logo' }, icon('cam')), h('h2', {}, title), h('p', {}, text),
    h('div', { class: 'crow' }, h('button', { class: 'btn pri', onclick: () => location.reload() }, icon('door'), 'Rejoindre à nouveau'), h('a', { class: 'btn', href: '/' }, 'Accueil'))));
}
window.addEventListener('pagehide', () => { S.left = true; S.engine?.leave(); });

// ---------------- Chiffrement de bout en bout : interface ----------------
const UID = localStorage.getItem('cc-e2ee-uid') || (() => { const u = b64u(rand(9)); localStorage.setItem('cc-e2ee-uid', u); return u; })();
function e2eeLabel() {
  if (S.e2?.keys) return { cls: 'ok', ic: 'lock', long: 'Chiffré de bout en bout', short: 'Bout en bout' };
  if (S.e2) return { cls: 'ok', ic: 'lock', long: 'Chiffré de bout en bout', short: 'Bout en bout' };
  if (S.info?.isPublic) return { cls: 'warn', ic: 'globe', long: 'Salon public : pas de chiffrement de bout en bout', short: 'Public · non E2EE' };
  return { cls: 'warn', ic: 'shield', long: 'Pas de chiffrement de bout en bout (TLS seulement)', short: 'TLS seulement' };
}
function paintE2eeBadge() {
  const b = $('#e2eeBadge'); if (!b) return;
  const l = e2eeLabel(); b.hidden = false; b.className = 'badge e2ee ' + l.cls;
  b.replaceChildren(icon(l.ic), h('span', { class: 'hide-m' }, l.long), h('span', { class: 'show-m' }, l.short));
  b.title = l.long + ' — détails';
  b.onclick = openSecurity;
}
function e2eeHint() {
  if (S.e2) return h('div', { class: 'hint', id: 'e2eeHint' }, icon('lock'), 'Chiffré de bout en bout : vidéo, son, écran, messages, réactions et fichiers sont chiffrés dans ton navigateur. Ton serveur relaie sans pouvoir les lire.',
    ' ', h('a', { href: '#', onclick: e => { e.preventDefault(); openSecurity(); } }, 'Détails'));
  if (S.info?.isPublic) return h('div', { class: 'hint', id: 'e2eeHint' }, icon('globe'), 'Salon public : pas de chiffrement de bout en bout. Flux chiffrés en TLS jusqu\'à ton serveur, qui peut techniquement les voir ; il les relaie sans enregistrer la vidéo ni le son.');
  return h('div', { class: 'hint', id: 'e2eeHint' }, icon('shield'), 'Ce salon n\'est pas chiffré de bout en bout (créé sans cette option ou avant la version 1.3) : chiffré en TLS jusqu\'à ton serveur seulement. Crée un nouveau salon privé pour le chiffrement de bout en bout.');
}
async function openSecurity() {
  const s = await session().catch(() => ({}));
  const items = (...l) => h('ul', { class: 'seclist' }, l.map(x => h('li', {}, x)));
  if (!S.e2) {
    modal(S.info?.isPublic ? 'Salon public' : 'Pas de chiffrement de bout en bout',
      h('p', { class: 'sub' }, S.info?.isPublic ? 'Un salon public est ouvert à tous : il n\'est pas chiffré de bout en bout. Tout est chiffré en TLS entre les navigateurs et ton serveur, qui relaie les flux et conserve l\'historique du chat en clair.' : 'Ce salon a été créé sans chiffrement de bout en bout (ou avant la version 1.3). Chiffré en TLS jusqu\'à ton serveur seulement.'),
      h('p', { class: 'hint' }, icon('lock'), 'Pour une conversation que même le serveur ne peut pas lire, crée un salon privé avec l\'option « Bout en bout ».'));
    return;
  }
  const code = S.e2.keys?.safety;
  modal('Chiffré de bout en bout',
    code ? h('div', { class: 'safety' }, h('div', { class: 'lbl' }, 'Code de sécurité du salon'), h('div', { class: 'code', id: 'safetyCode' }, code),
      h('p', { class: 'sub' }, 'Comparez ce code à voix haute : s\'il est identique chez tout le monde, vous partagez la même clé.')) : h('p', { class: 'sub' }, 'Rejoins le salon pour afficher le code de sécurité.'),
    items('Chiffrés dans ton navigateur : vidéo, son, partage d\'écran, messages, réactions, fichiers et historique.',
      'Ton serveur (et quiconque le contrôle, ou le proxy) relaie sans pouvoir lire. Il voit : qui est connecté, quand, les noms affichés, les tailles et le rythme des paquets.',
      S.e2.mode === 'link+pw' ? 'Clé = lien complet (après « # ») + mot de passe. Le mot de passe ne quitte jamais ton navigateur.' : 'La clé est dans le lien (après « # ») : le serveur ne la reçoit jamais. Toute personne qui a le lien complet peut lire.',
      'Quand quelqu\'un part ou est exclu, la clé des flux change ; mais il garde le lien : pour l\'écarter aussi du chat, crée un nouveau salon.',
      'Assistant IA (Olla) désactivé : le serveur ne peut pas lire les messages.',
      'Limite : la protection repose sur le code JavaScript servi par ton serveur. Un serveur compromis pourrait servir un code modifié.'),
    s.codeHash ? h('div', { class: 'hint' }, icon('shield'), h('span', {}, `Version ${s.version} (build ${s.build}) · empreinte du code servi : `, h('code', { class: 'hash' }, s.codeHash.slice(0, 16)), ' — à comparer avec « node scripts/code-hash.mjs » sur ton archive.')) : null);
}
function keyProblemView(status) {
  const t = status === 'nolink' ? 'Lien incomplet' : 'Clé invalide';
  const p = status === 'nolink'
    ? 'Ce salon est chiffré de bout en bout : la clé est la fin du lien (après « #k= »), et elle manque. Demande le lien complet à la personne qui t\'a invité, ou colle-le ici.'
    : 'La clé de ce lien ne correspond pas à ce salon (lien abîmé, tronqué ou d\'un autre salon). Demande le lien complet.';
  const inp = h('input', { placeholder: 'Colle le lien complet (…/r/salon#k=…)', 'aria-label': 'Lien complet', id: 'fullLink' });
  const go = () => {
    const v = inp.value.trim(), i = v.indexOf('#'), m = v.match(/\/r\/([a-z0-9-]{1,48})/i);
    if (i < 0 || (m && m[1].toLowerCase() !== slug)) { toast('Ce lien ne contient pas la clé de ce salon.', { error: true }); return; }
    location.hash = v.slice(i + 1); location.reload();
  };
  view.className = 'callwrap';
  view.replaceChildren(h('div', { class: 'center', id: 'keyProblem' }, h('span', { class: 'logo' }, icon('lock')), h('h2', {}, t), h('p', {}, p),
    h('form', { class: 'crow', onsubmit: e => { e.preventDefault(); go(); } }, h('div', { class: 'inp' }, icon('link'), inp), h('button', { class: 'btn pri', type: 'submit' }, 'Ouvrir')),
    h('a', { class: 'btn', href: '/' }, 'Accueil')));
}

// Messages chiffrés : déchiffrés dans l'ordre d'arrivée.
let msgChain = Promise.resolve();
const queueMsg = fn => { msgChain = msgChain.then(fn).catch(e => stats.errors.push('e2ee ' + e.message)); };
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
async function openMsg(m) {
  if (!m.enc) return m;
  let d; try { d = await S.e2.keys.open(m.enc, 'chat'); } catch { return { ...m, bad: true }; }
  const out = { ...m, text: str(d.text, 4000), replyTo: null, file: null };
  if (d.reply && typeof d.reply === 'object') out.replyTo = { id: str(d.reply.id, 32), name: str(d.reply.name, 40), excerpt: str(d.reply.excerpt, 80) };
  const f = d.file;
  if (f && /^[A-Za-z0-9_-]{16}$/.test(f.id) && typeof f.k === 'string') out.file = { id: f.id, name: str(f.name, 120) || 'fichier', type: str(f.type, 100), size: +f.size || 0, k: f.k };
  if (m.erx?.length) await openReactions(out, m.erx);
  return out;
}
async function openReactions(msg, erx) {
  const agg = {}, mine = new Set();
  for (const e of erx) {
    let d; try { d = await S.e2.keys.open(e, 'react:' + msg.id); } catch { continue; }
    if (!Array.isArray(d.e)) continue;
    for (const em of d.e.filter(x => EMOJIS.includes(x)).slice(0, 12)) { (agg[em] ||= []).push(str(d.n, 40) || '?'); if (d.u === UID) mine.add(em); }
  }
  msg.reactions = agg; msg.mine = mine;
}
async function sendEnc({ text = '', file = null }) {
  const r = S.replyTo;
  const payload = { text, file, reply: r ? { id: r.id, name: r.from?.name || '', excerpt: (r.text || r.file?.name || '').slice(0, 80) } : null };
  const enc = await S.e2.keys.seal(payload, 'chat');
  if (enc.length > 18000) { toast('Message trop long.', { error: true }); return false; }
  S.engine.send({ t: 'chat', enc, cid: Math.random().toString(36).slice(2, 10) });
  return true;
}
async function sendMsgReact(m, e) {
  if (!S.e2?.keys) return S.engine.send({ t: 'msgreact', id: m.id, emoji: e });
  const set = new Set(m.mine || []); if (set.has(e)) set.delete(e); else set.add(e);
  const enc = await S.e2.keys.seal({ u: UID, n: S.me?.name || myName(), e: [...set] }, 'react:' + m.id);
  S.engine.send({ t: 'msgreact', id: m.id, enc });
}
async function sendFlash(em) {
  if (!S.e2?.keys) return S.engine.send({ t: 'react', emoji: em });
  S.engine.send({ t: 'react', enc: await S.e2.keys.seal({ e: em }, 'flash') });
}

// Fichiers chiffrés : téléchargés en blob opaque, déchiffrés ici, affichés via une URL blob:.
const fileCache = new Map();
function loadEncFile(f) {
  let p = fileCache.get(f.id);
  if (!p) {
    p = fetch(`/f/${f.id}/fichier-chiffre.bin`, { credentials: 'same-origin' })
      .then(r => { if (!r.ok) throw new Error('Fichier introuvable'); return r.arrayBuffer(); })
      .then(b => decryptFile(b, f.k));
    fileCache.set(f.id, p); p.catch(() => fileCache.delete(f.id));
  }
  return p;
}
function encFile(f) {
  const isImg = /^image\/(png|jpeg|gif|webp)$/.test(f.type) && f.size <= 15 * 1024 * 1024;
  const row = h('a', { class: 'file', href: '#', title: 'Fichier chiffré de bout en bout' }, h('span', { class: 'ic' }, icon('file')),
    h('span', {}, h('div', { class: 'fn' }, f.name), h('div', { class: 'fs' }, `${fmtSize(f.size)} · chiffré`)), icon('download'));
  row.addEventListener('click', async e => {
    e.preventDefault(); e.stopPropagation();
    try {
      const data = await loadEncFile(f);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
      const a = h('a', { href: url, download: f.name }); document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { toast('Déchiffrement du fichier impossible.', { error: true }); }
  });
  if (!isImg) return row;
  const wrap = h('div', { class: 'encimg' }, h('div', { class: 'sysmsg' }, icon('lock'), ' Déchiffrement de l\'image…'));
  loadEncFile(f).then(data => {
    if (!sniffImage(data, f.type)) { wrap.replaceChildren(row); return; } // pas une vraie image : simple fichier
    const url = URL.createObjectURL(new Blob([data], { type: f.type }));
    wrap.replaceChildren(h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { class: 'imgmsg', src: url, alt: f.name })));
  }).catch(() => wrap.replaceChildren(h('div', { class: 'sysmsg bad' }, icon('lock'), ` Image « ${f.name} » illisible (clé différente).`)));
  return wrap;
}
function uploadEncFiles(files) {
  for (const f of [...files].slice(0, 5)) {
    const row = h('div', { class: 'sysmsg' }, `Chiffrement de ${f.name}…`); $('#msgs').append(row);
    (async () => {
      const { blob, key } = await encryptFile(new Uint8Array(await f.arrayBuffer()));
      const s = await session();
      const r = await new Promise((res, rej) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/rooms/${encodeURIComponent(slug)}/files`);
        xhr.setRequestHeader('X-CSRF-Token', s.csrf);
        xhr.setRequestHeader('X-File-Name', 'fichier-chiffre.bin'); // le vrai nom voyage chiffré dans le message
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = e => { if (e.lengthComputable) row.textContent = `Envoi de ${f.name} (chiffré)… ${Math.round(e.loaded / e.total * 100)} %`; };
        xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch {} if (xhr.status === 201) res(j); else rej(new Error(j.error || 'Envoi impossible.')); };
        xhr.onerror = () => rej(new Error('Envoi interrompu.'));
        xhr.send(new Blob([blob]));
      });
      await sendEnc({ file: { id: r.id, name: f.name, type: f.type || 'application/octet-stream', size: f.size, k: key } });
    })().catch(e => toast(e.message || 'Envoi impossible.', { error: true })).finally(() => row.remove());
  }
}

boot();
