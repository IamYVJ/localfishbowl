// Headless test of the Fishbowl authoritative server (session + room loop).
//   node scripts/test-server.mjs
//
// Drives the server's message dispatch directly with stub sockets (no real
// WebSocket / network). Exercises a full game over the wire, owner gating, the
// privacy invariant (current word reaches ONLY the clue-giver), showGuessedWords
// redaction, the turn-timer room loop, and the Part D security regressions.
//
// The `ws` dependency is NOT needed here — only server/index.js imports it. This
// harness imports the pure dispatch + room layer.

import { RoomManager } from '../server/rooms.js';
import { handleMessage, handleClose } from '../server/session.js';
import { originAllowed } from '../server/origin.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n— ' + t); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stub socket + dispatch helpers
// ---------------------------------------------------------------------------
function makeCtx() {
  return { manager: new RoomManager({ maxRooms: 50 }), maxRooms: 50 };
}
function makeWS() {
  const ws = {
    readyState: 1, sent: [],
    _id: null, _clientId: null, _code: null, _spectator: false,
    send(s) { ws.sent.push(JSON.parse(s)); },
    close() { ws.readyState = 3; },
  };
  return ws;
}
function tx(ctx, ws, msg) { handleMessage(ctx, ws, JSON.stringify(msg)); }
function lastMsg(ws, type) {
  for (let i = ws.sent.length - 1; i >= 0; i--) if (ws.sent[i].type === type) return ws.sent[i];
  return null;
}
function pubOf(ws) { const m = lastMsg(ws, 'state'); return m ? m.pub : null; }
function privOf(ws) { const m = lastMsg(ws, 'state'); return m ? m.priv : null; }

// Five distinct, recognizable words per player so we can prove none leak.
function wordsFor(tag) {
  return [`${tag}-alpha`, `${tag}-bravo`, `${tag}-charlie`, `${tag}-delta`, `${tag}-echo`];
}

// Seat the owner + (n-1) players in a fresh room; returns handles.
function seatGame(ctx, { players = 4, ownerSpectator = false } = {}) {
  const owner = makeWS();
  tx(ctx, owner, { type: 'createRoom', name: 'Owner', clientId: 'cid-owner', asSpectator: ownerSpectator });
  const code = lastMsg(owner, 'welcome').code;
  const seats = [owner];
  for (let i = 1; i < players; i++) {
    const ws = makeWS();
    tx(ctx, ws, { type: 'join', code, name: 'P' + i, clientId: 'cid-' + i });
    seats.push(ws);
  }
  return { owner, code, seats };
}

// Run the owner's lobby→submission→beginPlay, with every seated player
// submitting their words. ownerSeated controls whether the owner also submits.
function startToPlay(ctx, code, owner, seats, ownerSeated = true) {
  const room = ctx.manager.get(code);
  tx(ctx, owner, { type: 'startSubmission' });
  for (const ws of seats) {
    if (ws === owner && !ownerSeated) continue;
    const tag = ws === owner ? 'Owner' : ('P' + seats.indexOf(ws));
    tx(ctx, ws, { type: 'submitWords', words: wordsFor(tag) });
  }
  tx(ctx, owner, { type: 'beginPlay' });
  return room;
}

// The seated ws whose current engine id is the active clue-giver.
function clueWsFor(seats, room) {
  const id = room.engine.currentClueGiverId;
  return seats.find(w => w._id === id) || null;
}

// Play one round to completion by having each clue-giver guess until the bowl
// empties (no reliance on the turn timer here).
function wirePlayRound(ctx, code, owner, seats) {
  const room = ctx.manager.get(code);
  let guard = 0;
  while (room.engine.phase === 'turnReady' || room.engine.phase === 'turnSummary') {
    if (++guard > 2000) throw new Error('round did not terminate');
    if (room.engine.phase === 'turnSummary') { tx(ctx, owner, { type: 'continueTurn' }); continue; }
    const clue = clueWsFor(seats, room);
    tx(ctx, clue, { type: 'startTurn' });
    let n = 0;
    while (room.engine.phase === 'turnActive' && n < 1000) { tx(ctx, clue, { type: 'gotIt' }); n++; }
  }
}

// ===========================================================================
section('Full game over the wire — create, join, configure, submit, 3 rounds');
{
  const ctx = makeCtx();
  const { owner, code, seats } = seatGame(ctx, { players: 4 });
  const room = ctx.manager.get(code);

  ok(lastMsg(owner, 'welcome').owner === true, 'creator is welcomed as owner');
  ok(/^[A-Z2-9]{4}$/.test(code), `server assigns a 4-char alphabet code (got ${code})`);
  ok(room.engine.count === 4, 'four players seated over the wire');

  // Owner configures the game in the lobby (3 rounds, 2 teams).
  tx(ctx, owner, { type: 'setConfig', patch: { numTeams: 2, numRounds: 3 } });
  ok(pubOf(owner).config.numTeams === 2, 'owner setConfig applied (numTeams)');
  // Deterministic team split for the test.
  room.engine.players.forEach((p, i) => { p.team = i % 2; });

  startToPlay(ctx, code, owner, seats, true);
  ok(room.engine.phase === 'turnReady', 'game reached first turn after beginPlay');
  ok(room.engine.bowl.length === 20, `bowl has 4×5 = 20 words (got ${room.engine.bowl.length})`);

  // Play all three rounds.
  for (let r = 0; r < 3; r++) {
    wirePlayRound(ctx, code, owner, seats);
    ok(room.engine.phase === 'roundBreak', `round ${r + 1} ends at roundBreak`);
    if (r < 2) tx(ctx, owner, { type: 'nextRound' });
  }
  tx(ctx, owner, { type: 'finishGame' });
  ok(room.engine.phase === 'gameover', 'owner finished the game');
  ok(Array.isArray(pubOf(owner).winners), 'gameover broadcast carries winners');

  // Owner can re-lobby; players keep their seats.
  tx(ctx, owner, { type: 'playAgain' });
  ok(room.engine.phase === 'submission', 'playAgain returns to submission');
  ok(room.engine.count === 4, 'players retained through playAgain');
}

// ===========================================================================
section('Owner gating — a non-owner cannot drive owner-only controls');
{
  const ctx = makeCtx();
  const { owner, code, seats } = seatGame(ctx, { players: 4 });
  const room = ctx.manager.get(code);
  const intruder = seats[1]; // a seated, non-owner player

  // Non-owner tries to start submission and change config — both ignored.
  tx(ctx, intruder, { type: 'startSubmission' });
  ok(room.engine.phase === 'lobby', 'non-owner startSubmission is ignored');
  tx(ctx, intruder, { type: 'setConfig', patch: { numRounds: 4 } });
  ok(room.engine.config.numRounds !== 4, 'non-owner setConfig is ignored');

  // The owner can.
  tx(ctx, owner, { type: 'startSubmission' });
  ok(room.engine.phase === 'submission', 'owner startSubmission works');
}

// ===========================================================================
section('Privacy invariant over the wire — current word reaches ONLY the clue-giver');
{
  const ctx = makeCtx();
  const { owner, code, seats } = seatGame(ctx, { players: 4 });
  const room = ctx.manager.get(code);
  room.engine.players.forEach((p, i) => { p.team = i % 2; });
  startToPlay(ctx, code, owner, seats, true);

  const clue = clueWsFor(seats, room);
  tx(ctx, clue, { type: 'startTurn' });
  ok(room.engine.phase === 'turnActive', 'a turn is active');

  const cpriv = privOf(clue);
  ok(typeof cpriv.currentWord === 'string' && cpriv.currentWord.length > 0,
    'the clue-giver privately receives the current word');

  // Every OTHER seated player's private slice must not carry the current word.
  const others = seats.filter(w => w !== clue);
  ok(others.every(w => privOf(w).currentWord === undefined),
    'no other player receives the current word');

  // The public state must not contain the word text anywhere, for anyone.
  const word = cpriv.currentWord;
  ok(seats.every(w => !JSON.stringify(pubOf(w)).includes(word)),
    'the current word never appears in any public broadcast');
  ok(pubOf(owner).currentWord === undefined, 'public state has no currentWord field');
}

// ===========================================================================
section('showGuessedWords redaction + turn-timer room loop');
{
  const ctx = makeCtx();
  const { owner, code, seats } = seatGame(ctx, { players: 4 });
  const room = ctx.manager.get(code);
  room.engine.players.forEach((p, i) => { p.team = i % 2; });

  // Owner turns the recap secrecy ON (hide guessed words from everyone else).
  tx(ctx, owner, { type: 'setConfig', patch: { showGuessedWords: false } });
  ok(room.engine.config.showGuessedWords === false, 'owner disabled showGuessedWords');

  startToPlay(ctx, code, owner, seats, true);

  // Use a very short turn so the server's room-loop timer fires the turn end.
  room.engine.config.timerSeconds = 0.05;
  const clue = clueWsFor(seats, room);
  tx(ctx, clue, { type: 'startTurn' });
  tx(ctx, clue, { type: 'gotIt' });           // score exactly one word
  ok(room.engine.phase === 'turnActive', 'still mid-turn before the timer fires');

  await sleep(120);                            // let the room-loop timer expire
  ok(room.engine.phase === 'turnSummary', 'the server room-loop turn timer ended the turn');

  const sumPub = pubOf(owner).lastTurnSummary;
  ok(sumPub && sumPub.hidden === true, 'public recap is marked hidden');
  ok(sumPub.scored === 1, 'public recap still reports the score (count only)');
  ok(Array.isArray(sumPub.words) && sumPub.words.length === 0, 'public recap carries NO word text');
  // The real invariant: not one of the bowl's word texts appears in the recap.
  // (cluerId is a UUID and legitimately contains hyphens — don't proxy on '-'.)
  const recapJson = JSON.stringify(sumPub);
  ok(room.engine.bowl.every(w => !recapJson.includes(w.text)),
    'no guessed-word text leaks in the public recap');

  // The clue-giver who just played still sees their own words privately.
  const cpriv = privOf(clue);
  ok(Array.isArray(cpriv.summaryWords) && cpriv.summaryWords.length === 1,
    'the just-played clue-giver privately sees their guessed word');
  // A different seated player does NOT receive the summary word list.
  const other = seats.find(w => w !== clue);
  ok(privOf(other).summaryWords === undefined, 'other players do not receive the recap word list');
}

// ===========================================================================
section('Security — Part D regressions');
{
  // --- oversized name is clamped (engine caps seats to 16) ---
  {
    const ctx = makeCtx();
    const owner = makeWS();
    const huge = 'x'.repeat(200);
    tx(ctx, owner, { type: 'createRoom', name: huge, clientId: 'cid-x' });
    const code = lastMsg(owner, 'welcome').code;
    const seat = ctx.manager.get(code).engine.players[0];
    ok(seat.name.length <= 16, `oversized owner name clamped (len ${seat.name.length})`);
  }

  // --- mid-game seat reclaim requires the matching clientId ---
  {
    const ctx = makeCtx();
    const { owner, code, seats } = seatGame(ctx, { players: 4 });
    const room = ctx.manager.get(code);
    room.engine.players.forEach((p, i) => { p.team = i % 2; });
    startToPlay(ctx, code, owner, seats, true);
    ok(room.engine.phase !== 'lobby', 'game has started (past the lobby)');

    // P1 drops mid-game.
    const victim = seats[1];
    const victimName = room.engine.getPlayer(victim._id).name;
    handleClose(ctx, victim);
    ok(room.engine.getPlayer(victim._id)?.online === false, 'victim seat is now offline');

    // Attacker knows the public name but NOT the clientId — must be rejected.
    const attacker = makeWS();
    tx(ctx, attacker, { type: 'join', code, name: victimName, clientId: 'cid-ATTACKER' });
    ok(lastMsg(attacker, 'rejected'), 'name-only reclaim of an offline seat is rejected mid-game');
    ok(attacker._id === null, 'attacker never got a seat id');

    // The real device returns with the correct clientId — accepted.
    const real = makeWS();
    tx(ctx, real, { type: 'join', code, name: victimName, clientId: 'cid-1' });
    ok(lastMsg(real, 'welcome'), 'the original device reclaims the seat via its clientId');
    ok(room.engine.getPlayer(real._id)?.online === true, 'reclaimed seat is back online');
  }

  // --- mid-game: a LIVE player's seat cannot be seized by its public name ---
  // (regression for the seat-hijack fix: name-only reclaim of an ONLINE seat must
  // be refused, or an attacker who can read the public name would take over the
  // clue-giver and receive the secret word.)
  {
    const ctx = makeCtx();
    const { owner, code, seats } = seatGame(ctx, { players: 4 });
    const room = ctx.manager.get(code);
    room.engine.players.forEach((p, i) => { p.team = i % 2; });
    startToPlay(ctx, code, owner, seats, true);

    // Drive to an active turn so the clue-giver's seat holds the secret word.
    const clue = clueWsFor(seats, room);
    tx(ctx, clue, { type: 'startTurn' });
    ok(room.engine.phase === 'turnActive', 'a turn is active (clue-giver holds the word)');
    const victimName = room.engine.getPlayer(clue._id).name;
    const victimId = clue._id;
    const secret = privOf(clue).currentWord;
    ok(typeof secret === 'string' && secret, 'clue-giver privately holds the current word');

    // Attacker rejoins with the clue-giver's PUBLIC name and a foreign clientId.
    const attacker = makeWS();
    tx(ctx, attacker, { type: 'join', code, name: victimName, clientId: 'cid-ATTACKER' });
    ok(lastMsg(attacker, 'rejected'), 'name-only reclaim of a LIVE seat is rejected mid-game');
    ok(attacker._id === null, 'attacker never got a seat id');
    ok(privOf(attacker) === null, 'attacker received no state (and so no secret word)');
    // The live victim keeps their seat — same id, still online, socket undisplaced.
    ok(room.engine.getPlayer(victimId)?.online === true, 'victim seat untouched and still online');
    ok(room.conns.get(victimId) === clue, 'victim socket was not displaced');
  }

  // --- mid-game: a SEATED participant cannot seize another player's seat via its
  // public name, even presenting their OWN valid clientId. Regression for the
  // `byClient` short-circuit: owning *some* seat must not bypass the name-clash
  // guard, since the engine reclaims by name and would hand over the victim's
  // private slice (the secret word when the victim is the clue-giver). The other
  // hijack tests use a clientId matching no seat, so they miss this path.
  {
    const ctx = makeCtx();
    const { owner, code, seats } = seatGame(ctx, { players: 4 });
    const room = ctx.manager.get(code);
    room.engine.players.forEach((p, i) => { p.team = i % 2; });
    startToPlay(ctx, code, owner, seats, true);

    // Drive to an active turn so the clue-giver's seat holds the secret word.
    const clue = clueWsFor(seats, room);
    tx(ctx, clue, { type: 'startTurn' });
    ok(room.engine.phase === 'turnActive', 'a turn is active (clue-giver holds the word)');
    const victimId = clue._id;
    const victimName = room.engine.getPlayer(victimId).name;
    const victimClientId = room.engine.getPlayer(victimId).clientId;

    // Attacker is a DIFFERENT seated player who legitimately owns a seat via their
    // own clientId — exactly what the old `byClient` check waved straight through.
    const attacker = seats.find(w => w !== clue && w !== owner);
    const attackerId = attacker._id;
    const attackerClientId = attacker._clientId;
    ok(attackerClientId && attackerClientId !== victimClientId, 'attacker owns a real, different seat');

    tx(ctx, attacker, { type: 'join', code, name: victimName, clientId: attackerClientId });
    ok(lastMsg(attacker, 'rejected'), 'a seated player cannot grab another seat by its public name');
    // The clue-giver's seat is fully intact.
    ok(room.engine.getPlayer(victimId)?.online === true, 'clue-giver seat still online');
    ok(room.engine.getPlayer(victimId)?.clientId === victimClientId, 'clue-giver clientId not overwritten');
    ok(room.conns.get(victimId) === clue, 'clue-giver socket not displaced');
    // The attacker still holds ONLY their own original seat.
    ok(attacker._id === attackerId, 'attacker keeps only its own seat id');
    ok(room.conns.get(attackerId) === attacker, 'attacker socket still mapped to its own seat');
  }

  // --- clientId is coerced to a bounded string (non-string/oversized dropped) ---
  {
    const ctx = makeCtx();
    const owner = makeWS();
    tx(ctx, owner, { type: 'createRoom', name: 'Owner', clientId: 'z'.repeat(500) });
    const code = lastMsg(owner, 'welcome').code;
    const room = ctx.manager.get(code);
    ok(typeof room.ownerClientId === 'string' && room.ownerClientId.length === 64,
      `oversized clientId clamped to 64 chars (len ${room.ownerClientId?.length})`);

    const p = makeWS();
    tx(ctx, p, { type: 'join', code, name: 'P1', clientId: { evil: true } });
    ok(room.engine.getPlayer(p._id)?.clientId === null, 'a non-string clientId is dropped to null');
  }

  // --- one room per connection ---
  {
    const ctx = makeCtx();
    const owner = makeWS();
    tx(ctx, owner, { type: 'createRoom', name: 'A', clientId: 'cid-a' });
    const first = lastMsg(owner, 'welcome').code;
    tx(ctx, owner, { type: 'createRoom', name: 'A', clientId: 'cid-a' });
    ok(lastMsg(owner, 'rejected'), 'a second createRoom on the same socket is rejected');
    ok(ctx.manager.size === 1, 'only one room exists for the socket');
    ok(ctx.manager.get(first), 'the original room is intact');
  }

  // --- malformed / unknown messages never throw ---
  {
    const ctx = makeCtx();
    const ws = makeWS();
    let threw = false;
    try {
      handleMessage(ctx, ws, 'not-json{');
      handleMessage(ctx, ws, JSON.stringify({}));            // no type
      handleMessage(ctx, ws, JSON.stringify({ type: 42 }));  // non-string type
      handleMessage(ctx, ws, JSON.stringify({ type: 'gotIt' })); // not in a room
      handleMessage(ctx, ws, JSON.stringify({ type: 'nope' }));  // unknown
    } catch (_) { threw = true; }
    ok(!threw, 'malformed/unknown messages are handled without throwing');
    ok(lastMsg(ws, 'error') && lastMsg(ws, 'error').message === 'Not in a room.',
      'a room-scoped message with no room replies with a non-fatal error');
  }

  // --- origin allowlist (CSRF defence): prod rejects unknown / header-less ---
  {
    const prod = { isProd: true };
    ok(originAllowed('https://iamyvj.github.io', prod) === true, 'the GitHub Pages origin is allowed in prod');
    ok(originAllowed('https://evil.example.com', prod) === false, 'a foreign origin is rejected in prod');
    ok(originAllowed(undefined, prod) === false, 'a header-less upgrade is rejected in prod');
    ok(originAllowed(undefined, { isProd: false }) === true, 'a header-less upgrade is allowed outside prod (test harness)');
    ok(originAllowed('http://localhost:3000', { isProd: false }) === true, 'localhost is allowed outside prod');
  }
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
