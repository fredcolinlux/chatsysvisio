import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
const PORT = process.env.E2E_PORT || 8795;
// E2E_BASE=https://localhost:8443 : tests à travers un proxy TLS type NPM (port unique, WebSocket compris)
const BASE = process.env.E2E_BASE || `http://localhost:${PORT}`;
const chrome = process.env.CHROME_PATH || (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
const fake = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, ignoreHTTPSErrors: !!process.env.E2E_BASE, viewport: { width: 1440, height: 900 }, locale: 'fr-FR' },
  webServer: {
    command: `rm -rf /tmp/cc-e2e && PORT=${PORT} HOST=127.0.0.1 DATA_DIR=/tmp/cc-e2e MAX_PARTICIPANTS=25 CREATE_PER_10MIN=200 PUBLIC_URL=${process.env.E2E_BASE || ''} node server/index.mjs`,
    url: `http://localhost:${PORT}/healthz`, reuseExistingServer: false, timeout: 20_000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: { executablePath: chrome, args: fake } }, testIgnore: /navigateurs/ },
    { name: 'webkit', use: { browserName: 'webkit' }, testMatch: /navigateurs/ },
    // Microsoft Edge (Chromium) si installé : mêmes tests de son audible
    ...(fs.existsSync('/opt/microsoft/msedge/msedge') ? [{ name: 'msedge', use: { browserName: 'chromium', channel: 'msedge', launchOptions: { args: fake } }, testMatch: /audio/ }] : []),
    { name: 'firefox', use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0 } } }, testMatch: /navigateurs/ },
  ],
});
