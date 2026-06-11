// Headless end-to-end test of the Fishbowl engine. No browser, no network.
//   node scripts/test-engine.mjs
// Exercises: setup → submission → 3 rounds (shared bowl reused) → scoring →
// winner, plus rotation, timer handoff, round-empty, reconnect, config, and
// the sudden-death tiebreaker.

import { GameEngine, PHASES } from '../js/state.js';
import { ROUND_TYPES } from '../js/rules.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  ✗ FAIL:', msg); }
}
function section(t) { console.log('\n— ' + t); }

// ---------------------------------------------------------------------------
function freshGame({ players = 4, numTeams = 2, numRounds = 3, wordsPerPlayer = 5, timerSeconds = 60, allowSkip = false } = {}) {
  const eng = new GameEngine();
  eng.addPlayer('host', 'Host', { isHost: true });
  for (let i = 1; i < players; i++) eng.addPlayer('p' + i, 'Player' + i);
  eng.setConfig({ numTeams, numRounds, wordsPerPlayer, timerSeconds, allowSkip });
  // Deterministic team split: round-robin by join order.
  eng.players.forEach((p, i) => { p.team = i % numTeams; });
  return eng;
}

function submitAll(eng) {
  eng.startSubmission(eng.hostId);
  eng.players.forEach((p, i) => {
    const words = [];
    for (let w = 0; w < eng.config.wordsPerPlayer; w++) words.push(`${p.name}-w${w}`);
    eng.submitWords(p.id, words);
  });
  eng.beginPlay(eng.hostId);
}

// Plays one round to completion, guessing `perTurn` words then "timing out".
// Returns the list of clue-giver ids in the order they took a turn.
function playRound(eng, perTurn = 2) {
  const cluers = [];
  let guard = 0;
  while (eng.phase === PHASES.TURN_READY || eng.phase === PHASES.TURN_SUMMARY) {
    if (++guard > 1000) throw new Error('round did not terminate');
    if (eng.phase === PHASES.TURN_SUMMARY) { eng.continueFromSummary(eng.hostId); continue; }
    const clue = eng.currentClueGiverId;
    cluers.push(clue);
    eng.startTurn(clue);
    let n = 0;
    while (eng.phase === PHASES.TURN_ACTIVE && n < perTurn) { eng.gotIt(eng.currentClueGiverId); n++; }
    if (eng.phase === PHASES.TURN_ACTIVE) eng.endTurnByTime();
  }
  return cluers;
}

// ===========================================================================
section('Setup + submission');
{
  const eng = freshGame();
  ok(eng.phase === PHASES.LOBBY, 'starts in lobby');
  ok(eng.count === 4, 'four players seated');
  const start = eng.startSubmission(eng.hostId);
  ok(start.ok, 'host can start submission');
  ok(eng.phase === PHASES.SUBMISSION, 'moved to submission');

  // Partial submission is rejected; full submission locks in.
  const partial = eng.submitWords('host', ['only', 'three', 'words']);
  ok(!partial.ok, 'rejects fewer than wordsPerPlayer');
  ok(!eng.allSubmitted, 'not all submitted yet');

  eng.players.forEach(p => eng.submitWords(p.id, ['a', 'b', 'c', 'd', 'e']));
  ok(eng.allSubmitted, 'all submitted once each player commits 5');

  const begin = eng.beginPlay(eng.hostId);
  ok(begin.ok, 'host begins play');
  ok(eng.bowl.length === 20, `bowl has 4×5 = 20 words (got ${eng.bowl.length})`);
  ok(eng.phase === PHASES.TURN_READY, 'first turn is ready');
}

// ===========================================================================
section('Non-host cannot drive flow');
{
  const eng = freshGame();
  ok(!eng.startSubmission('p1').ok, 'non-host cannot start submission');
}

// ===========================================================================
section('Privacy — current word reaches only the clue-giver');
{
  const eng = freshGame();
  submitAll(eng);
  const clue = eng.currentClueGiverId;
  eng.startTurn(clue);
  ok(eng.phase === PHASES.TURN_ACTIVE, 'turn active');

  const pub = eng.publicState();
  const pubStr = JSON.stringify(pub);
  // No undrawn bowl word text should ever appear in the public state.
  const leaked = eng.bowl.some(w => pubStr.includes(w.text));
  ok(!leaked, 'public state never contains a bowl word');

  const privClue = eng.privateStateFor(clue);
  ok(typeof privClue.currentWord === 'string' && privClue.currentWord.length > 0,
    'clue-giver sees the current word');

  const other = eng.players.find(p => p.id !== clue);
  const privOther = eng.privateStateFor(other.id);
  ok(!('currentWord' in privOther) || !privOther.currentWord,
    'other players never receive the current word');
}

// ===========================================================================
section('Turn handoff — unguessed word returns, teams alternate, cluers rotate');
{
  const eng = freshGame({ players: 4, numTeams: 2 }); // teams: [host,p2] vs [p1,p3]
  submitAll(eng);

  const before = eng.bowlTotal;
  const clue1 = eng.currentClueGiverId;
  eng.startTurn(clue1);
  eng.gotIt(eng.currentClueGiverId); // score one
  const remainingMid = eng.remaining.length;
  eng.endTurnByTime();               // unguessed current word goes back
  ok(eng.remaining.length === remainingMid + 1, 'unguessed word returned to the bowl');
  ok(eng.phase === PHASES.TURN_SUMMARY, 'turn summary after timeout');
  ok(eng.lastTurnSummary.scored === 1, 'summary records one word scored');

  eng.continueFromSummary(eng.hostId);
  ok(eng.phase === PHASES.TURN_READY, 'continue advances to next turn');
  const clue2 = eng.currentClueGiverId;
  const t1 = eng.getPlayer(clue1).team, t2 = eng.getPlayer(clue2).team;
  ok(t1 !== t2, 'turn passes to the other team');
  ok(before === eng.bowlTotal, 'master bowl size unchanged by play');
}

// ===========================================================================
section('Clue-giver rotation within a team across its turns');
{
  const eng = freshGame({ players: 6, numTeams: 2 }); // team0: host,p2,p4 ; team1: p1,p3,p5
  submitAll(eng);
  const cluers = playRound(eng, 1); // 1 guess per turn → many turns
  // The first three turns for team 0 should use three distinct members.
  const team0Cluers = cluers.filter(id => eng.getPlayer(id).team === 0).slice(0, 3);
  ok(new Set(team0Cluers).size === 3, `team 0 rotates through its 3 members (got ${team0Cluers})`);
}

// ===========================================================================
section('Round ends when the bowl empties; three rounds reuse the same words');
{
  const eng = freshGame({ players: 4, numTeams: 2, numRounds: 3 });
  submitAll(eng);
  const bowlIds = eng.bowl.map(w => w.id).sort().join(',');

  for (let r = 0; r < 3; r++) {
    ok(eng.currentRound === r, `round index is ${r}`);
    ok(eng.remaining.length === eng.bowl.length, 'round opens with the full bowl');
    playRound(eng, 3);
    ok(eng.phase === PHASES.ROUND_BREAK, `round ${r} reaches the break (bowl empty)`);
    ok(eng.remaining.length === 0 && !eng.currentWordId, 'bowl is empty at round end');
    ok(eng.bowl.map(w => w.id).sort().join(',') === bowlIds, 'same words reused across rounds');
    if (r < 2) eng.nextRound(eng.hostId);
  }
  ok(eng.isFinalRound, 'on the final round at the break');

  const totals = eng.scores.map(s => s.reduce((a, b) => a + b, 0));
  const sumScored = totals[0] + totals[1];
  ok(sumScored === eng.bowl.length * 3, `every word scored each round: ${sumScored} === ${eng.bowl.length * 3}`);

  eng.finishGame(eng.hostId);
  ok(eng.phase === PHASES.GAMEOVER, 'game over after the final round');
  ok(Array.isArray(eng.winners) && eng.winners.length >= 1, 'a winner (or tie) is declared');
}

// ===========================================================================
section('Skip toggle');
{
  const off = freshGame({ allowSkip: false });
  submitAll(off);
  off.startTurn(off.currentClueGiverId);
  ok(!off.skip(off.currentClueGiverId).ok, 'skip rejected when disabled');

  const on = freshGame({ allowSkip: true });
  submitAll(on);
  on.startTurn(on.currentClueGiverId);
  const remBefore = on.remaining.length;
  const wordBefore = on.currentWordId;
  const r = on.skip(on.currentClueGiverId);
  ok(r.ok, 'skip allowed when enabled');
  ok(on.remaining.includes(wordBefore), 'skipped word returned to the bowl');
  ok(on.publicState().bowlRemaining === remBefore + 1, 'bowl-remaining count unchanged by a skip');
}

// ===========================================================================
section('Config: 4th round adds Statue; team count reclamp');
{
  const eng = freshGame({ numRounds: 4 });
  ok(eng.roundTypes.length === 4 && eng.roundTypes[3] === 'statue', '4 rounds includes statue');

  const eng2 = freshGame({ players: 6, numTeams: 4 });
  ok(eng2.config.numTeams === 4, 'numTeams set to 4');
  eng2.setConfig({ numTeams: 2 });
  ok(eng2.players.every(p => p.team < 2), 'players reclamped when team count drops');
}

// ===========================================================================
section('Reconnect reclaims the seat by name');
{
  const eng = freshGame();
  submitAll(eng);
  const victim = eng.players.find(p => p.id !== eng.hostId);
  const oldId = victim.id;
  eng.markOffline(oldId);
  ok(!eng.getPlayer(oldId).online, 'player marked offline mid-game');
  const res = eng.addPlayer('newconn', victim.name);
  ok(res.ok && res.reconnected, 'reconnect by name succeeds');
  ok(res.player.id === 'newconn' && res.player.online, 'seat reclaimed with new connection id');
}

// ===========================================================================
section('Winner computation + sudden death');
{
  const eng = freshGame({ players: 4, numTeams: 2 });
  submitAll(eng);
  // Force a tie directly on the score matrix, then drive to game over.
  eng.scores = [[3, 3, 3], [3, 3, 3]];
  eng.currentRound = 2;
  eng.remaining = []; eng.currentWordId = null;
  eng.phase = PHASES.ROUND_BREAK;
  eng.finishGame(eng.hostId);
  ok(eng.isTie && eng.winners.length === 2, 'tie detected with two winners');

  eng.startSuddenDeath(eng.hostId);
  ok(eng.suddenDeath && eng.phase === PHASES.TURN_READY, 'sudden death opens a new round');
  ok(eng.roundTypes[eng.currentRound] === 'sudden', 'sudden-death round type set');
  ok(eng.scores.every(s => s.length === eng.roundTypes.length), 'score matrix grew a column');
  ok(eng.remaining.length === eng.bowl.length, 'sudden death reuses the full bowl');
}

// ===========================================================================
section('Serialize / restore round-trips an in-progress game');
{
  const eng = freshGame();
  submitAll(eng);
  eng.startTurn(eng.currentClueGiverId);
  eng.gotIt(eng.currentClueGiverId);
  const snap = eng.serialize();

  const eng2 = new GameEngine();
  eng2.restore(snap);
  ok(eng2.bowl.length === eng.bowl.length, 'bowl restored');
  ok(eng2.scores[eng.currentTeamIndex][0] === eng.scores[eng.currentTeamIndex][0], 'scores restored');
  // An active turn settles to the recap on restore (the live clock is gone).
  ok(eng2.phase === PHASES.TURN_SUMMARY, 'active turn settles to summary after restore');
  ok(eng2.players.filter(p => p.online).length === 1, 'only the host is online after restore');
}

// ===========================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
