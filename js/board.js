// ============================================================================
// board.js — Grid geometry and the flip scan. The whole of Reversi's movement
// rule lives in this file and nowhere else.
//
// NOTHING HERE HARDCODES 8. Every function takes `size` because the host can
// choose a 6x6, 8x8 or 10x10 board (see js/rules.js). Sizes are always EVEN so
// that the four-disc centre opening is well defined.
//
// Pure module: no imports, no DOM, no clock, no randomness. That makes it
// directly testable in Node and safe for the bot to hammer thousands of times
// inside a search loop.
// ============================================================================

// Cell contents. Deliberately small integers rather than strings: the bot's
// alpha-beta search copies whole boards, and a Uint8Array of ints is both
// cheaper to clone and cheaper to compare than an array of 'black'/'white'.
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export function opponent(player) {
  return player === BLACK ? WHITE : BLACK;
}

// The eight compass directions as [rowDelta, colDelta]. A move sandwiches
// opponent discs along ANY of these, and every sandwiched run flips at once —
// so the scan below runs all eight rays for every candidate, it does not stop
// at the first one that works.
export const DIRECTIONS = Object.freeze([
  Object.freeze([-1, -1]), Object.freeze([-1, 0]), Object.freeze([-1, 1]),
  Object.freeze([0, -1]),                          Object.freeze([0, 1]),
  Object.freeze([1, -1]),  Object.freeze([1, 0]),  Object.freeze([1, 1]),
]);

// Column labels for the coordinate gutter. Ten letters covers the largest
// board; I is included because unlike chess, Othello notation does not skip it.
export const COLUMN_LETTERS = 'ABCDEFGHIJ';

// Flat row-major indexing: cell = row * size + col. The same scheme as the
// other games in this family, and it keeps a board a single contiguous array
// that structuredClone-free `.slice()` can copy in one go.
export function cellAt(row, col, size) {
  return row * size + col;
}

export function rowOf(cell, size) {
  return Math.floor(cell / size);
}

export function colOf(cell, size) {
  return cell % size;
}

export function cellCount(size) {
  return size * size;
}

export function inBounds(row, col, size) {
  return row >= 0 && row < size && col >= 0 && col < size;
}

// "D5", "A1". Used for the gutter, the move log and every aria-label, so an
// out-of-range cell returns a placeholder rather than throwing — a corrupt
// cell from a hostile peer should render as nonsense, not crash the tab.
export function cellName(cell, size) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= cellCount(size)) return '?';
  return COLUMN_LETTERS[colOf(cell, size)] + (rowOf(cell, size) + 1);
}

// Parses "d5" / "D5" back to a cell index. Test-suite and log-replay
// convenience; nothing in the running app calls it.
export function cellFromName(name, size) {
  if (typeof name !== 'string') return -1;
  const m = /^([A-Za-z])(\d{1,2})$/.exec(name.trim());
  if (!m) return -1;
  const col = COLUMN_LETTERS.indexOf(m[1].toUpperCase());
  const row = Number(m[2]) - 1;
  if (col < 0 || !inBounds(row, col, size)) return -1;
  return cellAt(row, col, size);
}

// The standard opening: four discs in the centre, same colours diagonal.
// On 8x8 that is white d4/e5 and black e4/d5, which is exactly what
// `mid = size / 2` produces — so 6x6 and 10x10 get the correct analogue for
// free rather than needing their own table.
export function openingBoard(size) {
  const board = new Uint8Array(cellCount(size));
  const mid = size / 2;
  board[cellAt(mid - 1, mid - 1, size)] = WHITE;
  board[cellAt(mid - 1, mid, size)] = BLACK;
  board[cellAt(mid, mid - 1, size)] = BLACK;
  board[cellAt(mid, mid, size)] = WHITE;
  return board;
}

export function cloneBoard(board) {
  return Uint8Array.from(board);
}

// THE RULE. Walks all eight rays from `cell`; a ray contributes only if it
// crosses one or more UNBROKEN opponent discs and then lands on one of the
// mover's own. Running off the edge or hitting an empty square kills the ray,
// which is why `run` is discarded rather than merged on those paths.
//
// Returns the flat list of every disc the move would turn over, across all
// directions. An empty list means the move is illegal: Reversi has no
// zero-flip placements, and that is the ONLY legality test there is.
export function flipsFor(board, cell, player, size) {
  const flips = [];
  if (!Number.isInteger(cell) || cell < 0 || cell >= board.length) return flips;
  if (board[cell] !== EMPTY) return flips;

  const foe = opponent(player);
  const row = rowOf(cell, size);
  const col = colOf(cell, size);

  for (const [dr, dc] of DIRECTIONS) {
    let r = row + dr;
    let c = col + dc;
    const run = [];
    while (inBounds(r, c, size) && board[cellAt(r, c, size)] === foe) {
      run.push(cellAt(r, c, size));
      r += dr;
      c += dc;
    }
    // Only a closing disc of the mover's own colour cements the run. Falling
    // off the board or stopping on EMPTY leaves it open, and an open run flips
    // nothing.
    if (run.length && inBounds(r, c, size) && board[cellAt(r, c, size)] === player) {
      for (const f of run) flips.push(f);
    }
  }
  return flips;
}

export function isLegalMove(board, cell, player, size) {
  return flipsFor(board, cell, player, size).length > 0;
}

// Every legal move for `player`, as a Map of cell -> flipped cells. A Map
// rather than an array because the UI wants the flip list for the preview
// assist and the engine wants it to apply the move, and computing the scan
// twice for every cell of a 10x10 board is waste the bot cannot afford.
//
// Iteration order is ascending cell index, which makes the bot's move ordering
// deterministic for a given board — important for reproducible tests.
export function legalMoveMap(board, player, size) {
  const moves = new Map();
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell] !== EMPTY) continue;
    const flips = flipsFor(board, cell, player, size);
    if (flips.length) moves.set(cell, flips);
  }
  return moves;
}

export function legalMoves(board, player, size) {
  return [...legalMoveMap(board, player, size).keys()];
}

// Cheaper than legalMoveMap when all you need is "can they move at all",
// because it stops at the first hit. Called on every turn change to decide
// whether to auto-pass, and twice more to decide whether the game is over.
export function hasLegalMove(board, player, size) {
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell] !== EMPTY) continue;
    if (flipsFor(board, cell, player, size).length) return true;
  }
  return false;
}

// Applies a move to a COPY and hands back both the new board and what changed.
// Nothing mutates the board it was given: the engine keeps its board in state
// that gets serialized, and the bot searches by cloning down the tree.
//
// Returns null for an illegal move rather than throwing, so the caller decides
// whether that is a bug (engine) or a hostile peer (net).
export function applyMove(board, cell, player, size) {
  const flips = flipsFor(board, cell, player, size);
  if (!flips.length) return null;
  const next = cloneBoard(board);
  next[cell] = player;
  for (const f of flips) next[f] = player;
  return { board: next, flips };
}

export function countDiscs(board) {
  let black = 0;
  let white = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === BLACK) black++;
    else if (board[i] === WHITE) white++;
  }
  return { black, white, empty: board.length - black - white };
}

// The four corners of whatever size board this is. The bot weights them
// heavily and the UI marks them, so both read the same source.
export function cornersFor(size) {
  const last = size - 1;
  return Object.freeze([
    cellAt(0, 0, size),
    cellAt(0, last, size),
    cellAt(last, 0, size),
    cellAt(last, last, size),
  ]);
}
