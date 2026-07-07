// ============================================================================
// net.js — WebRTC peer-to-peer networking (PeerJS), host-authoritative star.
//
// Architecture: HOST-AUTHORITATIVE STAR.
//   - The host creates a Peer whose ID is derived from the room code, so a
//     joiner can reconstruct the host's Peer ID from the code alone — no
//     discovery service required.
//   - Every joiner opens a single DataConnection to the host. Joiners never
//     talk to each other. The host validates intents and broadcasts state.
//
// ----------------------------------------------------------------------------
// SIGNALING / OFFLINE NOTE (read this):
//   PeerJS needs a "broker" (signaling server) ONCE to perform the WebRTC
//   handshake. After the connection is established, game traffic is direct
//   peer-to-peer over the LAN. The default broker below is PeerJS's free
//   public cloud, which requires the internet to be reachable for that initial
//   handshake — even though the cached PWA shell loads offline.
//
//   FOR FULLY-OFFLINE LAN PLAY: run your own PeerServer on the LAN, e.g.
//       npx peer --port 9000 --key peerjs --path /myapp
//   then point BROKER_CONFIG at it:
//       export const BROKER_CONFIG = {
//         host: '192.168.1.50', port: 9000, path: '/myapp', key: 'peerjs',
//         secure: false,
//       };
//   Every device must use the SAME broker config to find each other.
// ============================================================================

// Set to null to use PeerJS's default public cloud broker. Replace with an
// object (see note above) to self-host signaling for offline LAN play.
export const BROKER_CONFIG = null;

// Peer IDs are namespaced so room codes don't collide with other PeerJS apps
// sharing the public broker.
export const PEER_PREFIX = 'localfishbowl-v1-';

export function peerIdForCode(code) {
  return PEER_PREFIX + code.toUpperCase();
}

export function codeFromPeerId(id) {
  return id.startsWith(PEER_PREFIX) ? id.slice(PEER_PREFIX.length) : null;
}

function newPeer(id) {
  // window.Peer comes from the PeerJS CDN <script> tag in index.html.
  const opts = BROKER_CONFIG ? { ...BROKER_CONFIG } : {};
  return id ? new window.Peer(id, opts) : new window.Peer(opts);
}

// ---------------------------------------------------------------------------
// HOST side
// ---------------------------------------------------------------------------
export function createHost(code, handlers = {}) {
  const peer = newPeer(peerIdForCode(code));
  const connections = new Map(); // connId -> DataConnection

  peer.on('open', () => handlers.onOpen && handlers.onOpen(code));

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      connections.set(conn.peer, conn);
      handlers.onConnect && handlers.onConnect(conn.peer, conn);
    });
    conn.on('data', (raw) => {
      const msg = safeParse(raw);
      if (msg) handlers.onData && handlers.onData(conn.peer, msg);
    });
    const drop = () => {
      if (connections.has(conn.peer)) {
        connections.delete(conn.peer);
        handlers.onDisconnect && handlers.onDisconnect(conn.peer);
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  });

  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    connections,
    sendTo(connId, msg) {
      const conn = connections.get(connId);
      if (conn && conn.open) trySend(conn, msg);
    },
    broadcast(msg) {
      for (const conn of connections.values()) {
        if (conn.open) trySend(conn, msg);
      }
    },
    // Forget and close a connection without firing onDisconnect (we remove it
    // from the map first, so the conn's own close handler short-circuits). Used
    // when a reconnecting player takes over a seat held by a stale connection.
    dropConnection(connId) {
      const conn = connections.get(connId);
      connections.delete(connId);
      if (conn) { try { conn.close(); } catch (_) {} }
    },
    destroy() { try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// CLIENT side
// ---------------------------------------------------------------------------
export function joinHost(code, handlers = {}) {
  const peer = newPeer(null);
  let conn = null;

  peer.on('open', () => {
    conn = peer.connect(peerIdForCode(code), { reliable: true });

    conn.on('open', () => handlers.onOpen && handlers.onOpen(conn));
    conn.on('data', (raw) => {
      const msg = safeParse(raw);
      if (msg) handlers.onData && handlers.onData(msg);
    });
    conn.on('close', () => handlers.onClose && handlers.onClose());
    conn.on('error', (err) => handlers.onError && handlers.onError(err));
  });

  // A peer-level error firing before the connection opens almost always means
  // the room code is wrong or the broker is unreachable.
  peer.on('error', (err) => handlers.onError && handlers.onError(err));

  return {
    peer,
    send(msg) { if (conn && conn.open) trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },
    destroy() { try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// SERVER side (optional authoritative server) — a thin native-WebSocket
// transport with the SAME handle shape as joinHost():
//     { send(msg), isOpen(), destroy() }
// and the same client-side callbacks { onOpen(), onData(msg), onClose(), onError(err) }.
//
// In server mode the SERVER runs the engine and IS the host; this client only
// ships intents over the wire and renders the state it is sent. Used only when
// js/config.js sets SERVER_URL (otherwise the app is byte-for-byte pure P2P).
//
// NOTE: onError receives a DOM Event here (not a PeerJS error object), so the
// caller must NOT route it through describePeerError — use a generic message.
// ---------------------------------------------------------------------------
export function serverTransport(url, handlers = {}) {
  let ws;
  // Once destroy() runs, suppress every further callback. The socket's close
  // event fires ASYNCHRONOUSLY, so without this a transport we tore down (e.g.
  // when falling back to P2P after the server rejects a join) would still fire
  // onClose and clobber the new transport's screen.
  let dead = false;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    // The WebSocket constructor throws synchronously on a malformed URL — surface
    // it asynchronously so callers always observe it via the onError callback.
    setTimeout(() => { if (!dead) handlers.onError && handlers.onError(err); }, 0);
    return { send() {}, isOpen() { return false; }, destroy() { dead = true; } };
  }

  ws.onopen    = () => { if (!dead) handlers.onOpen && handlers.onOpen(); };
  ws.onmessage = (ev) => {
    if (dead) return;
    const msg = safeParse(ev.data);
    if (msg) handlers.onData && handlers.onData(msg);
  };
  ws.onclose   = () => { if (!dead) handlers.onClose && handlers.onClose(); };
  ws.onerror   = (err) => { if (!dead) handlers.onError && handlers.onError(err); };

  return {
    send(msg) {
      if (!dead && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify(msg)); } catch (_) { /* connection torn down */ }
      }
    },
    isOpen() { return !dead && ws.readyState === WebSocket.OPEN; },
    destroy() { dead = true; try { ws.close(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// DISCOVERY side — find games on the broker without typing a code.
//
//   IMPORTANT: peer.listAllPeers() only returns data when the signaling broker
//   is configured with `allow_discovery: true`. PeerJS's PUBLIC cloud broker
//   has this DISABLED, so list() will report `null` (unsupported) there. Run a
//   self-hosted PeerServer on the LAN (see BROKER_CONFIG note) to enable it.
//
//   list(cb)        -> cb(codes|null)  codes = array of room codes, null = the
//                      broker doesn't support discovery (fall back to a code).
//   probe(code, cb) -> cb(info|null)   briefly connects to a host to fetch its
//                      lobby info { hostName, playerCount, phase, joinable }.
// ---------------------------------------------------------------------------
export function createDiscovery() {
  const peer = newPeer(null);
  let ready = false;
  let dead = false;
  const queue = [];

  peer.on('open', () => {
    ready = true;
    while (queue.length) queue.shift()();
  });
  peer.on('error', () => { /* swallow; surfaces as a list/probe timeout */ });

  const whenReady = (fn) => { if (dead) return; if (ready) fn(); else queue.push(fn); };

  return {
    peer,
    list(cb) {
      whenReady(() => {
        let done = false;
        const finish = (codes) => { if (!done) { done = true; cb(codes); } };
        // No callback within the window ⇒ broker has discovery disabled.
        const timer = setTimeout(() => finish(null), 3500);
        try {
          peer.listAllPeers((all) => {
            clearTimeout(timer);
            const codes = (all || []).map(codeFromPeerId).filter(Boolean);
            finish(codes);
          });
        } catch (_) {
          clearTimeout(timer);
          finish(null);
        }
      });
    },
    probe(code, cb) {
      whenReady(() => {
        let done = false;
        let conn = null;
        const finish = (info) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { if (conn) conn.close(); } catch (_) {}
          cb(info);
        };
        const timer = setTimeout(() => finish(null), 4000);
        try {
          conn = peer.connect(peerIdForCode(code), { reliable: true });
          conn.on('open', () => trySend(conn, { type: 'lobbyQuery' }));
          conn.on('data', (raw) => {
            const msg = safeParse(raw);
            if (msg && msg.type === 'lobbyInfo') finish(msg.info);
          });
          conn.on('error', () => finish(null));
          conn.on('close', () => finish(null));
        } catch (_) {
          finish(null);
        }
      });
    },
    destroy() { dead = true; try { peer.destroy(); } catch (_) {} },
  };
}

// ---------------------------------------------------------------------------
// Wire helpers — JSON over the DataConnection. Guard against malformed input.
// ---------------------------------------------------------------------------
function trySend(conn, msg) {
  try { conn.send(JSON.stringify(msg)); } catch (_) { /* connection torn down */ }
}

function safeParse(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// Human-readable mapping for the common PeerJS error types, surfaced in the UI.
// ---------------------------------------------------------------------------
export function describePeerError(err) {
  const type = err && err.type;
  switch (type) {
    case 'peer-unavailable':
      return 'No game found with that code. Check the code and that the host is still hosting.';
    case 'unavailable-id':
      return 'That room code is already in use. Try hosting again for a new code.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return "Couldn't reach the connection server — check your internet / Wi-Fi.";
    case 'browser-incompatible':
      return 'This browser does not support the WebRTC features required.';
    default:
      return 'Connection problem: ' + (err && err.message ? err.message : 'unknown error') + '.';
  }
}
