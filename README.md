# Fishbowl — Party Word Game

A complete, **static** web implementation of the party classic *Fishbowl*
(a.k.a. *Salad Bowl* / *Celebrities*). One player hosts from their own browser
tab; everyone else joins with a 4-character code on the same Wi-Fi. All game
logic and authoritative state live in the host's tab — **no backend, no
accounts**. Built to run on a shared network and installable as a PWA that
works offline (app shell).

## How to play

Everyone secretly drops a few words into a shared **bowl**. The *same words*
are then played over **three rounds** — only the way you may clue them changes:

| Round | Name | How you clue |
| ----- | ---- | ------------ |
| 1 | **Describe** | Say anything — but never the word, any part of it, or a rhyme. |
| 2 | **Act it out** | Silent charades. No talking, no sounds. |
| 3 | **One word** | Say exactly **one** word as your clue, then only repeat it. |
| 4 | **Statue** *(optional)* | One frozen pose — strike it and hold completely still. |

Each turn: teams alternate, one teammate is the **clue-giver** and privately
sees the current word. Tap **Start**, then clue as many words as you can before
the timer runs out. **Got it** scores a point and draws the next word; when time
is up the unguessed word goes back in the bowl and the next team goes. The
clue-giver role rotates through each team so everyone takes a turn. A round ends
when the bowl is empty — then every word returns, reshuffled, for the next
round. Scores add up across all rounds; the highest total after the final round
wins (ties can be settled with a **sudden-death** tiebreaker).

**Host-configurable before the game starts:** words per player (default 5),
turn timer (default 60s), number of teams (2–4), whether to include the 4th
Statue round, and whether the clue-giver may skip/pass a word (default off).

## How it works

- **Networking:** WebRTC peer-to-peer via [PeerJS](https://peerjs.com/). Star
  topology, **host-authoritative**: the host owns all state, validates every
  intent, and broadcasts each player only the information they're entitled to
  see — the current word only ever reaches the active clue-giver's device, and
  submitted words stay hidden until they're drawn.
- **Room codes:** the friendly 4-char code maps directly to the host's Peer ID
  (`localfishbowl-v1-<CODE>`), so joiners reconstruct it from the code — no
  discovery service needed.
- **Signaling caveat:** PeerJS needs to reach a signaling *broker* once to set
  up the WebRTC handshake; after that, game traffic is direct P2P on the LAN.
  The default broker is PeerJS's public cloud (needs internet for that initial
  handshake). To play **fully offline on a LAN**, run your own broker and point
  the app at it — see [`js/net.js`](js/net.js) (`BROKER_CONFIG`).
- **Reconnect:** rejoining with the same name and code reclaims your seat, and a
  host reload rehydrates the in-progress game from a saved snapshot.

## Hosting & joining on the same Wi-Fi

1. The **host** opens the site, enters a name, and taps **Host Game**. A
   4-character room code appears — share it with the table.
2. **Players** open the same site, enter a name, and either pick the host's game
   from the *Games on this network* list or type the 4-character code, then tap
   **Connect**.
3. Once at least **4 players** are in (and every team has **2+**), the host taps
   **Start** to move everyone into word submission, then **Start Round 1** when
   all words are in.

> Everyone must be reaching the same deployed URL (e.g. the GitHub Pages link,
> or the host's `http://<computer-ip>:8000` when running locally).

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers SW)
manifest.webmanifest    PWA manifest (relative paths)
sw.js                   service worker — precaches the shell, cache-first
css/styles.css          dark/water minimalist theme
js/
  rules.js              ← ALL game-rule constants (limits, rounds, teams) +
                          pure logic. Start here.
  state.js              host-authoritative game engine / state machine
  net.js                PeerJS networking (BROKER_CONFIG lives at the top)
  ui.js                 rendering (pure view layer)
  util.js               helpers (room code, clipboard, persistence, DOM)
  main.js               controller wiring net + engine + UI together
icons/                  app icons (svg + generated png)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps)
  test-engine.mjs       headless end-to-end test of the game engine
```

## Regenerating icons

```bash
node scripts/gen-icons.js
```
