import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { Store, slugify, MAX_HISTORY } from '../../server/store.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-store-'));

test('slugify', () => {
  assert.equal(slugify('  Apéro du Jeudi !! '), 'apero-du-jeudi');
  assert.equal(slugify('***'), '');
});

test('salons : public au nom lisible, privé avec suffixe aléatoire, persistance', () => {
  const dir = tmp(); const s = new Store(dir);
  const pub = s.createRoom({ name: 'Club lecture', isPublic: true });
  assert.equal(pub.slug, 'club-lecture');
  assert.throws(() => s.createRoom({ name: 'Club Lecture', isPublic: true }), e => e.code === 'exists');
  const a = s.createRoom({ name: 'Famille' }), b = s.createRoom({ name: 'Famille' });
  assert.match(a.slug, /^famille-[a-z0-9]{6}$/); assert.notEqual(a.slug, b.slug);
  assert.deepEqual(s.publicRooms().map(r => r.slug), ['club-lecture']);
  const s2 = new Store(dir);
  assert.equal(s2.getRoom(a.slug)?.id, a.id);
});

test('messages : historique borné, réactions rejouées après redémarrage', () => {
  const dir = tmp(); const s = new Store(dir); const r = s.createRoom({ name: 'Bavards', isPublic: true });
  for (let i = 0; i < MAX_HISTORY + 20; i++) s.addMessage(r, { id: 'm' + i, ts: i, kind: 'user', text: 't' + i });
  s.setReactions(r, 'm' + (MAX_HISTORY + 19), { '👍': ['Alice'] });
  const s2 = new Store(dir); const h = s2.messages(s2.getRoom('bavards'));
  assert.equal(h.length, MAX_HISTORY);
  assert.deepEqual(h.at(-1).reactions, { '👍': ['Alice'] });
});

test('fichiers : stockés hors de la racine web, identifiants non devinables', () => {
  const s = new Store(tmp()); const r = s.createRoom({ name: 'Docs', isPublic: true });
  const m = s.saveFile(r, { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') });
  assert.match(m.id, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(s.fileMeta(m.id).roomId, r.id);
  assert.equal(s.fileMeta('../../etc/passwd'), null);
});
