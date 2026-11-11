// ============================================================================
// state.js — The authoritative game engine.
//
// Reversi is a PERFECT-INFORMATION game: both players can see everything that
// matters, all the time. That has two consequences baked into this file.
//
//   1. There is no public/private state split. `publicState()` is the whole of
//      it. Sibling projects in this family need a per-player view because they
//      hold hidden cards or hidden roles; here that would be pure ceremony.
//   2. Host-authoritative is completely safe. There is nothing for a host to
//      learn by running the engine that a guest could not work out from the
//      board, so no commit-reveal, no secrecy protocol, no anti-cheat.
//
// NO TIMERS ANYWHERE IN THIS CLASS. The engine has to stay a pure function of
// its own state: it is serialized into localStorage and rehydrated after a
// reload, it is driven identically by a hotseat tab, a bot loop and a remote
// peer, and the test suite plays thousands of games as fast as it can. Where a
// wall-clock reading is genuinely needed it arrives as a parameter.
// ============================================================================

import {
  BLACK, WHITE, EMPTY, opponent,
  openingBoard, cloneBoard, applyMove, hasLegalMove, legalMoveMap,
  countDiscs, cellName, cellCount,
} from './board.js';
import {
  normalizeConfig, boardSizeFor, antiOthelloOn, cleanName, botLevelFor, DEFAULTS,
} from './rules.js';

export const PHASES = Object.freeze({
  LOBBY: 'lobby',
  PLAY: 'play',
  GAME_OVER: 'gameOver',
});

export const DRAW = 'draw';

// Strict 1v1. Not a configurable maximum — Reversi is a two-player game and a
// third seat has no meaning on the board.
export const SEATS = Object.freeze([BLACK, WHITE]);

const LOG_LIMIT = 14;
const MAX_PLAYERS = 2;

function fail(error) {
  return { ok: false, error };
}

const OK = Object.freeze({ ok: true });

// --- restore() validators ---------------------------------------------------

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isSeat = (v) => v === BLACK || v === WHITE;
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);

// Rebuilds the typed array, and defends the length: a snapshot written under a
// different board size (or a truncated one) would otherwise leave every
// row-major index pointing at the wrong square.
function restoreBoard(cells, size) {
  const board = openingBoard(size);
  if (!Array.isArray(cells) || cells.length !== board.length) return board;
  for (let i = 0; i < board.length; i++) {
    const v = cells[i];
    board[i] = isSeat(v) ? v : EMPTY;
  }
  return board;
}

// Malformed entries are dropped rather than repaired, and so are later
// duplicates of an id or a seat: two players sharing either would make
// playerById/playerBySeat ambiguous.
function restorePlayers(raw) {
  const players = [];
  if (!Array.isArray(raw)) return players;
  for (const p of raw) {
    if (players.length >= MAX_PLAYERS) break;
    if (!isPlainObject(p) || typeof p.id !== 'string' || !p.id || !isSeat(p.seat)) continue;
    if (players.some((q) => q.id === p.id || q.seat === p.seat)) continue;
    const isBot = p.isBot === true;
    players.push({
      id: p.id,
      name: cleanName(p.name) || (isBot ? 'Bot' : 'Player'),
      isBot,
      botLevel: isBot ? botLevelFor(p.botLevel) : null,
      seat: p.seat,
      connected: typeof p.connected === 'boolean' ? p.connected : true,
    });
  }
  return players;
}

// The owner holds the controls, so a bot or an unknown id cannot be one.
function restoreOwner(id, players) {
  if (id === null || id === undefined) return null;
  const named = typeof id === 'string' && players.find((p) => p.id === id && !p.isBot);
  if (named) return id;
  const first = players.find((p) => !p.isBot);
  return first ? first.id : null;
}

function validCellIndex(v, size) {
  return Number.isInteger(v) && v >= 0 && v < cellCount(size);
}

function restoreLastMove(m, size) {
  if (!isPlainObject(m) || !validCellIndex(m.cell, size) || !isSeat(m.player)) return null;
  if (!Array.isArray(m.flips) || !m.flips.every((c) => validCellIndex(c, size))) return null;
  return { cell: m.cell, player: m.player, flips: [...m.flips] };
}

// Keeps the LAST entries, matching what _log trims to.
function restoreLog(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => isPlainObject(e) && typeof e.text === 'string')
    .map((e) => ({ text: e.text, seat: isSeat(e.seat) ? e.seat : null }))
    .slice(-LOG_LIMIT);
}

function restoreScore(s) {
  if (!isPlainObject(s)) return null;
  const { black, white, empty } = s;
  if (![black, white, empty].every((n) => Number.isInteger(n) && n >= 0)) return null;
  return { black, white, empty };
}

export class GameEngine {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = PHASES.LOBBY;
    // The room's CONTROLS, not the tab running the engine. Those are separate
    // ideas on purpose: in P2P one device is both, but under a future server
    // the server runs the engine while the owner is a client like anyone else.
    // Nothing in this file may ever assume they are the same.
    this.ownerId = null;
    this.players = [];
    this.config = normalizeConfig(DEFAULTS);
    this.size = boardSizeFor(this.config);
    this.board = openingBoard(this.size);
    this.turn = BLACK;      // black always opens
    this.plies = 0;         // completed moves; part of the UI's animation key
    this.lastMove = null;   // { cell, player, flips }
    this.lastPass = null;   // { player } — set when a turn was skipped
    this.log = [];
    this.winner = null;     // BLACK | WHITE | DRAW
    this.finalScore = null;
    // True when the owner stopped the game rather than the rules ending it.
    // The winner is still computed from the discs so the record stays
    // meaningful, but every surface must not call it a win.
    this.endedEarly = false;
    this.gamesPlayed = 0;
    // Which colour the first-listed player took this game. Flipped by
    // playAgain so a rematch does not hand the same person black twice.
    this.startSeat = BLACK;
  }

  // --- Lookups -------------------------------------------------------------

  playerById(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  playerBySeat(seat) {
    return this.players.find((p) => p.seat === seat) || null;
  }

  get currentPlayer() {
    return this.phase === PHASES.PLAY ? this.playerBySeat(this.turn) : null;
  }

  isOwner(id) {
    return !!id && id === this.ownerId;
  }

  // --- Lobby ---------------------------------------------------------------

  // The first player through the door takes the controls. Re-joining with a
  // known id is idempotent: it updates the name and marks them present rather
  // than allocating a second seat, which is what makes a mid-game reconnect
  // land back in the same colour.
  addPlayer(id, name, { isBot = false, botLevel = 'medium' } = {}) {
    if (typeof id !== 'string' || !id) return fail('Bad player id.');

    const existing = this.playerById(id);
    if (existing) {
      const clean = cleanName(name);
      if (clean) existing.name = clean;
      existing.connected = true;
      return OK;
    }

    if (this.players.length >= MAX_PLAYERS) return fail('This game is full.');
    // Mid-game joins are refused rather than queued: there is no third seat to
    // wait in, and a guest whose connection dropped is handled by the branch
    // above, not this one.
    if (this.phase !== PHASES.LOBBY) return fail('That game has already started.');

    const seat = SEATS.find((s) => !this.playerBySeat(s));
    this.players.push({
      id,
      name: cleanName(name) || (isBot ? 'Bot' : 'Player'),
      isBot: !!isBot,
      botLevel: isBot ? botLevelFor(botLevel) : null,
      seat,
      connected: true,
    });
    if (!this.ownerId && !isBot) this.ownerId = id;
    return OK;
  }

  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx < 0) return fail('No such player.');
    // Leaving mid-game only marks them away. Dropping the record would free
    // their seat, and the reconnect path above would then hand it to whoever
    // knocked next while the original player was still reloading.
    if (this.phase !== PHASES.LOBBY) {
      this.players[idx].connected = false;
      return OK;
    }
    this.players.splice(idx, 1);
    if (this.ownerId === id) {
      const heir = this.players.find((p) => !p.isBot);
      this.ownerId = heir ? heir.id : null;
    }
    return OK;
  }

  // A player renames THEMSELVES. Not owner-gated and not given a target id:
  // the actor is whoever the transport says sent it, so a peer cannot rename
  // their opponent. In hotseat the one human is legitimately both actors, and
  // main.js says so explicitly rather than this method guessing.
  setName(actorId, raw) {
    const player = this.playerById(actorId);
    if (!player) return fail('You are not in this game.');
    // An empty box falls back to the colour rather than staying blank: the
    // name is how a player is referred to in the log, the banner and the live
    // region, and " to play" reads as a bug rather than as an unnamed player.
    player.name = cleanName(raw) || (player.seat === BLACK ? 'Black' : 'White');
    return OK;
  }

  setConfig(patch) {
    if (this.phase !== PHASES.LOBBY) return fail('Rules are locked once play starts.');
    this.config = normalizeConfig({ ...this.config, ...patch });
    // The board is redealt immediately so the lobby preview always shows the
    // size that was just chosen.
    this.size = boardSizeFor(this.config);
    this.board = openingBoard(this.size);
    return OK;
  }

  swapSeats() {
    if (this.phase !== PHASES.LOBBY) return fail('Colours are locked once play starts.');
    for (const p of this.players) p.seat = opponent(p.seat);
    this.startSeat = opponent(this.startSeat);
    return OK;
  }

  setBotLevel(id, level) {
    const player = this.playerById(id);
    if (!player || !player.isBot) return fail('No such bot.');
    // Coerced rather than rejected: an unknown level is a peer sending junk,
    // and a bot that quietly plays at Medium is a better outcome than one
    // whose level is a string the search has no branch for.
    player.botLevel = botLevelFor(level);
    return OK;
  }

  startGame() {
    if (this.phase === PHASES.PLAY) return fail('Already playing.');
    if (this.players.length !== MAX_PLAYERS) return fail('Reversi needs exactly two players.');
    // A seat held for a dropped guest is not an opponent: starting now would
    // deal a game nobody is there to play.
    const away = this._absentPlayer();
    if (away) return fail(`Waiting for ${away.name} to reconnect.`);

    this.size = boardSizeFor(this.config);
    this.board = openingBoard(this.size);
    this.turn = BLACK;
    this.plies = 0;
    this.lastMove = null;
    this.lastPass = null;
    this.winner = null;
    this.finalScore = null;
    this.endedEarly = false;
    this.log = [];
    this.phase = PHASES.PLAY;
    this._log(`${this.seatName(BLACK)} opens.`, BLACK);
    return OK;
  }

  // --- Play ----------------------------------------------------------------

  playMove(actorId, cell) {
    if (this.phase !== PHASES.PLAY) return fail('The game is not running.');
    const player = this.playerById(actorId);
    if (!player) return fail('You are not in this game.');
    if (player.seat !== this.turn) return fail('It is not your turn.');

    const applied = applyMove(this.board, cell, this.turn, this.size);
    // applyMove returns null for anything that flips nothing, which covers
    // off-board indices, occupied squares and legal-looking-but-dead placements
    // in one check. That is the whole of Reversi's legality rule.
    if (!applied) return fail('That square would not flip anything.');

    this.board = applied.board;
    this.lastMove = { cell, player: this.turn, flips: applied.flips };
    this.lastPass = null;
    this.plies++;
    this._log(
      `${this.seatName(this.turn)} plays ${cellName(cell, this.size)} (+${applied.flips.length}).`,
      this.turn,
    );
    this._advanceTurn();
    return OK;
  }

  // Turn handover, auto-pass and game end — all three are the same decision,
  // so they live in one place.
  //
  // The end condition is NEITHER SIDE HAS A LEGAL MOVE. It is emphatically not
  // "the board is full": a game can lock up with empty squares nobody can play
  // into, and treating fullness as the end is the classic Reversi bug.
  _advanceTurn() {
    const next = opponent(this.turn);

    if (hasLegalMove(this.board, next, this.size)) {
      this.turn = next;
      return;
    }

    if (hasLegalMove(this.board, this.turn, this.size)) {
      // There is no pass BUTTON in Reversi — a player with no legal move
      // simply loses their turn, automatically. The UI announces it; the turn
      // does not change hands.
      this.lastPass = { player: next };
      this._log(`${this.seatName(next)} has no legal move and passes.`, next);
      return;
    }

    this._finish();
  }

  _finish() {
    const { black, white } = countDiscs(this.board);
    const anti = antiOthelloOn(this.config);
    // Draws are a real outcome, not an edge case: equal disc counts happen,
    // and are the same result whichever direction the comparison runs.
    let winner;
    if (black === white) winner = DRAW;
    else if (anti) winner = black < white ? BLACK : WHITE;
    else winner = black > white ? BLACK : WHITE;

    this.winner = winner;
    this.finalScore = { black, white, empty: cellCount(this.size) - black - white };
    this.phase = PHASES.GAME_OVER;
    this.gamesPlayed++;
    this.lastPass = null;
    const lead = winner === BLACK ? black : white;
    const trail = winner === BLACK ? white : black;
    // The winner's count comes first. Under Anti-Othello the winner has the
    // FEWER discs, so "larger first" would read as the loser's score.
    let text;
    if (this.endedEarly) {
      // Not "wins": nobody finished the game, so only say who led.
      text = winner === DRAW
        ? `Game ended early, level at ${black}-${white}.`
        : `Game ended early. ${this.seatName(winner)} led, ${lead}-${trail}.`;
    } else {
      text = winner === DRAW
        ? `Drawn, ${black}-${white}.`
        : `${this.seatName(winner)} wins ${lead}-${trail}.`;
    }
    this._log(text, winner === DRAW ? null : winner);
  }

  // Owner escape hatch: ends a game that is running. Distinct from _finish,
  // which is the rules deciding the game is over.
  endGame() {
    if (this.phase !== PHASES.PLAY) return fail('Nothing to end.');
    this.endedEarly = true;
    this._finish();
    return OK;
  }

  playAgain() {
    if (this.phase !== PHASES.GAME_OVER) return fail('Finish this game first.');
    // Checked before the colours swap: startGame would refuse too, but by then
    // the seats would already have flipped under a rematch that never began.
    const away = this._absentPlayer();
    if (away) return fail(`Waiting for ${away.name} to reconnect.`);
    for (const p of this.players) p.seat = opponent(p.seat);
    this.startSeat = opponent(this.startSeat);
    return this.startGame();
  }

  // A player whose connection dropped mid-game, kept seated so a reconnect
  // lands back in the same colour. Bots never disconnect, so they never match.
  _absentPlayer() {
    return this.players.find((p) => p.connected === false) || null;
  }

  backToLobby() {
    // Seats held for absent players only make sense while a game is on. Back in
    // the lobby they would block the room ("This game is full.") and let a game
    // start against nobody, so release them.
    const owner = this.ownerId;
    this.players = this.players.filter((p) => p.connected !== false);
    if (owner && !this.playerById(owner)) {
      const heir = this.players.find((p) => !p.isBot);
      this.ownerId = heir ? heir.id : null;
    }
    this.phase = PHASES.LOBBY;
    this.size = boardSizeFor(this.config);
    this.board = openingBoard(this.size);
    this.turn = BLACK;
    this.plies = 0;
    this.lastMove = null;
    this.lastPass = null;
    this.winner = null;
    this.finalScore = null;
    this.endedEarly = false;
    this.log = [];
    return OK;
  }

  // --- Derived -------------------------------------------------------------

  score() {
    const { black, white } = countDiscs(this.board);
    return { black, white };
  }

  legalMoves() {
    return this.phase === PHASES.PLAY ? legalMoveMap(this.board, this.turn, this.size) : new Map();
  }

  seatName(seat) {
    const player = this.playerBySeat(seat);
    if (player && player.name) return player.name;
    return seat === BLACK ? 'Black' : 'White';
  }

  _log(text, seat = null) {
    this.log.push({ text, seat });
    if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
  }

  // --- Persistence ---------------------------------------------------------

  // A plain, JSON-safe object. The board becomes a normal array because a
  // Uint8Array survives neither JSON.stringify nor the PeerJS wire intact — it
  // arrives as `{"0":2,"1":0,...}` and silently breaks every index.
  serialize() {
    return {
      phase: this.phase,
      ownerId: this.ownerId,
      players: this.players.map((p) => ({ ...p })),
      config: { ...this.config },
      size: this.size,
      board: Array.from(this.board),
      turn: this.turn,
      plies: this.plies,
      lastMove: this.lastMove ? { ...this.lastMove, flips: [...this.lastMove.flips] } : null,
      lastPass: this.lastPass ? { ...this.lastPass } : null,
      log: this.log.map((e) => ({ ...e })),
      winner: this.winner,
      finalScore: this.finalScore ? { ...this.finalScore } : null,
      endedEarly: this.endedEarly,
      gamesPlayed: this.gamesPlayed,
      startSeat: this.startSeat,
    };
  }

  // Copies ONLY the fields serialize() writes, each validated, and falls back to
  // the reset() default for anything malformed. A blanket Object.assign would let
  // a corrupt or stale localStorage entry overwrite methods (`playMove: 'x'`) or
  // hit the __proto__ setter, and a snapshot that bricks the engine on every
  // reload is worse than one that quietly loses a field.
  restore(snapshot) {
    this.reset();
    if (!isPlainObject(snapshot)) return this;

    this.config = normalizeConfig(snapshot.config);
    this.size = boardSizeFor(this.config);
    this.board = restoreBoard(snapshot.board, this.size);

    this.players = restorePlayers(snapshot.players);
    this.ownerId = restoreOwner(snapshot.ownerId, this.players);
    this.turn = snapshot.turn === WHITE ? WHITE : BLACK;
    this.startSeat = snapshot.startSeat === WHITE ? WHITE : BLACK;
    this.plies = count(snapshot.plies);
    this.gamesPlayed = count(snapshot.gamesPlayed);
    this.lastMove = restoreLastMove(snapshot.lastMove, this.size);
    this.lastPass = isPlainObject(snapshot.lastPass) && isSeat(snapshot.lastPass.player)
      ? { player: snapshot.lastPass.player } : null;
    this.log = restoreLog(snapshot.log);
    this.winner = snapshot.winner === DRAW || isSeat(snapshot.winner) ? snapshot.winner : null;
    this.finalScore = restoreScore(snapshot.finalScore);
    this.endedEarly = snapshot.endedEarly === true;

    const phase = Object.values(PHASES).includes(snapshot.phase) ? snapshot.phase : PHASES.LOBBY;
    if (phase !== PHASES.LOBBY && this.players.length !== MAX_PLAYERS) {
      // A game cannot be resumed without both seats, so drop back to a lobby
      // with a fresh opening board. Whoever did restore stays seated, which
      // keeps resumeLocal/resumeP2P (they bail only on an empty player list)
      // landing in a usable lobby instead of the home screen.
      this.board = openingBoard(this.size);
      this.turn = BLACK;
      this.plies = 0;
      this.lastMove = null;
      this.lastPass = null;
      this.winner = null;
      this.finalScore = null;
      this.endedEarly = false;
      this.phase = PHASES.LOBBY;
    } else {
      this.phase = phase;
    }
    return this;
  }

  // The complete state every device is allowed to see — which, in a
  // perfect-information game, is all of it. There is no privateStateFor().
  publicState() {
    return {
      phase: this.phase,
      ownerId: this.ownerId,
      players: this.players.map((p) => ({ ...p })),
      config: { ...this.config },
      size: this.size,
      board: Array.from(this.board),
      turn: this.turn,
      plies: this.plies,
      lastMove: this.lastMove ? { ...this.lastMove, flips: [...this.lastMove.flips] } : null,
      lastPass: this.lastPass ? { ...this.lastPass } : null,
      log: this.log.map((e) => ({ ...e })),
      winner: this.winner,
      finalScore: this.finalScore ? { ...this.finalScore } : null,
      endedEarly: this.endedEarly,
      score: this.score(),
      gamesPlayed: this.gamesPlayed,
    };
  }
}

// Rebuilds a live board from a publicState/serialize payload. The UI and the
// bot both need one, and both are handed plain arrays off the wire.
export function boardFrom(pub) {
  const cells = pub && Array.isArray(pub.board) ? pub.board : [];
  const board = cloneBoard(Uint8Array.from(cells, (v) => (v === BLACK || v === WHITE ? v : EMPTY)));
  return board;
}
