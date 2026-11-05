#!/usr/bin/env node
// Point d'entrée : node server/index.mjs (variables : voir server/config.mjs)
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createApp } from './app.mjs';

const cfg = loadConfig();
try { cfg.version ||= fs.readFileSync(path.join(cfg.root, 'VERSION'), 'utf8').trim(); } catch {}
try { cfg.build ||= fs.readFileSync(path.join(cfg.root, 'BUILD'), 'utf8').trim(); } catch {}
const { server } = createApp(cfg);
server.listen(cfg.port, cfg.host, () => console.log(`ChatSysVisio ${cfg.version || ''}${cfg.build ? ' (build ' + cfg.build + ')' : ''} à l'écoute sur http://${cfg.host}:${cfg.port} (données : ${cfg.dataDir})`));
const stop = () => { console.log('Arrêt…'); server.close(); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
