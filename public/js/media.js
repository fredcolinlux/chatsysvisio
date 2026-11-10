// Moteur média de ChatSysVisio : capture, encodage (WebCodecs ou repli), transport WebSocket, décodage, lecture.
// Tout passe par UNE connexion WSS (port 443) : aucun UDP, aucun port supplémentaire, aucun TURN.
import { pack, unpack, T_VIDEO, T_AUDIO, L_LO, L_HI, L_SCREEN, L_HD, F_KEY, csFlags, flagsCs, CODECS, CODEC_NAMES, PROTO } from './protocol.js';
import { ceilingFor, clampToSource, hdParams, screenParams, SendAdapter, normalizeQuality } from './quality.js';
import { AdpcmEncoder, adpcmDecode, ADPCM_RATE, Resampler, rmsLevel } from './adpcm.js';
import { roundLevel } from './e2ee.js';
import { opusConfigs } from './audio-config.js';
import { MicChain, loadFx } from './micfx.js';

const NOLAG = typeof location !== 'undefined' && (new URLSearchParams(location.search).get('force') || '').includes('nolag');
export const stats = (window.__cc = window.__cc || { sent: { video: 0, audio: 0, bytes: 0 }, recv: { video: {}, audio: {} }, decoded: { video: {}, audio: {} }, played: {}, codecs: {}, errors: [] });
const err = (where, e) => { stats.errors.push(`${where}: ${e?.message || e}`); if (stats.errors.length > 30) stats.errors.shift(); };

const AVC = 'avc1.42E01F';      // Baseline 3.1 : jusqu'à 1280×720
const AVC_HD = 'avc1.42E028';   // Baseline 4.0 : 1920×1080
const VCFG = { vp8: { codec: 'vp8' }, avc: { codec: AVC, avc: { format: 'annexb' } } };
const encCfg = (name, w, h) => name === 'avc' && w * h > 1280 * 720 ? { ...VCFG.avc, codec: AVC_HD } : VCFG[name];
const isApple = () => /Apple/.test(navigator.vendor || '');
const KEY_INTERVAL = 4000;

// ---------- Capacités du navigateur ----------
export async function detectCaps() {
  const force = new URLSearchParams(location.search).get('force') || '';
  const caps = { venc: [], vdec: [], aenc: [], adec: [], vmax: {} };
  if ('VideoEncoder' in window && !force.includes('jpeg')) {
    const ok = async (name, w, h, kbps, fps) => {
      try { return (await VideoEncoder.isConfigSupported({ ...encCfg(name, w, h), width: w, height: h, bitrate: kbps * 1000, framerate: fps, latencyMode: 'realtime' })).supported; } catch { return false; }
    };
    for (const name of Object.keys(VCFG)) {
      if (force.includes('avc') && name !== 'avc') continue; // tests : forcer H.264
      if (!(await ok(name, 640, 360, 500, 15))) continue;
      caps.venc.push(name);
      // 1080p seulement si l'encodeur l'accepte vraiment, sinon 720p, sinon 360p
      caps.vmax[name] = force.includes('no1080') ? 720 : (await ok(name, 1920, 1080, 2500, 24)) ? 1080 : (await ok(name, 1280, 720, 1200, 24)) ? 720 : 360;
    }
    // Safari / iPhone : H.264 est encodé par le matériel, VP8 par logiciel → H.264 d'abord (le serveur suit cet ordre).
    if (isApple() && caps.venc.includes('avc')) caps.venc.sort((a, b) => (b === 'avc') - (a === 'avc'));
  }
  if ('VideoDecoder' in window && !force.includes('jpeg')) {
    for (const [name, cfg] of Object.entries(VCFG)) {
      try { if ((await VideoDecoder.isConfigSupported({ codec: cfg.codec })).supported) caps.vdec.push(name); } catch {}
    }
  }
  if ('AudioEncoder' in window && !force.includes('adpcm')) {
    try { if ((await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 })).supported) caps.aenc.push('opus'); } catch {}
  }
  if ('AudioDecoder' in window && !force.includes('adpcm')) {
    try { if ((await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })).supported) caps.adec.push('opus'); } catch {}
  }
  stats.caps = caps;
  return caps;
}

// ---------- Transport ----------
export class Transport {
  constructor(url, { onOpen, onJson, onBinary, onClose }) {
    Object.assign(this, { url, onOpen, onJson, onBinary, onClose });
    this.closed = false; this.retry = 0; this.open();
  }
  open() {
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.retry = 0; this.onOpen?.(); };
    ws.onmessage = e => {
      if (typeof e.data === 'string') { let m; try { m = JSON.parse(e.data); } catch { return; } this.onJson?.(m); }
      else this.onBinary?.(e.data);
    };
    ws.onclose = e => {
      if (this.ws !== ws) return;
      const fatal = this.closed || [4003, 4001, 4004, 4005, 4010, 1008].includes(e.code);
      this.onClose?.(e.code, fatal);
      if (!fatal) setTimeout(() => !this.closed && this.open(), Math.min(8000, 500 * 2 ** this.retry++));
    };
  }
  get ready() { return this.ws?.readyState === 1; }
  get buffered() { return this.ws?.bufferedAmount || 0; }
  json(o) { if (this.ready) this.ws.send(JSON.stringify(o)); }
  bin(u8) { if (this.ready) { this.ws.send(u8); stats.sent.bytes += u8.byteLength; } }
  close() { this.closed = true; try { this.ws.close(1000); } catch {} }
}

// ---------- Émission vidéo ----------
const fit = (sw, sh, mw, mh) => {
  const portrait = sh > sw; if (portrait) [mw, mh] = [mh, mw];
  const s = Math.min(1, mw / sw, mh / sh);
  return [Math.max(2, Math.round(sw * s / 2) * 2), Math.max(2, Math.round(sh * s / 2) * 2)];
};

class VideoLayer {
  constructor(layer, send) {
    this.layer = layer; this.send = send; this.codec = 'jpeg'; this.enc = null; this.w = 0; this.h = 0;
    this.canvas = document.createElement('canvas'); this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.lastFrame = 0; this.lastKey = 0; this.forceKey = true; this.pending = false; this.bad = 0; this.skipped = 0; this.sentFrames = 0;
  }
  setCodec(c) { if (c !== this.codec) { this.codec = c; this.reset(); } }
  reset() { try { this.enc?.close(); } catch {} this.enc = null; this.w = this.h = 0; this.forceKey = true; }
  configure(w, h, kbps, fps) {
    this.reset(); this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
    if (this.codec === 'jpeg') return;
    const codecId = CODECS[this.codec];
    this.configuredAt = performance.now();
    this.enc = new VideoEncoder({
      output: (chunk, md) => {
        // L'encodeur indique l'espace réel de sa sortie (ex. Chrome : canvas RGB → YUV plage pleine BT.709).
        if (md?.decoderConfig) this.cs = csFlags(md.decoderConfig.colorSpace);
        const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
        this.send(pack({ type: T_VIDEO, layer: this.layer, flags: (chunk.type === 'key' ? F_KEY : 0) | (this.cs || 0), codec: codecId, ts: Math.round(chunk.timestamp / 1000) }, buf));
      },
      error: e => { err('encodeur ' + this.codec, e); this.bad++; this.reset(); },
    });
    try {
      this.enc.configure({ ...encCfg(this.codec, w, h), width: w, height: h, bitrate: kbps * 1000, framerate: fps, latencyMode: 'realtime' });
    } catch (e) { err('configure', e); this.bad++; this.enc = null; }
  }
  encode(src, sw, sh, { maxW, maxH, kbps, fps, quality }, now) {
    if (this.bad > 3 && this.codec !== 'jpeg') this.codec = 'jpeg';
    const [w, h] = fit(sw, sh, maxW, maxH);
    if (w !== this.w || h !== this.h || this.kbps !== kbps || (!this.enc && this.codec !== 'jpeg')) { this.kbps = kbps; this.configure(w, h, kbps, fps); }
    this.lastFrame = now;
    if (this.codec !== 'jpeg' && (!this.enc || this.enc.state !== 'configured' || this.enc.encodeQueueSize > 2)) {
      // Pendant la (re)configuration et les 2 premières secondes (préchauffage), un saut n'est pas un signe de retard.
      if (this.enc?.state === 'configured' && now - (this.configuredAt || 0) > 2000) this.skipped++;
      return;
    }
    // Source déjà à la bonne taille (ex. caméra 1080p sans effet) : pas de recopie dans un canvas.
    const direct = this.codec !== 'jpeg' && sw === w && sh === h && !this.noDirect;
    if (!direct) this.ctx.drawImage(src, 0, 0, w, h);
    if (this.codec === 'jpeg') {
      if (this.pending) return;
      this.pending = true;
      this.canvas.toBlob(b => {
        this.pending = false; if (!b) return;
        b.arrayBuffer().then(ab => this.send(pack({ type: T_VIDEO, layer: this.layer, flags: F_KEY, codec: CODECS.jpeg, ts: now | 0 }, new Uint8Array(ab))));
      }, 'image/jpeg', quality);
      return;
    }
    const key = this.forceKey || now - this.lastKey > KEY_INTERVAL;
    if (key) { this.forceKey = false; this.lastKey = now; }
    let frame;
    try {
      if (direct) { try { frame = new VideoFrame(src, { timestamp: Math.round(now * 1000) }); } catch { this.noDirect = true; this.ctx.drawImage(src, 0, 0, w, h); } }
      frame ||= new VideoFrame(this.canvas, { timestamp: Math.round(now * 1000) });
      this.enc.encode(frame, { keyFrame: key }); this.sentFrames++;
    }
    catch (e) { err('encode', e); this.bad++; }
    finally { frame?.close(); }
  }
}

// ---------- Moteur ----------
export class Engine {
  constructor(opts) {
    // opts : { slug, name, caps, ui, getCamSource(), quality }
    Object.assign(this, opts);
    this.need = new Set(); this.codecs = { video: 'jpeg', audio: 'adpcm' }; this.bitrates = { hi: 450, lo: 70, screen: 900, hd720: 1200, hd1080: 2500, screenHd: 1500 };
    this.state = { mic: false, cam: false, screen: false, hand: false };
    this.layers = [L_LO, L_HI, L_SCREEN, L_HD].map(l => new VideoLayer(l, u8 => this.sendVideo(u8)));
    this.adapter = new SendAdapter(); this.maxHeight = 1080; this.vq = 0; this.sendH = 0; this.wantH = 360;
    this.quality = normalizeQuality(this.quality);
    this.decoders = new Map(); this.adec = new Map(); this.peersBySid = new Map();
    this.audio = null; this.screenVideo = null; this.seq = 0;
    // Chiffrement de bout en bout (opts.e2ee = { media: MediaCrypto, ka: KeyAgreement }) : chiffrement des trames
    // dans l'ordre d'émission, déchiffrement dans l'ordre de réception par émetteur.
    this.txChain = Promise.resolve(); this.rxChains = new Map(); this.dfail = new Map();
    if (this.e2ee) {
      stats.e2ee = this.e2ee.media.stats;
      this.e2ee.ka.onReady = () => this.layers.forEach(L => { L.forceKey = true; });
    }
    this.ticker = new Worker('/js/ticker.js');
    this.ticker.onmessage = () => this.tick();
    this.ticker.postMessage(10); // 10 ms : cadence fine pour 24 i/s (1080p/720p) comme pour 15 et 8 i/s
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.t = new Transport(`${proto}//${location.host}/ws/${encodeURIComponent(this.slug)}`, {
      onOpen: () => this.t.json({ t: 'hello', name: this.name, caps: this.caps, state: this.state, proto: PROTO, build: document.documentElement.dataset.build || undefined }),
      onJson: m => this.onJson(m),
      onBinary: ab => this.onBinary(ab),
      onClose: (code, fatal) => { this.decoders.forEach(d => { try { d.dec?.close(); } catch {} }); this.decoders.clear(); this.ui.onDisconnect?.(code, fatal); },
    });
  }

  onJson(m) {
    if (this.e2ee && ['welcome', 'join', 'leave', 'e2ee'].includes(m.t)) {
      // Annonces et clés traitées dans l'ordre d'arrivée (vérifications asynchrones)
      this._kaChain = (this._kaChain || Promise.resolve()).then(() => this.e2ee.ka.onJson(m)).catch(e => err('e2ee', e));
      if (m.t === 'e2ee') return;
    }
    switch (m.t) {
      case 'welcome':
        this.bitrates = { ...this.bitrates, ...(m.bitrates || {}) }; this.maxHeight = m.maxHeight || 1080; this.you = m.you; this.vq = 0;
        this.peersBySid.clear(); for (const p of m.peers) this.peersBySid.set(p.sid, p);
        break;
      case 'join': this.peersBySid.set(m.peer.sid, m.peer); break;
      case 'leave': this.peersBySid.delete(m.sid); this.dropPeer(m.sid); this.rxChains.delete(m.sid); this.dfail.delete(m.sid); break;
      case 'need': this.need = new Set(m.layers); for (const l of m.layers) this.layers[l].forceKey = true; stats.need = m.layers; break;
      case 'codec':
        this.codecs = { video: m.video, audio: m.audio }; stats.codecs = this.codecs;
        for (const L of this.layers) L.setCodec(m.video);
        this.audio?.setCodec(m.audio);
        break;
      case 'keyreq': if (this.layers[m.layer]) this.layers[m.layer].forceKey = true; break;
    }
    this.ui.onMessage(m);
  }

  setState(patch) { Object.assign(this.state, patch); this.t?.json({ t: 'state', state: patch }); }
  send(obj) { this.t?.json(obj); }

  sendVideo(u8) {
    // Contre-pression locale : si la socket sature, on laisse tomber les images non-clés.
    if (this.t.buffered > 1_000_000 || (this.t.buffered > 400_000 && !(u8[4] & F_KEY))) { this.layers[u8[3]].forceKey = true; return; }
    if (this.e2ee) {
      if (!this.e2ee.ka.canSend()) { this.layers[u8[3]].forceKey = true; return; } // clé courante pas encore reçue
      return this.sealAndSend(u8, () => { stats.sent.video++; });
    }
    u8[11] = this.seq++ & 255; this.t.bin(u8); stats.sent.video++;
  }
  sendAudio(u8) {
    if (!this.t) return;
    if (!this.e2ee) return this.t.bin(u8);
    if (!this.e2ee.ka.canSend()) return;
    u8[10] = roundLevel(u8[10]);
    this.sealAndSend(u8);
  }
  sealAndSend(u8, done) {
    const media = this.e2ee.media;
    this.txChain = this.txChain.then(() => media.encrypt(u8)).then(out => {
      if (u8[0] === T_VIDEO) out[11] = this.seq++ & 255;
      this.t?.bin(out); done?.();
    }).catch(e => err('chiffrement', e));
  }

  // Plafond d'envoi (sans tenir compte de la caméra réelle) : réglage, appareil, codec, serveur.
  ceiling() {
    const c = this.codecs.video, deviceMax = c === 'jpeg' ? 360 : (this.caps?.vmax?.[c] ?? 720);
    return ceilingFor(this.quality, { mobile: this.isMobile?.(), effects: this.effectsActive?.(), codec: c, deviceMax, serverMax: this.maxHeight });
  }
  due(L, fps, now) { return now - L.lastFrame >= 1000 / fps - 6; }

  tick() {
    if (!this.t?.ready) return;
    const now = performance.now();
    const eco = this.quality === 'eco', br = this.bitrates;
    const lo = this.layers[L_LO], hi = this.layers[L_HI], hd = this.layers[L_HD];
    // Adaptation : socket qui accumule ou encodeur HD en retard → 1080p → 720p → 360p
    if (now - (this._adaptAt || 0) >= 250) {
      this._adaptAt = now;
      // ?force=nolag (tests) : ignore le retard de l'encodeur logiciel des navigateurs headless, garde le critère réseau.
      const lagging = !NOLAG && hd.sentFrames + hd.skipped > 4 && hd.skipped / (hd.sentFrames + hd.skipped) > 0.3;
      stats.send_lag = { sent: hd.sentFrames, skipped: hd.skipped };
      hd.skipped = hd.sentFrames = 0;
      let ceil = this.ceiling(), srcH = 0;
      const src0 = this.state.cam && this.lastSrc; if (src0) { ceil = clampToSource(ceil, src0.w, src0.h); srcH = Math.min(src0.w, src0.h); }
      this.sendH = ceil <= 360 ? ceil : this.adapter.update({ ceiling: ceil, buffered: this.t.buffered, lagging, now });
      // Annonce aux autres la hauteur max disponible (dès que la vraie taille de la caméra est connue)
      if (this.sendH !== this.vq && (srcH || ceil <= 360 || !this.state.cam)) { this.vq = this.sendH; this.setState({ vq: this.sendH }); }
      stats.send = { ceiling: ceil, sendH: this.sendH, adapt: this.adapter.level, buffered: this.t.buffered, need: [...this.need] };
      this.ui.onSendQuality?.(stats.send);
    }
    // Hauteur maximale réellement demandée (sert à composer l'arrière-plan à la bonne taille)
    this.wantH = this.need.has(L_HD) && !eco ? Math.max(this.sendH, 360) : this.need.has(L_HI) && !eco ? 360 : 144;
    if (this.state.cam) {
      const wLo = this.need.has(L_LO) || (eco && (this.need.has(L_HI) || this.need.has(L_HD)));
      const wHi = !eco && this.need.has(L_HI), wHd = !eco && this.need.has(L_HD);
      const jpeg = lo.codec === 'jpeg', hiFps = jpeg ? 8 : 15, hp = hdParams(this.sendH, br), hdFps = jpeg ? 8 : hp.fps;
      if ((wLo && this.due(lo, 8, now)) || (wHi && this.due(hi, hiFps, now)) || (wHd && this.due(hd, hdFps, now))) {
        const src = this.lastSrc = this.getCamSource(this.wantH);
        if (src) {
          if (wLo && this.due(lo, 8, now)) lo.encode(src.el, src.w, src.h, { maxW: 256, maxH: 144, kbps: br.lo, fps: 8, quality: 0.55 }, now);
          if (wHi && this.due(hi, hiFps, now)) hi.encode(src.el, src.w, src.h, { maxW: 640, maxH: 360, kbps: br.hi, fps: hiFps, quality: 0.62 }, now);
          if (wHd && this.due(hd, hdFps, now)) hd.encode(src.el, src.w, src.h, { ...hp, fps: hdFps }, now);
        }
      } else if (now - (this._probe || 0) > 1000) { this._probe = now; this.lastSrc = this.getCamSource(360); }
    } else this.lastSrc = null;
    if (this.state.screen && this.screenVideo && this.need.has(L_SCREEN)) {
      const v = this.screenVideo, sc = this.layers[L_SCREEN];
      const sp = screenParams(this.quality, { codec: sc.codec, adaptLevel: this.adapter.level, serverMax: this.maxHeight }, br);
      if (v.videoWidth && now - sc.lastFrame >= 1000 / sp.fps - 6) sc.encode(v, v.videoWidth, v.videoHeight, sp, now);
    }
  }

  // ---- Partage d'écran ----
  async startScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10, width: { max: 1920 }, height: { max: 1080 } }, audio: false });
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = stream; await v.play().catch(() => {});
    this.screenVideo = v; this.screenStream = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => this.stopScreen());
    this.layers[L_SCREEN].forceKey = true;
    this.setState({ screen: true });
    return stream;
  }
  stopScreen() {
    this.screenStream?.getTracks().forEach(t => t.stop()); this.screenStream = null; this.screenVideo = null;
    this.layers[L_SCREEN].reset();
    if (this.state.screen) { this.setState({ screen: false }); this.ui.onScreenStopped?.(); }
  }

  // ---- Réception ----
  onBinary(ab) {
    if (this.e2ee) return this.openBinary(new Uint8Array(ab));
    const p = unpack(ab); if (p) this.onPacket(p);
  }
  openBinary(u8) {
    const p = unpack(u8); if (!p) return;
    const { media, ka } = this.e2ee, sid = p.sid, nonce = ka.nonceOf(sid);
    if (!nonce) { media.stats.noann = (media.stats.noann || 0) + 1; return; } // annonce de l'émetteur pas encore reçue
    const prev = this.rxChains.get(sid) || Promise.resolve();
    const next = prev.then(() => media.decrypt(u8, nonce)).then(pt => {
      p.payload = pt; this.onPacket(p);
      const f = this.dfail.get(sid); if (f) { this.dfail.delete(sid); this.ui.onDecryptFail?.(sid, false); }
    }, e => {
      if (e.code === 'nokey') return ka.requestKey(e.tag);
      if (e.code !== 'auth') return;
      const f = this.dfail.get(sid) || { n: 0 }; f.n++; this.dfail.set(sid, f);
      if (f.n === 8) this.ui.onDecryptFail?.(sid, true);
    });
    this.rxChains.set(sid, next);
  }
  onPacket(p) {
    if (p.type === T_AUDIO) {
      stats.recv.audio[p.sid] = (stats.recv.audio[p.sid] || 0) + 1;
      this.ui.onLevel?.(p.sid, p.level);
      this.audio?.play(p.sid, p.codec, p.payload);
      return;
    }
    if (p.type !== T_VIDEO) return;
    stats.recv.video[p.sid] = (stats.recv.video[p.sid] || 0) + 1;
    const key = `${p.sid}:${p.layer}`, isKey = (p.flags & F_KEY) !== 0;
    const draw = img => {
      stats.decoded.video[p.sid] = (stats.decoded.video[p.sid] || 0) + 1;
      const f = (stats.frames ||= {})[key] ||= { n: 0, w: 0, h: 0 }; f.n++; f.w = img.displayWidth || img.width; f.h = img.displayHeight || img.height;
      this.ui.onFrame(p.sid, p.layer, img);
    };
    if (p.codec === CODECS.jpeg) {
      const blob = new Blob([p.payload], { type: 'image/jpeg' });
      createImageBitmap(blob).then(bmp => { draw(bmp); bmp.close?.(); }).catch(e => err('jpeg', e));
      return;
    }
    let d = this.decoders.get(key);
    // VP8 n'a pas d'en-tête de couleur : sans indication, le décodeur suppose BT.709 plage limitée → noirs bouchés,
    // blancs et peaux brûlés, teintes décalées. L'émetteur nous donne l'espace réel ; on reconfigure à l'image clé.
    const cs = p.codec === CODECS.vp8 ? (p.flags & 14) : 0;
    if (d && isKey && d.cs !== cs) { try { d.dec.close(); } catch {} d = null; }
    if (!d || d.codec !== p.codec || d.dec.state === 'closed') {
      try { d?.dec.close(); } catch {}
      const name = CODEC_NAMES[p.codec]; if (!VCFG[name] || !('VideoDecoder' in window)) return;
      d = { codec: p.codec, waitKey: true, dec: null, cs };
      d.dec = new VideoDecoder({
        output: f => {
          // Firefox / Safari ignorent l'indication de couleur du décodeur VP8 : on ré-étiquette l'image (une copie mémoire).
          const want = flagsCs(d.cs), have = f.colorSpace;
          if (want && /^(I420|NV12)/.test(f.format || '') && (have?.fullRange !== want.fullRange || have?.matrix !== want.matrix)) {
            const buf = new Uint8Array(f.allocationSize());
            f.copyTo(buf).then(layout => {
              let g; try { g = new VideoFrame(buf, { format: f.format, codedWidth: f.codedWidth, codedHeight: f.codedHeight, timestamp: f.timestamp, layout, visibleRect: f.visibleRect, displayWidth: f.displayWidth, displayHeight: f.displayHeight, colorSpace: want }); draw(g); }
              catch (e) { d.cs = 0; err('couleur', e); } finally { g?.close(); f.close(); }
            }, () => f.close());
            return;
          }
          try { draw(f); } finally { f.close(); }
        },
        error: e => { err('décodeur', e); d.waitKey = true; this.send({ t: 'keyreq', sid: p.sid, layer: p.layer }); try { d.dec.close(); } catch {} },
      });
      try { d.dec.configure({ codec: VCFG[name].codec, optimizeForLatency: true, ...(flagsCs(cs) ? { colorSpace: flagsCs(cs) } : {}) }); } catch (e) { err('configure décodeur', e); return; }
      this.decoders.set(key, d);
    }
    if (d.waitKey) { if (!isKey) { this.maybeKeyReq(p.sid, p.layer); return; } d.waitKey = false; }
    if (d.dec.decodeQueueSize > 6) { d.waitKey = true; this.maybeKeyReq(p.sid, p.layer); if (p.layer === L_HD) this.ui.onDecodeLag?.(p.sid, p.layer); return; }
    try { d.dec.decode(new EncodedVideoChunk({ type: isKey ? 'key' : 'delta', timestamp: p.ts * 1000, data: p.payload })); }
    catch (e) { err('decode', e); d.waitKey = true; this.maybeKeyReq(p.sid, p.layer); }
  }
  maybeKeyReq(sid, layer) {
    const k = `${sid}:${layer}`, now = performance.now(); this._kr ??= new Map();
    if (now - (this._kr.get(k) || 0) < 800) return; this._kr.set(k, now);
    this.send({ t: 'keyreq', sid, layer });
  }
  dropPeer(sid) {
    for (const [k, d] of this.decoders) if (k.startsWith(sid + ':')) { try { d.dec.close(); } catch {} this.decoders.delete(k); }
    this.audio?.dropPeer(sid);
  }
  subscribe(want) { const s = JSON.stringify(want); if (s === this._lastSubs) return; this._lastSubs = s; this.send({ t: 'subs', want }); stats.subs = want; }

  leave() {
    this.ticker.terminate(); this.t?.close(); this.stopScreen();
    this.decoders.forEach(d => { try { d.dec.close(); } catch {} });
    this.layers.forEach(l => l.reset());
  }
}

// ---------- Audio ----------
export class AudioIO {
  constructor() { this.ctx = null; this.codec = 'adpcm'; this.decs = new Map(); this.muted = true; this.level = 0; this.onLevel = null; this.fx = loadFx(); this.chain = null; }
  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {}
    this.ctx = new AC({ latencyHint: 'interactive' });
    this.ctx.resume?.().catch(() => {}); // dans le geste utilisateur (exigence iOS)
    await this.ctx.audioWorklet.addModule('/js/worklets.js');
    this.player = new AudioWorkletNode(this.ctx, 'cc-player', { numberOfInputs: 0, outputChannelCount: [2] });
    this.player.connect(this.ctx.destination);
    // Mesure de ce qui sort réellement des haut-parleurs (diagnostic « Infos techniques » et tests)
    this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 1024; this.player.connect(this.analyser);
    this._abuf = new Float32Array(this.analyser.fftSize);
    this.rate = this.ctx.sampleRate; stats.audioRate = this.rate;
    this.opusCfgs = 'AudioEncoder' in window ? await opusConfigs(window.AudioEncoder) : [];
    const resume = () => this.ctx.state !== 'running' && this.ctx.resume().catch(() => {});
    document.addEventListener('pointerdown', resume); document.addEventListener('keydown', resume);
    // Firefox laisse la promesse resume() en attente tant que la lecture n'est pas autorisée : ne jamais bloquer dessus.
    await Promise.race([this.ctx.resume().catch(() => {}), new Promise(r => setTimeout(r, 800))]);
  }
  // Niveau de sortie (crête sur ~20 ms) : 0 si rien n'est joué ou si le navigateur a suspendu le son.
  outputPeak() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._abuf); let e = 0; for (const x of this._abuf) e = Math.max(e, Math.abs(x)); return e;
  }
  // Interrupteurs du micro ({ ns, tune, comp, deess } + réglages de l'autotune) : appliqués à chaud ; renvoie l'état effectif.
  async setFx(fx) {
    this.fx = { ...fx };
    if (!this.chain) return null;
    const st = await this.chain.set(this.fx);
    stats.micfx = { ...st, rate: this.ctx.sampleRate, simd: this.chain.ns?.simd ?? null, tuneMs: this.chain.tuneLatencyMs };
    return st;
  }
  get running() { return this.ctx?.state === 'running'; }
  setSink(id) { if (this.ctx?.setSinkId) return this.ctx.setSinkId(id || '').catch(() => {}); }
  setCodec(c) { if (c === 'opus' && !this.opusCfgs?.length) c = 'adpcm'; if (c === this.codec) return; this.codec = c; this.resetEncoder(); }
  resetEncoder() {
    try { this.enc?.close(); } catch {}
    this.enc = null; this.adpcm = null; this.acc = null;
    if (this.codec === 'opus' && !this.opusCfgs?.length) this.codec = 'adpcm';
    if (this.codec === 'opus') {
      this.toRate = 48000; this.frame = 960;
      const cfg = this.opusCfgs[0];
      // Configuration refusée (souvent de façon asynchrone) : on passe à la suivante, puis à l'ADPCM. Jamais de boucle.
      const fail = e => { if (this.enc !== enc) return; err('opus enc', e); this.opusCfgs = this.opusCfgs.slice(1); this.resetEncoder(); };
      const enc = this.enc = new AudioEncoder({
        output: chunk => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); this.emit(CODECS.opus, b); },
        error: fail,
      });
      try { enc.configure(cfg); stats.opusMode = cfg.bitrateMode === 'constant' ? 'constant' : 'variable'; }
      catch (e) { return fail(e); }
    } else { this.toRate = ADPCM_RATE; this.frame = 320; this.adpcm = new AdpcmEncoder(); }
    this.rs = new Resampler(this.rate, this.toRate); this.acc = new Float32Array(0); this.ts = 0;
  }
  // Branche le micro ; send(u8) émet un paquet audio.
  attachMic(stream, send) {
    this.send = send;
    try { this.src?.disconnect(); } catch {}
    try { this.cap?.disconnect(); } catch {}
    try { this.chain?.output.disconnect(); } catch {}
    if (!stream || !stream.getAudioTracks().length) return;
    this.src = this.ctx.createMediaStreamSource(stream);
    this.cap = new AudioWorkletNode(this.ctx, 'cc-capture', { numberOfOutputs: 1, outputChannelCount: [1] });
    // Traitements du micro (réduction de bruit, compresseur, dé-esseur) : la chaîne est gardée d'un micro à l'autre.
    if (!this.chain) { this.chain = new MicChain(this.ctx); this.setFx(this.fx); }
    this.src.connect(this.chain.input); this.chain.output.connect(this.cap);
    // Sortie muette pour garder le nœud actif sur tous les navigateurs.
    const g = this.ctx.createGain(); g.gain.value = 0; this.cap.connect(g).connect(this.ctx.destination);
    if (!this.acc) this.resetEncoder();
    let quietSince = 0;
    this.cap.port.onmessage = e => {
      const block = e.data, lvl = rmsLevel(block);
      this.level = lvl; this.onLevel?.(lvl);
      if (this.muted || !this.send) return;
      // Détection d'activité vocale : on n'émet rien après 600 ms de quasi-silence (économie de bande passante).
      const now = performance.now();
      if (lvl > 40) quietSince = 0; else if (!quietSince) quietSince = now;
      if (quietSince && now - quietSince > 600) return;
      this.push(this.rs.process(block), lvl);
    };
  }
  push(pcm, lvl) {
    const a = new Float32Array(this.acc.length + pcm.length); a.set(this.acc); a.set(pcm, this.acc.length); this.acc = a;
    while (this.acc.length >= this.frame) {
      const f = this.acc.subarray(0, this.frame); this.acc = this.acc.slice(this.frame);
      this.curLevel = lvl;
      if (this.codec === 'opus' && this.enc?.state === 'configured') {
        try {
          const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: f.length, numberOfChannels: 1, timestamp: this.ts, data: f.slice() });
          this.enc.encode(ad); ad.close();
        } catch (e) { err('opus encode', e); }
      } else if (this.adpcm) this.emit(CODECS.adpcm, this.adpcm.encode(f));
      this.ts += Math.round(f.length / this.toRate * 1e6);
    }
  }
  emit(codec, payload) {
    stats.sent.audio++;
    this.send?.(pack({ type: T_AUDIO, codec, ts: Math.round(this.ts / 1000), level: this.curLevel || 0 }, payload));
  }
  play(sid, codec, payload) {
    if (!this.ctx) return;
    let d = this.decs.get(sid);
    if (!d || d.codec !== codec) {
      try { d?.dec?.close(); } catch {}
      d = { codec, dec: null, rs: new Resampler(codec === CODECS.opus ? 48000 : ADPCM_RATE, this.rate) };
      if (codec === CODECS.opus) {
        if (!('AudioDecoder' in window)) return;
        d.dec = new AudioDecoder({
          output: ad => {
            try {
              // Formats variables selon le navigateur (Chrome : f32-planar ; WebKit : parfois f32/s16 entrelacé, 2 canaux).
              const n = ad.numberOfFrames, fmt = ad.format || '', inter = !fmt.endsWith('-planar');
              const st = inter ? ad.numberOfChannels : 1, bytes = ad.allocationSize({ planeIndex: 0 });
              const f = new Float32Array(n);
              if (fmt.startsWith('f32')) {
                const all = new Float32Array(bytes / 4); ad.copyTo(all, { planeIndex: 0 });
                for (let i = 0; i < n; i++) f[i] = all[i * st];
              } else if (fmt.startsWith('s16')) {
                const all = new Int16Array(bytes / 2); ad.copyTo(all, { planeIndex: 0 });
                for (let i = 0; i < n; i++) f[i] = all[i * st] / 32768;
              } else if (fmt.startsWith('s32')) {
                const all = new Int32Array(bytes / 4); ad.copyTo(all, { planeIndex: 0 });
                for (let i = 0; i < n; i++) f[i] = all[i * st] / 2147483648;
              } else ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
              this.out(sid, d.rs.process(f));
            }
            catch (e) { err('opus copy', e); } finally { ad.close(); }
          },
          error: e => { err('opus dec', e); this.decs.delete(sid); },
        });
        d.dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      }
      this.decs.set(sid, d);
    }
    if (codec === CODECS.opus) {
      try { d.dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: (d.t = (d.t || 0) + 20000), data: payload })); } catch (e) { err('opus decode', e); }
    } else if (codec === CODECS.adpcm) this.out(sid, d.rs.process(adpcmDecode(payload)));
  }
  out(sid, pcm) {
    stats.decoded.audio[sid] = (stats.decoded.audio[sid] || 0) + 1;
    let e = 0; for (let i = 0; i < pcm.length; i += 8) e = Math.max(e, Math.abs(pcm[i])); stats.played[sid] = Math.max(stats.played[sid] || 0, e);
    this.player.port.postMessage({ sid, pcm }, [pcm.buffer]);
  }
  dropPeer(sid) { const d = this.decs.get(sid); try { d?.dec?.close(); } catch {} this.decs.delete(sid); this.player?.port.postMessage({ clear: sid }); }
  close() { try { this.ctx?.close(); } catch {} }
}
