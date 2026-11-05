#!/usr/bin/env node
// chatsysvisio-admin — gestion des administrateurs de ChatSysVisio (aucun mot de passe par défaut).
//   sudo chatsysvisio-admin create-admin [--user admin]   crée (ou remplace) un administrateur : mot de passe + TOTP + codes de secours
//   sudo chatsysvisio-admin reset-password --user admin   nouveau mot de passe (TOTP inchangé)
//   sudo chatsysvisio-admin reset-totp --user admin       nouveau secret TOTP et nouveaux codes de secours
//   sudo chatsysvisio-admin unlock --user admin           lève le verrouillage après trop d'échecs
//   sudo chatsysvisio-admin list | delete --user admin
// Options : --data-dir DIR (sinon DATA_DIR de /etc/chatsysvisio/chatsysvisio.env), --password-stdin, --no-verify, --json (tests).
// Les secrets s'affichent uniquement dans ce terminal ; ils ne sont jamais écrits dans un journal.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Admins, checkPassword } from '../server/accounts.mjs';
import { newSecret, newBackupCodes, otpauthUri, verifyTotp, hashBackup } from '../server/totp.mjs';
import { hashPassword } from '../server/security.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
// Options qui prennent une valeur : leur valeur n'est pas la commande (le wrapper passe --data-dir DIR en premier).
const VALUE_OPTS = new Set(['--data-dir', '--user']);
const cmd = argv.find((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1])) || 'help';
const opt = k => { const i = argv.indexOf('--' + k); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined; };
const die = m => { console.error('ERREUR : ' + m); process.exit(1); };

function dataDir() {
  if (opt('data-dir')) return path.resolve(String(opt('data-dir')));
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  try { const m = fs.readFileSync('/etc/chatsysvisio/chatsysvisio.env', 'utf8').match(/^\s*DATA_DIR=['"]?([^'"\n]+)/m); if (m) return m[1]; } catch {}
  return fs.existsSync('/var/lib/chatsysvisio') ? '/var/lib/chatsysvisio' : path.join(ROOT, 'data');
}
const DIR = dataDir();
if (!fs.existsSync(DIR)) die(`dossier de données introuvable : ${DIR}`);
// Lancé en root : les fichiers doivent rester au propriétaire du dossier (le service chatsysvisio, non root).
function fixOwner() {
  if (process.getuid?.() !== 0) return;
  const st = fs.statSync(DIR), f = path.join(DIR, 'admin.json');
  try { fs.chownSync(f, st.uid, st.gid); fs.chmodSync(f, 0o600); } catch {}
}

let stdinLines = null;
async function stdinLine() {
  if (!stdinLines) { const chunks = []; for await (const c of process.stdin) chunks.push(c); stdinLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/); }
  return stdinLines.shift() ?? '';
}
function prompt(q, { hidden = false } = {}) {
  if (!process.stdin.isTTY) return stdinLine();
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = s => { if (s.includes(q)) process.stdout.write(q); else if (s === '\r\n' || s === '\n') process.stdout.write(s); };
    rl.question(q, a => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); });
  });
}
async function askPassword() {
  if (opt('password-stdin')) { const pw = await stdinLine(); const e = checkPassword(pw, 12); if (e) die(e); return pw; }
  if (!process.stdin.isTTY) die('terminal requis (ou --password-stdin).');
  for (;;) {
    const a = await prompt('Mot de passe (12 caractères minimum, invisible) : ', { hidden: true });
    const e = checkPassword(a, 12); if (e) { console.log('  ' + e); continue; }
    const b = await prompt('Confirmation : ', { hidden: true });
    if (a !== b) { console.log('  Les deux saisies diffèrent.'); continue; }
    return a;
  }
}
async function qrTerminal(text) {
  const { default: qrcode } = await import('../public/vendor/qrcode.mjs');
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const n = q.getModuleCount(), on = (r, c) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) { // deux lignes de modules par ligne de texte (blocs ▀ ▄ █), fond blanc
    let l = ''; for (let c = -2; c < n + 2; c++) { const t = on(r, c), b = on(r + 1, c); l += t && b ? ' ' : t ? '▄' : b ? '▀' : '█'; }
    lines.push(l);
  }
  return lines.join('\n');
}
async function enrol(user) {
  const secret = newSecret(), codes = newBackupCodes(10), uri = otpauthUri({ secret, account: user });
  if (opt('json')) return { secret, codes, uri };
  console.log('\nScanne ce QR code avec ton application d\'authentification (Aegis, FreeOTP, Google Authenticator, 1Password…) :\n');
  console.log(await qrTerminal(uri));
  console.log(`\nOu saisis la clé à la main : ${secret.match(/.{1,4}/g).join(' ')}  (TOTP, SHA-1, 6 chiffres, 30 s)`);
  console.log('\nCodes de secours (un seul usage chacun) — à noter et ranger hors ligne :');
  console.log('  ' + codes.slice(0, 5).join('   ') + '\n  ' + codes.slice(5).join('   '));
  return { secret, codes, uri };
}
async function confirmTotp(secret) {
  if (opt('no-verify')) return;
  if (!process.stdin.isTTY && !opt('password-stdin')) return;
  for (let i = 0; i < 3; i++) {
    const c = await prompt('\nPour vérifier, saisis le code à 6 chiffres affiché par l\'application : ');
    if (verifyTotp(secret, c) >= 0) { console.log('  Code correct.'); return; }
    console.log('  Code incorrect (vérifie l\'heure du téléphone).');
  }
  die('vérification TOTP échouée : rien n\'a été enregistré.');
}

const admins = new Admins(DIR);
const user = String(opt('user') || 'admin').toLowerCase();
switch (cmd) {
  case 'create-admin': {
    if (!/^[a-z0-9._-]{3,32}$/.test(user)) die('identifiant : 3 à 32 caractères a-z 0-9 . _ -');
    if (admins.get(user) && !opt('force')) {
      if (!process.stdin.isTTY) die(`l'administrateur « ${user} » existe déjà (--force pour le remplacer).`);
      const a = await prompt(`L'administrateur « ${user} » existe déjà. Le remplacer ? (o/N) `); if (!/^[oy]/i.test(a)) process.exit(0);
    }
    if (!opt('json')) console.log(`Création de l'administrateur « ${user} » (données : ${DIR})`);
    const password = await askPassword();
    const e = await enrol(user);
    await confirmTotp(e.secret);
    admins.upsert({ user, password, totpSecret: e.secret, backupCodes: e.codes }); fixOwner();
    if (opt('json')) console.log(JSON.stringify({ ok: true, user, secret: e.secret, codes: e.codes }));
    else console.log(`\nAdministrateur « ${user} » enregistré. Page : https://<serveur>${process.env.ADMIN_PATH || '/admin'}/ depuis le réseau local (ou tunnel SSH).`);
    break;
  }
  case 'reset-password': {
    const rec = admins.get(user); if (!rec) die(`administrateur « ${user} » introuvable.`);
    const pw = await askPassword(); rec.hash = hashPassword(pw); rec.fails = 0; rec.lockUntil = 0; admins.update(rec); fixOwner();
    console.log(`Mot de passe de « ${user} » changé.`); break;
  }
  case 'reset-totp': {
    const rec = admins.get(user); if (!rec) die(`administrateur « ${user} » introuvable.`);
    const e = await enrol(user); await confirmTotp(e.secret);
    rec.totp = e.secret; rec.backup = e.codes.map(hashBackup); rec.lastStep = -1; admins.update(rec); fixOwner();
    if (opt('json')) console.log(JSON.stringify({ ok: true, secret: e.secret, codes: e.codes })); else console.log(`\nTOTP de « ${user} » renouvelé.`);
    break;
  }
  case 'unlock': { const rec = admins.get(user); if (!rec) die(`administrateur « ${user} » introuvable.`); rec.fails = 0; rec.lockUntil = 0; admins.update(rec); fixOwner(); console.log('Déverrouillé (le verrouillage par IP expire seul en 15 min ou au redémarrage du service).'); break; }
  case 'list': {
    const l = (admins.reload(), admins.admins);
    if (!l.length) console.log('Aucun administrateur. Créer : sudo chatsysvisio-admin create-admin');
    for (const a of l) console.log(`${a.user}  créé ${new Date(a.created).toLocaleString('fr-FR')}  codes de secours restants : ${a.backup?.length ?? 0}${a.lockUntil > Date.now() ? '  VERROUILLÉ' : ''}`);
    break;
  }
  case 'delete': { if (!admins.remove(user)) die(`administrateur « ${user} » introuvable.`); fixOwner(); console.log(`Administrateur « ${user} » supprimé.`); break; }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}
