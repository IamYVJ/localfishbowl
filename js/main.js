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
import { createHost, joinHost, createDiscovery, describePeerError, peerIdForCode } from './net.js';
import { render } from './ui.js';
import {
  generateRoomCode, normalizeCode, copyText,
  loadName, saveName, loadCode, saveCode,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from './util.js';

const root = document.getElementById('app');

// ---------------------------------------------------------------------------
// App state (everything the view needs to draw).
// ---------------------------------------------------------------------------
const app = {
  screen: 'home',                 // home | join | connecting | game | error | hostleft
  me: { id: null, name: loadName(), isHost: false, isSpectator: false },
  code: loadCode(),
  pub: null,
  priv: null,
  error: '',
  copied: false,
  showRules: false,

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

// A single low-frequency loop drives the visible turn countdown.
setInterval(() => {
  if (app.screen !== 'game' || !app.pub || app.pub.phase !== 'turnActive') return;
  if (app.localDeadline == null) return;
  app.clockMs = Math.max(0, app.localDeadline - performance.now());
  draw();
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
// Join an existing game.
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
  app.error = '';
  app.screen = 'connecting';
  saveSession({ mode: 'join', code, name });
  draw();

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
// NOT a player: it never enters the engine, sends no intents, and the host
// only ever sends it public state (priv === null), so the secret word can
// never reach it.
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
  saveSession({ mode: 'spectate', code });
  draw();

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
  if (app.me.isHost) handleIntent(app.me.id, msg);
  else if (net) net.send(msg);
}

function hostOnly(fn) {
  return (...args) => {
    if (!app.me.isHost || !engine) return;
    fn(...args);
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
    app.wordDrafts = null;
    draw();
  },
  toggleRules: () => { app.showRules = !app.showRules; draw(); },

  host: () => startHosting(),
  join: (code, name) => startJoining(code, name),
  spectate: (code) => startSpectating(code),

  copyCode: async () => {
    if (!app.code) return;
    const ok = await copyText(app.code);
    app.copied = ok;
    draw();
    if (ok) setTimeout(() => { app.copied = false; draw(); }, 1500);
  },

  // --- Host lobby controls ---
  setConfig: hostOnly((patch) => engine.setConfig(patch)),
  setPlayerTeam: hostOnly((playerId, team) => engine.setPlayerTeam(playerId, team)),
  autoBalance: hostOnly(() => engine.autoBalance()),
  startSubmission: hostOnly(() => {
    const r = engine.startSubmission(app.me.id);
    if (!r.ok) app.error = r.error;
  }),
  beginPlay: hostOnly(() => {
    const r = engine.beginPlay(app.me.id);
    if (!r.ok) app.error = r.error;
  }),

  // --- Host flow controls ---
  skipClueGiver: hostOnly(() => engine.skipClueGiver(app.me.id)),
  nextRound: hostOnly(() => engine.nextRound(app.me.id)),
  finishGame: hostOnly(() => engine.finishGame(app.me.id)),
  suddenDeath: hostOnly(() => engine.startSuddenDeath(app.me.id)),
  playAgain: hostOnly(() => engine.playAgain(app.me.id)),

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

if (!resumeSession()) draw();

// Service worker (relative path so it works under a GitHub Pages subpath).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
