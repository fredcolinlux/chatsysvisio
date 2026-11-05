// Statistiques du serveur pour l'administration : débits du relais, CPU, mémoire, disque, salons, durée de
// fonctionnement. Échantillon toutes les 10 s, 1 h d'historique en mémoire (360 points).
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

function cpuTimes() { let idle = 0, total = 0; for (const c of os.cpus()) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; } return { idle, total }; }
function dirSize(dir, max = 200000) {
  let n = 0, count = 0; const stack = [dir];
  while (stack.length && count < max) {
    const d = stack.pop(); let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) { count++; const p = path.join(d, e.name); if (e.isDirectory()) stack.push(p); else { try { n += fs.statSync(p).size; } catch {} } }
  }
  return n;
}

export class Stats {
  constructor({ hub, cfg, every = 10e3, points = 360 }) {
    Object.assign(this, { hub, cfg, every, points }); this.started = Date.now(); this.series = [];
    this.lastCpu = cpuTimes(); this.lastProc = process.cpuUsage(); this.lastAt = Date.now();
    this.lastIn = hub.bytesIn; this.lastOut = hub.bytesOut; this.dataSize = 0; this.dataSizeAt = 0;
    this.timer = setInterval(() => this.sample(), every); this.timer.unref?.();
  }
  close() { clearInterval(this.timer); }
  sample(now = Date.now()) {
    const dt = Math.max(1, now - this.lastAt) / 1000;
    const c = cpuTimes(), pr = process.cpuUsage();
    const dTot = c.total - this.lastCpu.total, cpu = dTot > 0 ? 100 * (1 - (c.idle - this.lastCpu.idle) / dTot) : 0;
    const proc = ((pr.user - this.lastProc.user) + (pr.system - this.lastProc.system)) / 1e6 / dt / os.cpus().length * 100;
    const p = { t: now, inKbps: Math.round((this.hub.bytesIn - this.lastIn) * 8 / dt / 1000), outKbps: Math.round((this.hub.bytesOut - this.lastOut) * 8 / dt / 1000),
      cpu: Math.round(cpu * 10) / 10, proc: Math.round(proc * 10) / 10, rss: process.memoryUsage().rss, rooms: this.hub.rooms.size, people: this.hub.peopleCount() };
    this.lastCpu = c; this.lastProc = pr; this.lastAt = now; this.lastIn = this.hub.bytesIn; this.lastOut = this.hub.bytesOut;
    this.series.push(p); if (this.series.length > this.points) this.series.shift();
    return p;
  }
  snapshot() {
    let disk = null;
    try { const s = fs.statfsSync(this.cfg.dataDir); disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
    if (Date.now() - this.dataSizeAt > 300e3) { this.dataSize = dirSize(this.cfg.dataDir); this.dataSizeAt = Date.now(); }
    return {
      version: this.cfg.version, build: this.cfg.build, node: process.version, uptime: Math.round((Date.now() - this.started) / 1000), sysUptime: Math.round(os.uptime()),
      load: os.loadavg().map(x => Math.round(x * 100) / 100), cpus: os.cpus().length,
      mem: { total: os.totalmem(), free: os.freemem(), rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed },
      disk, dataSize: this.dataSize, rooms: this.hub.rooms.size, people: this.hub.peopleCount(), storedRooms: this.hub.store.rooms.size,
      totals: { inBytes: this.hub.bytesIn, outBytes: this.hub.bytesOut },
      series: this.series,
    };
  }
}
