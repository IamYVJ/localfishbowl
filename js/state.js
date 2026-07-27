// ============================================================================
// state.js — Host-authoritative game engine for Fishbowl.
//
// ONLY the host runs this. It owns the entire authoritative state, validates
// every client intent, mutates state, and produces:
//   - publicState():        broadcast to everyone (NEVER contains an undrawn
//                           bowl word — the only secret in Fishbowl).
//   - privateStateFor(id):  the slice ONE player is entitled to see (the
//                           current word reaches ONLY the active clue-giver).
//
// Pure rule constants live in rules.js; this file is the state machine.
// ============================================================================

import {
  DEFAULTS, MIN_PLAYERS, MAX_PLAYERS, MIN_PER_TEAM,
  ROUND_TYPES, buildRoundList, teamTheme,
  shuffle, cleanWord, normalizeConfig, validateStart,
} from './rules.js';

export const PHASES = {
  LOBBY: 'lobby',           // joining, team assignment, host config
  SUBMISSION: 'submission', // everyone privately enters their words
  TURN_READY: 'turnReady',  // a team is up; clue-giver must tap Start
  TURN_ACTIVE: 'turnActive',// timer running; word shown only to clue-giver
  TURN_SUMMARY: 'turnSummary', // recap of the turn before handoff
  ROUND_BREAK: 'roundBreak',// bowl emptied; standings before the next round
  GAMEOVER: 'gameover',
};

export class GameEngine {
  constructor() { this.reset(); }

  reset() {
    this.phase = PHASES.LOBBY;
    this.players = [];          // join-ordered: { id, name, online, team, words[], submitted }
    this.hostId = null;
    this.config = { ...DEFAULTS };

    this.roundTypes = buildRoundList(DEFAULTS.numRounds); // e.g. ['describe','act','oneword']
    this.currentRound = 0;

    this.bowl = [];             // master list (persists across rounds): { id, text }
    this.remaining = [];        // word ids still to guess THIS round (shuffled)
    this.currentWordId = null;  // the word the clue-giver is on right now

    this.currentTeamIndex = 0;
    this.cluerPointers = [];    // per-team rotation cursor
    this.guessedThisTurn = [];  // word ids guessed during the active turn
    this.turnEndsAt = null;     // host-clock ms when the active turn expires
    this.carryMs = null;        // carryOverTime: ms the clue-giver keeps into
                                // the next round after clearing the bowl early

    this.scores = [];           // scores[teamIndex][roundIndex] = points
    this.lastTurnSummary = null;// { teamIndex, words[], reason, scored }
    this.suddenDeath = false;

    this.winners = null;        // array of winning team indices (gameover)
    this.isTie = false;
  }

  // -------------------------------------------------------------------------
  // Roster management
  // -------------------------------------------------------------------------

  /**
   * Seat a player, or let them reclaim their seat on reconnect (same name).
   * `opts.clientId` is a stable per-device token (server mode): it is stored on
   * the seat so the server can reclaim it by device id; P2P passes none and the
   * behaviour is identical (it stays null). It is NEVER exposed in publicState.
   */
  addPlayer(id, name, { isHost = false, clientId = null } = {}) {
    const trimmed = (name || '').trim().slice(0, 16);
    if (!trimmed) return { ok: false, error: 'Name required.' };

    // Reconnect: a known name reclaims its seat. We allow this even when the
    // seat still *looks* online — an abrupt disconnect (device sleep, Wi-Fi
    // drop, tab close) frequently never delivers a clean close, so the stale
    // `online` flag must NOT lock a returning player out of their own seat.
    // The host drops the old (now-orphaned) connection after we hand back the
    // seat. Trade-off: in the lobby two people choosing the identical name will
    // share one seat — the later joiner takes it over (the earlier connection
    // is closed cleanly) — which is the same name-reclaim model we rely on for
    // reconnects.
    const existing = this.players.find(
      p => p.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (existing) {
      const oldId = existing.id;
      existing.online = true;
      existing.id = id;
      // Refresh the reconnect token if one was supplied (server mode); keep the
      // prior token otherwise so a P2P reclaim never wipes a stored clientId.
      if (clientId) existing.clientId = clientId;
      if (oldId !== id) this._remapPlayerId(oldId, id);
      if (isHost) this.hostId = id;
      return { ok: true, player: existing, reconnected: true, prevId: oldId };
    }

    if (this.phase !== PHASES.LOBBY) {
      return { ok: false, error: 'Game already started — cannot join.' };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, error: `Game is full (${MAX_PLAYERS} players max).` };
    }

    const team = this._smallestTeam();
    // `scores` tracks words this player got guessed AS the clue-giver, indexed
    // by round — the basis for the end-of-game per-player stats.
    const player = { id, name: trimmed, online: true, team, words: [], submitted: false, scores: [], skips: [], clientId: clientId || null };
    this.players.push(player);
    if (isHost) this.hostId = id;
    return { ok: true, player };
  }

  /** Reconnecting players get a new PeerJS id; migrate id-keyed state. */
  _remapPlayerId(oldId, newId) {
    if (oldId === newId) return;
    if (this.hostId === oldId) this.hostId = newId;
    // The turn recap remembers its clue-giver by id (for review/continue
    // permissions); keep it pointing at the reconnected player.
    if (this.lastTurnSummary && this.lastTurnSummary.cluerId === oldId) {
      this.lastTurnSummary.cluerId = newId;
    }
  }

  markOffline(id) {
    const p = this.players.find(x => x.id === id);
    if (!p) return;
    p.online = false;
    // In the lobby, drop the seat entirely so the roster stays clean.
    if (this.phase === PHASES.LOBBY) {
      this.players = this.players.filter(x => x.id !== id);
      this._clampTeams();
    }
  }

  getPlayer(id) { return this.players.find(p => p.id === id); }
  get count() { return this.players.length; }

  _teamMembers(t) { return this.players.filter(p => p.team === t); }
  _teamCounts() {
    const counts = new Array(this.config.numTeams).fill(0);
    for (const p of this.players) if (p.team < this.config.numTeams) counts[p.team]++;
    return counts;
  }
  _smallestTeam() {
    const counts = this._teamCounts();
    let best = 0;
    for (let t = 1; t < counts.length; t++) if (counts[t] < counts[best]) best = t;
    return best;
  }

  /** The clue-giver for the current team, derived from the rotation cursor. */
  get currentClueGiverId() {
    const members = this._teamMembers(this.currentTeamIndex);
    if (!members.length) return null;
    const ptr = this.cluerPointers[this.currentTeamIndex] || 0;
    return members[ptr % members.length].id;
  }

  /**
   * The clue-giver for team `t`, `offset` steps ahead in its rotation.
   * offset 0 = whoever clues when team `t` is next up; offset 1 = the one after.
   * Used by the spectator board to show each team's current/next clue-giver.
   */
  _teamCluerAt(t, offset = 0) {
    const members = this._teamMembers(t);
    if (!members.length) return null;
    const len = members.length;
    const ptr = ((this.cluerPointers[t] || 0) + offset) % len;
    const m = members[(ptr + len) % len];
    return { id: m.id, name: m.name };
  }

  // -------------------------------------------------------------------------
  // Lobby / config (host only — guarded by main.js)
  // -------------------------------------------------------------------------

  setConfig(patch) {
    if (this.phase !== PHASES.LOBBY) return;
    const next = normalizeConfig({ ...this.config, ...patch });
    const teamsChanged = next.numTeams !== this.config.numTeams;
    const roundsChanged = next.numRounds !== this.config.numRounds;
    this.config = next;
    if (teamsChanged) this._clampTeams();
    if (roundsChanged) this.roundTypes = buildRoundList(next.numRounds);
  }

  /** Reassign anyone whose team index fell outside a reduced team count. */
  _clampTeams() {
    for (const p of this.players) {
      if (p.team >= this.config.numTeams) p.team = this._smallestTeam();
    }
  }

  setPlayerTeam(playerId, team) {
    if (this.phase !== PHASES.LOBBY) return;
    const p = this.getPlayer(playerId);
    if (!p) return;
    if (team < 0 || team >= this.config.numTeams) return;
    p.team = team;
  }

  autoBalance() {
    if (this.phase !== PHASES.LOBBY) return;
    const shuffled = shuffle(this.players);
    shuffled.forEach((p, i) => { p.team = i % this.config.numTeams; });
  }

  // -------------------------------------------------------------------------
  // Submission phase
  // -------------------------------------------------------------------------

  startSubmission(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can start.' };
    if (this.phase !== PHASES.LOBBY) return { ok: false, error: 'Already started.' };
    const v = validateStart(this.count, this._teamCounts());
    if (!v.ok) return { ok: false, error: v.errors.join(' ') };
    this.players.forEach(p => { p.words = []; p.submitted = false; });
    this.phase = PHASES.SUBMISSION;
    return { ok: true };
  }

  /** A player commits their list of words to the bowl (locks it in). */
  submitWords(id, words) {
    if (this.phase !== PHASES.SUBMISSION) return { ok: false, error: 'Not the submission phase.' };
    const p = this.getPlayer(id);
    if (!p) return { ok: false, error: 'Unknown player.' };
    const cleaned = (Array.isArray(words) ? words : [])
      .map(cleanWord)
      .filter(Boolean)
      .slice(0, this.config.wordsPerPlayer);
    if (cleaned.length < this.config.wordsPerPlayer) {
      return { ok: false, error: `Enter all ${this.config.wordsPerPlayer} words.` };
    }
    p.words = cleaned;
    p.submitted = true;
    return { ok: true };
  }

  /** Let a player reopen their list before everyone is ready. */
  unsubmitWords(id) {
    if (this.phase !== PHASES.SUBMISSION) return;
    const p = this.getPlayer(id);
    if (p) p.submitted = false;
  }

  get submittedCount() { return this.players.filter(p => p.submitted).length; }
  get allSubmitted() { return this.count > 0 && this.players.every(p => p.submitted); }

  // -------------------------------------------------------------------------
  // Begin play — pool the bowl and open Round 1.
  // -------------------------------------------------------------------------
  beginPlay(actorId) {
    if (actorId !== this.hostId) return { ok: false, error: 'Only the host can start.' };
    if (this.phase !== PHASES.SUBMISSION) return { ok: false, error: 'Not ready to start.' };
    if (!this.allSubmitted) return { ok: false, error: 'Everyone must submit their words first.' };

    let n = 0;
    this.bowl = [];
    for (const p of this.players) {
      for (const text of p.words) this.bowl.push({ id: 'w' + (n++), text });
    }
    if (!this.bowl.length) return { ok: false, error: 'The bowl is empty.' };

    this.roundTypes = buildRoundList(this.config.numRounds);
    this.scores = this.players.length
      ? Array.from({ length: this.config.numTeams }, () => new Array(this.roundTypes.length).fill(0))
      : [];
    // Fresh per-player stat rows, one cell per round, for both points and skips.
    this.players.forEach(p => {
      p.scores = new Array(this.roundTypes.length).fill(0);
      p.skips = new Array(this.roundTypes.length).fill(0);
    });
    this.currentRound = 0;
    this.cluerPointers = new Array(this.config.numTeams).fill(0);
    this.currentTeamIndex = 0;
    this.suddenDeath = false;
    this.winners = null;
    this.isTie = false;
    this._openRound();
    return { ok: true };
  }

  _openRound() {
    this.remaining = shuffle(this.bowl.map(w => w.id));
    this.currentWordId = null;
    this.guessedThisTurn = [];
    this.turnEndsAt = null;
    this.phase = PHASES.TURN_READY;
  }

  // -------------------------------------------------------------------------
  // Turn flow
  // -------------------------------------------------------------------------

  /** Host escape hatch: skip an absent clue-giver to the next teammate. */
  skipClueGiver(actorId) {
    if (actorId !== this.hostId) return;
    if (this.phase !== PHASES.TURN_READY) return;
    const members = this._teamMembers(this.currentTeamIndex);
    if (members.length <= 1) return;
    this.cluerPointers[this.currentTeamIndex] =
      (this.cluerPointers[this.currentTeamIndex] || 0) + 1;
  }

  startTurn(id) {
    if (this.phase !== PHASES.TURN_READY) return { ok: false, error: 'Not ready to start a turn.' };
    if (id !== this.currentClueGiverId) return { ok: false, error: 'Only the clue-giver can start.' };
    if (!this.remaining.length && !this.currentWordId) {
      return { ok: false, error: 'The bowl is empty.' };
    }
    this.guessedThisTurn = [];
    this._drawNext();
    // carryOverTime: resume on the time carried from clearing the bowl last
    // round (armed in _concludeTurn); otherwise a fresh full-length turn.
    const ms = this.carryMs != null ? this.carryMs : this.config.timerSeconds * 1000;
    this.carryMs = null;
    this.turnEndsAt = Date.now() + ms;
    this.phase = PHASES.TURN_ACTIVE;
    return { ok: true };
  }

  _drawNext() {
    this.currentWordId = this.remaining.length ? this.remaining.shift() : null;
  }

  gotIt(id) {
    if (this.phase !== PHASES.TURN_ACTIVE) return { ok: false, error: 'No turn in progress.' };
    if (id !== this.currentClueGiverId) return { ok: false, error: 'Only the clue-giver can score.' };
    if (!this.currentWordId) return { ok: false, error: 'No word in play.' };

    this.scores[this.currentTeamIndex][this.currentRound] += 1;
    // Credit the word to the clue-giver who got it guessed (per-player stats).
    const cluer = this.getPlayer(this.currentClueGiverId);
    if (cluer) cluer.scores[this.currentRound] = (cluer.scores[this.currentRound] || 0) + 1;
    this.guessedThisTurn.push(this.currentWordId);
    this._drawNext();
    // Emptying the bowl ends the round immediately, even mid-turn.
    if (!this.currentWordId) this._concludeTurn('empty');
    return { ok: true };
  }

  skip(id) {
    if (this.phase !== PHASES.TURN_ACTIVE) return { ok: false, error: 'No turn in progress.' };
    if (!this.config.allowSkip) return { ok: false, error: 'Skipping is turned off.' };
    if (id !== this.currentClueGiverId) return { ok: false, error: 'Only the clue-giver can skip.' };
    if (!this.currentWordId) return { ok: false, error: 'No word in play.' };
    // Tally the skip against the clue-giver, by round (shown in the end-of-game
    // stats), then return the word to the bowl and draw the next.
    const cluer = this.getPlayer(this.currentClueGiverId);
    if (cluer) {
      const sk = cluer.skips || (cluer.skips = []);
      sk[this.currentRound] = (sk[this.currentRound] || 0) + 1;
    }
    this.remaining.push(this.currentWordId);
    this._drawNext();
    return { ok: true };
  }

  /** Called by the host when the turn timer expires. */
  endTurnByTime() {
    if (this.phase !== PHASES.TURN_ACTIVE) return;
    // The unguessed word goes back into the bowl for the next clue-giver.
    if (this.currentWordId) {
      this.remaining.push(this.currentWordId);
      this.currentWordId = null;
    }
    this._concludeTurn('time');
  }

  _concludeTurn(reason) {
    const justPlayed = this.currentTeamIndex;
    // Capture who clued BEFORE advancing the cursor — the review step (below)
    // is restricted to the clue-giver who actually just played this turn.
    const cluerId = this.currentClueGiverId;

    // carryOverTime: emptying the bowl (round cleared) with time still on the
    // clock lets the SAME clue-giver keep that time and clue the next round — so
    // we neither advance this team's rotation cursor nor hand off to the next
    // team. Never on the final round (nothing to carry into) nor on a timeout.
    const remainingMs = this.turnEndsAt ? Math.max(0, this.turnEndsAt - Date.now()) : 0;
    const carrying = reason === 'empty'
      && this.config.carryOverTime
      && !this.isFinalRound
      && remainingMs > 0;

    // The clue-giver's turn is over unless they're carrying: advance this team's
    // rotation cursor only when we're actually handing off.
    if (!carrying) this.cluerPointers[justPlayed] = (this.cluerPointers[justPlayed] || 0) + 1;

    // Every word scored this turn, kept as toggleable items so the clue-giver
    // can later uncheck a mis-scored one (when review is enabled).
    const items = this.guessedThisTurn.map(wid => ({
      id: wid, text: this._wordText(wid), included: true,
    }));
    this.lastTurnSummary = {
      teamIndex: justPlayed,
      reason,
      round: this.currentRound,
      cluerId,
      items,
      scored: items.length,
      words: items.map(it => it.text),
      carry: carrying,   // UI hint: this recap leads into a same-player carry-over
    };

    // Pass to the next team (every team is non-empty per start validation),
    // unless the clue-giver is carrying their time into the next round.
    if (!carrying) this.currentTeamIndex = (justPlayed + 1) % this.config.numTeams;
    this.currentWordId = null;
    this.turnEndsAt = null;
    this.guessedThisTurn = [];
    this.carryMs = carrying ? remainingMs : null;

    // A carry-over ALWAYS pauses on the recap (so the cleared words show and
    // review can still adjust them) before the same player resumes next round.
    // With review on, even an ordinary bowl-emptying turn pauses on the recap so
    // its words can be corrected; continueFromSummary then routes to the round
    // break (or back to play if a word was sent back). With review off and no
    // carry, an emptied bowl ends the round straight away, as before.
    const roundComplete = (reason === 'empty') && !this.config.reviewGuesses && !carrying;
    this.phase = roundComplete ? PHASES.ROUND_BREAK : PHASES.TURN_SUMMARY;
  }

  /**
   * The turn recap as broadcast to EVERYONE. When showGuessedWords is off we
   * strip the actual word text (items[].text and words[]) so opponents can't
   * learn the recurring bowl — the same words come back every round. The
   * just-played clue-giver still gets the full text privately, via
   * privateStateFor().summaryItems / summaryWords.
   */
  _publicSummary() {
    const s = this.lastTurnSummary;
    if (!s) return null;
    if (this.config.showGuessedWords) return s;
    return {
      teamIndex: s.teamIndex,
      reason: s.reason,
      round: s.round,
      cluerId: s.cluerId,
      scored: s.scored,
      carry: s.carry,
      hidden: true,
      items: (s.items || []).map(it => ({ id: it.id, included: it.included })),
      words: [],
    };
  }

  /** Recompute the derived score/word fields after a review toggle. */
  _refreshSummaryDerived() {
    const s = this.lastTurnSummary;
    if (!s || !s.items) return;
    const included = s.items.filter(it => it.included);
    s.words = included.map(it => it.text);
    s.scored = included.length;
  }

  /**
   * Review step (host-toggle `reviewGuesses`): the clue-giver who just played
   * unchecks a mis-scored word (loses the point, word returns to the bowl to be
   * replayed) or re-checks one. Only valid on the turn recap, only by that
   * clue-giver.
   */
  reviewGuessedWord(actorId, wordId, included) {
    if (this.phase !== PHASES.TURN_SUMMARY) return { ok: false, error: 'Not reviewing a turn.' };
    if (!this.config.reviewGuesses) return { ok: false, error: 'Word review is turned off.' };
    const s = this.lastTurnSummary;
    if (!s || !s.items) return { ok: false, error: 'Nothing to review.' };
    if (actorId !== s.cluerId) return { ok: false, error: 'Only the clue-giver can adjust their words.' };
    const item = s.items.find(it => it.id === wordId);
    if (!item) return { ok: false, error: 'Unknown word.' };

    const want = !!included;
    if (item.included === want) return { ok: true }; // no-op

    const row = this.scores[s.teamIndex];
    // Keep the clue-giver's per-player tally in lockstep with the team score.
    const cluer = this.getPlayer(s.cluerId);
    if (want) {
      // Re-count it: restore the point and pull it back out of the bowl.
      row[s.round] = (row[s.round] || 0) + 1;
      if (cluer) cluer.scores[s.round] = (cluer.scores[s.round] || 0) + 1;
      const i = this.remaining.indexOf(wordId);
      if (i !== -1) this.remaining.splice(i, 1);
      item.included = true;
    } else {
      // Discount it: drop the point and return the word to the bowl to replay.
      row[s.round] = Math.max(0, (row[s.round] || 0) - 1);
      if (cluer) cluer.scores[s.round] = Math.max(0, (cluer.scores[s.round] || 0) - 1);
      if (!this.remaining.includes(wordId)) this.remaining.push(wordId);
      item.included = false;
    }
    this._refreshSummaryDerived();
    return { ok: true };
  }

  _wordText(wid) {
    const w = this.bowl.find(x => x.id === wid);
    return w ? w.text : '';
  }

  /** Advance from the per-turn recap to the next clue-giver. */
  continueFromSummary(id) {
    if (this.phase !== PHASES.TURN_SUMMARY) return;
    if (id !== this.hostId && id !== this.currentClueGiverId) return;

    // carryOverTime: the same clue-giver keeps their leftover time (carryMs is
    // still armed — startTurn consumes it). An empty bowl means the round is
    // genuinely complete, so open the NEXT round; the clue-giver stays the same
    // because _concludeTurn left the rotation/team cursors untouched. If a word
    // was sent back during review the round isn't done — the same clue-giver
    // just finishes the CURRENT round with the carried time.
    if (this.carryMs != null) {
      if (!this.remaining.length) { this.currentRound += 1; this._openRound(); }
      else this.phase = PHASES.TURN_READY;
      return;
    }

    // If the bowl emptied (incl. after a review left every word counted), the
    // round is over; otherwise hand off to the next clue-giver. With review off
    // the bowl is always non-empty here, so this stays TURN_READY as before.
    this.phase = this.remaining.length ? PHASES.TURN_READY : PHASES.ROUND_BREAK;
  }

  get isFinalRound() { return this.currentRound >= this.roundTypes.length - 1; }

  nextRound(actorId) {
    if (actorId !== this.hostId) return;
    if (this.phase !== PHASES.ROUND_BREAK) return;
    if (this.isFinalRound) return;
    this.currentRound += 1;
    this._openRound();
  }

  finishGame(actorId) {
    if (actorId !== this.hostId) return;
    if (this.phase !== PHASES.ROUND_BREAK) return;
    if (!this.isFinalRound) return;
    this._computeWinners();
    this.phase = PHASES.GAMEOVER;
  }

  _computeWinners() {
    const totals = this.scores.map(s => s.reduce((a, b) => a + b, 0));
    const top = Math.max(...totals);
    this.winners = totals.map((t, i) => (t === top ? i : -1)).filter(i => i >= 0);
    this.isTie = this.winners.length > 1;
  }

  /** Optional sudden-death tiebreaker: one more (Describe-style) round. */
  startSuddenDeath(actorId) {
    if (actorId !== this.hostId) return;
    if (this.phase !== PHASES.GAMEOVER || !this.isTie) return;
    this.roundTypes.push('sudden');
    this.scores.forEach(s => s.push(0));
    this.players.forEach(p => {
      (p.scores || (p.scores = [])).push(0);
      (p.skips || (p.skips = [])).push(0);
    });
    this.currentRound = this.roundTypes.length - 1;
    this.suddenDeath = true;
    this.winners = null;
    this.isTie = false;
    this._openRound();
  }

  /** Re-lobby keeping players, teams and config; players re-enter new words. */
  playAgain(actorId) {
    if (actorId !== this.hostId) return;
    const players = this.players.map(p => ({ ...p, words: [], submitted: false, scores: [], skips: [] }));
    const config = this.config;
    const hostId = this.hostId;
    this.reset();
    this.players = players;
    this.config = config;
    this.hostId = hostId;
    this.roundTypes = buildRoundList(config.numRounds);
    this.phase = PHASES.SUBMISSION;
  }

  // -------------------------------------------------------------------------
  // Snapshot / restore — lets a HOST reload rehydrate the in-progress game.
  // -------------------------------------------------------------------------
  serialize() {
    return JSON.parse(JSON.stringify({
      phase: this.phase,
      players: this.players,
      hostId: this.hostId,
      config: this.config,
      roundTypes: this.roundTypes,
      currentRound: this.currentRound,
      bowl: this.bowl,
      remaining: this.remaining,
      currentWordId: this.currentWordId,
      currentTeamIndex: this.currentTeamIndex,
      cluerPointers: this.cluerPointers,
      guessedThisTurn: this.guessedThisTurn,
      turnEndsAt: this.turnEndsAt,
      carryMs: this.carryMs,
      scores: this.scores,
      lastTurnSummary: this.lastTurnSummary,
      suddenDeath: this.suddenDeath,
      winners: this.winners,
      isTie: this.isTie,
    }));
  }

  restore(s) {
    if (!s) return;
    this.reset();
    Object.assign(this, {
      phase: s.phase ?? PHASES.LOBBY,
      players: Array.isArray(s.players) ? s.players : [],
      hostId: s.hostId ?? null,
      config: normalizeConfig(s.config || {}),
      roundTypes: Array.isArray(s.roundTypes) ? s.roundTypes : buildRoundList(DEFAULTS.numRounds),
      currentRound: s.currentRound ?? 0,
      bowl: Array.isArray(s.bowl) ? s.bowl : [],
      remaining: Array.isArray(s.remaining) ? s.remaining : [],
      currentWordId: s.currentWordId ?? null,
      currentTeamIndex: s.currentTeamIndex ?? 0,
      cluerPointers: Array.isArray(s.cluerPointers) ? s.cluerPointers : [],
      guessedThisTurn: Array.isArray(s.guessedThisTurn) ? s.guessedThisTurn : [],
      turnEndsAt: s.turnEndsAt ?? null,
      carryMs: s.carryMs ?? null,
      scores: Array.isArray(s.scores) ? s.scores : [],
      lastTurnSummary: s.lastTurnSummary ?? null,
      suddenDeath: !!s.suddenDeath,
      winners: s.winners ?? null,
      isTie: !!s.isTie,
    });
    // A live turn timer can't survive a reload reliably; settle to the recap so
    // play resumes cleanly rather than against a stale clock.
    if (this.phase === PHASES.TURN_ACTIVE) {
      this.endTurnByTime();
    }
    // Everyone is offline until their connection re-establishes after reload.
    // Guard older snapshots that predate per-player stats.
    this.players.forEach(p => {
      p.online = (p.id === this.hostId);
      if (!Array.isArray(p.scores)) p.scores = [];
      if (!Array.isArray(p.skips)) p.skips = [];
      if (p.clientId === undefined) p.clientId = null;
    });
  }

  // -------------------------------------------------------------------------
  // Projections
  // -------------------------------------------------------------------------

  /** A light summary a joiner can read BEFORE committing to the game. */
  lobbyInfo(hostName) {
    return {
      hostName: (hostName || 'Host').trim(),
      playerCount: this.count,
      phase: this.phase,
      joinable: this.phase === PHASES.LOBBY && this.count < MAX_PLAYERS,
    };
  }

  _teamsView() {
    const clueId = this.currentClueGiverId;
    return Array.from({ length: this.config.numTeams }, (_, t) => {
      const theme = teamTheme(t);
      const members = this._teamMembers(t).map(p => ({
        id: p.id, name: p.name, online: p.online, isCluer: p.id === clueId,
        scores: (p.scores || []).slice(),
        total: (p.scores || []).reduce((a, b) => a + b, 0),
        skips: (p.skips || []).slice(),
        skipTotal: (p.skips || []).reduce((a, b) => a + b, 0),
      }));
      const rowScores = this.scores[t] || [];
      return {
        index: t,
        name: theme.name,
        color: theme.color,
        dim: theme.dim,
        members,
        scores: rowScores.slice(),
        roundScore: rowScores[this.currentRound] || 0,
        total: rowScores.reduce((a, b) => a + b, 0),
        isCurrent: t === this.currentTeamIndex,
        cluer: this._teamCluerAt(t, 0),      // who clues when this team is up
        nextCluer: this._teamCluerAt(t, 1),  // the teammate after them
      };
    });
  }

  _roundView() {
    const id = this.roundTypes[this.currentRound] || 'describe';
    const def = ROUND_TYPES[id];
    return {
      id, name: def.name, short: def.short, rule: def.rule,
      index: this.currentRound,
      total: this.roundTypes.length,
      isFinal: this.isFinalRound,
      isSudden: id === 'sudden',
    };
  }

  publicState() {
    const inTurn = this.phase === PHASES.TURN_ACTIVE;
    const clueId = this.currentClueGiverId;
    const clue = this.getPlayer(clueId);

    const state = {
      phase: this.phase,
      hostId: this.hostId,
      config: { ...this.config },
      playerCount: this.count,
      players: this.players.map(p => ({
        id: p.id, name: p.name, online: p.online, team: p.team,
        isHost: p.id === this.hostId,
      })),

      round: this._roundView(),
      teams: this._teamsView(),
      currentTeamIndex: this.currentTeamIndex,
      clueGiver: clue ? { id: clue.id, name: clue.name, team: clue.team } : null,

      bowlRemaining: this.remaining.length + (this.currentWordId ? 1 : 0),
      bowlTotal: this.bowl.length,
      guessedThisTurn: this.guessedThisTurn.length,

      timerSeconds: this.config.timerSeconds,
      turnRemainingMs: inTurn && this.turnEndsAt
        ? Math.max(0, this.turnEndsAt - Date.now())
        : null,
      // Time the clue-giver is carrying into the next round (shown on the recap
      // and the ready screen before they resume); null when not carrying.
      carryMs: this.carryMs,

      lastTurnSummary: this._publicSummary(),
      suddenDeath: this.suddenDeath,
    };

    if (this.phase === PHASES.SUBMISSION) {
      state.submittedCount = this.submittedCount;
      state.allSubmitted = this.allSubmitted;
    }

    if (this.phase === PHASES.GAMEOVER) {
      state.winners = this.winners || [];
      state.isTie = this.isTie;
    }
    return state;
  }

  privateStateFor(id) {
    const p = this.getPlayer(id);
    if (!p) return null;
    const priv = {
      playerId: id,
      name: p.name,
      team: p.team,
      teamName: teamTheme(p.team).name,
      teamColor: teamTheme(p.team).color,
      isHost: id === this.hostId,
    };

    if (this.phase === PHASES.SUBMISSION) {
      priv.submitted = !!p.submitted;
      priv.words = (p.words || []).slice();
      priv.wordsNeeded = this.config.wordsPerPlayer;
    }

    const isClue = id === this.currentClueGiverId;
    priv.isClueGiver = isClue;

    if (this.phase === PHASES.TURN_READY) {
      priv.isUpNext = isClue;
    }

    if (this.phase === PHASES.TURN_ACTIVE && isClue) {
      // THE one secret in Fishbowl — reaches ONLY the active clue-giver.
      priv.currentWord = this._wordText(this.currentWordId);
      priv.guessedWords = this.guessedThisTurn.map(wid => this._wordText(wid));
      priv.canSkip = this.config.allowSkip;
    }

    if (this.phase === PHASES.TURN_SUMMARY) {
      priv.canContinue = (id === this.hostId) || isClue;
      const justCluer = !!this.lastTurnSummary && id === this.lastTurnSummary.cluerId;
      // Only the clue-giver who just played may fix their scored words.
      priv.canReviewGuesses = !!this.config.reviewGuesses && justCluer;
      // The clue-giver who just played always sees their own words in full,
      // even when showGuessedWords hides them from everyone else.
      if (justCluer) {
        priv.summaryItems = (this.lastTurnSummary.items || []).map(it => ({ ...it }));
        priv.summaryWords = (this.lastTurnSummary.words || []).slice();
      }
    }

    return priv;
  }
}
