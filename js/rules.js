// ============================================================================
// rules.js — ALL Fishbowl rule constants + pure logic. Start reading here.
//
// Fishbowl (a.k.a. Salad Bowl / Celebrities): every player submits a few
// words into a shared "bowl". The SAME words are reused for every round, only
// the way you may clue them changes:
//   Round 1 — DESCRIBE : say anything except the word (or part/rhyme of it).
//   Round 2 — ACT      : silent charades, no talking and no sounds.
//   Round 3 — ONE WORD : exactly one spoken word as the clue.
//   Round 4 — STATUE   : (optional) one frozen pose, no movement. (toggle)
//
// This module holds only constants and pure functions. The host-authoritative
// state machine lives in state.js.
// ============================================================================

// ---- Lobby / setup limits --------------------------------------------------
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 20;
export const MIN_PER_TEAM = 2;
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 4;

// ---- Configurable settings (host sets these before the game starts) --------
export const DEFAULTS = Object.freeze({
  wordsPerPlayer: 5,   // words each player adds to the bowl
  timerSeconds: 60,    // length of a single turn
  numTeams: 2,         // 2–4
  numRounds: 3,        // 3, or 4 to include the STATUE round
  allowSkip: false,    // may the clue-giver pass on a word?
  reviewGuesses: false,// after each turn, may the clue-giver uncheck a
                       // mis-scored word? (loses the point, returns to bowl)
});

export const LIMITS = Object.freeze({
  wordsPerPlayer: { min: 1, max: 10 },
  timerSeconds:   { min: 20, max: 180 },
  numTeams:       { min: MIN_TEAMS, max: MAX_TEAMS },
  numRounds:      { min: 3, max: 4 },
});

// ---- Round definitions -----------------------------------------------------
// `id` is stable; the engine builds the per-game round list from these.
export const ROUND_TYPES = Object.freeze({
  describe: { id: 'describe', name: 'Describe',  short: 'R1',
    rule: 'Say anything — but never the word, any part of it, or a rhyme.' },
  act:      { id: 'act',      name: 'Act it out', short: 'R2',
    rule: 'Silent charades. No talking, no sounds, no pointing at objects.' },
  oneword:  { id: 'oneword',  name: 'One word',   short: 'R3',
    rule: 'Say exactly ONE word as your clue. Then only repeat that one word.' },
  statue:   { id: 'statue',   name: 'Statue',     short: 'R4',
    rule: 'One frozen pose. Strike it and hold completely still — no movement.' },
  sudden:   { id: 'sudden',   name: 'Sudden death', short: 'SD',
    rule: 'Tiebreaker — describe the word (no saying it) to break the tie.' },
});

// The ordered round list for a game with `numRounds` rounds.
export function buildRoundList(numRounds) {
  const list = ['describe', 'act', 'oneword'];
  if (numRounds >= 4) list.push('statue');
  return list;
}

// ---- Team identity (name + colour) ----------------------------------------
// Colours are deliberately distinct on the dark water theme. Index 0 is the
// aqua accent so a 2-team game reads as "the house colour vs. coral".
export const TEAM_THEMES = Object.freeze([
  { name: 'Blue',   color: '#38D6F0', dim: 'rgba(56, 214, 240, 0.14)' }, // aqua
  { name: 'Orange', color: '#FF9F6B', dim: 'rgba(255, 159, 107, 0.16)' }, // coral
  { name: 'Purple', color: '#B38CF5', dim: 'rgba(179, 140, 245, 0.16)' }, // violet
  { name: 'Green',  color: '#5EE6A8', dim: 'rgba(94, 230, 168, 0.16)' }, // sea-green
]);

export function teamTheme(index) {
  return TEAM_THEMES[index % TEAM_THEMES.length];
}

// ---- Pure helpers ----------------------------------------------------------

/** Fisher–Yates, returns a NEW shuffled array (crypto-seeded when available). */
export function shuffle(arr) {
  const a = arr.slice();
  const rnd = (n) => {
    try {
      const buf = new Uint32Array(1);
      (crypto || window.crypto).getRandomValues(buf);
      return buf[0] % n;
    } catch (_) {
      return Math.floor(Math.random() * n);
    }
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Clamp a number into [min, max], coercing non-numbers to the fallback. */
export function clampInt(value, min, max, fallback) {
  let n = parseInt(value, 10);
  if (!Number.isFinite(n)) n = fallback;
  return Math.max(min, Math.min(max, n));
}

/** Sanitise a single submitted word: trim, collapse inner whitespace, cap. */
export function cleanWord(raw) {
  return (raw || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/** Normalise a host config object against the limits above. */
export function normalizeConfig(cfg = {}) {
  const c = { ...DEFAULTS, ...cfg };
  return {
    wordsPerPlayer: clampInt(c.wordsPerPlayer, LIMITS.wordsPerPlayer.min, LIMITS.wordsPerPlayer.max, DEFAULTS.wordsPerPlayer),
    timerSeconds:   clampInt(c.timerSeconds, LIMITS.timerSeconds.min, LIMITS.timerSeconds.max, DEFAULTS.timerSeconds),
    numTeams:       clampInt(c.numTeams, LIMITS.numTeams.min, LIMITS.numTeams.max, DEFAULTS.numTeams),
    numRounds:      clampInt(c.numRounds, LIMITS.numRounds.min, LIMITS.numRounds.max, DEFAULTS.numRounds),
    allowSkip:      !!c.allowSkip,
    reviewGuesses:  !!c.reviewGuesses,
  };
}

/**
 * Can the game start? Needs the player floor, every team filled to the
 * per-team minimum, and at least one team of each colour occupied.
 * `teamCounts` is an array of member counts per team index.
 */
export function validateStart(playerCount, teamCounts) {
  const errors = [];
  if (playerCount < MIN_PLAYERS) errors.push(`Need at least ${MIN_PLAYERS} players.`);
  teamCounts.forEach((n, i) => {
    if (n < MIN_PER_TEAM) errors.push(`${teamTheme(i).name} needs at least ${MIN_PER_TEAM} players.`);
  });
  return { ok: errors.length === 0, errors };
}
