// ============================================================================
// origin.js — WS upgrade Origin allowlist (CSRF defence, not authentication).
//
// Kept in its own side-effect-free module (no `ws`, no server bootstrap) so the
// headless test harness can exercise it without importing index.js (which would
// require the `ws` dependency and start a listening server).
//
// Browsers always send an Origin header. A header-less upgrade (raw ws client,
// test harness) is permitted only OUTSIDE production. NOTE: a non-browser client
// can forge Origin, so this bounds CSRF from real browsers — the connection /
// rate / payload limits in index.js are what actually bound abuse.
// ============================================================================

export function originAllowed(origin, {
  isProd = process.env.NODE_ENV === 'production',
  allowed = (process.env.ALLOWED_ORIGINS || 'https://iamyvj.github.io')
    .split(',').map(s => s.trim()).filter(Boolean),
} = {}) {
  if (!origin) return !isProd;
  if (allowed.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname;
    if ((host === 'localhost' || host === '127.0.0.1') && !isProd) return true;
  } catch (_) { /* malformed Origin */ }
  return false;
}
