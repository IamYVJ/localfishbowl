// ============================================================================
// config.js — Optional authoritative-server endpoint.
//
// Fishbowl plays peer-to-peer by default (PeerJS / same Wi-Fi). When a server is
// configured here, the home screen ALSO offers "Host online" and joining becomes
// server-first (falling back to P2P for the same code). Leave both strings empty
// to disable server mode entirely — the app then behaves exactly as the pure-P2P
// build (the boot health check is skipped and no server UI ever appears).
//
//   SERVER_URL    — the WebSocket endpoint. The TRAILING SLASH IS REQUIRED:
//                   Caddy proxies `/fishbowl/*` to the container, and the upgrade
//                   request must land on `/fishbowl/` (→ `/` inside the server).
//   SERVER_HEALTH — the plain-HTTP liveness probe used at boot to decide whether
//                   to reveal the online options (short timeout, best-effort).
// ============================================================================

export const SERVER_URL    = 'wss://pi.tail360216.ts.net/fishbowl/';
export const SERVER_HEALTH = 'https://pi.tail360216.ts.net/fishbowl/health';
