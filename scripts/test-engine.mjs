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
section('Skip clue-giver — host escape hatch, even when the host is clueing');
{
  const eng = freshGame({ players: 4, numTeams: 2 }); // host on team 0 with p2
  submitAll(eng);
  ok(eng.phase === PHASES.TURN_READY, 'ready for the first turn');

  const firstCluer = eng.currentClueGiverId;
  ok(firstCluer === eng.hostId, 'host is the first clue-giver in this layout');

  // Non-host cannot skip the clue-giver.
  eng.skipClueGiver('p1');
  ok(eng.currentClueGiverId === firstCluer, 'a non-host skip is ignored');

  // Host skips even though the host is the one clueing → hands off to a teammate.
  eng.skipClueGiver(eng.hostId);
  const nextCluer = eng.currentClueGiverId;
  ok(nextCluer !== firstCluer, 'host skipped themselves to the next teammate');
  ok(eng.getPlayer(nextCluer).team === eng.getPlayer(firstCluer).team,
    'skip stays within the same team that is up');

  // Skip only applies while a turn is pending, not mid-turn.
  eng.startTurn(eng.currentClueGiverId);
  const midCluer = eng.currentClueGiverId;
  eng.skipClueGiver(eng.hostId);
  ok(eng.currentClueGiverId === midCluer, 'skip is a no-op once the turn is active');
}

// ===========================================================================
section('Review guesses — clue-giver can uncheck a mis-scored word');
{
  const eng = freshGame({ players: 4, numTeams: 2 });
  eng.setConfig({ reviewGuesses: true });
  submitAll(eng);

  const cluer = eng.currentClueGiverId;
  const team = eng.getPlayer(cluer).team;
  eng.startTurn(cluer);
  eng.gotIt(cluer);
  eng.gotIt(cluer);            // two words counted for this team this round
  eng.endTurnByTime();

  ok(eng.phase === PHASES.TURN_SUMMARY, 'timed turn lands on the recap');
  const s = eng.lastTurnSummary;
  ok(s.cluerId === cluer, 'summary records the clue-giver who played');
  ok(s.items.length === 2 && s.scored === 2, 'two words recorded as counted');
  ok(eng.scores[team][0] === 2, 'team scored 2 this round');

  // Only the clue-giver who played may edit.
  const other = eng.players.find(p => p.id !== cluer).id;
  ok(!eng.reviewGuessedWord(other, s.items[0].id, false).ok, 'a different player cannot edit');
  ok(!eng.reviewGuessedWord(cluer, 'no-such-word', false).ok, 'unknown word rejected');

  // Uncheck one → point lost, word returns to the bowl to be replayed.
  const wid = s.items[0].id;
  const remBefore = eng.remaining.length;
  ok(eng.reviewGuessedWord(cluer, wid, false).ok, 'clue-giver unchecks a word');
  ok(eng.scores[team][0] === 1, 'point removed on uncheck');
  ok(eng.lastTurnSummary.scored === 1 && eng.lastTurnSummary.words.length === 1, 'recap count drops to 1');
  ok(eng.remaining.includes(wid) && eng.remaining.length === remBefore + 1, 'unchecked word returned to the bowl');

  // Re-check it → point restored, word pulled back out.
  ok(eng.reviewGuessedWord(cluer, wid, true).ok, 'clue-giver re-checks the word');
  ok(eng.scores[team][0] === 2, 'point restored on re-check');
  ok(!eng.remaining.includes(wid) && eng.remaining.length === remBefore, 'word removed from the bowl again');

  // Review is rejected when the toggle is off.
  const offGame = freshGame({ players: 4, numTeams: 2 });
  submitAll(offGame);
  const c2 = offGame.currentClueGiverId;
  offGame.startTurn(c2); offGame.gotIt(c2); offGame.endTurnByTime();
  ok(!offGame.reviewGuessedWord(c2, offGame.lastTurnSummary.items[0].id, false).ok,
    'review rejected when the toggle is off');
}

// ===========================================================================
section('Review guesses — bowl-emptying turn still gets a recap');
{
  const eng = freshGame({ players: 4, numTeams: 2, wordsPerPlayer: 1 }); // 4-word bowl
  eng.setConfig({ reviewGuesses: true });
  submitAll(eng);

  const cluer = eng.currentClueGiverId;
  eng.startTurn(cluer);
  while (eng.phase === PHASES.TURN_ACTIVE) eng.gotIt(eng.currentClueGiverId);
  ok(eng.phase === PHASES.TURN_SUMMARY, 'emptying the bowl pauses on the recap when review is on');
  ok(eng.remaining.length === 0, 'bowl is empty going into the recap');

  // Uncheck one → it returns to the bowl → continue should resume play.
  const wid = eng.lastTurnSummary.items[0].id;
  eng.reviewGuessedWord(cluer, wid, false);
  eng.continueFromSummary(eng.hostId);
  ok(eng.phase === PHASES.TURN_READY, 'an unchecked word keeps the round going');

  // Replay the returned word; with everything counted, the round ends.
  const c2 = eng.currentClueGiverId;
  eng.startTurn(c2);
  while (eng.phase === PHASES.TURN_ACTIVE) eng.gotIt(eng.currentClueGiverId);
  ok(eng.phase === PHASES.TURN_SUMMARY, 'back on the recap after replaying the word');
  eng.continueFromSummary(eng.hostId);
  ok(eng.phase === PHASES.ROUND_BREAK, 'round ends once every word is counted');
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
  ok(res.prevId === oldId, 'reports the previous connection id for cleanup');
}

// ===========================================================================
section('Reconnect works even when the disconnect was never detected');
{
  // The real-world bug: an abrupt drop (sleep / Wi-Fi / tab close) leaves the
  // seat still flagged online, because no clean `close` ever reached the host.
  const eng = freshGame();
  submitAll(eng);
  const victim = eng.players.find(p => p.id !== eng.hostId);
  const oldId = victim.id;
  ok(victim.online, 'seat is still flagged online (no close event fired)');

  const res = eng.addPlayer('reconn', victim.name.toUpperCase()); // case-insensitive
  ok(res.ok && res.reconnected, 'same name reclaims the seat despite the stale online flag');
  ok(res.prevId === oldId && res.player.id === 'reconn', 'new id takes over, old id reported');
  ok(eng.players.filter(p => p.name.toLowerCase() === victim.name.toLowerCase()).length === 1,
    'no duplicate seat is created');

  // A late close for the dead connection must not knock the reclaimed seat out.
  eng.markOffline(oldId);
  ok(eng.getPlayer('reconn') && eng.getPlayer('reconn').online,
    'a late disconnect for the old id is a harmless no-op');
}

// ===========================================================================
section('Reconnect mid-summary keeps clue-giver permissions');
{
  const eng = freshGame({ players: 4, numTeams: 2 });
  eng.setConfig({ reviewGuesses: true });
  submitAll(eng);
  const cluer = eng.currentClueGiverId;
  eng.startTurn(cluer);
  eng.gotIt(cluer);
  eng.endTurnByTime();
  ok(eng.phase === PHASES.TURN_SUMMARY && eng.lastTurnSummary.cluerId === cluer,
    'recap remembers the clue-giver by id');

  const res = eng.addPlayer('cluer-reconn', eng.getPlayer(cluer).name);
  ok(res.ok && res.reconnected, 'clue-giver reconnects during the recap');
  ok(eng.lastTurnSummary.cluerId === 'cluer-reconn',
    'recap follows the clue-giver to the new connection id');
  ok(eng.reviewGuessedWord('cluer-reconn', eng.lastTurnSummary.items[0].id, false).ok,
    'reconnected clue-giver can still adjust their guesses');
}

// ===========================================================================
section('Per-player stats — words credited to the clue-giver, by round');
{
  const eng = freshGame({ players: 4, numTeams: 2 });
  submitAll(eng);
  const cluer = eng.currentClueGiverId;
  const team = eng.getPlayer(cluer).team;
  eng.startTurn(cluer);
  eng.gotIt(cluer);
  eng.gotIt(cluer);
  eng.endTurnByTime();
  ok(eng.getPlayer(cluer).scores[0] === 2, 'clue-giver credited 2 words in round 0');
  const other = eng.players.find(p => p.id !== cluer);
  ok((other.scores[0] || 0) === 0, 'a player who has not clued has no points');

  // publicState surfaces per-player scores + totals for the stats screen.
  const pub = eng.publicState();
  const m = pub.teams[team].members.find(x => x.id === cluer);
  ok(m && m.scores[0] === 2 && m.total === 2, 'public team view exposes member scores + total');

  // Each team total equals the sum of its players' totals.
  let allMatch = true;
  pub.teams.forEach(t => {
    const sumPlayers = t.members.reduce((a, x) => a + (x.total || 0), 0);
    if (sumPlayers !== t.total) allMatch = false;
  });
  ok(allMatch, "team totals equal the sum of their players' totals");
}

// ===========================================================================
section('Per-player stats — review, play-again and serialize');
{
  const eng = freshGame({ players: 4, numTeams: 2 });
  eng.setConfig({ reviewGuesses: true });
  submitAll(eng);
  const cluer = eng.currentClueGiverId;
  eng.startTurn(cluer);
  eng.gotIt(cluer);
  eng.gotIt(cluer);
  eng.endTurnByTime();
  ok(eng.getPlayer(cluer).scores[0] === 2, 'two words credited before review');
  eng.reviewGuessedWord(cluer, eng.lastTurnSummary.items[0].id, false);
  ok(eng.getPlayer(cluer).scores[0] === 1, 'unchecking a word drops the clue-giver tally');

  // Stats survive a host reload (serialize → restore).
  const clone = new GameEngine();
  clone.restore(eng.serialize());
  ok(clone.getPlayer(cluer).scores[0] === 1, 'per-player stats round-trip through serialize');

  eng.playAgain(eng.hostId);
  ok(eng.players.every(p => (p.scores || []).reduce((a, b) => a + b, 0) === 0),
    'play-again clears per-player stats');
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
