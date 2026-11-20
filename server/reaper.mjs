// Suppression automatique des salons PUBLICS restés vides (1.12).
// Un salon public sans aucun participant connecté depuis PUBLIC_ROOM_IDLE_TTL_MIN minutes (10 par défaut) est détruit :
// retiré de la liste, historique, fichiers et métadonnées effacés, nom de nouveau libre. Les salons privés et les salons
// protégés par mot de passe (même publics) ne sont pas concernés : ils gardent l'expiration après ROOM_TTL_DAYS jours
// d'inactivité.
//
// - Un seul minuteur par salon (Map roomId → minuteur), annulé dès que quelqu'un arrive, à la suppression et à l'arrêt.
// - Le début du vide est noté dans le salon (room.emptySince, rooms.json) : après un redémarrage, un salon déjà vide
//   garde son compte à rebours (supprimé tout de suite s'il a déjà expiré) ; sans date connue, il repart de zéro.
// - Course arrivée / suppression : Node exécute tout sur un seul fil ; au déclenchement on revérifie que le salon existe
//   encore, est toujours public, n'a personne et a vraiment dépassé le délai. Une connexion WebSocket en cours
//   d'ouverture relance le compte à rebours (bump) et le hub refuse d'attacher quelqu'un à un salon supprimé.
const MAX_DELAY = 2 ** 31 - 1; // limite de setTimeout (~24,8 jours) : au-delà, on se réarme

export class RoomReaper {
  constructor({ store, count, ttlMs, onDestroy = () => {}, log = () => {}, now = () => Date.now(), timers = { set: setTimeout, clear: clearTimeout } }) {
    this.store = store; this.count = count; this.ttlMs = ttlMs; this.onDestroy = onDestroy; this.log = log; this.now = now; this.t = timers;
    this.timers = new Map(); // roomId → { h, slug }
    this.closed = false;
  }
  static eligible(room) { return !!room?.isPublic && !room.passwordHash; }
  enabled() { const t = this.ttlMs(); return Number.isFinite(t) && t > 0; }
  live(room) { return !!room && this.store.getRoom(room.slug) === room; }
  
  // Au démarrage : personne n'est connecté, chaque salon public est vide.
  start() {
    const now = this.now(); let n = 0;
    for (const room of [...this.store.rooms.values()]) {
      if (!RoomReaper.eligible(room) || this.count(room) > 0) continue;
      if (!Number.isFinite(room.emptySince) || room.emptySince > now) { room.emptySince = now; n++; }
      if (this.enabled()) this.schedule(room);
    }
    if (n) this.store.saveSoon();
  }
  occupied(room) {
    this.cancel(room.id);
    if (room.emptySince != null) { delete room.emptySince; if (this.live(room)) this.store.saveSoon(); }
  }
  emptied(room) {
    if (this.closed || !this.live(room) || !RoomReaper.eligible(room) || this.count(room) > 0) return;
    room.emptySince = this.now(); this.store.saveSoon();
    if (this.enabled()) this.schedule(room);
  }
  // Quelqu'un est en train d'arriver (poignée de main WebSocket) : le compte à rebours repart de zéro.
  bump(room) { if (this.timers.has(room.id) && this.live(room) && this.count(room) === 0) { room.emptySince = this.now(); this.schedule(room); } }
  remaining(room) {
    if (!RoomReaper.eligible(room) || !this.enabled() || this.count(room) > 0 || !Number.isFinite(room.emptySince)) return null;
    return Math.max(0, room.emptySince + this.ttlMs() - this.now());
  }
  schedule(room) {
    this.cancel(room.id);
    const left = Math.min(MAX_DELAY, Math.max(0, room.emptySince + this.ttlMs() - this.now()));
    const h = this.t.set(() => this.fire(room.id, room.slug), left); h?.unref?.();
    this.timers.set(room.id, { h, slug: room.slug });
  }
  cancel(roomId) { const e = this.timers.get(roomId); if (e) { this.t.clear(e.h); this.timers.delete(roomId); } }
  fire(roomId, slug) {
    this.timers.delete(roomId);
    if (this.closed) return;
    const room = this.store.getRoom(slug);
    if (!room || room.id !== roomId || !RoomReaper.eligible(room) || !this.enabled() || this.count(room) > 0 || !Number.isFinite(room.emptySince)) return;
    if (room.emptySince + this.ttlMs() > this.now()) return this.schedule(room); // délai allongé entre-temps, ou réveil anticipé
    this.destroy(room);
  }
  destroy(room) {
    this.cancel(room.id);
    try { this.store.deleteRoom(room); } catch (e) { this.log('suppression du salon public', room.slug, e.message); return; }
    try { this.onDestroy(room); } catch (e) { this.log('suppression du salon public (nettoyage)', e.message); }
    this.log(`salon public ${room.slug} supprimé (vide depuis ${Math.round((this.now() - room.emptySince) / 60000)} min)`);
  }
  close() { this.closed = true; for (const e of this.timers.values()) this.t.clear(e.h); this.timers.clear(); }
}
