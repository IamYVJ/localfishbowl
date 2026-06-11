// ============================================================================
// ui.js — All rendering. Pure view layer: given app state + intent callbacks,
// it builds DOM. It never touches the network or the game engine directly.
//
//   render(root, app, intents)
//     app     : { screen, me, code, pub, priv, error, wordDrafts, clockMs, ... }
//     intents : host/join/setName/setConfig/submitWords/startTurn/gotIt/… }
// ============================================================================

import { el, clear } from './util.js';
import {
  ROUND_TYPES, LIMITS, MIN_PLAYERS, MAX_PLAYERS, MIN_PER_TEAM,
} from './rules.js';

export function render(root, app, intents) {
  clear(root);
  let node;
  switch (app.screen) {
    case 'home':       node = homeScreen(app, intents); break;
    case 'join':       node = joinScreen(app, intents); break;
    case 'connecting': node = infoScreen('Connecting…', `Reaching room ${app.code}.`, true); break;
    case 'error':      node = errorScreen(app, intents); break;
    case 'hostleft':   node = infoScreen('Host left', 'The host ended the game. Thanks for playing.', false,
                                          el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK HOME')); break;
    case 'game':       node = gameScreen(app, intents); break;
    default:           node = homeScreen(app, intents);
  }
  root.appendChild(node);
  if (app.showRules) root.appendChild(rulesOverlay(intents));
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------
function wordmark(intents) {
  return el('div', { class: 'wordmark' },
    el('span', { class: 'wordmark-dot' }),
    el('span', { class: 'wordmark-text' }, 'FISHBOWL'),
    el('button', { class: 'help-btn', 'aria-label': 'How to play', title: 'How to play',
      onclick: () => intents.toggleRules() }, '?'),
  );
}

function shell(...children) { return el('main', { class: 'shell' }, ...children); }
function liveRegion(text) {
  return el('div', { class: 'sr-only', 'aria-live': 'polite', role: 'status' }, text || '');
}
function panel(label, ...children) {
  return el('section', { class: 'panel' },
    label ? el('div', { class: 'section-label' }, label) : null,
    ...children);
}

// ---------------------------------------------------------------------------
// HOME
// ---------------------------------------------------------------------------
function homeScreen(app, intents) {
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '16', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name', 'data-focus': 'name',
    oninput: (e) => intents.setName(e.target.value),
  });

  return shell(
    wordmark(intents),
    el('h1', { class: 'hero' }, 'Fishbowl'),
    el('p', { class: 'tagline' },
      'The party classic, played on your phones. Drop words in the ',
      el('span', { class: 'accent' }, 'bowl'),
      ', then describe, act, and one-word your way to victory — same words, three ways.'),
    el('div', { class: 'field-group' }, nameInput),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.host() }, '+ HOST GAME'),
      el('button', { class: 'btn btn-secondary', onclick: () => intents.gotoJoin() }, '▷ JOIN GAME'),
    ),
    el('button', { class: 'link-btn', onclick: () => intents.toggleRules() }, 'How to play'),
    el('p', { class: 'fine' }, 'Plays peer-to-peer in your browser on the same Wi-Fi. No accounts, no servers.'),
  );
}

// ---------------------------------------------------------------------------
// JOIN
// ---------------------------------------------------------------------------
function joinScreen(app, intents) {
  const nameInput = el('input', {
    class: 'field', type: 'text', maxlength: '16', placeholder: 'Your name',
    value: app.me.name || '', 'aria-label': 'Your name', 'data-focus': 'name',
    oninput: (e) => intents.setName(e.target.value),
  });
  const codeInput = el('input', {
    class: 'field field-code', type: 'text', maxlength: '4', placeholder: 'CODE',
    value: app.code || '', autocapitalize: 'characters', autocomplete: 'off',
    'aria-label': 'Room code', 'data-focus': 'code',
    oninput: (e) => { e.target.value = e.target.value.toUpperCase(); },
  });

  return shell(
    wordmark(intents),
    el('h1', { class: 'hero hero-sm' }, 'Join a game'),
    el('p', { class: 'tagline' }, 'Pick a game on your ', el('span', { class: 'accent' }, 'Wi-Fi'), ' — or enter a code.'),
    el('div', { class: 'field-group' }, nameInput),
    el('div', { class: 'section-label' }, 'GAMES ON THIS NETWORK'),
    discoveryList(app, intents, nameInput),
    el('div', { class: 'section-label' }, 'OR ENTER A CODE'),
    el('div', { class: 'field-group' }, codeInput),
    app.error ? el('p', { class: 'error-text', role: 'alert' }, app.error) : null,
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.join(codeInput.value, nameInput.value) }, '> CONNECT'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK'),
    ),
    el('button', { class: 'link-btn', onclick: () => intents.spectate(codeInput.value) },
      '📺 Watch on a TV / big screen'),
    el('p', { class: 'fine' }, 'Spectators see the scoreboard, timer and whose turn it is — never the secret words.'),
  );
}

function discoveryList(app, intents, nameInput) {
  const state = app.discoveryState || 'idle';
  const games = app.discovered || [];

  if (state === 'unsupported') {
    return el('p', { class: 'fine' },
      'Automatic discovery isn’t available on the public signaling server — ',
      'enter the 4-character code the host is showing instead. ',
      '(Self-host a PeerServer on your LAN to enable the live list.)');
  }
  if (state === 'searching' && games.length === 0) {
    return el('div', { class: 'discovery-status' },
      el('div', { class: 'spinner spinner-sm' }),
      el('span', { class: 'fine' }, 'Looking for open games…'));
  }
  if (games.length === 0) {
    return el('p', { class: 'fine' },
      'No open games found yet. Make sure you’re on the same Wi-Fi as the host, or enter a code below.');
  }
  return el('ul', { class: 'game-list' },
    ...games.map(g => el('li', {},
      el('button', {
        class: 'game-row' + (g.joinable ? '' : ' game-row-busy'),
        disabled: g.joinable ? false : true,
        onclick: () => g.joinable && intents.join(g.code, nameInput.value),
      },
        el('span', { class: 'game-code' }, g.code),
        el('span', { class: 'game-meta' },
          el('span', { class: 'game-host' }, (g.hostName || 'Host') + '’s game'),
          el('span', { class: 'game-sub' },
            g.joinable
              ? `${g.playerCount} ${g.playerCount === 1 ? 'player' : 'players'} in lobby`
              : 'In progress — can’t join'),
        ),
        el('span', { class: 'game-go' }, g.joinable ? '▷' : '🔒'),
      ),
    )),
  );
}

function infoScreen(title, body, spinner, ...extra) {
  return shell(
    el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), el('span', { class: 'wordmark-text' }, 'FISHBOWL')),
    el('h1', { class: 'hero hero-sm' }, title),
    el('p', { class: 'tagline' }, body),
    spinner ? el('div', { class: 'spinner' }) : null,
    ...extra,
    liveRegion(title),
  );
}

function errorScreen(app, intents) {
  return shell(
    el('div', { class: 'wordmark' }, el('span', { class: 'wordmark-dot' }), el('span', { class: 'wordmark-text' }, 'FISHBOWL')),
    el('h1', { class: 'hero hero-sm' }, 'Connection problem'),
    el('p', { class: 'error-text', role: 'alert' }, app.error || 'Something went wrong.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, '‹ BACK HOME')),
  );
}

// ---------------------------------------------------------------------------
// GAME (dispatches on phase)
// ---------------------------------------------------------------------------
function gameScreen(app, intents) {
  const pub = app.pub;
  if (!pub) return infoScreen('Loading…', 'Syncing with the host.', true);
  if (app.me.isSpectator) return spectatorScreen(app, intents);
  switch (pub.phase) {
    case 'lobby':       return lobbyScreen(app, intents);
    case 'submission':  return submissionScreen(app, intents);
    case 'turnReady':   return turnReadyScreen(app, intents);
    case 'turnActive':  return turnActiveScreen(app, intents);
    case 'turnSummary': return turnSummaryScreen(app, intents);
    case 'roundBreak':  return roundBreakScreen(app, intents);
    case 'gameover':    return gameOverScreen(app, intents);
    default:            return infoScreen('Loading…', 'Syncing with the host.', true);
  }
}

// ---------------------------------------------------------------------------
// LOBBY
// ---------------------------------------------------------------------------
function lobbyScreen(app, intents) {
  const pub = app.pub;
  const isHost = app.me.isHost;
  const teams = pub.teams;

  const children = [
    wordmark(intents),
    codeCard(app, intents),
    el('div', { class: 'section-label' }, `PLAYERS · ${pub.playerCount}/${MAX_PLAYERS}`),
    teamColumns(pub, app, intents, isHost),
  ];

  if (isHost) {
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: () => intents.autoBalance() }, '⇄ AUTO-BALANCE TEAMS')));
    children.push(configEditor(app, intents));

    const teamCounts = teams.map(t => t.members.length);
    const enoughPlayers = pub.playerCount >= MIN_PLAYERS;
    const teamsOk = teamCounts.every(n => n >= MIN_PER_TEAM);
    const canStart = enoughPlayers && teamsOk;
    if (!canStart) {
      children.push(el('p', { class: 'fine' },
        !enoughPlayers ? `Need at least ${MIN_PLAYERS} players to start.`
                       : `Every team needs at least ${MIN_PER_TEAM} players.`));
    }
    if (app.error) children.push(el('p', { class: 'error-text', role: 'alert' }, app.error));
    children.push(el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary' + (canStart ? '' : ' btn-disabled'),
        disabled: canStart ? false : true,
        onclick: () => canStart && intents.startSubmission(),
      }, '> START — ADD WORDS'),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE'),
    ));
  } else {
    children.push(el('p', { class: 'tagline' }, 'Waiting for the host to ', el('span', { class: 'accent' }, 'start the game'), '…'));
    children.push(el('div', { class: 'spinner' }));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
  }

  return shell(...children, liveRegion(`${pub.playerCount} players in the lobby`));
}

function codeCard(app, intents) {
  return el('div', { class: 'code-card', title: 'Tap to copy', onclick: () => intents.copyCode && intents.copyCode() },
    el('div', { class: 'code-label' }, 'ROOM CODE'),
    el('div', { class: 'code-value' }, app.code || '----'),
    el('div', { class: 'code-hint' }, app.copied ? 'COPIED ✓' : 'TAP TO COPY'),
  );
}

// Team columns; in the lobby the host can tap a player to reassign teams.
function teamColumns(pub, app, intents, editable) {
  return el('div', { class: 'team-cols cols-' + pub.teams.length },
    ...pub.teams.map(team => el('div', { class: 'team-col', style: `--team:${team.color};--team-dim:${team.dim}` },
      el('div', { class: 'team-col-head' }, team.name),
      el('ul', { class: 'team-members' },
        ...(team.members.length
          ? team.members.map(m => el('li', { class: 'team-member' + (m.id === app.me.id ? ' is-me' : '') },
              el('span', { class: 'dot ' + (m.online ? 'on' : 'off') }),
              el('span', { class: 'tm-name' }, m.name),
            ))
          : [el('li', { class: 'team-member empty' }, 'No players yet')]),
      ),
    )),
    editable ? assignList(pub, intents) : null,
  );
}

// Host-only: a compact "who is on which team" reassignment list.
function assignList(pub, intents) {
  return el('div', { class: 'assign-list' },
    el('div', { class: 'section-label' }, 'ASSIGN TEAMS'),
    ...pub.players.map(p => el('div', { class: 'assign-row' },
      el('span', { class: 'assign-name' }, p.name + (p.isHost ? ' ★' : '')),
      el('div', { class: 'assign-teams' },
        ...pub.teams.map(t => el('button', {
          class: 'team-pick' + (p.team === t.index ? ' sel' : ''),
          style: `--team:${t.color}`,
          title: t.name,
          onclick: () => intents.setPlayerTeam(p.id, t.index),
        }, String(t.index + 1))),
      ),
    )),
  );
}

function configEditor(app, intents) {
  const c = app.pub.config;
  return el('section', { class: 'config' },
    el('div', { class: 'section-label' }, 'GAME SETTINGS'),
    stepper('Words per player', c.wordsPerPlayer, LIMITS.wordsPerPlayer, (v) => intents.setConfig({ wordsPerPlayer: v })),
    stepper('Turn timer', c.timerSeconds, LIMITS.timerSeconds, (v) => intents.setConfig({ timerSeconds: v }), 's', 5),
    stepper('Teams', c.numTeams, LIMITS.numTeams, (v) => intents.setConfig({ numTeams: v })),
    toggleRow('Include Statue round (4th)', c.numRounds >= 4,
      () => intents.setConfig({ numRounds: c.numRounds >= 4 ? 3 : 4 }),
      'Adds a silent one-frozen-pose round after One Word.'),
    toggleRow('Allow skip / pass', c.allowSkip,
      () => intents.setConfig({ allowSkip: !c.allowSkip }),
      'Lets the clue-giver return a hard word to the bowl and draw the next.'),
  );
}

function stepper(label, value, limit, onChange, suffix = '', step = 1) {
  const dec = () => onChange(Math.max(limit.min, value - step));
  const inc = () => onChange(Math.min(limit.max, value + step));
  return el('div', { class: 'stepper' },
    el('span', { class: 'stepper-label' }, label),
    el('div', { class: 'stepper-ctrl' },
      el('button', { class: 'step-btn', 'aria-label': 'Decrease ' + label,
        disabled: value <= limit.min ? true : false, onclick: dec }, '−'),
      el('span', { class: 'stepper-val' }, value + suffix),
      el('button', { class: 'step-btn', 'aria-label': 'Increase ' + label,
        disabled: value >= limit.max ? true : false, onclick: inc }, '+'),
    ),
  );
}

function toggleRow(name, on, onToggle, blurb) {
  return el('label', { class: 'toggle' + (on ? ' on' : '') },
    el('input', { type: 'checkbox', ...(on ? { checked: true } : {}), onchange: onToggle }),
    el('span', { class: 'toggle-box' }),
    el('span', { class: 'toggle-text' },
      el('span', { class: 'toggle-name' }, name),
      blurb ? el('span', { class: 'toggle-blurb' }, blurb) : null,
    ),
  );
}

// ---------------------------------------------------------------------------
// SUBMISSION
// ---------------------------------------------------------------------------
function submissionScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};
  const need = priv.wordsNeeded || pub.config.wordsPerPlayer;
  const isHost = app.me.isHost;

  const children = [
    wordmark(intents),
    el('h1', { class: 'hero hero-sm' }, 'Fill the bowl'),
    el('p', { class: 'tagline' },
      'Secretly add ', el('span', { class: 'accent' }, `${need} words`),
      ' — names, places, things, phrases. They’re hidden until drawn.'),
    el('div', { class: 'section-label' }, `READY · ${pub.submittedCount}/${pub.playerCount}`),
    teamTag(priv),
  ];

  if (priv.submitted) {
    children.push(panel('YOUR WORDS — LOCKED IN ✓',
      el('ul', { class: 'word-list' }, ...(priv.words || []).map(w => el('li', { class: 'word-chip' }, w))),
      el('p', { class: 'fine' }, 'You can edit until everyone is ready.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-secondary', onclick: () => intents.editWords() }, '✎ EDIT WORDS')),
    ));
  } else {
    const inputs = el('div', { class: 'field-group' },
      ...Array.from({ length: need }, (_, i) => el('input', {
        class: 'field', type: 'text', maxlength: '60',
        placeholder: `Word ${i + 1}`,
        value: (app.wordDrafts && app.wordDrafts[i]) || '',
        'aria-label': `Word ${i + 1}`, 'data-focus': `word-${i}`,
        autocomplete: 'off',
        oninput: (e) => intents.setWordDraft(i, e.target.value),
      })),
    );
    if (app.error) children.push(el('p', { class: 'error-text', role: 'alert' }, app.error));
    children.push(panel('YOUR WORDS', inputs,
      el('p', { class: 'fine' }, 'Keep your screen private!'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', onclick: () => intents.submitWords() }, '> DROP IN THE BOWL')),
    ));
  }

  // Host start gate.
  if (isHost) {
    const canBegin = pub.allSubmitted;
    children.push(el('div', { class: 'btn-row' },
      el('button', {
        class: 'btn btn-primary' + (canBegin ? '' : ' btn-disabled'),
        disabled: canBegin ? false : true,
        onclick: () => canBegin && intents.beginPlay(),
      }, canBegin ? '> START ROUND 1' : `WAITING · ${pub.submittedCount}/${pub.playerCount}`),
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'END GAME'),
    ));
  } else if (priv.submitted) {
    children.push(el('p', { class: 'tagline' }, 'Waiting for everyone else and the host to ', el('span', { class: 'accent' }, 'start'), '…'));
    children.push(el('div', { class: 'spinner' }));
  }

  return shell(...children, liveRegion(`${pub.submittedCount} of ${pub.playerCount} players ready`));
}

function teamTag(priv) {
  if (!priv || priv.team == null) return null;
  return el('div', { class: 'team-tag', style: `--team:${priv.teamColor}` },
    el('span', { class: 'team-dot' }), 'You’re on ', el('strong', {}, priv.teamName));
}

// ---------------------------------------------------------------------------
// Shared board chrome for the play phases
// ---------------------------------------------------------------------------
function boardHead(pub) {
  const r = pub.round;
  return el('header', { class: 'board-head' },
    el('div', { class: 'round-row' },
      el('span', { class: 'round-pill' }, r.isSudden ? 'SUDDEN DEATH' : `ROUND ${r.index + 1}/${r.total}`),
      el('span', { class: 'round-name' }, r.name),
    ),
    el('p', { class: 'round-rule' }, r.rule),
    el('div', { class: 'bowl-count' },
      el('span', { class: 'bowl-num' }, String(pub.bowlRemaining)),
      el('span', { class: 'bowl-label' }, `of ${pub.bowlTotal} left in the bowl`)),
  );
}

function scoreboard(pub, app) {
  return el('ul', { class: 'scoreboard' },
    ...pub.teams.map(t => el('li', {
      class: 'score-row' + (t.isCurrent ? ' current' : ''),
      style: `--team:${t.color};--team-dim:${t.dim}`,
    },
      el('span', { class: 'score-team' },
        el('span', { class: 'team-dot' }),
        el('span', { class: 'score-name' }, t.name),
        t.members.some(m => m.id === app.me.id) ? el('span', { class: 'you-tag' }, 'you') : null,
      ),
      el('span', { class: 'score-detail' }, `+${t.roundScore} this round`),
      el('span', { class: 'score-total' }, String(t.total)),
    )),
  );
}

function clueGiverLine(pub) {
  const cg = pub.clueGiver;
  const team = cg ? pub.teams[cg.team] : null;
  return el('p', { class: 'cluer-line' },
    el('span', { class: 'team-dot', style: team ? `--team:${team.color}` : '' }),
    'Clue-giver: ', el('strong', {}, cg ? cg.name : '—'),
    team ? el('span', { class: 'muted' }, ` · ${team.name}`) : null,
  );
}

function lastTurnRecap(pub) {
  const s = pub.lastTurnSummary;
  if (!s) return null;
  const team = pub.teams[s.teamIndex];
  return el('div', { class: 'recap' },
    el('div', { class: 'section-label' }, `LAST TURN · ${team ? team.name : ''} · ${s.scored} guessed`),
    s.words.length
      ? el('ul', { class: 'word-list small' }, ...s.words.map(w => el('li', { class: 'word-chip' }, w)))
      : el('p', { class: 'fine' }, 'No words guessed.'),
  );
}

// ---------------------------------------------------------------------------
// TURN — READY (start gate)
// ---------------------------------------------------------------------------
function turnReadyScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};
  const team = pub.teams[pub.currentTeamIndex];
  const children = [wordmark(intents), boardHead(pub), scoreboard(pub, app)];

  if (priv.isUpNext) {
    children.push(panel(null,
      el('p', { class: 'big-prompt' }, 'You’re the clue-giver!'),
      el('p', { class: 'tagline' }, pub.round.rule),
      el('p', { class: 'fine' }, 'Hold your phone so only you can see it. Tap Start when your team is ready.'),
      el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary btn-xl', onclick: () => intents.startTurn() }, '▶ START TURN')),
    ));
  } else {
    children.push(panel(null,
      el('p', { class: 'big-prompt', style: team ? `color:${team.color}` : '' }, `${team ? team.name : ''} are up`),
      clueGiverLine(pub),
      el('p', { class: 'tagline' }, 'Get ready to guess out loud. Waiting for the clue-giver to start…'),
      el('div', { class: 'spinner' }),
    ));
    if (app.me.isHost) {
      children.push(el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-ghost', onclick: () => intents.skipClueGiver() }, 'Skip to next clue-giver')));
    }
  }

  children.push(lastTurnRecap(pub));
  return shell(...children, liveRegion(`${team ? team.name : ''} up next`));
}

// ---------------------------------------------------------------------------
// TURN — ACTIVE
// ---------------------------------------------------------------------------
function turnActiveScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};
  const team = pub.teams[pub.currentTeamIndex];
  const accent = team ? team.color : 'var(--accent)';

  const remainMs = app.clockMs != null ? app.clockMs : (pub.turnRemainingMs || 0);
  const totalMs = (pub.timerSeconds || 60) * 1000;
  const timer = timerBar(remainMs, totalMs, accent);

  if (priv.isClueGiver) {
    const got = (priv.guessedWords || []).length;
    const children = [
      el('div', { class: 'clue-top' },
        el('span', { class: 'round-pill' }, pub.round.short + ' · ' + pub.round.name),
        timerChip(remainMs, accent),
      ),
      el('div', { class: 'word-card', style: `--team:${accent}` },
        el('div', { class: 'word-eyebrow' }, 'YOUR WORD'),
        el('div', { class: 'word-text' }, priv.currentWord || '—'),
        el('div', { class: 'word-rule' }, pub.round.rule),
      ),
      timer,
      el('div', { class: 'got-count' }, `${got} guessed this turn · ${pub.bowlRemaining} left`),
      el('div', { class: 'action-stack' },
        el('button', { class: 'btn btn-primary btn-xl', onclick: () => intents.gotIt() }, '✓ GOT IT'),
        priv.canSkip
          ? el('button', { class: 'btn btn-secondary btn-skip', onclick: () => intents.skip() }, '↻ SKIP')
          : null,
      ),
    ];
    return shell(...children, liveRegion('Your turn — clue the word'));
  }

  // Everyone else: shared board, the word is NEVER shown.
  return shell(
    wordmark(intents),
    boardHead(pub),
    timer,
    el('div', { class: 'guess-prompt', style: `--team:${accent}` },
      el('p', { class: 'big-prompt', style: `color:${accent}` }, `${team ? team.name : ''} are clueing`),
      clueGiverLine(pub),
      el('p', { class: 'tagline' }, 'Shout out your guesses!'),
      el('div', { class: 'got-count' }, `${pub.guessedThisTurn} guessed this turn`),
    ),
    scoreboard(pub, app),
    liveRegion(`${team ? team.name : ''} are clueing`),
  );
}

function timerBar(remainMs, totalMs, accent) {
  const pct = Math.max(0, Math.min(100, (remainMs / totalMs) * 100));
  const low = remainMs <= 10000;
  return el('div', { class: 'timer' + (low ? ' low' : '') },
    el('div', { class: 'timer-fill', style: `width:${pct}%;--team:${accent}` }),
    el('span', { class: 'timer-text' }, formatTime(remainMs)),
  );
}

function timerChip(remainMs, accent) {
  const low = remainMs <= 10000;
  return el('span', { class: 'timer-chip' + (low ? ' low' : ''), style: `--team:${accent}` }, formatTime(remainMs));
}

function formatTime(ms) {
  const total = Math.ceil(Math.max(0, ms) / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// TURN — SUMMARY
// ---------------------------------------------------------------------------
function turnSummaryScreen(app, intents) {
  const pub = app.pub;
  const priv = app.priv || {};
  const s = pub.lastTurnSummary;
  const team = s ? pub.teams[s.teamIndex] : null;
  const nextTeam = pub.teams[pub.currentTeamIndex];

  const children = [
    wordmark(intents),
    el('div', { class: 'summary-banner', style: team ? `--team:${team.color};--team-dim:${team.dim}` : '' },
      el('div', { class: 'summary-eyebrow' }, s && s.reason === 'time' ? 'TIME!' : 'TURN OVER'),
      el('div', { class: 'summary-score', style: team ? `color:${team.color}` : '' },
        `+${s ? s.scored : 0}`),
      el('div', { class: 'summary-team' }, team ? team.name : ''),
    ),
    s && s.words.length
      ? panel('WORDS GUESSED THIS TURN',
          el('ul', { class: 'word-list' }, ...s.words.map(w => el('li', { class: 'word-chip' }, w))))
      : panel(null, el('p', { class: 'fine' }, 'No words guessed that turn.')),
    el('div', { class: 'next-up' },
      el('span', { class: 'team-dot', style: nextTeam ? `--team:${nextTeam.color}` : '' }),
      'Up next: ', el('strong', {}, nextTeam ? nextTeam.name : '—'),
      pub.clueGiver ? el('span', { class: 'muted' }, ` · ${pub.clueGiver.name}`) : null,
    ),
    scoreboard(pub, app),
  ];

  if (priv.canContinue) {
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.continueTurn() }, '> NEXT TURN')));
  } else {
    children.push(el('p', { class: 'fine' }, 'Waiting for the next turn to begin…'));
  }

  return shell(...children, liveRegion('Turn over'));
}

// ---------------------------------------------------------------------------
// ROUND BREAK
// ---------------------------------------------------------------------------
function roundBreakScreen(app, intents) {
  const pub = app.pub;
  const isHost = app.me.isHost;
  const r = pub.round;
  const nextType = !r.isFinal ? ROUND_TYPES[nextRoundId(pub)] : null;

  const children = [
    wordmark(intents),
    el('div', { class: 'round-done' },
      el('div', { class: 'summary-eyebrow' }, 'BOWL EMPTY'),
      el('h1', { class: 'hero hero-sm' }, r.isSudden ? 'Sudden death done' : `Round ${r.index + 1} complete`),
    ),
    fullScoreTable(pub, app),
  ];

  if (!r.isFinal) {
    children.push(el('p', { class: 'tagline' }, 'Same words, new challenge: ',
      el('span', { class: 'accent' }, nextType ? nextType.name : 'next round'), '.'));
    if (isHost) {
      children.push(el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', onclick: () => intents.nextRound() },
          `> START ROUND ${r.index + 2}`)));
    } else {
      children.push(waitingRow());
    }
  } else {
    if (isHost) {
      children.push(el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn-primary', onclick: () => intents.finishGame() }, '> SEE FINAL RESULTS')));
    } else {
      children.push(waitingRow());
    }
  }

  return shell(...children, liveRegion('Round complete'));
}

function nextRoundId(pub) {
  // The public round view doesn't ship the full list, so infer the next type.
  const order = ['describe', 'act', 'oneword', 'statue'];
  const idx = order.indexOf(pub.round.id);
  return order[idx + 1] || 'describe';
}

function waitingRow() {
  return el('div', { class: 'wait-row' },
    el('div', { class: 'spinner spinner-sm' }),
    el('span', { class: 'fine' }, 'Waiting for the host…'));
}

// ---------------------------------------------------------------------------
// GAME OVER
// ---------------------------------------------------------------------------
function gameOverScreen(app, intents) {
  const pub = app.pub;
  const isHost = app.me.isHost;
  const winners = (pub.winners || []).map(i => pub.teams[i]).filter(Boolean);
  const tie = pub.isTie;

  let banner;
  if (tie) {
    banner = el('div', { class: 'win-banner tie' },
      el('div', { class: 'win-eyebrow' }, 'IT’S A TIE'),
      el('div', { class: 'win-team' }, winners.map(t => t.name).join(' & ')),
      el('div', { class: 'win-score' }, `${winners[0] ? winners[0].total : 0} points each`),
    );
  } else {
    const w = winners[0];
    banner = el('div', { class: 'win-banner', style: w ? `--team:${w.color};--team-dim:${w.dim}` : '' },
      el('div', { class: 'win-eyebrow' }, 'WINNER'),
      el('div', { class: 'win-team', style: w ? `color:${w.color}` : '' }, w ? w.name : '—'),
      el('div', { class: 'win-score' }, w ? `${w.total} points` : ''),
    );
  }

  const children = [wordmark(intents), banner, fullScoreTable(pub, app)];

  if (isHost) {
    const row = [el('button', { class: 'btn btn-primary', onclick: () => intents.playAgain() }, '> PLAY AGAIN')];
    if (tie) row.unshift(el('button', { class: 'btn btn-secondary', onclick: () => intents.suddenDeath() }, '⚔ SUDDEN DEATH'));
    children.push(el('div', { class: 'btn-row' }, ...row));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-ghost', onclick: intents.goHome }, 'NEW GAME')));
  } else {
    children.push(el('p', { class: 'fine' }, 'Waiting for the host to start a new game, or leave to go home.'));
    children.push(el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-secondary', onclick: intents.goHome }, 'LEAVE')));
  }

  return shell(...children, liveRegion(tie ? 'It is a tie' : `${winners[0] ? winners[0].name : ''} wins`));
}

// A teams × rounds score table with totals.
function fullScoreTable(pub, app) {
  const rounds = pub.teams[0] ? pub.teams[0].scores.length : 0;
  const head = el('tr', {}, el('th', {}, 'Team'),
    ...Array.from({ length: rounds }, (_, i) => el('th', {}, roundColHeader(pub, i))),
    el('th', { class: 'tot-col' }, 'Total'));
  const body = pub.teams.map(t => el('tr', { class: t.isCurrent ? 'current' : '' },
    el('td', {},
      el('span', { class: 'team-dot', style: `--team:${t.color}` }),
      t.name + (t.members.some(m => m.id === app.me.id) ? ' (you)' : '')),
    ...t.scores.map(v => el('td', {}, String(v))),
    el('td', { class: 'tot-col' }, String(t.total)),
  ));
  return el('table', { class: 'score-table' }, el('thead', {}, head), el('tbody', {}, ...body));
}

function roundColHeader(pub, i) {
  // Round columns: R1..R3 (+R4 statue) then SD if a sudden-death column exists.
  const base = ['R1', 'R2', 'R3', 'R4'];
  const totalRounds = pub.teams[0] ? pub.teams[0].scores.length : 0;
  const hasSudden = pub.suddenDeath && i === totalRounds - 1;
  return hasSudden ? 'SD' : (base[i] || `R${i + 1}`);
}

// ---------------------------------------------------------------------------
// SPECTATOR — a read-only, TV / big-screen view. Shows the round, the turn
// timer, cards left, the running scoreboard, who is clueing right now, and the
// next clue-giver for every team. It NEVER shows a word: a spectator's
// app.priv is always null and the public state carries no word, so the secret
// physically cannot reach this screen.
// ---------------------------------------------------------------------------
function spectatorScreen(app, intents) {
  const pub = app.pub;
  let body;
  switch (pub.phase) {
    case 'lobby':       body = tvLobby(pub, app); break;
    case 'submission':  body = tvSubmission(pub); break;
    case 'turnReady':
    case 'turnActive':
    case 'turnSummary': body = tvPlay(app, pub); break;
    case 'roundBreak':  body = tvRoundBreak(pub, app); break;
    case 'gameover':    body = tvGameOver(pub, app); break;
    default:            body = tvLobby(pub, app);
  }

  return el('main', { class: 'tv' },
    tvHead(app, pub),
    body,
    el('button', { class: 'link-btn tv-exit', onclick: intents.goHome }, 'Leave spectator view'),
    liveRegion(tvAnnounce(pub)),
  );
}

function tvHead(app, pub) {
  const r = pub.round;
  const showRound = ['turnReady', 'turnActive', 'turnSummary', 'roundBreak'].includes(pub.phase);
  return el('header', { class: 'tv-head' },
    el('div', { class: 'tv-brand' },
      el('span', { class: 'wordmark-dot' }),
      el('span', { class: 'wordmark-text' }, 'FISHBOWL'),
      el('span', { class: 'tv-tag' }, 'SPECTATING'),
    ),
    showRound
      ? el('div', { class: 'tv-round' },
          el('span', { class: 'round-pill' }, r.isSudden ? 'SUDDEN DEATH' : `ROUND ${r.index + 1}/${r.total}`),
          el('span', { class: 'tv-round-name' }, r.name))
      : el('div', { class: 'tv-round' }),
    el('div', { class: 'tv-room' },
      el('span', { class: 'tv-room-label' }, 'ROOM'),
      el('span', { class: 'tv-room-code' }, app.code || '----')),
  );
}

// The core in-play layout: a big main column + a board rail on the side.
function tvPlay(app, pub) {
  return el('div', { class: 'tv-play' },
    el('div', { class: 'tv-main' },
      el('p', { class: 'tv-round-rule' }, pub.round.rule),
      el('div', { class: 'tv-tiles' },
        tvTimerTile(app, pub),
        tvCardsTile(pub),
      ),
      tvNow(pub),
    ),
    el('aside', { class: 'tv-board' },
      el('div', { class: 'tv-board-label' }, 'SCORE'),
      tvScores(pub),
      el('div', { class: 'tv-board-label' }, 'CLUE-GIVERS'),
      el('div', { class: 'tv-decks' }, ...pub.teams.map(t => tvDeck(pub, t))),
    ),
  );
}

function tvTimerTile(app, pub) {
  const active = pub.phase === 'turnActive';
  const totalMs = (pub.timerSeconds || 60) * 1000;
  const remainMs = active
    ? (app.clockMs != null ? app.clockMs : (pub.turnRemainingMs || 0))
    : totalMs;
  const pct = Math.max(0, Math.min(100, (remainMs / totalMs) * 100));
  const low = active && remainMs <= 10000;
  const team = pub.teams[pub.currentTeamIndex];
  const accent = team ? team.color : 'var(--accent)';
  return el('div', { class: 'tv-tile time' + (low ? ' low' : ''), style: `--team:${accent}` },
    el('div', { class: 'tv-tile-label' }, active ? 'TIME LEFT' : 'TURN TIMER'),
    el('div', { class: 'tv-tile-value' }, formatTime(remainMs)),
    el('div', { class: 'tv-tile-bar' }, el('div', { class: 'tv-tile-fill', style: `width:${pct}%;--team:${accent}` })),
    el('div', { class: 'tv-tile-sub' }, active ? `${pub.guessedThisTurn} guessed this turn` : 'waiting to start'),
  );
}

function tvCardsTile(pub) {
  const pct = pub.bowlTotal ? Math.max(0, Math.min(100, (pub.bowlRemaining / pub.bowlTotal) * 100)) : 0;
  return el('div', { class: 'tv-tile cards' },
    el('div', { class: 'tv-tile-label' }, 'CARDS LEFT'),
    el('div', { class: 'tv-tile-value' }, String(pub.bowlRemaining)),
    el('div', { class: 'tv-tile-bar' }, el('div', { class: 'tv-tile-fill', style: `width:${pct}%` })),
    el('div', { class: 'tv-tile-sub' }, `of ${pub.bowlTotal} in the bowl`),
  );
}

// The big "who has the bowl right now" panel.
function tvNow(pub) {
  const cg = pub.clueGiver;
  const team = cg ? pub.teams[cg.team] : null;
  const accent = team ? team.color : 'var(--accent)';
  const eyebrow = pub.phase === 'turnActive' ? 'CLUEING NOW' : 'UP NEXT';
  return el('div', { class: 'tv-now', style: `--team:${accent}` },
    el('div', { class: 'tv-now-eyebrow' }, eyebrow),
    el('div', { class: 'tv-now-name', style: `color:${accent}` }, cg ? cg.name : '—'),
    el('div', { class: 'tv-now-team' },
      el('span', { class: 'team-dot', style: `--team:${accent}` }),
      team ? team.name : ''),
  );
}

function tvScores(pub) {
  return el('ul', { class: 'tv-scores' },
    ...pub.teams.map(t => el('li', {
      class: 'tv-score' + (t.isCurrent ? ' current' : ''),
      style: `--team:${t.color};--team-dim:${t.dim}`,
    },
      el('span', { class: 'team-dot', style: `--team:${t.color}` }),
      el('span', { class: 'tv-score-name' }, t.name),
      el('span', { class: 'tv-score-total' }, String(t.total)),
    )),
  );
}

// One team's clue-giver rotation: who is on the bowl (or up next) + who follows.
function tvDeck(pub, t) {
  const cluingNow = pub.phase === 'turnActive' && t.isCurrent;
  const cluer = t.cluer ? t.cluer.name : '—';
  const next = t.nextCluer ? t.nextCluer.name : null;
  return el('div', { class: 'tv-deck' + (t.isCurrent ? ' current' : ''), style: `--team:${t.color};--team-dim:${t.dim}` },
    el('div', { class: 'tv-deck-team' },
      el('span', { class: 'team-dot', style: `--team:${t.color}` }), t.name),
    el('div', { class: 'tv-deck-now' + (cluingNow ? ' live' : '') },
      cluingNow ? el('span', { class: 'tv-live-dot' }) : null,
      el('span', { class: 'tv-deck-label' }, cluingNow ? 'clueing' : 'up next'),
      el('span', { class: 'tv-deck-name' }, cluer)),
    next && next !== cluer ? el('div', { class: 'tv-deck-then' }, `then ${next}`) : null,
  );
}

function tvLobby(pub, app) {
  return el('div', { class: 'tv-center' },
    el('div', { class: 'tv-big' }, 'Get your phones out'),
    el('div', { class: 'tv-code-big' }, app.code || '----'),
    el('div', { class: 'tv-sub' },
      `${pub.playerCount} ${pub.playerCount === 1 ? 'player' : 'players'} joined · waiting for the host to start`),
    teamColumns(pub, app, null, false),
  );
}

function tvSubmission(pub) {
  const pct = pub.playerCount ? Math.round(((pub.submittedCount || 0) / pub.playerCount) * 100) : 0;
  return el('div', { class: 'tv-center' },
    el('div', { class: 'tv-big' }, 'Filling the bowl'),
    el('div', { class: 'tv-sub' }, `${pub.submittedCount || 0} of ${pub.playerCount} players ready`),
    el('div', { class: 'tv-tile-bar wide' }, el('div', { class: 'tv-tile-fill', style: `width:${pct}%` })),
    el('div', { class: 'tv-sub' }, 'Everyone is secretly adding their words.'),
  );
}

function tvRoundBreak(pub, app) {
  const r = pub.round;
  const nextType = !r.isFinal ? ROUND_TYPES[nextRoundId(pub)] : null;
  return el('div', { class: 'tv-center' },
    el('div', { class: 'summary-eyebrow' }, 'BOWL EMPTY'),
    el('div', { class: 'tv-big' }, r.isSudden ? 'Sudden death done' : `Round ${r.index + 1} complete`),
    el('div', { class: 'tv-table' }, fullScoreTable(pub, app)),
    el('div', { class: 'tv-sub' }, nextType
      ? `Next up: ${nextType.name} — same words, new challenge.`
      : 'Final round done — results coming up.'),
  );
}

function tvGameOver(pub, app) {
  const winners = (pub.winners || []).map(i => pub.teams[i]).filter(Boolean);
  const tie = pub.isTie;
  const w = winners[0];
  return el('div', { class: 'tv-center' },
    el('div', { class: 'win-eyebrow' }, tie ? 'IT’S A TIE' : 'WINNER'),
    el('div', { class: 'tv-big', style: (!tie && w) ? `color:${w.color}` : '' },
      tie ? winners.map(t => t.name).join(' & ') : (w ? w.name : '—')),
    el('div', { class: 'tv-sub' }, tie
      ? `${w ? w.total : 0} points each`
      : (w ? `${w.total} points` : '')),
    el('div', { class: 'tv-table' }, fullScoreTable(pub, app)),
  );
}

function tvAnnounce(pub) {
  switch (pub.phase) {
    case 'turnActive': return pub.clueGiver ? `${pub.clueGiver.name} is clueing now` : 'Turn in progress';
    case 'turnReady':  return pub.clueGiver ? `${pub.clueGiver.name} is up next` : 'Get ready';
    case 'gameover': {
      if (pub.isTie) return 'It is a tie';
      const w = (pub.winners || [])[0];
      return w != null && pub.teams[w] ? `${pub.teams[w].name} wins` : 'Game over';
    }
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// RULES overlay
// ---------------------------------------------------------------------------
function rulesOverlay(intents) {
  const round = (short, name, text) => el('div', { class: 'rule-round' },
    el('span', { class: 'rule-short' }, short),
    el('div', {}, el('div', { class: 'rule-name' }, name), el('p', { class: 'rule-text' }, text)));

  const sheet = el('div', { class: 'rules-sheet', role: 'dialog', 'aria-label': 'How to play' },
    el('div', { class: 'rules-head' },
      el('h2', {}, 'How to play'),
      el('button', { class: 'help-btn close', 'aria-label': 'Close', onclick: () => intents.toggleRules() }, '×')),
    el('p', { class: 'tagline' },
      'Everyone secretly adds a few words to a shared bowl. The ',
      el('strong', {}, 'same words'),
      ' are played three times — only the way you clue them changes.'),
    el('div', { class: 'rule-rounds' },
      round('R1', ROUND_TYPES.describe.name, ROUND_TYPES.describe.rule),
      round('R2', ROUND_TYPES.act.name, ROUND_TYPES.act.rule),
      round('R3', ROUND_TYPES.oneword.name, ROUND_TYPES.oneword.rule),
      round('R4', ROUND_TYPES.statue.name + ' (optional)', ROUND_TYPES.statue.rule),
    ),
    el('div', { class: 'section-label' }, 'EACH TURN'),
    el('ul', { class: 'rule-list' },
      el('li', {}, 'Teams alternate. One teammate is the clue-giver and gets a private word.'),
      el('li', {}, 'Tap Start, then clue as many words as you can before the timer runs out.'),
      el('li', {}, '“Got it” scores a point and draws the next word. The clue-giver role rotates so everyone gets a turn.'),
      el('li', {}, 'When time’s up, the unguessed word goes back in the bowl and the next team goes.'),
      el('li', {}, 'A round ends when the bowl is empty. Then all words return, reshuffled, for the next round.'),
    ),
    el('p', { class: 'fine' }, 'Scores add up across every round. Highest total after the final round wins.'),
    el('div', { class: 'btn-row' },
      el('button', { class: 'btn btn-primary', onclick: () => intents.toggleRules() }, 'GOT IT')),
  );

  return el('div', { class: 'rules-overlay', onclick: (e) => { if (e.target.classList.contains('rules-overlay')) intents.toggleRules(); } }, sheet);
}
