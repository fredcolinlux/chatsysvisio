// Tableau blanc partagé : vue, saisie (Pointer Events : souris, doigt, stylet) et rendu vectoriel.
// Les traits sont des coordonnées entières sur une feuille 16:9 (board-model.js) : même dessin sur tous les écrans.
import { h, icon } from './common.js';
import { W, H, COLORS, WIDTHS, MAX_PTS, SHAPES, newId, keepPoint, cleanStroke } from './board-model.js';

const TOOL_LIST = [['pen', 'Stylet'], ['line', 'Ligne'], ['arrow', 'Flèche'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['eraser', 'Gomme']];
const COLOR_NAMES = ['Noir', 'Bleu', 'Rouge', 'Vert', 'Violet'];
const WIDTH_NAMES = ['Fin', 'Moyen', 'Épais'];

// Dessine un trait sur un contexte 2D dont l'échelle est « px par unité » (sc).
export function drawStroke(ctx, s, sc) {
  const st = s.pr ? 3 : 2, p = s.p, n = p.length / st;
  const base = s.w * W / 1000 * sc * (s.k === 'eraser' ? 3 : 1);
  ctx.save();
  ctx.globalCompositeOperation = s.k === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = ctx.fillStyle = COLORS[s.c] || COLORS[0];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = base;
  const X = i => p[i * st] * sc, Y = i => p[i * st + 1] * sc, P = i => (s.pr ? 0.35 + 1.3 * p[i * st + 2] / 100 : 1);
  if (SHAPES.has(s.k)) {
    const x0 = X(0), y0 = Y(0), x1 = X(1), y1 = Y(1);
    ctx.beginPath();
    if (s.k === 'rect') ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    else if (s.k === 'ellipse') ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
    else {
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      if (s.k === 'arrow') {
        const a = Math.atan2(y1 - y0, x1 - x0), L = Math.max(base * 3.5, 10 * sc * W / 1000);
        ctx.moveTo(x1, y1); ctx.lineTo(x1 - L * Math.cos(a - 0.45), y1 - L * Math.sin(a - 0.45));
        ctx.moveTo(x1, y1); ctx.lineTo(x1 - L * Math.cos(a + 0.45), y1 - L * Math.sin(a + 0.45));
      }
    }
    ctx.stroke(); ctx.restore(); return;
  }
  if (n === 1) { ctx.beginPath(); ctx.arc(X(0), Y(0), base * P(0) / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
  if (!s.pr) {
    // lissage : courbes quadratiques passant par les milieux des segments
    ctx.beginPath(); ctx.moveTo(X(0), Y(0));
    for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    ctx.lineTo(X(n - 1), Y(n - 1)); ctx.stroke();
  } else {
    // pression : épaisseur variable, segment par segment (milieu à milieu, même lissage)
    let mx = X(0), my = Y(0);
    for (let i = 1; i < n; i++) {
      const nx = i < n - 1 ? (X(i) + X(i + 1)) / 2 : X(i), ny = i < n - 1 ? (Y(i) + Y(i + 1)) / 2 : Y(i);
      ctx.beginPath(); ctx.lineWidth = base * P(i); ctx.moveTo(mx, my); ctx.quadraticCurveTo(X(i), Y(i), nx, ny); ctx.stroke();
      mx = nx; my = ny;
    }
  }
  ctx.restore();
}

// ctx : { send(op, stroke|null, extra), me() → id, isOwner(), name(peerId), meta(), toast(msg), onClose(), onLock(on), onClear() }
export class BoardView {
  constructor(ctx) {
    this.ctx = ctx;
    this.items = [];                    // traits validés, dans l'ordre du serveur
    this.byId = new Map();
    this.live = new Map();              // traits en cours des autres : clé from:id → { s, from, at }
    this.undoStack = []; this.redoStack = []; // actions (listes de traits) de cette personne
    this.tool = 'pen'; this.color = 1; this.width = 1; this.cur = null; this.enabled = true;
    this.base = h('canvas', { class: 'wbc', 'aria-label': 'Tableau blanc' });
    this.over = h('canvas', { class: 'wbc wbover', 'aria-hidden': 'true' });
    this.tags = h('div', { class: 'wbtags', 'aria-hidden': 'true' });
    this.paper = h('div', { class: 'wbpaper' }, this.base, this.over, this.tags);
    this.bar = this.toolbar();
    this.status = h('div', { class: 'wbstatus', 'aria-live': 'polite' });
    this.el = h('div', { class: 'wb' }, h('div', { class: 'wbarea' }, this.paper), this.bar, this.status);
    this.paper.addEventListener('pointerdown', e => this.down(e));
    this.paper.addEventListener('pointermove', e => this.move(e));
    for (const ev of ['pointerup', 'pointercancel']) this.paper.addEventListener(ev, e => this.up(e));
    this.paper.addEventListener('contextmenu', e => e.preventDefault());
    this.el.addEventListener('dblclick', e => e.stopPropagation());
    this.el.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
      e.preventDefault(); e.shiftKey ? this.redo() : this.undo();
    });
    this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(this.el.querySelector('.wbarea'));
    this.raf = 0; this.loop = () => { this.raf = requestAnimationFrame(this.loop); this.drawLive(); };
    this.raf = requestAnimationFrame(this.loop);
    this.paint();
  }
  destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }

  // ---------- barre d'outils ----------
  toolbar() {
    const btn = (ic, label, fn, data = {}) => h('button', { type: 'button', class: 'wbb', title: label, 'aria-label': label, dataset: data, onclick: fn }, icon(ic));
    const tools = TOOL_LIST.map(([k, l]) => btn(k, l, () => { this.tool = k; this.paint(); }, { tool: k }));
    const colors = COLORS.map((c, i) => { const b = h('button', { type: 'button', class: 'wbcol', title: COLOR_NAMES[i], 'aria-label': 'Couleur ' + COLOR_NAMES[i], dataset: { col: String(i) }, onclick: () => { this.color = i; if (this.tool === 'eraser') this.tool = 'pen'; this.paint(); } }, h('i')); b.firstChild.style.background = c; return b; });
    const widths = WIDTHS.map((w, i) => { const b = h('button', { type: 'button', class: 'wbw', title: 'Trait ' + WIDTH_NAMES[i].toLowerCase(), 'aria-label': 'Épaisseur ' + WIDTH_NAMES[i], dataset: { w: String(i) }, onclick: () => { this.width = i; this.paint(); } }, h('i')); b.firstChild.style.width = b.firstChild.style.height = (4 + i * 4) + 'px'; return b; });
    const sep = () => h('span', { class: 'wbsep' });
    this.lockBtn = btn('lock', 'Verrouiller : toi seul dessines', () => this.ctx.onLock(!this.ctx.meta()?.locked), { owner: '1' });
    this.clearBtn = btn('trash', 'Tout effacer', () => this.ctx.onClear(), { owner: '1' });
    this.closeBtn = btn('x', 'Fermer le tableau blanc', () => this.ctx.onClose(), { owner: '1' });
    this.undoBtn = btn('undo', 'Annuler (Ctrl+Z)', () => this.undo()); this.redoBtn = btn('redo', 'Rétablir (Ctrl+Maj+Z)', () => this.redo());
    return h('div', { class: 'wbbar', role: 'toolbar', 'aria-label': 'Outils du tableau blanc' },
      h('div', { class: 'wbgrp' }, tools), sep(), h('div', { class: 'wbgrp' }, colors), sep(), h('div', { class: 'wbgrp' }, widths), sep(),
      h('div', { class: 'wbgrp' }, this.undoBtn, this.redoBtn), sep(),
      h('div', { class: 'wbgrp' }, btn('download', 'Exporter en PNG', () => this.exportPng()), this.lockBtn, this.clearBtn, this.closeBtn));
  }
  paint() {
    const meta = this.ctx.meta() || {}, owner = this.ctx.isOwner();
    this.bar.querySelectorAll('[data-tool]').forEach(b => { const on = b.dataset.tool === this.tool; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    this.bar.querySelectorAll('[data-col]').forEach(b => b.classList.toggle('on', +b.dataset.col === this.color && this.tool !== 'eraser'));
    this.bar.querySelectorAll('[data-w]').forEach(b => b.classList.toggle('on', +b.dataset.w === this.width));
    this.bar.querySelectorAll('[data-owner]').forEach(b => { b.hidden = !owner; });
    this.lockBtn.replaceChildren(icon(meta.locked ? 'lock' : 'unlock'));
    this.lockBtn.title = meta.locked ? 'Déverrouiller : tout le monde dessine' : 'Verrouiller : toi seul dessines';
    this.lockBtn.classList.toggle('on', !!meta.locked);
    this.undoBtn.disabled = !this.undoStack.length; this.redoBtn.disabled = !this.redoStack.length;
    const can = this.canDraw();
    this.el.classList.toggle('ro', !can);
    const who = meta.ownerName || '?';
    const txt = meta.away ? `${who} s'est déconnecté : le tableau se ferme dans quelques secondes s'il ne revient pas.`
      : !can && meta.locked ? `Verrouillé par ${who} : lecture seule.` : '';
    if (this.status.textContent !== txt) this.status.textContent = txt;
    this.status.hidden = !txt;
  }
  canDraw() { const m = this.ctx.meta(); return !!m && this.enabled && (!m.locked || this.ctx.isOwner()); }

  // ---------- taille et rendu ----------
  fit() {
    const area = this.el.querySelector('.wbarea'), cs = getComputedStyle(area);
    const aw = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight), ah = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (aw <= 0 || ah <= 0) return;
    const w = Math.floor(Math.min(aw, ah * W / H)), hh = w * H / W;
    this.paper.style.width = w + 'px'; this.paper.style.height = hh + 'px';
    const dpr = Math.min(devicePixelRatio || 1, 2), pw = Math.round(w * dpr), ph = Math.round(hh * dpr);
    for (const c of [this.base, this.over]) if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
    this.sc = pw / W; this.cssW = w; this._busy = true; this.redraw();
  }
  redraw() {
    if (!this.sc) return;
    const g = this.base.getContext('2d'); g.clearRect(0, 0, this.base.width, this.base.height);
    for (const s of this.items) drawStroke(g, s, this.sc);
  }
  drawLive() {
    if (!this.sc) return;
    // rien en cours : on ne redessine pas (une dernière image pour effacer, puis repos)
    const busy = !!(this.live.size || this.cur); if (!busy && !this._busy) return; this._busy = busy;
    const g = this.over.getContext('2d'); g.clearRect(0, 0, this.over.width, this.over.height);
    const now = performance.now(), tags = [];
    for (const [k, l] of this.live) {
      if (now - l.at > 4000) { this.live.delete(k); continue; }
      if (l.s.k === 'eraser') { const st = l.s.pr ? 3 : 2, n = l.s.p.length / st; if (n) { g.save(); g.strokeStyle = 'rgba(80,90,110,.6)'; g.lineWidth = 1.5; g.beginPath(); g.arc(l.s.p[(n - 1) * st] * this.sc, l.s.p[(n - 1) * st + 1] * this.sc, l.s.w * W / 1000 * this.sc * 1.5, 0, 7); g.stroke(); g.restore(); } }
      else drawStroke(g, l.s, this.sc);
      if (l.from && now - l.at < 1500) { const st = l.s.pr ? 3 : 2, n = l.s.p.length / st; if (n) tags.push([l.from, l.s.p[(n - 1) * st] * this.sc, l.s.p[(n - 1) * st + 1] * this.sc, l.s.c]); }
    }
    if (this.cur && this.cur.s.k !== 'eraser') drawStroke(g, this.cur.s, this.sc);
    // nom de qui dessine, près de la pointe (une étiquette par personne, déplacée plutôt que recréée)
    this.tagEls ||= new Map();
    const dpr = this.base.width / (this.cssW || 1), seen = new Set();
    for (const [from, x, y, c] of tags) {
      if (seen.has(from)) continue; seen.add(from);
      let e = this.tagEls.get(from);
      if (!e) { e = h('span', { class: 'wbtag' }, this.ctx.name(from)); this.tags.append(e); this.tagEls.set(from, e); }
      e.style.left = Math.round(x / dpr + 8) + 'px'; e.style.top = Math.round(y / dpr + 8) + 'px'; e.style.background = COLORS[c] || COLORS[1];
    }
    for (const [from, e] of this.tagEls) if (!seen.has(from)) { e.remove(); this.tagEls.delete(from); }
  }

  // ---------- saisie ----------
  pt(e) {
    const r = this.paper.getBoundingClientRect();
    const x = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * W), y = Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * H);
    return [x, y, Math.round(Math.min(1, Math.max(0, e.pressure || 0.5)) * 100)];
  }
  down(e) {
    if (!this.canDraw() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (this.cur) return; // un seul trait à la fois (second doigt ignoré)
    e.preventDefault(); try { this.paper.setPointerCapture(e.pointerId); } catch {}
    const pr = e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5 && !SHAPES.has(this.tool);
    const [x, y, p] = this.pt(e);
    const s = { id: newId(), k: this.tool, c: this.color, w: WIDTHS[this.width], ...(pr ? { pr: true } : {}), p: SHAPES.has(this.tool) ? [x, y, x, y] : pr ? [x, y, p] : [x, y] };
    this.cur = { s, pid: e.pointerId, sent: 0, lastSend: 0, action: [] };
    this.sendLive(true);
  }
  move(e) {
    const c = this.cur; if (!c || e.pointerId !== c.pid) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents?.() || []; const list = evs.length ? evs : [e];
    const s = c.s, st = s.pr ? 3 : 2;
    for (const ev of list) {
      const [x, y, p] = this.pt(ev);
      if (SHAPES.has(s.k)) { s.p[2] = x; s.p[3] = y; continue; }
      if (!keepPoint(s.p, x, y, st, s.k === 'eraser' ? 20 : 10)) continue;
      s.p.push(x, y); if (s.pr) s.p.push(p);
      if (s.p.length / st >= MAX_PTS) { // trait trop long : on le valide et on continue sur un nouveau, sans couture visible
        this.commit(c);
        const keep = s.p.slice(-st);
        c.s = { ...s, id: newId(), p: keep }; c.sent = 0;
      }
    }
    if (performance.now() - c.lastSend > 50) this.sendLive();
  }
  up(e) {
    const c = this.cur; if (!c || e.pointerId !== c.pid) return;
    this.cur = null;
    this.commit(c);
    if (c.action.length) { this.undoStack.push(c.action); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack = []; }
    this.paint();
  }
  sendLive(first = false) {
    const c = this.cur; if (!c) return;
    const s = c.s, st = s.pr ? 3 : 2, shape = SHAPES.has(s.k);
    const from = shape ? 0 : c.sent;
    if (!first && !shape && from >= s.p.length) return;
    c.lastSend = performance.now();
    this.ctx.send('live', { ...cleanStroke({ ...s, p: s.p.slice(from) }), n: from / st });
    c.sent = s.p.length;
  }
  commit(c) {
    const s = cleanStroke(c.s);
    if (SHAPES.has(s.k) && s.p[0] === s.p[2] && s.p[1] === s.p[3]) return; // forme vide (simple clic)
    this.addItem(s); c.action.push(s);
    this.ctx.send('add', s);
  }
  undo() {
    const a = this.undoStack.pop(); if (!a) return;
    const ids = a.map(s => s.id).filter(id => this.byId.has(id));
    this.removeIds(ids); if (ids.length) this.ctx.send('undo', null, { ids });
    this.redoStack.push(a); this.paint();
  }
  redo() {
    const a = this.redoStack.pop(); if (!a) return;
    const again = a.map(s => ({ ...s, id: newId() })); // nouvel identifiant : le serveur refuse un identifiant déjà vu
    for (const s of again) { this.addItem(s); this.ctx.send('add', s); }
    this.undoStack.push(again); this.paint();
  }

  // ---------- état reçu ----------
  addItem(s, from) {
    if (this.byId.has(s.id)) return;
    this.items.push(s); this.byId.set(s.id, s);
    if (from) this.live.delete(from + ':' + s.id);
    if (this.sc) drawStroke(this.base.getContext('2d'), s, this.sc);
  }
  removeIds(ids) {
    const set = new Set(ids); if (!ids.length) return;
    this.items = this.items.filter(s => !set.has(s.id)); for (const id of ids) this.byId.delete(id);
    this.redraw();
  }
  clear() { this.items = []; this.byId.clear(); this.live.clear(); this.undoStack = []; this.redoStack = []; this.redraw(); this.paint(); }
  setAll(items) { this.items = []; this.byId.clear(); for (const s of items) { this.items.push(s); this.byId.set(s.id, s); } this.redraw(); }
  onLive(from, s) {
    const k = from + ':' + s.id, l = this.live.get(k), st = s.pr ? 3 : 2;
    if (!l || SHAPES.has(s.k) || s.n === 0) { this.live.set(k, { from, at: performance.now(), s: { ...s, p: s.p.slice() } }); return; }
    if (s.n * st !== l.s.p.length) { if (s.n * st < l.s.p.length) l.s.p.length = s.n * st; else return; } // fragment manquant : on attend le trait final
    l.s.p.push(...s.p); l.at = performance.now();
  }

  exportPng() {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const g = c.getContext('2d');
    const ink = document.createElement('canvas'); ink.width = c.width; ink.height = c.height;
    const gi = ink.getContext('2d'); for (const s of this.items) drawStroke(gi, s, c.width / W);
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(ink, 0, 0);
    c.toBlob(b => {
      if (!b) return;
      const url = URL.createObjectURL(b), a = h('a', { href: url, download: `tableau-blanc-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    }, 'image/png');
  }
}
