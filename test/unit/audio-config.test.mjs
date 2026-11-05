import test from 'node:test';
import assert from 'node:assert/strict';
import { opusConfigs, OPUS_CBR, OPUS_BASE } from '../../public/js/audio-config.js';

const fakeAE = support => ({ isConfigSupported: async c => ({ supported: support(c), config: c }) });

test('Opus : débit constant si accepté (Chrome/Edge bureau), puis débit variable en secours', async () => {
  assert.deepEqual(await opusConfigs(fakeAE(() => true)), [OPUS_CBR, OPUS_BASE]);
});
test('Opus : débit constant refusé (Safari, certains Chrome Android) → débit variable seul', async () => {
  assert.deepEqual(await opusConfigs(fakeAE(c => c.bitrateMode !== 'constant')), [OPUS_BASE]);
});
test('Opus : indisponible ou vérification en erreur → aucune config (repli ADPCM)', async () => {
  assert.deepEqual(await opusConfigs(fakeAE(() => false)), []);
  assert.deepEqual(await opusConfigs({ isConfigSupported: async () => { throw new TypeError('x'); } }), []);
  assert.deepEqual(await opusConfigs(undefined), []);
});
