// ============================================================================
// test-engine.mjs — Headless engine suite. `npm test`.
//
// Node only, zero dependencies, no DOM. Everything under js/ that matters to
// the rules is importable straight into Node precisely because none of it
// touches the document or the clock.
// ============================================================================

import {
  BLACK, WHITE, EMPTY, opponent,
  openingBoard, flipsFor, legalMoves, legalMoveMap, hasLegalMove, applyMove,
  countDiscs, cellName, cellFromName, cellAt, cellCount, cornersFor, DIRECTIONS,
} from '../js/board.js';
import {
  BOARD_SIZES, DEFAULTS, RULE_KEYS, normalizeConfig, presetConfig, presetOf,
  describeHouseRules, describeAssists, weightsFor, randomBelow, shuffle, cleanName,
  boardSizeFor, antiOthelloOn, legalDotsOn, flipPreviewOn, discCounterOn,
  BOT_LEVELS, botLevelFor,
} from '../js/rules.js';
import { GameEngine, PHASES, DRAW, boardFrom } from '../js/state.js';
import { applyGameIntent, GAME_INTENTS, PLAYER_INTENTS, OWNER_INTENTS } from '../js/intents.js';
import { chooseMove, createBotDriver, BOT_THINK_MS, SEARCH_BUDGET_MS } from '../js/bot.js';
import {
  validEnvelope, validCell, validConfigPatch, validClientId, validNameField,
  validPublicState, decodePeerFrame, TokenBucket,
  MAX_TYPE_LEN, MAX_FRAME_BYTES, MAX_CONNECTIONS,
} from '../js/guards.js';
// The two browser-facing modules are still importable here, because the parts
// the wire protocol depends on — room codes and the peer id derived from them —
// touch neither the DOM nor localStorage. Anything in util.js that does is
// simply not called below.
import {
  normalizeCode, generateRoomCode, CODE_LENGTH,
  clientId, loadName, saveName, loadLastCode, saveLastCode,
  saveSession, loadSession, clearSession, saveEngineSnapshot, loadEngineSnapshot,
} from '../js/util.js';
import {
  PEER_PREFIX, peerIdForCode, codeFromPeerId, isFatalPeerError, describePeerError,
} from '../js/net.js';
import {
  SERVER_URL, SERVER_HEALTH, serverConfigured, HEALTH_TIMEOUT_MS, HEALTH_RETRIES,
} from '../js/config.js';
// Only the packaging section at the very bottom touches the filesystem — it
// checks that sw.js still precaches every module the app actually imports.
import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; } else { failed++; console.error('  x FAIL:', msg); }
}

function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function section(t) { console.log('\n- ' + t); }

// Deterministic RNG. rules.js reads `crypto` at CALL time, so swapping the
// global here — before any engine exists — is enough to pin every shuffle and
// tie-break in the suite. `seed(n)` restarts the stream.
//
// This matters more than it looks: the random-game driver below plays tens of
// thousands of games, and an unseeded run that happened to pass locally could
// fail at random in CI on a sequence it never tried.
let prng = 0;
function seed(n) { prng = n >>> 0; }
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: {
    getRandomValues(buf) {
      for (let i = 0; i < buf.length; i++) {
        prng = (prng + 0x6D2B79F5) >>> 0;
        let t = prng;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        buf[i] = (t ^ (t >>> 14)) >>> 0;
      }
      return buf;
    },
  },
});
seed(1);

// --- Helpers ---------------------------------------------------------------

// Boards as ASCII art, so a test position reads the way it looks.
function parseBoard(rows) {
  const size = rows.length;
  const board = new Uint8Array(size * size);
  rows.forEach((row, r) => {
    const cells = row.replace(/\s+/g, '');
    if (cells.length !== size) throw new Error(`row ${r} is ${cells.length} wide, expected ${size}`);
    for (let c = 0; c < size; c++) {
      const ch = cells[c].toUpperCase();
      board[r * size + c] = ch === 'B' ? BLACK : ch === 'W' ? WHITE : EMPTY;
    }
  });
  return board;
}

function twoPlayerGame({ size = 8, turn = BLACK, rows = null, ...config } = {}) {
  const engine = new GameEngine();
  engine.addPlayer('p-black', 'Black');
  engine.addPlayer('p-white', 'White');
  engine.setConfig({ boardSize: size, ...config });
  engine.startGame();
  if (rows) engine.board = parseBoard(rows);
  engine.turn = turn;
  return engine;
}

function names(cells, size) {
  return cells.map((c) => cellName(c, size)).sort().join(' ');
}

// --- Geometry --------------------------------------------------------------

section('geometry');
{
  eq(cellName(cellAt(0, 0, 8), 8), 'A1', 'top-left is A1');
  eq(cellName(cellAt(7, 7, 8), 8), 'H8', 'bottom-right is H8');
  eq(cellName(cellAt(3, 3, 8), 8), 'D4', 'row 3 col 3 is D4');
  eq(cellName(-1, 8), '?', 'negative cell renders as ?');
  eq(cellName(64, 8), '?', 'off-board cell renders as ?');
  eq(cellFromName('d4', 8), cellAt(3, 3, 8), 'cellFromName round-trips lowercase');
  eq(cellFromName('J10', 10), cellAt(9, 9, 10), 'cellFromName handles two-digit rows');
  eq(cellFromName('I9', 8), -1, 'cellFromName rejects off-board names');
  eq(DIRECTIONS.length, 8, 'there are eight directions');

  for (const size of BOARD_SIZES) {
    const board = openingBoard(size);
    const { black, white, empty } = countDiscs(board);
    eq(black, 2, `${size}x${size} opens with two black discs`);
    eq(white, 2, `${size}x${size} opens with two white discs`);
    eq(empty, cellCount(size) - 4, `${size}x${size} opens with the rest empty`);
    const mid = size / 2;
    // Same colours on a diagonal — black top-right/bottom-left, as in the
    // official setup (black e4 and d5 on an 8x8).
    eq(board[cellAt(mid - 1, mid, size)], BLACK, `${size}x${size} black is top-right of centre`);
    eq(board[cellAt(mid, mid - 1, size)], BLACK, `${size}x${size} black is bottom-left of centre`);
    eq(board[cellAt(mid - 1, mid - 1, size)], WHITE, `${size}x${size} white is top-left of centre`);
    eq(board[cellAt(mid, mid, size)], WHITE, `${size}x${size} white is bottom-right of centre`);
  }

  eq(cornersFor(8).join(','), '0,7,56,63', 'corners of an 8x8');
  eq(cornersFor(6).join(','), '0,5,30,35', 'corners of a 6x6');
}

// --- Legal moves and flips -------------------------------------------------

section('legal moves');
{
  const board = openingBoard(8);
  eq(names(legalMoves(board, BLACK, 8), 8), 'C4 D3 E6 F5', 'black has the four standard openings');
  eq(names(legalMoves(board, WHITE, 8), 8), 'C5 D6 E3 F4', 'white has the mirrored four');

  for (const size of BOARD_SIZES) {
    eq(legalMoves(openingBoard(size), BLACK, size).length, 4,
      `${size}x${size} opens with exactly four legal moves`);
  }

  // Occupied and off-board squares flip nothing, which is the same thing as
  // being illegal — there is no separate legality test in this engine.
  eq(flipsFor(board, cellAt(3, 3, 8), BLACK, 8).length, 0, 'cannot play on an occupied square');
  eq(flipsFor(board, -5, BLACK, 8).length, 0, 'a negative index flips nothing');
  eq(flipsFor(board, 999, BLACK, 8).length, 0, 'an out-of-range index flips nothing');
  eq(flipsFor(board, cellAt(0, 0, 8), BLACK, 8).length, 0, 'a zero-flip square is not playable');
  eq(applyMove(board, cellAt(0, 0, 8), BLACK, 8), null, 'applyMove refuses a zero-flip move');

  // A move must not mutate the board it was handed: the bot searches by
  // cloning down the tree and the engine serializes what it holds.
  const before = Array.from(board).join('');
  applyMove(board, cellAt(2, 3, 8), BLACK, 8);
  eq(Array.from(board).join(''), before, 'applyMove leaves its input board untouched');
}

section('multi-direction flips');
{
  // D4 for black closes four separate rays at once: up-left, up, up-right and
  // left. Every one of them flips — Reversi does not stop at the first.
  const board = parseBoard([
    '........',
    '.B.B.B..',
    '..WWW...',
    '.BW.....',
    '........',
    '........',
    '........',
    '........',
  ]);
  const cell = cellAt(3, 3, 8);
  const flips = flipsFor(board, cell, BLACK, 8);
  eq(flips.length, 4, 'four discs flip from one move');
  eq(names(flips, 8), 'C3 C4 D3 E3', 'all four rays resolve');

  const after = applyMove(board, cell, BLACK, 8);
  eq(countDiscs(after.board).white, 0, 'every flipped disc changed colour');
  eq(countDiscs(after.board).black, 9, 'four already there, four flipped, one placed');

  // A run that reaches the edge is open, and an open run flips nothing.
  const openRun = parseBoard([
    'WW......',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  eq(flipsFor(openRun, cellAt(0, 2, 8), WHITE, 8).length, 0,
    'a run closed by the edge rather than a disc does not flip');

  // A gap breaks the run even though the far end is the right colour.
  const gapped = parseBoard([
    'B.WB....',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  eq(flipsFor(gapped, cellAt(0, 1, 8), BLACK, 8).length, 1,
    'the run stops at the empty square, so only the adjacent white flips');
}

section('hasLegalMove agrees with legalMoveMap');
{
  seed(7);
  for (const size of BOARD_SIZES) {
    let board = openingBoard(size);
    let player = BLACK;
    for (let i = 0; i < 40; i++) {
      const map = legalMoveMap(board, player, size);
      eq(hasLegalMove(board, player, size), map.size > 0,
        `${size}x${size} ply ${i}: fast check matches full generation`);
      if (!map.size) { player = opponent(player); continue; }
      const cells = [...map.keys()];
      const pick = cells[randomBelow(cells.length)];
      board = applyMove(board, pick, player, size).board;
      player = opponent(player);
    }
  }
}

// --- Auto-pass -------------------------------------------------------------

section('auto-pass');
{
  // Black to move. White's only reachable empty squares are A1 and F6, and
  // neither closes a run for white — so white must lose the turn, twice.
  const engine = twoPlayerGame({
    size: 6,
    turn: BLACK,
    rows: [
      '.BBBBB',
      'BWBBBB',
      'BBBBBB',
      'BBBBBB',
      'BBBBWB',
      'BBBBB.',
    ],
  });

  eq(hasLegalMove(engine.board, WHITE, 6), false, 'white is stuck in this position');
  eq(hasLegalMove(engine.board, BLACK, 6), true, 'black is not');

  const r1 = engine.playMove('p-black', cellAt(0, 0, 6));
  ok(r1.ok, 'black plays A1');
  eq(engine.turn, BLACK, 'the turn does not change hands when the opponent cannot move');
  ok(!!engine.lastPass, 'a pass was recorded');
  eq(engine.lastPass.player, WHITE, 'white is the one who passed');
  ok(engine.log.some((e) => /passes/.test(e.text)), 'the pass is in the log');
  eq(engine.phase, PHASES.PLAY, 'a pass does not end the game while someone can still move');

  // Out-of-turn attempts are refused, including by the player who just passed.
  const bad = engine.playMove('p-white', cellAt(5, 5, 6));
  ok(!bad.ok, 'the passed player cannot sneak a move in');

  const r2 = engine.playMove('p-black', cellAt(5, 5, 6));
  ok(r2.ok, 'black plays again immediately');
  eq(engine.phase, PHASES.GAME_OVER, 'with the board full and nobody able to move, the game ends');
  eq(engine.lastPass, null, 'lastPass is cleared once the game is over');
  eq(engine.winner, BLACK, 'black wins the wipeout');
  eq(engine.finalScore.black, 36, 'black holds every square');
}

// --- Game end with a non-full board ---------------------------------------

section('game ends when neither side can move, full board or not');
{
  // Black plays C3 and flips white's last disc. Neither side owns a disc the
  // other can sandwich, so the game is over with 33 of 36 squares empty. If
  // this engine used "board is full" as its end condition it would hang here.
  const engine = twoPlayerGame({
    size: 6,
    turn: BLACK,
    rows: [
      '......',
      '......',
      '..WB..',
      '......',
      '......',
      '......',
    ],
  });

  const res = engine.playMove('p-black', cellAt(2, 1, 6));
  ok(res.ok, 'black flips the last white disc');
  eq(engine.phase, PHASES.GAME_OVER, 'the game ends immediately');
  eq(engine.finalScore.empty, 33, 'and it ends with the board mostly empty');
  eq(engine.finalScore.black, 3, 'black has three discs');
  eq(engine.finalScore.white, 0, 'white has none');
  eq(engine.winner, BLACK, 'black wins on count');
}

section('draws');
{
  // Two isolated groups of three, each walled in by the edge. Nobody can move
  // and the counts are level.
  const engine = twoPlayerGame({
    size: 6,
    turn: BLACK,
    rows: [
      '.WB...',
      '......',
      '......',
      '......',
      '......',
      '...WWW',
    ],
  });

  const res = engine.playMove('p-black', cellAt(0, 0, 6));
  ok(res.ok, 'black plays A1 and flips B1');
  eq(engine.phase, PHASES.GAME_OVER, 'neither side has a reply');
  eq(engine.winner, DRAW, 'three discs each is a draw');
  eq(engine.finalScore.black, 3, 'black has three');
  eq(engine.finalScore.white, 3, 'white has three');
  ok(engine.log.some((e) => /Drawn/.test(e.text)), 'the draw is logged as a draw');
}

section('anti-othello');
{
  const rows = [
    '......',
    '......',
    '..WB..',
    '......',
    '......',
    '......',
  ];

  const normal = twoPlayerGame({ size: 6, turn: BLACK, rows });
  normal.playMove('p-black', cellAt(2, 1, 6));
  eq(normal.winner, BLACK, 'normally, the most discs wins');

  const anti = twoPlayerGame({ size: 6, turn: BLACK, rows, antiOthello: true });
  anti.playMove('p-black', cellAt(2, 1, 6));
  eq(anti.winner, WHITE, 'under Anti-Othello the same position is a white win');
  eq(anti.finalScore.white, 0, 'white wins with zero discs');

  // A draw is a draw whichever direction the comparison runs.
  const drawRows = [
    '.WB...',
    '......',
    '......',
    '......',
    '......',
    '...WWW',
  ];
  const antiDraw = twoPlayerGame({ size: 6, turn: BLACK, rows: drawRows, antiOthello: true });
  antiDraw.playMove('p-black', cellAt(0, 0, 6));
  eq(antiDraw.winner, DRAW, 'Anti-Othello does not turn a draw into a win');
}

// --- Engine plumbing -------------------------------------------------------

section('turn order and rejections');
{
  const engine = twoPlayerGame();
  eq(engine.turn, BLACK, 'black opens');
  eq(engine.currentPlayer.id, 'p-black', 'and black is on move');

  ok(!engine.playMove('p-white', cellAt(2, 3, 8)).ok, 'white cannot move first');
  ok(!engine.playMove('nobody', cellAt(2, 3, 8)).ok, 'a stranger cannot move at all');
  ok(!engine.playMove('p-black', cellAt(0, 0, 8)).ok, 'black cannot play a dead square');
  eq(engine.plies, 0, 'a rejected move changes nothing');

  ok(engine.playMove('p-black', cellAt(2, 3, 8)).ok, 'black plays D3');
  eq(engine.turn, WHITE, 'the turn passes to white');
  eq(engine.plies, 1, 'one ply played');
  eq(engine.lastMove.cell, cellAt(2, 3, 8), 'lastMove records the square');
  eq(engine.lastMove.flips.length, 1, 'lastMove records what flipped');
}

section('lobby');
{
  const engine = new GameEngine();
  eq(engine.phase, PHASES.LOBBY, 'a new engine starts in the lobby');
  ok(!engine.startGame().ok, 'a game cannot start with nobody in it');

  ok(engine.addPlayer('a', 'Ada').ok, 'first player joins');
  eq(engine.ownerId, 'a', 'and takes the room controls');
  ok(!engine.startGame().ok, 'one player is still not enough');

  ok(engine.addPlayer('b', 'Bea').ok, 'second player joins');
  ok(!engine.addPlayer('c', 'Cal').ok, 'a third is refused — Reversi is strictly 1v1');
  eq(engine.ownerId, 'a', 'the controls did not move');

  eq(engine.playerById('a').seat, BLACK, 'the first seat is black');
  eq(engine.playerById('b').seat, WHITE, 'the second is white');
  ok(engine.swapSeats().ok, 'the owner can swap colours in the lobby');
  eq(engine.playerById('a').seat, WHITE, 'colours swapped');

  // Re-adding a known id is a reconnect, not a new seat.
  ok(engine.addPlayer('a', 'Ada').ok, 're-joining is idempotent');
  eq(engine.players.length, 2, 'and does not allocate another seat');

  ok(engine.startGame().ok, 'two players is enough');
  ok(!engine.setConfig({ boardSize: 10 }).ok, 'rules lock once play starts');
  ok(!engine.swapSeats().ok, 'so do colours');

  // A disconnect mid-game holds the seat rather than freeing it.
  ok(engine.removePlayer('b').ok, 'a player can drop out mid-game');
  eq(engine.players.length, 2, 'their seat is held, not freed');
  eq(engine.playerById('b').connected, false, 'they are marked away');
  ok(engine.addPlayer('b', 'Bea').ok, 'and they can come back');
  eq(engine.playerById('b').connected, true, 'reconnected');
}

section('serialize / restore');
{
  seed(11);
  const engine = twoPlayerGame({ size: 10, flipPreview: true });
  for (let i = 0; i < 20; i++) {
    const cells = [...engine.legalMoves().keys()];
    if (!cells.length) break;
    engine.playMove(engine.currentPlayer.id, cells[randomBelow(cells.length)]);
  }

  // Through JSON, because that is what both localStorage and the peer wire do
  // to it. A Uint8Array does not survive the trip.
  const snapshot = JSON.parse(JSON.stringify(engine.serialize()));
  const revived = new GameEngine().restore(snapshot);

  eq(revived.phase, engine.phase, 'phase survives');
  eq(revived.turn, engine.turn, 'turn survives');
  eq(revived.size, engine.size, 'board size survives');
  eq(revived.plies, engine.plies, 'ply count survives');
  eq(Array.from(revived.board).join(''), Array.from(engine.board).join(''), 'the board survives');
  ok(revived.board instanceof Uint8Array, 'and comes back as a typed array');
  eq(names([...revived.legalMoves().keys()], revived.size),
    names([...engine.legalMoves().keys()], engine.size), 'the same moves are legal after a restore');

  // A snapshot whose board length disagrees with its size is thrown away
  // rather than indexed into: every row-major offset would be wrong.
  const corrupt = new GameEngine().restore({ ...snapshot, board: snapshot.board.slice(0, 5) });
  eq(corrupt.board.length, cellCount(corrupt.size), 'a truncated board is replaced with a fresh one');
  const junk = new GameEngine().restore({ ...snapshot, board: snapshot.board.map(() => 9) });
  eq(countDiscs(junk.board).black + countDiscs(junk.board).white, 0,
    'unrecognised cell values become empty rather than a third colour');
  ok(new GameEngine().restore(null) instanceof GameEngine, 'restoring nothing is survivable');
}

section('play again and back to lobby');
{
  const engine = twoPlayerGame({
    size: 6,
    turn: BLACK,
    rows: ['......', '......', '..WB..', '......', '......', '......'],
  });
  engine.playMove('p-black', cellAt(2, 1, 6));
  eq(engine.phase, PHASES.GAME_OVER, 'game over');
  eq(engine.gamesPlayed, 1, 'one game played');

  const wasBlack = engine.playerBySeat(BLACK).id;
  ok(engine.playAgain().ok, 'a rematch starts');
  eq(engine.phase, PHASES.PLAY, 'straight back into play');
  ok(engine.playerBySeat(BLACK).id !== wasBlack, 'colours swap so the same player does not open twice');
  eq(engine.plies, 0, 'a fresh board');
  eq(countDiscs(engine.board).black, 2, 'dealt the opening again');

  ok(engine.backToLobby().ok, 'and the owner can drop back to the lobby');
  eq(engine.phase, PHASES.LOBBY, 'in the lobby');
  ok(engine.setConfig({ boardSize: 10 }).ok, 'where the rules unlock again');
  eq(engine.size, 10, 'and the preview board resizes immediately');
}

// --- Rules -----------------------------------------------------------------

section('config normalization');
{
  const clean = normalizeConfig({});
  eq(JSON.stringify(clean), JSON.stringify(DEFAULTS), 'an empty patch gives the official game');
  eq(describeHouseRules({}).length, 0, 'official play lists no house rules');

  const hostile = normalizeConfig({
    boardSize: 7,
    antiOthello: 'yes',
    legalDots: 1,
    __proto__: { polluted: true },
    ownerId: 'attacker',
    board: 'nonsense',
  });
  eq(hostile.boardSize, 8, 'an odd board size falls back to 8 — the opening needs a centre 2x2');
  eq(hostile.antiOthello, false, 'a non-boolean toggle falls back to the default');
  eq(hostile.legalDots, DEFAULTS.legalDots, 'so does a truthy non-boolean');
  eq(Object.keys(hostile).length, Object.keys(DEFAULTS).length, 'no extra keys survive');
  eq(hostile.ownerId, undefined, 'a config patch cannot smuggle in engine fields');

  eq(normalizeConfig({ boardSize: 999 }).boardSize, 10, 'a huge size clamps into range');
  eq(normalizeConfig({ boardSize: 1 }).boardSize, 6, 'a tiny one clamps up');
  eq(normalizeConfig(null).boardSize, 8, 'a null config is survivable');

  eq(presetOf(presetConfig('quick')), 'quick', 'presets round-trip');
  eq(presetOf(presetConfig('reversed')), 'reversed', 'including Anti-Othello');
  eq(presetOf({ ...presetConfig('classic'), flipPreview: true }), 'classic',
    'turning on an assist does not change the ruleset');
  eq(describeHouseRules(presetConfig('grand'))[0], '10x10 board', 'a size change is a house rule');
}

section('positional weights');
{
  // The canonical 8x8 Othello table. weightsFor() generates it from distance
  // to the edge rather than storing it, which is what lets 6x6 and 10x10 work
  // at all — the bot would otherwise index straight off the end of this.
  const canonical = [
    100, -20, 10, 5, 5, 10, -20, 100,
    -20, -50, -2, -2, -2, -2, -50, -20,
    10, -2, -1, -1, -1, -1, -2, 10,
    5, -2, -1, -1, -1, -1, -2, 5,
    5, -2, -1, -1, -1, -1, -2, 5,
    10, -2, -1, -1, -1, -1, -2, 10,
    -20, -50, -2, -2, -2, -2, -50, -20,
    100, -20, 10, 5, 5, 10, -20, 100,
  ];
  eq(Array.from(weightsFor(8)).join(','), canonical.join(','), 'the generated 8x8 table is the classic one');
  ok(weightsFor(8) === weightsFor(8), 'tables are cached, not rebuilt per call');

  for (const size of BOARD_SIZES) {
    const w = weightsFor(size);
    eq(w.length, cellCount(size), `${size}x${size} table covers every square`);
    for (const corner of cornersFor(size)) eq(w[corner], 100, `${size}x${size} corners score 100`);
    // X-squares — the diagonal neighbour of each corner — must be the worst
    // square on the board, because taking one is what hands the corner over.
    const last = size - 1;
    for (const [r, c] of [[1, 1], [1, last - 1], [last - 1, 1], [last - 1, last - 1]]) {
      eq(w[cellAt(r, c, size)], -50, `${size}x${size} X-square at ${cellName(cellAt(r, c, size), size)}`);
    }
    eq(w[cellAt(0, 1, size)], -20, `${size}x${size} C-square is negative`);
  }
}

section('helpers');
{
  eq(cleanName('  Ada   Lovelace  '), 'Ada Lovelace', 'names collapse whitespace');
  eq(cleanName('BadName'), 'Bad Name', 'control characters are stripped');
  eq(cleanName('x'.repeat(50)).length, 20, 'names are capped');
  eq(cleanName(42), '', 'a non-string name is empty');

  seed(3);
  const source = [1, 2, 3, 4, 5, 6, 7, 8];
  const mixed = shuffle(source);
  eq(source.join(','), '1,2,3,4,5,6,7,8', 'shuffle does not mutate its input');
  eq([...mixed].sort((a, b) => a - b).join(','), '1,2,3,4,5,6,7,8', 'shuffle is a permutation');
  eq(randomBelow(0), 0, 'randomBelow(0) is 0 rather than NaN');
  eq(randomBelow(1), 0, 'randomBelow(1) is always 0');
}

// --- The intents seam ------------------------------------------------------

section('intents dispatcher');
{
  const engine = twoPlayerGame();
  const owner = 'p-black';
  const other = 'p-white';
  eq(engine.ownerId, owner, 'the first player holds the room controls');

  // Unknown types are NOT handled, so the caller can tell "this dispatcher
  // does not own that message" from "that message was refused".
  eq(applyGameIntent(engine, owner, { type: 'teleport' }).handled, false, 'unknown types are unhandled');
  eq(applyGameIntent(engine, owner, null).handled, false, 'a null message is unhandled');
  eq(applyGameIntent(engine, owner, { type: 42 }).handled, false, 'a non-string type is unhandled');

  // Owner gating lives in the dispatcher, not the engine: "who may press the
  // button" is a room policy, not a rule of Reversi.
  const refused = applyGameIntent(engine, other, { type: 'backToLobby' });
  eq(refused.handled, true, 'an owner intent from a non-owner is handled');
  eq(refused.result.ok, false, 'and refused');
  eq(engine.phase, PHASES.PLAY, 'with no effect on the engine');

  // Every intent type in the published lists must actually be routed.
  for (const type of GAME_INTENTS) {
    eq(applyGameIntent(engine, owner, { type, cell: 0, config: {}, playerId: owner, level: 'easy' }).handled,
      true, `${type} is routed`);
  }

  // Cell bounds are checked against THIS board, not a hardcoded 64.
  const fresh = twoPlayerGame();
  for (const bad of [-1, 64, 1e9, 2.5, '19', null, undefined, NaN]) {
    const res = applyGameIntent(fresh, owner, { type: 'playMove', cell: bad });
    ok(res.handled && !res.result.ok, `cell ${String(bad)} is rejected`);
  }
  eq(fresh.plies, 0, 'none of those touched the engine');

  const small = twoPlayerGame({ size: 6 });
  ok(!applyGameIntent(small, owner, { type: 'playMove', cell: 40 }).result.ok,
    'a cell that is legal on 8x8 is out of bounds on 6x6');

  // F7 on a 10x10 is cell 65 — past the end of an 8x8 board, and one of
  // black's four opening moves here.
  const big = twoPlayerGame({ size: 10 });
  eq(cellFromName('F7', 10), 65, 'F7 on a 10x10 is index 65');
  ok(applyGameIntent(big, owner, { type: 'playMove', cell: cellFromName('F7', 10) }).result.ok,
    'and a cell past 64 is fine on 10x10');

  const good = applyGameIntent(fresh, owner, { type: 'playMove', cell: cellAt(2, 3, 8) });
  ok(good.result.ok, 'a real move goes through');
  eq(fresh.plies, 1, 'and lands');
}

section('inbound message guards');
{
  eq(validEnvelope({ type: 'playMove' }).type, 'playMove', 'a well-formed envelope passes');
  eq(validEnvelope(null), null, 'null is rejected');
  eq(validEnvelope('playMove'), null, 'a bare string is rejected');
  eq(validEnvelope({ type: 'x'.repeat(MAX_TYPE_LEN + 1) }), null, 'an oversized type is rejected');
  // typeof [] === 'object', so an array with a type property would otherwise
  // sail straight through.
  const arr = [];
  arr.type = 'playMove';
  eq(validEnvelope(arr), null, 'an array masquerading as a message is rejected');

  eq(validCell(5, 36), 5, 'an in-range cell passes');
  eq(validCell(36, 36), null, 'one past the end is rejected');
  eq(validCell(2.5, 36), null, 'a fraction is rejected');

  eq(validConfigPatch({}), null, 'an empty patch is rejected');
  eq(validConfigPatch([1, 2]), null, 'an array is not a patch');
  const huge = {};
  for (let i = 0; i < 40; i++) huge[`k${i}`] = 1;
  eq(validConfigPatch(huge), null, 'a patch with too many keys is rejected before normalization');

  ok(!!validClientId('a'.repeat(32)), 'a 32-char hex id passes');
  eq(validClientId('short'), null, 'a short id is rejected');
  eq(validClientId('has spaces in it here'), null, 'an id with spaces is rejected');

  eq(decodePeerFrame(JSON.stringify({ type: 'ping' })).type, 'ping', 'a JSON string frame decodes');
  eq(decodePeerFrame('{ not json'), null, 'malformed JSON is dropped, not thrown');
  eq(decodePeerFrame('x'.repeat(MAX_FRAME_BYTES + 1)), null, 'an oversized frame is dropped');
  eq(decodePeerFrame(new ArrayBuffer(8)), null, 'binary frames are refused outright');

  // Time is a parameter here too, so the limiter is testable without waiting.
  const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now: 0 });
  eq([bucket.take(0), bucket.take(0), bucket.take(0)].join(), 'true,true,true', 'the bucket spends its capacity');
  eq(bucket.take(0), false, 'and then refuses');
  eq(bucket.take(2000), true, 'two seconds later it has refilled');
  eq(bucket.take(1e9), true, 'a long gap refills but does not overflow');
  bucket.take(1e9); bucket.take(1e9); bucket.take(1e9);
  eq(bucket.take(1e9), false, 'capacity is still the cap');
}

// --- Bot -------------------------------------------------------------------

// Plays a whole game with a chosen bot level on each seat, checking every
// single move against the generator as it goes. Returns the winner and the
// worst think time seen, so both legality and the time box are observable.
function botGame({ size = 8, levels, anti = false, budgetMs = 5, clock = Date.now }) {
  let board = openingBoard(size);
  let player = BLACK;
  let illegal = 0;
  let worst = 0;
  const cap = cellCount(size) + 10;
  let plies = 0;

  while (plies <= cap) {
    if (!hasLegalMove(board, player, size)) {
      if (!hasLegalMove(board, opponent(player), size)) break;
      player = opponent(player);
      continue;
    }
    const started = clock();
    const cell = chooseMove(board, player, {
      boardSize: size,
      antiOthello: anti,
      level: levels[player],
      deadline: budgetMs === Infinity ? Infinity : started + budgetMs,
      clock,
    });
    worst = Math.max(worst, clock() - started);
    if (!legalMoves(board, player, size).includes(cell)) { illegal++; break; }
    board = applyMove(board, cell, player, size).board;
    player = opponent(player);
    plies++;
  }

  const { black, white } = countDiscs(board);
  const lead = anti ? white - black : black - white;
  return {
    illegal, worst, plies, board,
    winner: lead === 0 ? DRAW : (lead > 0 ? BLACK : WHITE),
  };
}

section('bot: move legality across levels, sizes and scoring');
{
  // The definition of done: every level plays hundreds of complete games
  // without ever producing a move the generator would refuse. A small budget
  // keeps this quick while still driving the real iterative-deepening path —
  // a starved search must still return a legal move from a completed depth.
  const GAMES = 120;
  for (const level of ['easy', 'medium', 'hard']) {
    let illegal = 0;
    let games = 0;
    let worst = 0;
    for (const size of BOARD_SIZES) {
      for (const anti of [false, true]) {
        seed(size * 97 + (anti ? 7 : 3));
        for (let g = 0; g < GAMES / 6; g++) {
          const r = botGame({ size, anti, levels: { [BLACK]: level, [WHITE]: level }, budgetMs: 5 });
          illegal += r.illegal;
          worst = Math.max(worst, r.worst);
          games++;
        }
      }
    }
    eq(illegal, 0, `${level}: ${games} full games with no illegal move`);
    console.log(`  ${level}: ${games} games, worst think ${worst}ms`);
  }
}

section('bot: purity and basic contract');
{
  seed(11);
  const board = openingBoard(8);
  const before = Array.from(board);
  chooseMove(board, BLACK, { boardSize: 8, level: 'hard', deadline: Date.now() + 50 });
  eq(Array.from(board).join(), before.join(), 'chooseMove does not mutate the board it is given');

  eq(chooseMove(null, BLACK, { boardSize: 8 }), null, 'a missing board yields no move');
  eq(chooseMove(openingBoard(6), BLACK, { boardSize: 8 }), null, 'a board of the wrong size yields no move');

  // Board where black is completely shut out.
  const stuck = parseBoard([
    'BB......',
    'BB......',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  eq(chooseMove(stuck, BLACK, { boardSize: 8, level: 'hard' }), null, 'no legal move yields null');

  // Exactly one legal move must come back without consulting the clock at
  // all — a deadline already in the past would otherwise abort the search.
  const oneMove = parseBoard([
    'BW......',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
    '........',
  ]);
  eq(legalMoves(oneMove, BLACK, 8).length, 1, 'the crafted position really has one legal move');
  eq(
    chooseMove(oneMove, BLACK, { boardSize: 8, level: 'hard', deadline: 0 }),
    cellFromName('C1', 8),
    'the only legal move is returned even with the deadline already gone',
  );
}

section('bot: easy is greedy on purpose');
{
  // C4 turns one disc; C6 turns three. A greedy player takes C6 — and that is
  // the beginner trap Easy is built to fall into.
  const rows = [
    '........',
    '........',
    '..BWW...',
    '...BW...',
    '...WWW..',
    '...WB...',
    '........',
    '........',
  ];
  const board = parseBoard(rows);
  const moves = legalMoveMap(board, BLACK, 8);
  const best = Math.max(...[...moves.values()].map((f) => f.length));
  ok(best >= 3, `the crafted position offers a fat capture (${best} discs)`);

  seed(5);
  let greedy = 0;
  const TRIES = 40;
  for (let i = 0; i < TRIES; i++) {
    const cell = chooseMove(board, BLACK, { boardSize: 8, level: 'easy' });
    // EASY_SLACK lets it take anything within one disc of the best.
    if (moves.get(cell).length >= best - 1) greedy++;
  }
  eq(greedy, TRIES, 'easy always picks within one disc of the largest capture');

  // Under Anti-Othello the naive instinct inverts with the win condition.
  const worst = Math.min(...[...moves.values()].map((f) => f.length));
  seed(5);
  let meek = 0;
  for (let i = 0; i < TRIES; i++) {
    const cell = chooseMove(board, BLACK, { boardSize: 8, level: 'easy', antiOthello: true });
    if (moves.get(cell).length <= worst + 1) meek++;
  }
  eq(meek, TRIES, 'under anti-othello easy picks within one disc of the smallest capture');
}

section('bot: the search values corners');
{
  // A1 is open and black can take it by flipping along the top edge only.
  // That last part matters: a corner reached by flipping diagonally also hands
  // you the X-square next to it, and the static table — which cannot know the
  // X-square stops being a liability once you hold the corner — scores that
  // bundle as a net loss. So this position deliberately isolates the corner.
  const board = parseBoard([
    '.WWB....',
    '.B.W....',
    '..BWB...',
    '...BW...',
    '...WBW..',
    '....BB..',
    '........',
    '........',
  ]);
  const corner = cellFromName('A1', 8);
  const flips = legalMoveMap(board, BLACK, 8).get(corner);
  ok(flips, 'A1 really is legal here');
  ok(!flips.includes(cellFromName('B2', 8)), 'and taking it does not also pick up the X-square');
  for (const level of ['medium', 'hard']) {
    seed(3);
    eq(
      chooseMove(board, BLACK, { boardSize: 8, level, deadline: Infinity }),
      corner,
      `${level} takes the open corner`,
    );
  }

  // The other half of the same lesson, and the more valuable one: A1 is empty
  // and B2 is legal, so stepping there offers white the corner. The search has
  // to decline a capture it can see in order to avoid a loss it cannot.
  const trap = parseBoard([
    '..B.....',
    '..W.....',
    'BWWWB...',
    '...BW...',
    '...WB...',
    '........',
    '........',
    '........',
  ]);
  const xSquare = cellFromName('B2', 8);
  ok(legalMoves(trap, BLACK, 8).includes(xSquare), 'the X-square is on offer');
  for (const level of ['medium', 'hard']) {
    seed(3);
    ok(
      chooseMove(trap, BLACK, { boardSize: 8, level, deadline: Infinity }) !== xSquare,
      `${level} refuses the X-square beside an empty corner`,
    );
  }
}

section('bot: deeper levels play stronger');
{
  // Full depth on the small board: hard reaches 6 plies where medium stops at
  // 3, so this measures the depth difference rather than the clock. Colours
  // alternate so neither level keeps the first-move advantage.
  const trials = [
    { strong: 'medium', weak: 'easy', n: 20, floor: 13 },
    { strong: 'hard', weak: 'medium', n: 10, floor: 7 },
  ];
  for (const { strong, weak, n, floor } of trials) {
    seed(42);
    let wins = 0;
    for (let i = 0; i < n; i++) {
      const strongIsBlack = i % 2 === 0;
      const levels = {
        [BLACK]: strongIsBlack ? strong : weak,
        [WHITE]: strongIsBlack ? weak : strong,
      };
      const r = botGame({ size: 6, levels, budgetMs: Infinity });
      eq(r.illegal, 0, `${strong} v ${weak} game ${i} stayed legal`);
      if (r.winner !== DRAW && (r.winner === BLACK) === strongIsBlack) wins++;
    }
    ok(wins >= floor, `${strong} beats ${weak} in ${wins}/${n} games (needed ${floor})`);
    console.log(`  ${strong} v ${weak}: ${wins}/${n}`);
  }
}

section('bot: the time box holds');
{
  // A fake clock makes this exact rather than timing-dependent: every reading
  // advances by a fixed step, so "elapsed" is a count of clock reads and the
  // search must abandon the depth it is on the moment the budget is spent.
  let fake = 0;
  const clock = () => (fake += 1);
  const board = openingBoard(10);
  seed(9);
  const cell = chooseMove(board, BLACK, {
    boardSize: 10, level: 'hard', clock, deadline: 3,
  });
  ok(legalMoves(board, BLACK, 10).includes(cell), 'a search cut off almost immediately still returns a legal move');

  // Real clock, real budget: a full 10x10 midgame think must respect the cap.
  let worst = 0;
  seed(13);
  const r = botGame({ size: 10, levels: { [BLACK]: 'hard', [WHITE]: 'hard' }, budgetMs: SEARCH_BUDGET_MS });
  worst = r.worst;
  eq(r.illegal, 0, 'a full-budget 10x10 game stays legal throughout');
  // Generous ceiling: the check runs every 256 nodes, so the budget can be
  // overshot by whatever the node in flight costs. This is a guard against
  // the box failing open, not a benchmark.
  ok(worst <= SEARCH_BUDGET_MS * 2, `worst think ${worst}ms stayed within twice the ${SEARCH_BUDGET_MS}ms budget`);
  console.log(`  10x10 hard, worst think ${worst}ms`);
}

section('bot: levels and the driver');
{
  eq(BOT_LEVELS.map((l) => l.id).join(), 'easy,medium,hard', 'three levels, in order');
  eq(botLevelFor('nonsense'), 'medium', 'an unknown level falls back to medium');
  eq(botLevelFor('hard'), 'hard', 'a known level is kept');

  const engine = new GameEngine();
  engine.addPlayer('human', 'Human');
  engine.addPlayer('bot', 'Bot', { isBot: true, botLevel: 'poison' });
  eq(engine.playerById('bot').botLevel, 'medium', 'a junk level is coerced when the bot joins');
  eq(engine.setBotLevel('bot', 'hard').ok, true, 'the level can be changed');
  eq(engine.playerById('bot').botLevel, 'hard', 'and it sticks');
  eq(engine.setBotLevel('human', 'hard').ok, false, 'a human has no level to set');

  engine.startGame();
  const driver = createBotDriver({ thinkMs: 1000, budgetMs: 20 });

  // The bot is white; black opens, so nothing should happen yet.
  const botSeat = engine.playerById('bot').seat;
  const humanSeat = engine.playerById('human').seat;
  eq(engine.turn, BLACK, 'black opens');
  eq(driver.tick(engine, 0), false, "the driver does nothing on the human's turn");

  // Play the human's move, then watch the pause be respected.
  const first = [...engine.legalMoves().keys()][0];
  eq(applyGameIntent(engine, 'human', { type: 'playMove', cell: first }).result.ok,
    humanSeat === BLACK, 'the human moves when it is their colour');

  if (engine.turn === botSeat) {
    const pliesBefore = engine.plies;
    // The pause is measured from the first tick that SEES the turn, not from
    // the move that created it — the driver holds no clock of its own and only
    // learns what time it is when someone ticks it.
    eq(driver.tick(engine, 0), false, 'the pause starts on the first tick that sees the turn');
    eq(driver.tick(engine, 999), false, 'still thinking at 999ms');
    eq(driver.isThinking(engine, 999), true, 'and it reports itself as thinking');
    eq(driver.tick(engine, 1000), true, 'it moves once the pause is up');
    eq(engine.plies, pliesBefore + 1, 'exactly one move was played');
    eq(driver.tick(engine, 1001), false, 'and it does not move twice for the same turn');
  }

  // A finished game must not be driven.
  engine.phase = PHASES.GAME_OVER;
  eq(driver.tick(engine, 1e9), false, 'a finished game is left alone');
  ok(BOT_THINK_MS > 0, 'the think pause is a positive number of milliseconds');
}

// --- The wire, below the protocol -----------------------------------------

section('room codes and the peer id derived from them');
{
  eq(CODE_LENGTH, 4, 'codes are four characters');

  // O/0 and I/1 are absent from the alphabet because these get read aloud down
  // a phone line. normalizeCode DROPS them rather than guessing a mapping:
  // there is no correct character to map 0 to, and a code that comes out short
  // fails the length check visibly instead of dialling the wrong room.
  eq(normalizeCode('ab12'), 'AB2', 'the digit 1 is not in the alphabet and is dropped');
  eq(normalizeCode('o0i1'), '', 'a code made entirely of banned characters normalizes to empty');
  eq(normalizeCode(' k m 7 q '), 'KM7Q', 'spacing and case are irrelevant');
  eq(normalizeCode('KM7QXX'), 'KM7Q', 'and anything past four characters is cut');
  eq(normalizeCode(null), '', 'a non-string is empty, not a crash');

  seed(11);
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    if (code.length !== CODE_LENGTH || normalizeCode(code) !== code) {
      ok(false, `generated code ${code} is not stable under normalization`);
      break;
    }
  }
  ok(true, '200 generated codes are all four legal characters');

  // There is no discovery service in this app: the host's peer id IS the room
  // code under a prefix, which is the entire reason a guest can find a host
  // knowing nothing but four characters. The round trip has to be exact.
  eq(peerIdForCode('km7q'), `${PEER_PREFIX}KM7Q`, 'the peer id is the prefix plus the normalized code');
  eq(codeFromPeerId(peerIdForCode('km7q')), 'KM7Q', 'and it round-trips');
  eq(codeFromPeerId('reversi-v0-KM7Q'), '', 'an id from a different protocol version yields no code');
  eq(codeFromPeerId('KM7Q'), '', 'a bare code is not a peer id');
  eq(codeFromPeerId(42), '', 'a non-string id yields no code');

  // Two tabs typing the same code in different cases must reach one room.
  eq(peerIdForCode('KM7Q'), peerIdForCode(' km7q '), 'case and spacing cannot split a room in two');
}

section('peer errors are classified and translated');
{
  // Fatal means "stop retrying" — the reconnect loop reads this, so a
  // misclassification is either an infinite retry against a hopeless error or
  // a game abandoned over a blip.
  ok(isFatalPeerError({ type: 'unavailable-id' }), 'a taken room code is fatal');
  ok(isFatalPeerError({ type: 'browser-incompatible' }), 'no WebRTC at all is fatal');
  ok(!isFatalPeerError({ type: 'network' }), 'a network blip is NOT fatal');
  ok(!isFatalPeerError({ type: 'peer-unavailable' }), 'a host that is not up yet is not fatal');
  ok(!isFatalPeerError(null), 'a missing error is not fatal');
  ok(!isFatalPeerError({}), 'an error with no type is not fatal');

  // Every message reaches a player, so none may be blank and none may leak
  // PeerJS's own developer-facing wording.
  for (const type of ['peer-unavailable', 'unavailable-id', 'browser-incompatible',
    'network', 'server-error', 'socket-error', 'socket-closed', 'webrtc',
    'disconnected', 'ssl-unavailable', 'something-new', undefined]) {
    const text = describePeerError({ type });
    ok(typeof text === 'string' && text.length > 10, `${String(type)} has a readable message`);
  }
  eq(describePeerError(null), 'Something went wrong with the connection.',
    'even a null error produces a sentence');
}

section('the server seam is present and unwired');
{
  // The brief's seam: shipped blank on day one so that adding a backend later
  // is a matter of filling these in, not of teaching every call site the
  // difference between local and remote.
  eq(SERVER_URL, '', 'SERVER_URL is empty in v1');
  eq(SERVER_HEALTH, '', 'SERVER_HEALTH is empty in v1');
  eq(serverConfigured(), false, 'so serverConfigured() is false');

  // The other half of the lesson: whenever these DO get used, they must not be
  // tight. A cold TLS handshake to a sleeping host ran ~4.6s in this family of
  // projects, so a 4s budget failed the first request of every session.
  ok(HEALTH_TIMEOUT_MS >= 10000, 'the health budget is at least ten seconds');
  ok(HEALTH_RETRIES >= 1, 'and a failed probe is retried at least once');
}

// --- Naming ----------------------------------------------------------------

section('setName');
{
  const engine = twoPlayerGame();
  const owner = 'p-black';

  // setName is a PLAYER intent, not an owner one: a guest must be able to
  // change their own name without the host's permission.
  ok(PLAYER_INTENTS.includes('setName'), 'setName is a player intent');
  ok(!OWNER_INTENTS.includes('setName'), 'and is not owner-gated');

  ok(applyGameIntent(engine, 'p-white', { type: 'setName', name: 'Ada' }).result.ok,
    'a non-owner can rename themselves');
  eq(engine.playerById('p-white').name, 'Ada', 'and it lands');

  ok(applyGameIntent(engine, owner, { type: 'setName', name: '  Grace   Hopper  ' }).result.ok,
    'a name goes through the same cleaning as everywhere else');
  eq(engine.playerById(owner).name, 'Grace Hopper', 'collapsed, trimmed');

  // Blank falls back to the colour rather than staying empty, because the name
  // is interpolated into " to play" in the banner and the live region.
  ok(applyGameIntent(engine, owner, { type: 'setName', name: '   ' }).result.ok, 'a blank name is accepted');
  eq(engine.playerById(owner).name, 'Black', 'and falls back to the colour, never to empty');

  // Refused, not truncated: a megabyte of text is not a typo, and the guard
  // exists to stop it reaching cleanName at all.
  const huge = applyGameIntent(engine, owner, { type: 'setName', name: 'x'.repeat(5000) });
  eq(huge.result.ok, false, 'an absurd name is refused outright');
  eq(engine.playerById(owner).name, 'Black', 'and changes nothing');
  eq(validNameField('x'.repeat(5000)), null, 'the guard is what refuses it');
  eq(validNameField('x'.repeat(64)), 'x'.repeat(64), 'a long-but-sane name passes the guard');
  eq(validNameField(42), null, 'a non-string name is refused');

  eq(applyGameIntent(engine, 'nobody', { type: 'setName', name: 'Ghost' }).result.ok, false,
    'someone who is not in the game cannot rename anyone');
}

// --- What a guest accepts from the host ------------------------------------

section('validPublicState');
{
  // This is the most trusted message in the protocol and the one a guest
  // renders directly, so its guard gets the most scrutiny. A guest has no
  // engine — host-authoritative is the whole design — so this checks SHAPE and
  // BOUNDS, never legality.
  const engine = twoPlayerGame();
  engine.playMove('p-black', cellAt(2, 3, 8));
  const base = engine.publicState();

  ok(!!validPublicState(base), 'a real broadcast passes');
  ok(!!validPublicState(twoPlayerGame({ size: 6 }).publicState()), 'so does a 6x6 one');
  ok(!!validPublicState(twoPlayerGame({ size: 10 }).publicState()), 'and a 10x10 one');

  // Round-tripping through JSON is what actually happens on the wire, and is
  // the only form this function will ever really see.
  ok(!!validPublicState(JSON.parse(JSON.stringify(base))), 'and it survives the wire');

  // `mangle` shallow-copies so each case starts from a known-good object.
  const mangle = (patch) => validPublicState({ ...base, ...patch });

  eq(mangle({ size: 'eight' }), null, 'a non-numeric size is rejected');
  eq(mangle({ size: 64 }), null, 'an absurd size is rejected');
  eq(mangle({ size: 10 }), null, 'a size that disagrees with the board length is rejected');
  eq(mangle({ board: base.board.slice(1) }), null, 'a board of the wrong length is rejected');
  eq(mangle({ board: 'x'.repeat(64) }), null, 'a board that is a string is rejected');
  eq(mangle({ config: null }), null, 'a missing config is rejected');
  eq(mangle({ score: [] }), null, 'a score that is an array is rejected');
  eq(mangle({ phase: 7 }), null, 'a non-string phase is rejected');
  eq(mangle({ plies: -1 }), null, 'negative plies are rejected');
  eq(mangle({ plies: 1.5 }), null, 'fractional plies are rejected');

  eq(mangle({ players: [...base.players, { id: 'x', name: 'Third' }] }), null,
    'a third seat is rejected — the lobby would render a player the engine can never reach');
  eq(mangle({ players: [{ id: '', name: 'Nameless' }] }), null, 'a player with no id is rejected');
  eq(mangle({ players: [{ id: 'x' }] }), null, 'a player with no name is rejected');
  eq(mangle({ players: 'both' }), null, 'a players field that is not an array is rejected');
  ok(!!mangle({ players: [] }), 'but an empty seat list is fine — that is a fresh room');

  // The two fields that are spread or iterated by the renderer, and so turn a
  // wrong-looking board into a thrown TypeError mid-game.
  eq(mangle({ lastMove: { cell: 19, flips: 'lots' } }), null, 'flips that are not an array are rejected');
  eq(mangle({ lastMove: { cell: 19, flips: new Array(65).fill(0) } }), null,
    'more flips than the board has squares is rejected');
  ok(!!mangle({ lastMove: null }), 'no last move is fine');
  ok(!!mangle({ lastMove: undefined }), 'and so is an absent one');

  eq(mangle({ log: 'a line' }), null, 'a log that is not an array is rejected');
  eq(mangle({ log: new Array(500).fill({ text: 'spam' }) }), null, 'an unbounded log is rejected');
  eq(mangle({ log: [{ at: 1 }] }), null, 'a log entry with no text is rejected');

  eq(mangle({ lastPass: 'white passed' }), null, 'a non-object lastPass is rejected');
  eq(mangle({ finalScore: 42 }), null, 'a non-object finalScore is rejected');

  eq(validPublicState(null), null, 'null is rejected');
  eq(validPublicState([]), null, 'an array is rejected');
  eq(validPublicState('{}'), null, 'a string is rejected');

  // Shape only, by design: this one is a legal-looking broadcast of a position
  // that could never have been reached, and it passes. The guard's job is to
  // stop a crash, not to referee a game it has no engine for.
  ok(!!mangle({ board: new Array(64).fill(BLACK) }), 'an impossible-but-well-formed board passes');

  // The connection cap is the other half of the hostile-peer budget: two
  // seats, plus a small allowance for a reconnecting player still holding a
  // half-dead channel.
  ok(MAX_CONNECTIONS >= 2 && MAX_CONNECTIONS <= 8, 'the connection cap is small but not stingy');
}

section('boardFrom rebuilds a board from anything');
{
  // Both the renderer and the bot need a real Uint8Array, and both are handed
  // a plain array that came off the wire as JSON.
  const engine = twoPlayerGame();
  engine.playMove('p-black', cellAt(2, 3, 8));
  const pub = JSON.parse(JSON.stringify(engine.publicState()));
  const rebuilt = boardFrom(pub);

  eq(rebuilt.length, 64, 'the rebuilt board is the right length');
  eq(rebuilt.join(''), Array.from(engine.board).join(''), 'and identical to the original');
  eq(countDiscs(rebuilt).black, 4, 'with the same discs on it');

  // Every value that is not a disc becomes EMPTY rather than being trusted, so
  // a peer cannot introduce a third colour that the renderer has no class for.
  const junk = boardFrom({ board: [BLACK, WHITE, 9, -1, 'B', null, undefined, NaN, 1.5] });
  eq(junk.join(','), `${BLACK},${WHITE},0,0,0,0,0,0,0`, 'anything that is not a disc becomes empty');
  eq(boardFrom(null).length, 0, 'a missing payload gives an empty board, not a throw');
  eq(boardFrom({ board: 'not an array' }).length, 0, 'and so does a board of the wrong type');
}

// --- Toggles ---------------------------------------------------------------

section('every toggle, read the way the app reads it');
{
  // The five host toggles are only ever read through these accessors, so this
  // is the surface that matters — normalizeConfig is tested separately above.
  eq(RULE_KEYS.length, 5, 'there are five host toggles');
  for (const key of ['boardSize', 'antiOthello', 'legalDots', 'flipPreview', 'discCounter']) {
    ok(RULE_KEYS.includes(key), `${key} is one of them`);
  }

  // Defaults: the official game, with the two assists that work everywhere on
  // and the one that does not off.
  eq(boardSizeFor(DEFAULTS), 8, 'the default board is 8x8');
  eq(antiOthelloOn(DEFAULTS), false, 'the default scoring is classic');
  eq(legalDotsOn(DEFAULTS), true, 'legal dots default on');
  eq(discCounterOn(DEFAULTS), true, 'the disc counter defaults on');
  // Flip preview is the deliberate exception. It is driven by hover, which a
  // touch device does not have, so defaulting it on would advertise a feature
  // that silently does nothing for a large share of players. Off by default,
  // available to anyone with a pointer who wants it.
  eq(flipPreviewOn(DEFAULTS), false, 'flip preview defaults OFF — it is hover-only');

  for (const size of BOARD_SIZES) {
    eq(boardSizeFor({ boardSize: size }), size, `${size}x${size} is offered`);
    eq(size % 2, 0, `${size} is even, so the opening four have a centre to sit in`);
  }
  // Garbage from the wire falls back rather than producing a board with no
  // centre, or a negative one.
  for (const bad of [7, 0, -8, 1e9, '8', null, undefined, NaN]) {
    eq(boardSizeFor({ boardSize: bad }), DEFAULTS.boardSize, `boardSize ${String(bad)} falls back to the default`);
  }

  // Each assist reads independently — turning one off must not disturb another.
  const off = { legalDots: false, flipPreview: false, discCounter: false };
  eq(legalDotsOn(off), false, 'dots off');
  eq(flipPreviewOn(off), false, 'preview off');
  eq(discCounterOn(off), false, 'counter off');
  eq(legalDotsOn({ ...DEFAULTS, flipPreview: false }), true, 'turning preview off leaves dots alone');
  eq(discCounterOn({ ...DEFAULTS, legalDots: false }), true, 'turning dots off leaves the counter alone');

  // The lobby summaries. Defaults produce no house-rule line at all, which is
  // what makes a non-default game visible at a glance.
  eq(describeHouseRules(DEFAULTS).length, 0, 'a default game has nothing to announce');
  eq(describeHouseRules({ boardSize: 6 }).join(' | '), '6x6 board', 'a small board is announced');
  eq(describeHouseRules({ boardSize: 10, antiOthello: true }).join(' | '),
    '10x10 board | Anti-Othello: fewest discs wins', 'and so is both at once');

  const allOn = { legalDots: true, flipPreview: true, discCounter: true };
  eq(describeAssists(allOn).length, 3, 'all three assists are listed when all three are on');
  eq(describeAssists(off).length, 0, 'and none when all three are off');
  eq(describeAssists(DEFAULTS).join(' | '),
    'Legal-move dots | Live disc count', 'the list follows the toggles');

  // An assist is an assist: none of them may touch the rules. Same seed, same
  // moves, assists flipped — the games must be identical ply for ply.
  const play = (config) => {
    seed(77);
    const engine = twoPlayerGame({ size: 8, ...config });
    while (engine.phase === PHASES.PLAY) {
      const moves = [...engine.legalMoves().keys()];
      engine.playMove(engine.currentPlayer.id, moves[randomBelow(moves.length)]);
    }
    return `${engine.plies}:${Array.from(engine.board).join('')}:${engine.winner}`;
  };
  eq(play({ ...DEFAULTS }), play(off), 'the assists change nothing about the game itself');
}

// --- Surviving a reload ----------------------------------------------------

// A Map-backed stand-in for localStorage. The storage layer is the one part of
// util.js the engine's correctness depends on — a bad round-trip here loses a
// game in progress — so it is worth exercising for real rather than by hand in
// a browser, where the failure would only ever show up as "my game vanished".
function fakeStorage({ throws = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) { if (throws) throw new Error('denied'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { if (throws) throw new Error('denied'); map.set(k, String(v)); },
    removeItem(k) { if (throws) throw new Error('denied'); map.delete(k); },
  };
}

section('a reload lands back in the same game');
{
  const store = fakeStorage();
  globalThis.localStorage = store;

  // Identity first: generated once, then stable forever. This is the value a
  // seat in a live game is bound to, and nothing re-issues it.
  seed(101);
  const id = clientId();
  ok(/^[0-9a-f]{32}$/.test(id), 'the client id is 128 bits of hex');
  eq(clientId(), id, 'and is the same on every subsequent call');
  eq(store.map.get('reversi.clientId'), id, 'stored under the reversi. prefix');
  for (const key of store.map.keys()) {
    ok(key.startsWith('reversi.'), `${key} is namespaced to this app`);
  }

  // A real game, mid-play, through the exact path a reload takes.
  const engine = twoPlayerGame({ size: 10, antiOthello: true });
  engine.playMove('p-black', cellFromName('F7', 10));
  engine.playMove('p-white', [...engine.legalMoves().keys()][0]);
  const before = engine.publicState();

  saveEngineSnapshot(engine.serialize());
  saveSession({ mode: 'p2p', code: 'KM7Q', screen: 'game' });

  const revived = new GameEngine().restore(loadEngineSnapshot());
  const after = revived.publicState();
  eq(JSON.stringify(after), JSON.stringify(before), 'the whole game survives the round trip');
  eq(revived.size, 10, 'including a non-default board size');
  eq(revived.config.antiOthello, true, 'and the house rules');
  eq(revived.plies, 2, 'and the position');

  // And it is still a live engine, not a picture of one.
  const moves = [...revived.legalMoves().keys()];
  ok(moves.length > 0, 'the restored engine can still generate moves');
  ok(revived.playMove(revived.currentPlayer.id, moves[0]).ok, 'and still accept one');

  const session = loadSession();
  eq(session.mode, 'p2p', 'the session remembers the mode');
  eq(session.code, 'KM7Q', 'and the room code');

  // Sessions expire rather than lingering: a snapshot from last week is
  // almost never what someone opening the page wants to see. Date.now is
  // swapped rather than waited on, for the same reason the engine has no
  // timers anywhere.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 7 * 60 * 60 * 1000;   // TTL is six hours
    eq(loadSession(), null, 'a stale session is not resumed');
  } finally {
    Date.now = realNow;
  }
  eq(loadEngineSnapshot(), null, 'and expiring it drops the snapshot with it');

  // THE guarantee behind "Clear cache & reload": wiping the session must never
  // take the identity or the display name with it.
  saveName('Ada');
  saveLastCode('km7q');
  saveEngineSnapshot(engine.serialize());
  saveSession({ mode: 'hotseat' });
  clearSession();
  eq(loadSession(), null, 'the session is gone');
  eq(loadEngineSnapshot(), null, 'the snapshot is gone');
  eq(clientId(), id, 'the client id is NOT — it is unrecoverable if lost');
  eq(loadName(), 'Ada', 'and neither is the name');
  eq(loadLastCode(), 'KM7Q', 'the last room code is normalized on the way back out');

  // Corrupt storage degrades rather than throwing on boot.
  store.map.set('reversi.session', '{ not json');
  store.map.set('reversi.engine', 'nonsense');
  eq(loadSession(), null, 'a corrupt session reads as absent');
  eq(loadEngineSnapshot(), null, 'so does a corrupt snapshot');
  store.map.set('reversi.clientId', 'no spaces allowed here!');
  ok(clientId() !== 'no spaces allowed here!', 'a malformed stored id is replaced');

  // Private browsing and some enterprise policies throw on ACCESS, not just on
  // write. The app must still boot.
  globalThis.localStorage = fakeStorage({ throws: true });
  const volatileId = clientId();
  ok(/^[0-9a-f]{32}$/.test(volatileId), 'with no storage at all there is still an id for this page load');
  eq(clientId(), volatileId, 'and it is stable within the session');
  eq(loadName(), '', 'reads degrade to empty rather than throwing');
  eq(loadSession(), null, 'and so does the session');
  saveName('Ignored');    // must not throw
  clearSession();         // must not throw
  ok(true, 'writes against dead storage are swallowed');

  delete globalThis.localStorage;
}

// --- Full random games -----------------------------------------------------

section('random full games');
{
  const GAMES = 300;
  for (const size of BOARD_SIZES) {
    for (const antiOthello of [false, true]) {
      seed(size * 1000 + (antiOthello ? 1 : 0));
      let draws = 0;
      let passes = 0;
      let shortGames = 0;
      let problems = 0;

      for (let g = 0; g < GAMES; g++) {
        const engine = twoPlayerGame({ size, antiOthello });
        const cap = cellCount(size) + 10;   // one disc per ply; the slack is paranoia
        let plies = 0;

        while (engine.phase === PHASES.PLAY) {
          if (plies++ > cap) { problems++; break; }
          const moves = [...engine.legalMoves().keys()];
          if (!moves.length) { problems++; break; }   // PLAY with no moves is a bug
          const actor = engine.currentPlayer;
          const before = countDiscs(engine.board);
          const cell = moves[randomBelow(moves.length)];
          const res = engine.playMove(actor.id, cell);
          if (!res.ok) { problems++; break; }
          if (!engine.lastMove.flips.length) problems++;
          const after = countDiscs(engine.board);
          // Every move places exactly one disc and flips at least one, so the
          // total always rises by exactly one and the mover's count rises by
          // at least two.
          if (after.black + after.white !== before.black + before.white + 1) problems++;
          if (engine.lastPass) passes++;
        }

        if (engine.phase !== PHASES.GAME_OVER) { problems++; continue; }

        const { black, white, empty } = engine.finalScore;
        if (black + white + empty !== cellCount(size)) problems++;
        if (black + white !== 4 + engine.plies) problems++;
        if (empty > 0) shortGames++;
        if (engine.winner === DRAW) {
          draws++;
          if (black !== white) problems++;
        } else {
          const expected = antiOthello
            ? (black < white ? BLACK : WHITE)
            : (black > white ? BLACK : WHITE);
          if (engine.winner !== expected) problems++;
        }
        // Once a game is over, both sides must genuinely be stuck.
        if (hasLegalMove(engine.board, BLACK, size)) problems++;
        if (hasLegalMove(engine.board, WHITE, size)) problems++;
      }

      const label = `${size}x${size}${antiOthello ? ' anti' : ''}`;
      eq(problems, 0, `${label}: ${GAMES} random games with no rule violations`);
      ok(passes > 0, `${label}: at least one turn was auto-passed across the run`);
      console.log(`  ${label}: ${GAMES} games, ${draws} drawn, ${shortGames} ended with empty squares, ${passes} passes`);
    }
  }
}

// --- Packaging -------------------------------------------------------------

// Not engine tests, and deliberately here anyway: the failure they catch is
// the single nastiest one this app can ship. sw.js precaches a list of files
// by hand, and the browser resolves `import` one file at a time — so a module
// added to js/ but forgotten in SHELL leaves the app unable to boot OFFLINE
// while working perfectly in every test and every online reload. It would be
// found by a user on a train, not by anyone here.
//
// Checking it by reading the files is worth more than checking it by eye,
// because the eye only looks when it remembers to.

section('packaging: the service worker precaches the whole import graph');
{
  const root = new URL('..', import.meta.url);
  const readText = (rel) => readFileSync(new URL(rel, root), 'utf8');

  const sw = readText('sw.js');
  const shellBlock = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const shell = new Set([...shellBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  ok(shell.size > 10, 'the SHELL list parsed');

  // Walk the real import graph from the entry point, the way the browser does.
  const seen = new Set();
  const queue = ['js/main.js'];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readText(file);
    for (const m of src.matchAll(/from\s+'(\.\/[^']+)'/g)) {
      queue.push(`js/${m[1].slice(2)}`);
    }
  }
  ok(seen.size >= 11, `the graph reached ${seen.size} modules from js/main.js`);

  for (const file of [...seen].sort()) {
    ok(shell.has(`./${file}`), `./${file} is in SHELL`);
  }

  // The reverse direction catches the other rot: a module deleted or renamed,
  // leaving SHELL pointing at a file that no longer exists. cache.addAll()
  // rejects as a unit, so ONE bad path fails the whole install and the app
  // silently never gains an offline mode at all.
  for (const entry of shell) {
    if (entry === './') continue;
    ok(existsSync(new URL(entry.slice(2), root)), `SHELL entry ${entry} exists on disk`);
  }

  // Anything js/main.js pulls in that the graph walk missed would be a dynamic
  // import, which the walk above cannot see and the browser would still need.
  const dynamic = [...readText('js/main.js').matchAll(/import\(\s*'([^']+)'/g)].map((m) => m[1]);
  eq(dynamic.length, 0, 'there are no dynamic imports for the walk to miss');
}

section('packaging: the page, the manifest and the worker agree');
{
  const root = new URL('..', import.meta.url);
  const readText = (rel) => readFileSync(new URL(rel, root), 'utf8');

  const html = readText('index.html');
  const sw = readText('sw.js');
  const shellBlock = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const shell = new Set([...shellBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]));

  // Every same-origin asset the page pulls must be relative, or it breaks the
  // moment the site is served from a GitHub Pages SUBPATH rather than a root.
  const localRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('data:'));
  for (const ref of localRefs) {
    ok(ref.startsWith('./'), `${ref} is a relative path`);
    ok(existsSync(new URL(ref.slice(2), root)), `${ref} exists`);
    // sw.js registers itself and must NOT precache itself.
    if (ref !== './sw.js') ok(shell.has(ref), `${ref} is precached`);
  }

  const manifest = JSON.parse(readText('manifest.webmanifest'));
  eq(manifest.start_url, './', 'the manifest start_url is relative');
  eq(manifest.scope, './', 'and so is the scope');
  ok(manifest.icons.length >= 3, 'there are at least three icons');
  ok(manifest.icons.some((i) => String(i.purpose || '').includes('maskable')),
    'one of them is maskable');
  for (const icon of manifest.icons) {
    ok(icon.src.startsWith('./'), `icon ${icon.src} is relative`);
    ok(existsSync(new URL(icon.src.slice(2), root)), `icon ${icon.src} exists`);
    ok(shell.has(icon.src), `icon ${icon.src} is precached`);
  }
  eq(manifest.theme_color, '#0A0B12', 'the theme colour matches the --bg token');

  // The analytics beacon must never be routed or precached: one answered from
  // cache records nothing, and offline loads going uncounted is the correct
  // trade-off.
  ok(html.includes('gc.zgo.at/count.js'), 'the beacon is on the page');
  // sw.js DOES name the beacon, in a comment explaining why it is left alone —
  // which is the reason it stays left alone. So the check is that it never
  // reaches a cache list or an interception branch, not that the string is
  // absent. `code` is the file with its comments stripped.
  const code = sw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!code.includes('gc.zgo.at'), 'but no live line in the worker references it');
  ok(!code.includes('goatcounter'), 'nor the counter endpoint');
  ok(!shell.has('//gc.zgo.at/count.js'), 'the beacon is not precached');
  // The interception list is a closed set. Anything not named here falls
  // through to the network untouched, which is what the beacon relies on.
  const intercepted = [...code.matchAll(/hostname === '([^']+)'/g)].map((m) => m[1]);
  eq(intercepted.sort().join(' '), 'fonts.googleapis.com fonts.gstatic.com unpkg.com',
    'only fonts and the pinned CDN are intercepted by hostname');

  // The PeerJS version pinned in the page and the one precached must match, or
  // the cache holds a library the page never asks for.
  const pinned = html.match(/unpkg\.com\/peerjs@([\d.]+)/);
  ok(!!pinned, 'PeerJS is pinned to an exact version in the page');
  ok(sw.includes(pinned[0]), `the worker precaches that same version (${pinned[1]})`);
  // Best-effort only. In SHELL it would be a CDN hiccup failing the whole
  // install, and hotseat and bot mode do not need the file at all.
  ok(!shell.has(`https://${pinned[0]}`), 'but PeerJS is not in SHELL');
}

section('packaging: the felt does not evict the squares it sits behind');
{
  // A layout regression that no amount of DOM testing catches, because the DOM
  // is correct and only the geometry is wrong — which is exactly why it is
  // pinned here in text rather than left to be noticed by eye.
  //
  // .felt spans the whole playing area. As a normal grid item that marks every
  // one of those cells OCCUPIED, and auto-placement refuses to overlap an
  // occupied cell, so all 64 squares get evicted into implicit rows down the
  // gutter column and the board collapses. Absolute positioning is what stops
  // it being a grid item at all; it still reads grid-column/grid-row to find
  // its containing block, but it no longer consumes anything.
  const css = readFileSync(new URL('../css/styles.css', import.meta.url), 'utf8');
  const ruleFor = (sel) => {
    const at = css.indexOf(`\n${sel} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  const felt = ruleFor('.felt');
  ok(!!felt, '.felt has a rule');
  ok(/position:\s*absolute/.test(felt), '.felt is positioned, not placed');
  // Out-of-flow and empty means shrink-to-fit means zero. It needs stretching
  // to the grid area it resolved.
  ok(/inset:\s*0/.test(felt), '.felt is stretched to the area it resolved');
  ok(/grid-column:\s*2\s*\/\s*-1/.test(felt), '.felt still spans the playing columns');
  ok(/grid-row:\s*2\s*\/\s*-1/.test(felt), '.felt still spans the playing rows');

  // The pairing. Without this the felt resolves against the viewport and the
  // board loses its surface entirely.
  ok(/position:\s*relative/.test(ruleFor('.board')),
    '.board is the containing block for it');

  // The squares must stay auto-placed — the fix works precisely because
  // nothing else in the board competes for explicit territory.
  ok(!/grid-(area|column|row)/.test(ruleFor('.cell')),
    '.cell claims no grid position of its own');
}

// --- Result ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
