// ============================================================================
// session.js — Per-connection message dispatch.
//
// Maps incoming wire messages to engine calls, mirroring main.js handleIntent()
// for player intents and ADDING owner-control intents that the P2P design never
// needed (in P2P the host called the engine directly; here the owner client must
// send those over the wire, and the server gates them on ownership).
//
// Connection identity is stashed on the ws object:
//   ws._id        playerId assigned by the server (engine seat key)
//   ws._clientId  stable per-device id sent by the client (reconnect/owner match)
//   ws._code      room code this socket is attached to
//   ws._spectator true for watch-only connections (never a seat / private slice)
//
// ---------------------------------------------------------------------------
// WIRE PROTOCOL (server mode)
// ---------------------------------------------------------------------------
// client -> server:
//   createRoom { name, clientId, asSpectator? }      owner creates a room
//   join       { code, name, clientId }              seat / reclaim a seat
//   spectate   { code, name?, clientId? }            watch only (TV mode)
//   lobbyQuery { code }                              fetch lobby info pre-join
//
//   -- owner controls (server gates on ownership) --
//   setConfig      { patch }     setPlayerTeam { playerId, team }   autoBalance {}
//   startSubmission{}            beginPlay {}        skipClueGiver {}
//   nextRound {}                 finishGame {}       suddenDeath {}    playAgain {}
//
//   -- player intents (identical semantics to main.js handleIntent) --
//   submitWords { words } | editWords {} | startTurn {} | gotIt {} | skip {} |
//   continueTurn {} | reviewGuess { wordId, included }
//
// server -> client:
//   welcome   { playerId, code, owner?, spectator? }
//   state     { pub, priv }
//   lobbyInfo { info|null }
//   rejected  { message }   (fatal for this attempt — bad code/name/full)
//   error     { message }   (non-fatal — illegal move)
// ============================================================================

import { randomUUID } from 'node:crypto';

import { sync, clearRoomTimers, send } from './rooms.js';

function safeParse(raw) {
  try { const m = JSON.parse(raw); return (m && typeof m === 'object') ? m : null; }
  catch (_) { return null; }
}

// Normalise codes EXACTLY as the client does (js/util.js normalizeCode): upper,
// strip whitespace, drop look-alikes (O/0, I/1), keep the 4-char alphabet form.
function normCode(c) {
  return (c == null ? '' : String(c))
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/O/g, '0').replace(/0/g, '') // map then drop ambiguous zero
    .replace(/[I1]/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4);
}

// Clamp a user-supplied display name: strip control chars, trim, cap to 24 chars.
// Defends against oversized names bloating broadcasts and control chars in logs.
// (The engine further caps seated names to 16 — this is the outer guard.)
function cleanName(s) {
  return (s == null ? '' : String(s)).replace(/\p{Cc}/gu, '').trim().slice(0, 24);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export function handleMessage(ctx, ws, raw) {
  const msg = safeParse(raw);
  if (!msg || typeof msg.type !== 'string') return;

  // Pre-room messages (no room attached yet).
  switch (msg.type) {
    case 'createRoom': return onCreateRoom(ctx, ws, msg);
    case 'join':       return onJoin(ctx, ws, msg);
    case 'spectate':   return onSpectate(ctx, ws, msg);
    case 'lobbyQuery': return onLobbyQuery(ctx, ws, msg);
    default: break;
  }

  // Everything else requires an attached room.
  const room = ws._code ? ctx.manager.get(ws._code) : null;
  if (!room) { send(ws, { type: 'error', message: 'Not in a room.' }); return; }
  room.lastActive = Date.now();

  const e = room.engine;
  // Owner = the room creator, matched by stable clientId across reconnects, or by
  // the current connection's seat id. Owner-control messages run only when true.
  // The engine's host-only methods ALSO re-check actorId === hostId (we keep
  // engine.hostId === the owner's seat id), so this is defence in depth.
  const isOwner = !!(ws._clientId && ws._clientId === room.ownerClientId)
               || (room.ownerId != null && ws._id === room.ownerId);

  switch (msg.type) {
    // ---- owner controls -------------------------------------------------
    case 'setConfig':
      // engine.setConfig is a no-op outside the lobby; gate on ownership here.
      if (isOwner) { e.setConfig(msg.patch && typeof msg.patch === 'object' ? msg.patch : {}); sync(room); }
      break;
    case 'setPlayerTeam':
      if (isOwner) { e.setPlayerTeam(msg.playerId, msg.team); sync(room); }
      break;
    case 'autoBalance':
      if (isOwner) { e.autoBalance(); sync(room); }
      break;
    case 'startSubmission':
      if (isOwner) {
        const r = e.startSubmission(ws._id);
        if (!r.ok) send(ws, { type: 'error', message: r.error }); else sync(room);
      }
      break;
    case 'beginPlay':
      if (isOwner) {
        const r = e.beginPlay(ws._id);
        if (!r.ok) send(ws, { type: 'error', message: r.error }); else sync(room);
      }
      break;
    case 'skipClueGiver':
      if (isOwner) { e.skipClueGiver(ws._id); sync(room); }
      break;
    case 'nextRound':
      if (isOwner) { e.nextRound(ws._id); sync(room); }
      break;
    case 'finishGame':
      if (isOwner) { e.finishGame(ws._id); sync(room); }
      break;
    case 'suddenDeath':
      if (isOwner) { e.startSuddenDeath(ws._id); sync(room); }
      break;
    case 'playAgain':
      if (isOwner) { clearRoomTimers(room); e.playAgain(ws._id); sync(room); }
      break;

    // ---- player intents (identical semantics to main.js handleIntent) ----
    case 'submitWords': {
      const r = e.submitWords(ws._id, msg.words);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }
    case 'editWords':
      e.unsubmitWords(ws._id); sync(room); break;
    case 'startTurn': {
      const r = e.startTurn(ws._id);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }
    case 'gotIt': {
      const r = e.gotIt(ws._id);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }
    case 'skip': {
      const r = e.skip(ws._id);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }
    case 'continueTurn':
      e.continueFromSummary(ws._id); sync(room); break;
    case 'reviewGuess': {
      const r = e.reviewGuessedWord(ws._id, msg.wordId, msg.included);
      if (!r.ok) send(ws, { type: 'error', message: r.error });
      sync(room); break;
    }

    default: break;
  }
}

// ---------------------------------------------------------------------------
// Room entry handlers
// ---------------------------------------------------------------------------
function onCreateRoom(ctx, ws, msg) {
  // One room per connection — stops a single socket from spamming the room cap.
  if (ws._code && ctx.manager.get(ws._code)) {
    send(ws, { type: 'rejected', message: 'You already have a room on this connection.' });
    return;
  }
  const name = cleanName(msg.name);
  if (!name) { send(ws, { type: 'rejected', message: 'Enter a name first.' }); return; }
  if (ctx.manager.size >= ctx.maxRooms) {
    send(ws, { type: 'rejected', message: 'Server is at capacity — try again shortly.' });
    return;
  }

  const asSpectator = !!msg.asSpectator;
  const room = ctx.manager.create(name);
  const id = randomUUID();

  ws._id = id;
  ws._clientId = msg.clientId || null;
  ws._code = room.code;
  ws._spectator = asSpectator;

  room.ownerClientId = ws._clientId;
  room.ownerId = id;
  room.conns.set(id, ws);

  if (asSpectator) {
    // Spectating owner: owns the room but takes no seat (never a clue-giver).
    // Keeping engine.hostId === this id lets the owner drive host-only methods.
    room.engine.hostId = id;
  } else {
    room.engine.addPlayer(id, name, { isHost: true, clientId: ws._clientId });
  }

  send(ws, { type: 'welcome', playerId: id, code: room.code, owner: true, spectator: asSpectator });
  sync(room);
}

function onJoin(ctx, ws, msg) {
  const code = normCode(msg.code);
  const room = ctx.manager.get(code);
  if (!room) {
    send(ws, { type: 'rejected', message: 'No game found with that code. Check the code and that the host is still hosting.' });
    return;
  }

  const name = cleanName(msg.name);
  const clientId = msg.clientId || null;
  const e = room.engine;

  // SECURITY (server mode): once the game has started a seat may hold private
  // state (the current word, the recap words), so reclaim is allowed ONLY via
  // the stable clientId (same device/browser). Block a name-only reclaim of an
  // offline seat — otherwise anyone who can see a disconnected player's (public)
  // name could seize their seat and read its private slice. In the lobby there
  // is no private state yet, so name reclaim is fine. (The shared engine stays
  // lenient for trusted P2P play; this guard is the server's stricter policy.)
  if (e.phase !== 'lobby') {
    const byClient = clientId ? e.players.find(p => p.clientId === clientId) : null;
    if (!byClient && e.players.some(p => p.name.toLowerCase() === name.toLowerCase() && !p.online)) {
      send(ws, { type: 'rejected', message: 'That player disconnected mid-game — rejoin from the same device/browser to reclaim the seat.' });
      return;
    }
  }

  // Identify the seat this join will reclaim (if any), so we can retire its old
  // socket after the engine remaps the id (mirrors the host's connection-map
  // race fix: adopt the new socket first, then close the stale one).
  const prior = clientId
    ? e.players.find(p => p.clientId === clientId)
    : e.players.find(p => p.name.toLowerCase() === name.toLowerCase() && !p.online);
  const oldId = prior ? prior.id : null;

  const id = randomUUID();
  const r = e.addPlayer(id, name, { isHost: false, clientId });
  if (!r.ok) { send(ws, { type: 'rejected', message: r.error }); return; }

  ws._id = r.player.id;   // engine reclaim sets player.id === id
  ws._clientId = clientId;
  ws._code = code;
  ws._spectator = false;
  room.conns.set(ws._id, ws);

  if (oldId && oldId !== ws._id) {
    const oldWs = room.conns.get(oldId);
    room.conns.delete(oldId);
    if (oldWs && oldWs !== ws) { try { oldWs.close(); } catch (_) {} }
  }

  // Restore ownership/host across an owner reconnect.
  const owner = !!(clientId && clientId === room.ownerClientId);
  if (owner) { room.ownerId = ws._id; e.hostId = ws._id; }

  send(ws, { type: 'welcome', playerId: ws._id, code, owner });
  sync(room);
}

function onSpectate(ctx, ws, msg) {
  const code = normCode(msg.code);
  const room = ctx.manager.get(code);
  if (!room) { send(ws, { type: 'rejected', message: 'No game found with that code.' }); return; }

  const id = randomUUID();
  ws._id = id;
  ws._clientId = msg.clientId || null;
  ws._code = code;
  ws._spectator = true;
  room.conns.set(id, ws);

  // A spectating owner reconnect keeps ownership but never takes a seat.
  const owner = !!(ws._clientId && ws._clientId === room.ownerClientId);
  if (owner) { room.ownerId = id; room.engine.hostId = id; }

  send(ws, { type: 'welcome', playerId: id, code, spectator: true, owner });
  send(ws, { type: 'state', pub: room.engine.publicState(), priv: null });
  // Refresh everyone else only if ownership/host changed (isHost flags).
  if (owner) sync(room);
}

function onLobbyQuery(ctx, ws, msg) {
  const room = ctx.manager.get(normCode(msg.code));
  if (!room) { send(ws, { type: 'lobbyInfo', info: null }); return; }
  // Reuse the engine's own lobby projection so joinable rules live in one place.
  send(ws, { type: 'lobbyInfo', info: room.engine.lobbyInfo(room.ownerName) });
}

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------
export function handleClose(ctx, ws) {
  if (!ws._code || !ws._id) return;
  const room = ctx.manager.get(ws._code);
  if (!room) return;

  // Only treat this as a real disconnect if THIS socket is still the current one
  // for the seat — a stale handler from a replaced (reconnected) socket must not
  // evict the live one.
  if (room.conns.get(ws._id) !== ws) return;
  room.conns.delete(ws._id);

  if (!ws._spectator) {
    // In the lobby the engine drops the seat entirely; mid-game it just flips the
    // seat offline so the player can reclaim it (by clientId — see onJoin).
    room.engine.markOffline(ws._id);
  }
  sync(room);
}
