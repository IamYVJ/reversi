# Reversi — Othello in a browser tab

A complete, **static** web implementation of Reversi (Othello). Play both sides
on one screen, play a friend on another device with a 4-character code, or play
the bot. There is **no game server, no accounts and no build step** — the
repository is the deployment. Installable as a PWA that works offline.

Reversi is a **perfect-information** game: everything that matters is on the
board, visible to both players, all game long. That single fact removes most of
the machinery the sibling repos need. There is no public/private state split,
because there is nothing private to split off. The host can run the engine
without anyone having to trust them, because the host cannot learn anything from
holding it that they could not read off their own screen. And hotseat is a real
mode rather than a debug shortcut — two people sharing one screen is not a
compromised game of Reversi, it is just a game of Reversi.

## How to play

Black moves first. The four centre squares start filled diagonally. On your
turn you place one disc so that it **flanks** a line of your opponent's discs
between the new disc and another of yours — those discs all turn over and become
yours. Whoever has the most discs at the end wins.

- A move is only legal if it flips **at least one** disc. If it flips nothing,
  it is not a move.
- Flanking works in all **eight directions**, and every sandwiched run flips at
  once. A single disc dropped into the right gap can turn over three lines
  simultaneously.
- **If you have no legal move, your turn passes automatically.** There is no
  pass button, because passing is not a choice you get to make — the rules make
  it for you. The app says so out loud when it happens.
- **The game ends when neither player can move**, which is not the same as the
  board being full. Roughly one game in a hundred at 8×8 ends with empty squares
  still on the board, and about one in thirty at 6×6. Ending on "the board is
  full" instead is the classic way to get this wrong, so the end condition here
  is stated as what it actually is.
- **Draws are possible** and are shown as draws, not rounded into a win.

Squares are named **column letter, row number** — `D3` is column D, row 3. That
is the notation used in published Othello games, and the gutter labels, the
screen-reader announcements and the move log all read from one function, so
there is only ever one convention in play.

## Game modes

Three of them, all on the home screen — none is buried behind another.

| Mode | What it is |
| ---- | ---------- |
| **Same device** | Two players, one screen. Needs no network at all. |
| **Against the bot** | Three strengths. Also needs no network at all. |
| **With a friend** | Peer-to-peer over a 4-character room code. |

The host sets the house rules in the lobby; the joiner watches the choices
arrive and has no controls of their own. In hotseat and bot games the host is
you, so every control is yours.

Four **presets** set the rules in one tap:

| Preset | What it is |
| ------ | ---------- |
| **Classic** | Official Othello. 8×8, most discs wins. |
| **Quick** | 6×6. Same rules, about half the moves. |
| **Grand** | 10×10. Longer game, more room to manoeuvre. |
| **Anti-Othello** | Fewest discs wins. Everything else unchanged. |

A preset writes *every* rule it owns rather than only the ones it mentions, so
switching between them cannot leave a leftover behind.

### House rules

Two toggles change how the game is played:

| Rule | Default | What it changes |
| ---- | ------- | --------------- |
| **Board size** | 8×8 | 6, 8 or 10. Always even — the opening is defined as the middle 2×2, which an odd board does not have. |
| **Anti-Othello** | Off | On, the player with the **fewest** discs at the end wins. Only the scoring flips; every rule about legal moves, flipping and passing is untouched. It is a stranger game than it sounds, because the moves that feel generous are the good ones. |

### Assists

Three toggles change only what is drawn. None of them alters play, and turning
one on does not knock the lobby out of "Classic" — an assist is not a rule.

| Assist | Default | What it does |
| ------ | ------- | ------------ |
| **Legal-move dots** | On | Marks every square you could play. |
| **Flip preview** | **Off** | Hovering a legal square shows exactly which discs it would turn over. Off by default because it is driven by **hover**, which a touch device does not have — defaulting it on would advertise a feature that silently does nothing for a large share of players. |
| **Live disc count** | On | Running score in the header. |

**Nothing hardcodes 8.** Board geometry is a parameter threaded from
[`js/rules.js`](js/rules.js) through every layer, including the bot's positional
weights — see below, because that is the one place where board size is a real
trap rather than a loop bound.

## The bot

One engine, three depths. **Play the bot** works with the network genuinely
unplugged.

| Level | How it thinks |
| ----- | ------------- |
| **Easy** | Takes the most discs it can see right now, with a little noise so it is not the same game twice. Greedy is a genuinely *bad* Reversi strategy — flipping everything early hands over mobility — so this loses in a recognisably human way rather than by playing randomly. |
| **Medium** | Alpha-beta to depth 3. Sees the obvious trap, not the one after it. |
| **Hard** | Alpha-beta to depth 6 with positional weights and mobility. Plays for the corners and takes your options away. |

`chooseMove(board, player, config)` is **pure** — a board in, a cell out, no
clock, no storage, no DOM. That is what lets the test suite play hundreds of
complete bot games per run and assert that no illegal move is ever returned, at
every board size, with scoring both ways round.

The search is synchronous and **time-boxed by iterative deepening**: it deepens
until a 600ms budget is spent and plays the best move from the last ply that
finished, so the nominal depth is a ceiling rather than a promise. Measured
worst case is ~610ms at 10×10 on Hard, and it happens while the board is inert
and waiting anyway. A Web Worker is the escape hatch if that ever stops being
true, and it is not needed yet.

**Positional weights are generated, not tabulated.** The canonical Othello
weight table is written for 8×8, and a 6×6 or 10×10 board would index straight
off the end of it — silently, with `undefined` arriving deep inside the search.
So the table is computed from each square's distance to the nearest edge
instead. It reproduces the classic 8×8 numbers exactly, which the tests check
square by square, and gives the same shape at any size: corners `+100`, the
diagonal neighbour of a corner `-50`, its edge neighbour `-20`, and so on down
to `-1` for the interior.

## Hosting & joining

1. The **host** opens the site and taps **Host a game**. A 4-character room code
   appears — tap it to copy.
2. The **joiner** opens the same site, types the code into the box on the *With
   a friend* card, and taps **Join**.
3. The host picks a preset and any house rules, then starts. Black moves first.

> Both players must be reaching the same URL — share the link, not a screenshot
> of the code.

## Project layout

```
index.html              app shell (loads PeerJS + fonts, registers the SW, the
                          footer beacon and the cache-reset escape hatch)
manifest.webmanifest    PWA manifest (relative paths)
sw.js                   service worker — precaches the whole import graph,
                          stale-while-revalidate (never caches the analytics
                          beacon, so offline loads simply go uncounted)
css/styles.css          indigo theme on near-black; the board is the one
                          deliberately distinct surface, because Othello's
                          identity is black and white discs on green felt
js/
  rules.js              ← board sizes, house-rule defaults, presets, bot levels,
                          and the GENERATED positional weights. Imports nothing
  board.js              ← geometry: flat row-major cells, coordinate names, the
                          eight directions, the opening. Size is always an
                          argument, never a module constant
  state.js              the engine — legal moves, flips, automatic passing, the
                          both-players-stuck ending, scoring both ways round. No
                          timers, ever: it is serialised and replayed by tests
  intents.js            ← the one place a game action is applied to an engine,
                          shared by the UI, the wire, the bot and the tests
  guards.js             ← the bounds on anything from another device (frame size,
                          shape, rate limit) — a room code is a public address
  bot.js                ← a pure chooser (alpha-beta, iterative deepening, time
                          boxed) plus a driver that plays it through intents.js
  net.js                PeerJS transport; the host's Peer ID is derived from the
                          room code, so there is no discovery service
  ui.js                 rendering (pure view layer — no network, no engine, no
                          storage)
  util.js               helpers (room code, clipboard, persistence, clientId, DOM)
  config.js             ← the server seam: empty, and deliberately so
  main.js               controller wiring transport, engine and view together
icons/                  app icons (svg + generated png — committed on purpose,
                          see .gitignore)
scripts/
  gen-icons.js          regenerates the PNG icons (node, no deps — a hand-rolled
                          PNG encoder over node:zlib)
  test-engine.mjs       headless tests — the rules, every board size, every
                          toggle, hundreds of full bot games, the guards, reload
                          recovery, and a check that sw.js still precaches every
                          module the app actually imports
package.json            npm test / npm run icons (no dependencies)
```

`npm test` runs the whole suite in Node — no browser, no dependencies, no build
step.

---

*Othello* is a trademark of its respective owner. This is an unofficial,
non-commercial fan implementation for playing with friends. The code is
[MIT](LICENSE).
