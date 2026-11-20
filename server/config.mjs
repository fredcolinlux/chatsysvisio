// Configuration (variables d'environnement, voir /etc/chatsysvisio/chatsysvisio.env).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const int = (v, d) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => v === undefined || v === '' ? d : /^(1|true|yes|oui|on)$/i.test(v);

export function loadConfig(over = {}) {
  const c = {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    port: int(env.PORT, 8790),
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    trustedProxies: (env.TRUSTED_PROXIES ?? '127.0.0.1,::1').split(',').map(s => s.trim()).filter(Boolean),
    // Si défini : seules ces adresses (le proxy NPM) + la machine locale peuvent ouvrir une connexion TCP.
    allowFrom: (env.ALLOW_FROM || '').split(',').map(s => s.trim()).filter(Boolean),
    maxParticipants: Math.min(25, Math.max(2, int(env.MAX_PARTICIPANTS, 25))),
    roomTtlDays: int(env.ROOM_TTL_DAYS, 30),
    // 1.12 : salon PUBLIC supprimé après N minutes sans personne (0 = jamais ; décimales acceptées, ex. 0.1 = 6 s)
    publicRoomIdleTtlMin: (v => Number.isFinite(v) && v >= 0 ? Math.min(v, 525600) : 10)(parseFloat(env.PUBLIC_ROOM_IDLE_TTL_MIN ?? '')),
    uploadMaxMb: int(env.UPLOAD_MAX_MB, 10),
    roomQuotaMb: Math.max(1, int(env.ROOM_QUOTA_MB, 200)),     // espace disque max des fichiers d'un salon
    maxRooms: Math.max(10, int(env.MAX_ROOMS, 5000)),          // nombre max de salons sur le serveur
    createPer10Min: Math.max(1, int(env.CREATE_PER_10MIN, 10)), // salons créés par IP et par 10 min
    allowAnonCreate: bool(env.ALLOW_ANON_CREATE, true),
    createPasswordHash: env.CREATE_PASSWORD_HASH || '',
    videoHiKbps: int(env.VIDEO_HI_KBPS, 450),
    videoLoKbps: int(env.VIDEO_LO_KBPS, 70),
    screenKbps: int(env.SCREEN_KBPS, 900),
    video720Kbps: int(env.VIDEO_720_KBPS, 1200),               // couche HD en 720p
    video1080Kbps: int(env.VIDEO_1080_KBPS, 2500),             // couche HD en 1080p (salon chargé, plancher)
    // 1.10 : débit HD des petits salons (≤ 3 personnes), dégressif jusqu'à VIDEO_*_KBPS au-delà de 6 personnes
    video720MaxKbps: int(env.VIDEO_720_MAX_KBPS, 2000),
    video1080MaxKbps: int(env.VIDEO_1080_MAX_KBPS, 4000),
    screenHdKbps: int(env.SCREEN_HD_KBPS, 1500),               // partage d'écran 1080p
    // hauteur max autorisée sur le serveur : 1080 (défaut), 720 ou 360 (pour un lien montant faible)
    videoMaxHeight: [360, 720, 1080].includes(int(env.VIDEO_MAX_HEIGHT, 1080)) ? int(env.VIDEO_MAX_HEIGHT, 1080) : 1080,
    mediaMaxKbps: Math.max(2000, int(env.MEDIA_MAX_KBPS, 20000)), // débit média max par participant (anti-abus)
    audioTopN: int(env.AUDIO_TOP_N, 4),
    forceHsts: bool(env.FORCE_HSTS, false),
    securityContact: env.SECURITY_CONTACT || '', // ex. mailto:moi@example.org → publie /.well-known/security.txt
    ollaUrl: (env.OLLA_URL || '').replace(/\/+$/, ''),
    ollaModel: env.OLLA_MODEL || 'qwen3:14b',
    aiEnabled: bool(env.AI_ENABLED, false),
    version: env.APP_VERSION || '',
    build: env.APP_BUILD || '',
    // Préfixe des étiquettes de dérivation E2EE (vide = 'chatsysvisio/e2ee/v1/'). Une installation migrée d'un ancien nom
    // garde l'ancien préfixe : les salons chiffrés existants (mot de passe, contrôle de clé, historique) restent lisibles.
    e2eeLabel: /^[a-z0-9][a-z0-9._\/-]{0,62}\/$/.test(env.E2EE_LABEL || '') ? env.E2EE_LABEL : '',
    // --- Administration (1.2) : page réservée au réseau local, compte créé par « chatsysvisio-admin create-admin » ---
    adminPath: env.ADMIN_PATH || '/admin',
    // réseaux autorisés (adresse réelle du client ; X-Forwarded-For n'est cru que venant de TRUSTED_PROXIES)
    adminAllowCidr: (env.ADMIN_ALLOW_CIDR || '127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10').split(',').map(s => s.trim()).filter(Boolean),
    adminAllowHttp: bool(env.ADMIN_ALLOW_HTTP, false), // HTTP en clair hors boucle locale (déconseillé)
    adminEnabled: bool(env.ADMIN_ENABLED, true),
    // --- Comptes (facultatifs) ; modifiables à chaud depuis l'administration ---
    signupMode: ['closed', 'open', 'invite', 'approval'].includes(env.SIGNUP_MODE) ? env.SIGNUP_MODE : 'closed',
    accountsOnlyCreate: bool(env.ACCOUNTS_ONLY_CREATE, false),
    guestJoin: bool(env.GUEST_JOIN, true),                                // numéro de build (fichier BUILD, incrémenté par scripts/package.sh)
    ...over,
  };
  c.aiEnabled = c.aiEnabled && !!c.ollaUrl;
  return c;
}
