#!/usr/bin/env node
// Calcule l'empreinte scrypt d'un code de création de salon (CREATE_PASSWORD_HASH). Le code est lu sur l'entrée standard,
// jamais passé en argument (il apparaîtrait dans l'historique et la liste des processus).
//   printf '%s' 'mon code' | node scripts/hash-password.mjs
import { hashPassword } from '../server/security.mjs';
let s = ''; process.stdin.setEncoding('utf8');
for await (const c of process.stdin) s += c;
s = s.replace(/\r?\n$/, '');
if (s.length < 6) { console.error('Code trop court (6 caractères minimum).'); process.exit(1); }
process.stdout.write(hashPassword(s) + '\n');
