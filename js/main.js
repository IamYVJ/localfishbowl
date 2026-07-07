// ============================================================================
// main.js — App controller. Wires the network layer, the host's authoritative
// engine, user intents, and the view together.
//
//   HOST  : owns a GameEngine, applies every intent through it, then
//           broadcasts tailored public+private state to each connection.
//   CLIENT: holds the last public+private snapshot received from the host and
//           sends intents over the wire.
// ============================================================================

import { GameEngine } from './state.js';
import { createHost, joinHost, createDiscovery, serverTransport, describePeerError, peerIdForCode } from './net.js';
import { render, updateTimerNodes } from './ui.js';
import {
  generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode, loadClientId,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';
import { SERVER_URL, SERVER_HEALTH } from './config.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',                 // home | join | connecting | game | error | hostleft
  // me.isHost doubles as "I am the controller": the P2P host OR the server room
  // owner. me.clientId is the stable seat/owner-reclaim token (server mode only).
  me: { id: null, name: loadName(), isHost: false, isSpectator: false, clientId: loadClientId() },
  code: loadCode(),
  pub: null,
  priv: null,
  error: '',
  copied: false,
  showRules: false,

  // Transport. 'p2p' = PeerJS/LAN (the original build); 'server' = authoritative
  // WebSocket server. serverUp is set by the boot health check ONLY when a server
  // is configured AND reachable — it gates every piece of server-mode UI, so with
  // no server (or an unreachable one) the app stays byte-for-byte pure P2P.
  mode: 'p2p',
  serverUp: false,

  // Local-network game discovery (Join screen).
  discovered: [],
  discoveryState: 'idle',         // idle | searching | ok | unsupported

  // Word-submission drafts (client-side, uncontrolled inputs).
  wordDrafts: null,

  // Turn countdown — driven locally, re-synced on every state message.
  clockMs: null,
  localDeadline: null,            // performance.now()-based deadline
};

// Host-only runtime.
let engine = null;
let net = null;            // host or client handle
let turnTimer = null;      // host-side authoritative turn-end timeout

// Client-only: background peer used to discover games on the Join screen.
let discovery = null;
let discoveryTimer = null;

// A single low-frequency loop drives the visible turn countdown. It mutates ONLY
// the timer nodes in place — calling the full draw() here would tear down and
// rebuild the entire DOM 4×/second, which flickers and resets the timer's CSS
// animation on every tick. Phase/state changes still trigger a full re-render
// via the host's state messages.
setInterval(() => {
  if (app.screen !== 'game' || !app.pub || app.pub.phase !== 'turnActive') return;
  if (app.localDeadline == null) return;
  app.clockMs = Math.max(0, app.localDeadline - performance.now());
  const totalMs = (app.pub.timerSeconds || 60) * 1000;
  updateTimerNodes(root, app.clockMs, totalMs);
}, 250);

// ---------------------------------------------------------------------------
// Render wrapper — keeps a little local UI bookkeeping in sync first.
// ---------------------------------------------------------------------------
function draw() {
  // Initialise / tear down submission drafts as we enter/leave that phase.
  if (app.pub && app.pub.phase === 'submission') {
    if (app.wordDrafts === null) {
      const need = (app.priv && app.priv.wordsNeeded) || app.pub.config.wordsPerPlayer;
      const existing = (app.priv && app.priv.words) || [];
      app.wordDrafts = Array.from({ length: need }, (_, i) => existing[i] || '');
    }
  } else {
    app.wordDrafts = null;
  }

  // Preserve focus + caret across full re-renders (a peer's state broadcast
  // can redraw the page while someone is typing their words).
  const active = document.activeElement;
  const focusKey = active && active.getAttribute ? active.getAttribute('data-focus') : null;
  let selStart = null, selEnd = null;
  if (focusKey) { try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {} }

  render(root, app, intents);

  if (focusKey) {
    const next = root.querySelector(`[data-focus="${focusKey}"]`);
    if (next) {
      next.focus();
      if (selStart != null) { try { next.setSelectionRange(selStart, selEnd); } catch (_) {} }
    }
  }
}

// ---------------------------------------------------------------------------
// Clock — convert the host's remaining-ms into a local deadline so the display
// counts down smoothly between state messages.
// ---------------------------------------------------------------------------
function syncClock(pub) {
  if (pub && pub.phase === 'turnActive' && pub.turnRemainingMs != null) {
    app.clockMs = pub.turnRemainingMs;
    app.localDeadline = performance.now() + pub.turnRemainingMs;
  } else {
    app.clockMs = null;
    app.localDeadline = null;
  }
}

// ---------------------------------------------------------------------------
// HOST: push state. Renders the host's own view and sends each client the
// public state plus ONLY that player's private slice.
// ---------------------------------------------------------------------------
function hostSync() {
  app.pub = engine.publicState();
  app.priv = engine.privateStateFor(app.me.id);
  syncClock(app.pub);
  saveEngineSnapshot(engine.serialize());
  draw();

  for (const connId of net.connections.keys()) {
    net.sendTo(connId, {
      type: 'state',
      pub: app.pub,
      priv: engine.privateStateFor(connId),
    });
  }
  scheduleTurnTimer();
}

// The host owns the authoritative turn clock. Schedule a single timeout when a
// turn goes active; clear it whenever we leave the active phase. Mid-turn
// "Got it" syncs don't reschedule (the timer keeps running for the full turn).
function scheduleTurnTimer() {
  if (app.pub && app.pub.phase === 'turnActive') {
    if (!turnTimer) {
      const ms = app.pub.turnRemainingMs != null
        ? app.pub.turnRemainingMs
        : engine.config.timerSeconds * 1000;
      turnTimer = setTimeout(() => {
        turnTimer = null;
        engine.endTurnByTime();
        hostSync();
      }, ms);
    }
  } else if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
}

// ---------------------------------------------------------------------------
// HOST: apply one player's intent through the engine (validation lives there).
// Used both for remote clients and for the host's own button presses.
// ---------------------------------------------------------------------------
function handleIntent(playerId, msg) {
  switch (msg.type) {
    case 'lobbyQuery':
      net.sendTo(playerId, { type: 'lobbyInfo', info: engine.lobbyInfo(app.me.name) });
      break;
    case 'join': {
      const r = engine.addPlayer(playerId, msg.name, { isHost: false });
      if (!r.ok) { net.sendTo(playerId, { type: 'rejected', message: r.error }); return; }
      // A reconnect (or same-name takeover) reclaimed a seat under a new
      // connection id. Drop the old, now-orphaned connection so it can't linger
      // or later fire a disconnect against the seat we just handed back.
      if (r.reconnected && r.prevId && r.prevId !== playerId) {
        net.dropConnection(r.prevId);
      }
      net.sendTo(playerId, { type: 'welcome', playerId });
      hostSync();
      break;
    }
    case 'spectate':
      // Watchers never enter the engine — they only ever receive public state
      // (no private slice), so the current word can never reach them. Future
      // updates flow through hostSync, which iterates every open connection.
      net.sendTo(playerId, { type: 'state', pub: engine.publicState(), priv: null });
      break;
    case 'submitWords': {
      const r = engine.submitWords(playerId, msg.words);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    case 'editWords':    engine.unsubmitWords(playerId); hostSync(); break;
    case 'startTurn': {
      const r = engine.startTurn(playerId);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    case 'gotIt': {
      const r = engine.gotIt(playerId);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    case 'skip': {
      const r = engine.skip(playerId);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    case 'continueTurn': engine.continueFromSummary(playerId); hostSync(); break;
    case 'reviewGuess': {
      const r = engine.reviewGuessedWord(playerId, msg.wordId, msg.included);
      if (!r.ok) net.sendTo(playerId, { type: 'error', message: r.error });
      hostSync();
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------------------
// Start hosting.
// ---------------------------------------------------------------------------
function hostHandlers() {
  return {
    onConnect: (connId) => { net.sendTo(connId, { type: 'lobbyInfo', info: engine.lobbyInfo(app.me.name) }); },
    onData:    (connId, msg) => handleIntent(connId, msg),
    onDisconnect: (connId) => { engine.markOffline(connId); hostSync(); },
    onError: (err) => {
      app.screen = 'error';
      app.error = describePeerError(err);
      draw();
    },
  };
}

function startHosting() {
  const name = (app.me.name || '').trim();
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }

  const code = generateRoomCode();
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.error = '';

  engine = new GameEngine();
  engine.addPlayer(app.me.id, name, { isHost: true });

  saveSession({ mode: 'host', code, name });
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// Rehydrate an in-progress game after a HOST reload, re-using the same code.
function resumeHosting(code, snapshot, name) {
  app.code = code; saveCode(code);
  app.me.id = peerIdForCode(code);
  app.me.isHost = true;
  app.me.name = name || app.me.name;
  app.error = '';

  engine = new GameEngine();
  engine.restore(snapshot);
  engine.hostId = app.me.id;
  const hostPlayer = engine.getPlayer(app.me.id);
  if (hostPlayer) hostPlayer.online = true;

  saveSession({ mode: 'host', code, name: app.me.name });
  net = createHost(code, hostHandlers());

  app.screen = 'game';
  hostSync();
}

// ---------------------------------------------------------------------------
// SERVER MODE — host / join / spectate against the authoritative WebSocket
// server. The server runs the engine and IS the host; this client (even the
// room owner) only ships intents over the wire and renders what it receives.
//
// Server mode is NEVER auto-resumed across reloads in v1 — every server attempt
// calls clearSession(), and resumeSession() only ever restores a P2P session.
// ---------------------------------------------------------------------------

// welcome/state/error handling is identical across the three server flows; the
// callers differ only in failure policy, supplied via opts:
//   onRejected(msg) — server explicitly refused this attempt (bad code/name/full).
//   onFail()        — the connection failed/closed BEFORE we entered a game (can't
//                     reach the server, 403 from a non-allow-listed origin, or a
//                     drop mid-handshake). join/spectate pass onFail to fall back
//                     to P2P; "Host online" omits it and surfaces an error.
// A drop AFTER we're in a game ('game' screen) is always a real disconnect.
function serverHandlers({ onRejected, onFail }) {
  const fail = (defaultMsg) => {
    if (app.screen === 'game') { app.screen = 'hostleft'; draw(); return; }
    if (onFail) { onFail(); return; }
    app.screen = 'error'; app.error = defaultMsg; draw();
  };
  return {
    onData: (msg) => {
      switch (msg.type) {
        case 'welcome':
          app.me.id = msg.playerId;
          if (msg.code) { app.code = msg.code; saveCode(app.code); }
          app.me.isHost = !!msg.owner;          // owner == the controller in server mode
          app.me.isSpectator = !!msg.spectator;
          break;
        case 'state':
          app.pub = msg.pub; app.priv = msg.priv;
          syncClock(app.pub);
          app.screen = 'game';
          draw();
          break;
        case 'rejected':
          onRejected(msg);
          break;
        case 'error':
          app.error = msg.message; draw();
          break;
        default: break;
      }
    },
    onClose: () => fail('The connection to the game server closed.'),
    onError: () => { if (!net || !net.isOpen()) fail("Couldn't reach the game server. Check your connection and try again."); },
  };
}

// Host a game ON THE SERVER (the "Host online" home button). No P2P fallback —
// the user explicitly chose online, so a failure surfaces as an error.
function hostOnServer() {
  const name = (app.me.name || '').trim();
  if (!name) { app.screen = 'home'; app.error = 'Enter a name first.'; draw(); return; }

  stopDiscovery();
  app.me.name = name; saveName(name);
  app.me.isHost = false;          // becomes true on welcome.owner
  app.me.isSpectator = false;
  app.mode = 'server';
  app.error = '';
  app.screen = 'connecting';
  clearSession();                 // server mode is not resumed in v1
  draw();

  net = serverTransport(SERVER_URL, {
    ...serverHandlers({
      onRejected: (msg) => {
        clearSession(); teardownNet();
        app.mode = 'p2p';
        app.screen = 'home'; app.error = msg.message; draw();
      },
    }),
    onOpen: () => net.send({ type: 'createRoom', name, clientId: app.me.clientId }),
  });
}

// ---------------------------------------------------------------------------
// Join an existing game. Server-first when a server is reachable (one code can
// reach a server-hosted OR a P2P-hosted game): we try the server, and if it has
// no such room we fall back to a P2P join for the same code. With no server the
// path is byte-for-byte the original P2P join.
// ---------------------------------------------------------------------------
function startJoining(rawCode, rawName) {
  const name = (rawName || '').trim();
  const code = normalizeCode(rawCode);
  if (!name) { app.error = 'Enter your name.'; app.screen = 'join'; draw(); return; }
  if (code.length !== 4) { app.error = 'Enter the full 4-character code.'; app.screen = 'join'; draw(); return; }

  stopDiscovery();
  app.me.name = name; saveName(name);
  app.code = code; saveCode(code);
  app.me.isHost = false;
  app.me.isSpectator = false;
  app.error = '';
  app.screen = 'connecting';
  draw();

  if (app.serverUp) {
    app.mode = 'server';
    clearSession();
    net = serverTransport(SERVER_URL, {
      ...serverHandlers({
        onRejected: (msg) => {
          // No such room on the server → maybe it's a P2P game with this code.
          if (/no game/i.test(msg.message || '')) { teardownNet(); joinViaP2P(code, name); return; }
          clearSession(); teardownNet();
          app.mode = 'p2p';
          app.screen = 'join'; app.error = msg.message; startDiscovery(); draw();
        },
        // Can't reach the server (offline, 403 origin, drop mid-handshake) →
        // try the same code as a P2P game before giving up.
        onFail: () => { teardownNet(); joinViaP2P(code, name); },
      }),
      onOpen: () => net.send({ type: 'join', code, name, clientId: app.me.clientId }),
    });
    return;
  }

  joinViaP2P(code, name);
}

// The original PeerJS join — unchanged behaviour, extracted so the server path
// can fall back to it. Persists a P2P 'join' session for reload-resume.
function joinViaP2P(code, name) {
  app.mode = 'p2p';
  saveSession({ mode: 'join', code, name });

  net = joinHost(code, {
    onOpen: () => net.send({ type: 'join', name }),
    onData: (msg) => {
      switch (msg.type) {
        case 'welcome':  app.me.id = msg.playerId; break;
        case 'state':
          app.pub = msg.pub; app.priv = msg.priv;
          syncClock(app.pub);
          app.screen = 'game';
          draw();
          break;
        case 'rejected':
          clearSession(); teardownNet();
          app.screen = 'join'; app.error = msg.message; startDiscovery(); draw();
          break;
        case 'error':    app.error = msg.message; draw(); break;
        default: break;
      }
    },
    onClose: () => {
      if (app.screen === 'game') { app.screen = 'hostleft'; }
      else { app.screen = 'error'; app.error = 'The host closed the connection.'; }
      draw();
    },
    onError: (err) => {
      if (!net || !net.isOpen()) {
        app.screen = 'error';
        app.error = describePeerError(err);
        draw();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Spectate an existing game — a read-only TV/big-screen view. A spectator is
// NOT a player: it never enters the engine, sends no intents, and the host (P2P
// or server) only ever sends it public state (priv === null), so the secret
// word can never reach it. Server-first with the same P2P fallback as joining.
// ---------------------------------------------------------------------------
function startSpectating(rawCode) {
  const code = normalizeCode(rawCode);
  if (code.length !== 4) { app.error = 'Enter the full 4-character code.'; app.screen = 'join'; draw(); return; }

  stopDiscovery();
  app.code = code; saveCode(code);
  app.me.isHost = false;
  app.me.isSpectator = true;
  app.me.id = null;
  app.me.name = app.me.name || 'Spectator';
  app.error = '';
  app.screen = 'connecting';
  draw();

  if (app.serverUp) {
    app.mode = 'server';
    clearSession();
    net = serverTransport(SERVER_URL, {
      ...serverHandlers({
        onRejected: (msg) => {
          if (/no game/i.test(msg.message || '')) { teardownNet(); spectateViaP2P(code); return; }
          clearSession(); teardownNet();
          app.mode = 'p2p';
          app.screen = 'join'; app.error = msg.message; startDiscovery(); draw();
        },
        onFail: () => { teardownNet(); spectateViaP2P(code); },
      }),
      onOpen: () => net.send({ type: 'spectate', code, clientId: app.me.clientId }),
    });
    return;
  }

  spectateViaP2P(code);
}

// The original PeerJS spectate — unchanged behaviour, extracted for fallback.
function spectateViaP2P(code) {
  app.mode = 'p2p';
  saveSession({ mode: 'spectate', code });

  net = joinHost(code, {
    onOpen: () => net.send({ type: 'spectate' }),
    onData: (msg) => {
      if (msg.type === 'state') {
        app.pub = msg.pub; app.priv = null;
        syncClock(app.pub);
        app.screen = 'game';
        draw();
      }
    },
    onClose: () => {
      if (app.screen === 'game') { app.screen = 'hostleft'; }
      else { app.screen = 'error'; app.error = 'The host closed the connection.'; }
      draw();
    },
    onError: (err) => {
      if (!net || !net.isOpen()) {
        app.screen = 'error';
        app.error = describePeerError(err);
        draw();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Discovery lifecycle (Join screen).
// ---------------------------------------------------------------------------
function startDiscovery() {
  stopDiscovery();
  app.discovered = [];
  app.discoveryState = 'searching';
  discovery = createDiscovery();

  const tick = () => {
    if (!discovery) return;
    discovery.list((codes) => {
      if (!discovery) return;
      if (codes === null) { app.discoveryState = 'unsupported'; draw(); return; }
      app.discoveryState = 'ok';
      const targets = codes.filter((c) => c && c !== app.code);
      if (targets.length === 0) {
        app.discovered = [];
        draw();
        discoveryTimer = setTimeout(tick, 3500);
        return;
      }
      const found = [];
      let pending = targets.length;
      const settle = () => {
        if (--pending > 0) return;
        app.discovered = found.sort((a, b) => a.code.localeCompare(b.code));
        draw();
        discoveryTimer = setTimeout(tick, 3500);
      };
      targets.forEach((code) => {
        discovery.probe(code, (info) => {
          if (info) found.push({ code, ...info });
          settle();
        });
      });
    });
  };
  tick();
}

function stopDiscovery() {
  if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = null; }
  if (discovery) { try { discovery.destroy(); } catch (_) {} discovery = null; }
  app.discoveryState = 'idle';
  app.discovered = [];
}

function teardownNet() {
  try { if (net) net.destroy(); } catch (_) {}
  net = null;
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
}

// ---------------------------------------------------------------------------
// Intents handed to the view. Player intents route through sendIntent (the
// host applies locally; clients send over the wire). Host-only flow controls
// drive the engine directly.
// ---------------------------------------------------------------------------
function sendIntent(msg) {
  // SERVER mode: everyone (owner included) ships intents over the wire — the
  // server runs the engine. P2P mode: the host applies locally; clients send.
  if (app.mode === 'server') { if (net) net.send(msg); return; }
  if (app.me.isHost) handleIntent(app.me.id, msg);
  else if (net) net.send(msg);
}

// Owner/host flow controls. In P2P the host drives the LOCAL engine directly and
// re-broadcasts via hostSync(). In SERVER mode the owner has no local engine —
// the control is sent over the wire and the server gates it on ownership and
// broadcasts the result. Either way it is a no-op unless this client is the
// room's controller (app.me.isHost). `wireMsg` may be a plain object or a
// function of the same args, producing the server message to send.
function ownerControl(p2pFn, wireMsg) {
  return (...args) => {
    if (!app.me.isHost) return;
    if (app.mode === 'server') {
      if (net) net.send(typeof wireMsg === 'function' ? wireMsg(...args) : wireMsg);
      return;
    }
    if (!engine) return;
    p2pFn(...args);
    hostSync();
  };
}

const intents = {
  setName: (n) => { app.me.name = n; saveName(n); },
  gotoJoin: () => { app.screen = 'join'; app.error = ''; startDiscovery(); draw(); },
  goHome: () => {
    teardownNet();
    stopDiscovery();
    clearSession();
    engine = null;
    app.screen = 'home';
    app.pub = null; app.priv = null; app.error = '';
    app.me.isHost = false; app.me.isSpectator = false; app.me.id = null;
    app.mode = 'p2p';
    app.wordDrafts = null;
    draw();
  },
  toggleRules: () => { app.showRules = !app.showRules; draw(); },

  host: () => startHosting(),
  hostOnline: () => hostOnServer(),
  join: (code, name) => startJoining(code, name),
  spectate: (code) => startSpectating(code),

  copyCode: async () => {
    if (!app.code) return;
    const ok = await copyText(app.code);
    app.copied = ok;
    draw();
    if (ok) setTimeout(() => { app.copied = false; draw(); }, 1500);
  },

  // --- Host/owner lobby controls (P2P: local engine · server: over the wire) ---
  setConfig: ownerControl((patch) => engine.setConfig(patch),
    (patch) => ({ type: 'setConfig', patch })),
  setPlayerTeam: ownerControl((playerId, team) => engine.setPlayerTeam(playerId, team),
    (playerId, team) => ({ type: 'setPlayerTeam', playerId, team })),
  autoBalance: ownerControl(() => engine.autoBalance(), { type: 'autoBalance' }),
  startSubmission: ownerControl(() => {
    const r = engine.startSubmission(app.me.id);
    if (!r.ok) app.error = r.error;
  }, { type: 'startSubmission' }),
  beginPlay: ownerControl(() => {
    const r = engine.beginPlay(app.me.id);
    if (!r.ok) app.error = r.error;
  }, { type: 'beginPlay' }),

  // --- Host/owner flow controls ---
  skipClueGiver: ownerControl(() => engine.skipClueGiver(app.me.id), { type: 'skipClueGiver' }),
  nextRound: ownerControl(() => engine.nextRound(app.me.id), { type: 'nextRound' }),
  finishGame: ownerControl(() => engine.finishGame(app.me.id), { type: 'finishGame' }),
  suddenDeath: ownerControl(() => engine.startSuddenDeath(app.me.id), { type: 'suddenDeath' }),
  playAgain: ownerControl(() => engine.playAgain(app.me.id), { type: 'playAgain' }),

  // --- Word submission (per player) ---
  setWordDraft: (i, value) => { if (app.wordDrafts) app.wordDrafts[i] = value; },
  submitWords: () => {
    const words = (app.wordDrafts || []).map(w => (w || '').trim());
    sendIntent({ type: 'submitWords', words });
  },
  editWords: () => sendIntent({ type: 'editWords' }),

  // --- Turn (per player) ---
  startTurn: () => sendIntent({ type: 'startTurn' }),
  gotIt: () => sendIntent({ type: 'gotIt' }),
  skip: () => sendIntent({ type: 'skip' }),
  continueTurn: () => sendIntent({ type: 'continueTurn' }),
  reviewGuess: (wordId, included) => sendIntent({ type: 'reviewGuess', wordId, included }),
};

// ---------------------------------------------------------------------------
// Boot — resume the previous session if there is one.
// ---------------------------------------------------------------------------
function resumeSession() {
  const s = loadSession();
  if (!s || !s.code) return false;

  if (s.mode === 'host') {
    const snapshot = loadEngineSnapshot();
    if (!snapshot) return false;
    resumeHosting(s.code, snapshot, s.name);
    return true;
  }
  if (s.mode === 'join' && s.name) {
    startJoining(s.code, s.name);
    return true;
  }
  if (s.mode === 'spectate') {
    startSpectating(s.code);
    return true;
  }
  return false;
}

// Best-effort liveness probe for the optional authoritative server. Runs only
// when a server is configured (config.js). On success it flips app.serverUp,
// which is the SINGLE gate for every piece of server-mode UI — so a missing or
// unreachable server leaves the app byte-for-byte pure P2P. Short timeout; never
// blocks boot. resumeSession() runs FIRST (below) so it sees serverUp === false
// and only ever restores a P2P session.
function checkServerHealth() {
  if (!SERVER_URL || !SERVER_HEALTH) return;   // server mode disabled
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  fetch(SERVER_HEALTH, { signal: ctrl.signal, cache: 'no-store' })
    .then((res) => { if (!res.ok) throw new Error('health'); return res.json(); })
    .then(() => {
      app.serverUp = true;
      if (app.screen === 'home') draw();        // reveal the "Host online" option
    })
    .catch(() => { /* unreachable — stay in the pure-P2P UI */ })
    .finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Boot — resume the previous (always P2P) session if there is one, THEN probe
// the server. The synchronous resume sees serverUp === false, guaranteeing it
// never takes a server path.
// ---------------------------------------------------------------------------
if (!resumeSession()) draw();
checkServerHealth();

// Service worker (relative path so it works under a GitHub Pages subpath).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
