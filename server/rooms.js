// ============================================================================
// rooms.js — In-memory room manager + per-room authoritative loop.
//
// Each Room owns ONE GameEngine (the exact same engine the browser host runs,
// imported from ../js/). The server is authoritative: it validates intents
// through the engine, broadcasts tailored public+private state to every socket,
// and runs the turn-end timer that the browser host used to run in main.js
// (scheduleTurnTimer).
//
// Rooms are in-memory: codes are reused once a room is GC'd, and everything
// resets on restart. No persistence by design (matches the P2P game — there is
// no stats or durable state to keep).
// ============================================================================

import { randomInt } from 'node:crypto';

import { GameEngine } from '../js/state.js';

// A room with no open sockets is collected after this idle window.
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 30 * 60 * 1000;

// Same unambiguous alphabet as js/util.js generateRoomCode (no O/0, I/1) so a
// server-assigned code looks and types exactly like a P2P code.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;

const WS_OPEN = 1; // ws readyState for an open socket

function send(ws, msg) {
  try { if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg)); } catch (_) { /* socket gone */ }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
export class Room {
  constructor(code, ownerName) {
    this.code = code;
    this.ownerName = ownerName;
    this.ownerClientId = null;   // stable device id of the owner (survives reconnect)
    this.ownerId = null;         // current playerId of the owner connection
    this.engine = new GameEngine();
    this.conns = new Map();      // playerId -> ws
    this.timers = { turn: null };
    this.lastActive = Date.now();
  }

  hasOpenConns() {
    for (const ws of this.conns.values()) if (ws.readyState === WS_OPEN) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// RoomManager
// ---------------------------------------------------------------------------
export class RoomManager {
  constructor({ maxRooms = 50 } = {}) {
    this.rooms = new Map();      // CODE -> Room
    this.maxRooms = maxRooms;
  }

  get size() { return this.rooms.size; }

  get(code) {
    if (code == null) return null;
    return this.rooms.get(String(code).toUpperCase()) || null;
  }

  create(ownerName) {
    let code;
    do { code = genCode(); } while (this.rooms.has(code));
    const room = new Room(code, ownerName);
    this.rooms.set(code, room);
    return room;
  }

  delete(code) {
    const room = this.get(code);
    if (room) { clearRoomTimers(room); this.rooms.delete(room.code); }
  }

  // NO publicList() — discovery is code-only / private by design (matches the
  // P2P broker where browse is disabled). You must know the code to join.

  // GC rooms whose sockets have all gone and that have been idle past the TTL.
  sweep() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (!room.hasOpenConns() && (now - room.lastActive) > ROOM_TTL_MS) {
        this.delete(room.code);
      }
    }
  }
}

// 4-char code from the unambiguous alphabet — matches js/util.js generateRoomCode.
function genCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  return code;
}

// ---------------------------------------------------------------------------
// Authoritative loop helpers (operate on a Room)
// ---------------------------------------------------------------------------

// Send every connection the public state plus ONLY its own private slice.
// Spectators (no seat) get priv: null — privateStateFor also returns null for an
// unseated id, but we gate on the flag for clarity and safety so the secret
// word can never reach a watcher.
export function broadcastState(room) {
  const e = room.engine;
  const pub = e.publicState();
  for (const [playerId, ws] of room.conns) {
    if (ws.readyState !== WS_OPEN) continue;
    const priv = ws._spectator ? null : e.privateStateFor(playerId);
    send(ws, { type: 'state', pub, priv });
  }
}

export function clearRoomTimers(room) {
  if (room.timers.turn) { clearTimeout(room.timers.turn); room.timers.turn = null; }
}

// The server owns the authoritative turn clock — the exact role main.js
// scheduleTurnTimer() played for the browser host. Arm ONE timeout when a turn
// goes active; clear it whenever we leave the active phase. Mid-turn "Got it"
// syncs don't reschedule (the timer keeps running for the full turn), so we
// only arm when none is pending.
export function scheduleTurnTimer(room) {
  const e = room.engine;
  const pub = e.publicState();
  if (pub.phase === 'turnActive') {
    if (!room.timers.turn) {
      const ms = pub.turnRemainingMs != null ? pub.turnRemainingMs : e.config.timerSeconds * 1000;
      room.timers.turn = setTimeout(() => {
        room.timers.turn = null;
        e.endTurnByTime();
        sync(room);
      }, Math.max(0, ms));
    }
  } else if (room.timers.turn) {
    clearTimeout(room.timers.turn);
    room.timers.turn = null;
  }
}

// The server analogue of the browser host's hostSync(): mark activity, broadcast
// tailored state, then (re)arm the turn timer. No stats to record.
export function sync(room) {
  room.lastActive = Date.now();
  broadcastState(room);
  scheduleTurnTimer(room);
}

export { send };
