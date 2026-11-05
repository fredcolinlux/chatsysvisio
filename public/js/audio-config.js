// Choix de la configuration de l'encodeur Opus (WebCodecs). Débit constant si le navigateur le permet (la taille des
// paquets ne trahit pas ce qui est dit), sinon débit variable, sinon repli ADPCM. Certains navigateurs (Safari,
// Chrome Android selon l'appareil) n'acceptent pas toutes les options : on vérifie avec isConfigSupported.
export const OPUS_BASE = Object.freeze({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 24000 });
export const OPUS_CBR = Object.freeze({ ...OPUS_BASE, bitrateMode: 'constant' });

// AE : AudioEncoder (ou un substitut pour les tests). Renvoie la liste ordonnée des configurations utilisables.
export async function opusConfigs(AE) {
  if (!AE?.isConfigSupported) return [];
  const ok = async c => { try { return !!(await AE.isConfigSupported(c)).supported; } catch { return false; } };
  const out = [];
  if (await ok(OPUS_CBR)) out.push(OPUS_CBR);
  if (await ok(OPUS_BASE)) out.push(OPUS_BASE);
  return out;
}
