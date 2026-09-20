// ============================================================================
// bot.js — A computer opponent, and the paced driver that lets it take a turn.
//
// ONE ENGINE, THREE DEPTHS
//   There is a single search here, not three bots. Easy, Medium and Hard differ
//   in how far they look and — for Easy only — what they value. Everything runs
//   over board.js's move generator, so no level can invent an illegal move:
//   candidates only ever come out of legalMoveMap().
//
// WHY EASY IS GREEDY ON PURPOSE
//   Taking the most discs available this turn is the classic beginner trap in
//   Reversi. Discs flip back constantly, so early greed hands over mobility and
//   the corners that decide the endgame. Easy is built to fall into it: it is
//   not a crippled search, it is a plausible bad idea played consistently.
//
// NO CLOCK OF ITS OWN
//   Same rule state.js follows. chooseMove() takes a `deadline` and a `clock`
//   as parameters, so the test suite runs it with deadline:Infinity and gets
//   byte-identical results every time. The driver at the bottom is ticked by
//   whoever owns the engine; it never starts a timer.
//
// PURITY
//   chooseMove(board, player, config) reads nothing but its arguments and
//   mutates nothing it was given. It clones before it searches. That is what
//   lets the harness play hundreds of full games with no DOM and no engine.
// ============================================================================

import {
  EMPTY, BLACK, opponent, cloneBoard, flipsFor, legalMoveMap, hasLegalMove, countDiscs,
} from './board.js';
import { weightsFor, boardSizeFor, antiOthelloOn, botLevelFor, shuffle } from './rules.js';
import { applyGameIntent } from './intents.js';
// Only for the phase name. state.js does not import this module, so there is
// no cycle — and taking the constant rather than writing 'play' here is what
// stops a renamed phase leaving the bot quietly asleep instead of failing.
import { PHASES } from './state.js';

// How deep each level looks. Easy never reaches the search at all; its entry
// is here so the table is the single place the levels are described.
const DEPTHS = Object.freeze({ easy: 0, medium: 3, hard: 6 });

// Hard cap on a single think, in milliseconds. The search is synchronous and
// blocks the tab, so this is a UI budget rather than a strength setting:
// iterative deepening means whatever depth completed inside it is what gets
// played, and a 10x10 midgame simply lands on a shallower answer than a 6x6.
export const SEARCH_BUDGET_MS = 600;

// A terminal position is worth more than any arrangement of discs can be.
// Finite, not Infinity, so that "win in two" still outranks "win in five"
// once the depth bonus below is applied.
const WIN_SCORE = 1e6;

// Shaves the win score by how deep it was found, so a forced win is taken by
// the shortest line available rather than dawdling. Small enough that it can
// never promote a loss above a win.
const DEPTH_BONUS = 1000;

// What one point of mobility advantage is worth against one point of
// positional value. Mobility dominates for most of the game — a player with no
// good moves is forced to wreck their own position — so this is deliberately
// large. It stops the bot trading its whole structure for a few extra discs.
const MOBILITY_WEIGHT = 12;

// Disc count barely matters until the board is nearly full, because anything
// can flip back. Weighted near zero and left in only so that two otherwise
// identical positions are separated by something.
const DISC_WEIGHT = 1;

// Easy treats any move within this many discs of the greedy best as equally
// good and picks among them at random. Without it a greedy bot is perfectly
// deterministic and replays the same game every time, which reads as a puzzle
// rather than an opponent.
const EASY_SLACK = 1;

/**
 * Pick a move. Pure: same arguments in, same move out.
 *
 * @param board    Uint8Array, as held by the engine. Never mutated.
 * @param player   BLACK or WHITE — whose turn it is.
 * @param config   { ...houseConfig, level, deadline, clock }
 *                 houseConfig supplies boardSize and antiOthello; `level` is
 *                 the bot strength; `deadline` is an absolute timestamp the
 *                 search must not run past; `clock` reads the current time.
 * @returns the chosen cell index, or null when there is nothing legal.
 */
export function chooseMove(board, player, config = {}) {
  const size = boardSizeFor(config);
  if (!board || board.length !== size * size) return null;

  const anti = antiOthelloOn(config);
  const level = botLevelFor(config.level);
  const moves = legalMoveMap(board, player, size);
  if (!moves.size) return null;
  // One legal move is not a decision. Skipping the search here is what keeps
  // the endgame — where this is common — from spending its whole budget
  // confirming the inevitable.
  if (moves.size === 1) return [...moves.keys()][0];

  if (level === 'easy') return greedyPick(moves, anti);

  const clock = typeof config.clock === 'function' ? config.clock : Date.now;
  const deadline = config.deadline == null
    ? clock() + SEARCH_BUDGET_MS
    : config.deadline;

  return searchBest(board, player, size, {
    anti,
    maxDepth: DEPTHS[level],
    deadline,
    clock,
    moves,
  });
}

/**
 * Easy: the most discs available right now.
 *
 * Under Anti-Othello the naive instinct inverts with the win condition — a
 * beginner told "fewest discs wins" grabs the fewest — so the comparison flips
 * too. The point is a consistent bad idea, not a bot that is accidentally
 * strong because the rules changed underneath it.
 */
function greedyPick(moves, anti) {
  const scored = [...moves.entries()].map(([cell, flips]) => ({
    cell,
    n: anti ? -flips.length : flips.length,
  }));
  const best = scored.reduce((m, s) => (s.n > m ? s.n : m), -Infinity);
  const tied = scored.filter((s) => s.n >= best - EASY_SLACK);
  // shuffle() rather than Math.random() so the bot draws on the same
  // crypto-seeded source as everything else, and the harness can pin it.
  return shuffle(tied)[0].cell;
}

/**
 * Medium and Hard: alpha-beta, widened one ply at a time.
 *
 * Iterative deepening rather than one deep call, for two reasons. It is what
 * makes the time box safe — a depth that does not finish is simply discarded
 * and the previous depth's answer stands, so the bot always has a move to
 * play. And the shallow pass gives a move ordering for the next one, which on
 * a branchy midgame board buys back much more time than the repeat costs.
 */
function searchBest(board, player, size, ctx) {
  const { maxDepth, deadline, clock, moves } = ctx;
  const weights = weightsFor(size);
  const state = { weights, size, anti: ctx.anti, deadline, clock, nodes: 0, out: false };

  let order = [...moves.keys()];
  let chosen = order[0];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const ranked = [];
    let alpha = -Infinity;

    for (const cell of order) {
      const next = applyTo(board, cell, player, size, moves.get(cell));
      const score = -negamax(next, opponent(player), size, depth - 1, -Infinity, -alpha, state);
      if (state.out) break;
      ranked.push({ cell, score });
      if (score > alpha) alpha = score;
    }

    // Partial depth tells us nothing trustworthy: the moves that were searched
    // were compared against each other, but the ones that were not could all
    // be better. Throw it away and keep the last complete answer.
    if (state.out) break;

    ranked.sort((a, b) => b.score - a.score);
    order = ranked.map((r) => r.cell);
    const top = ranked[0].score;
    const tied = ranked.filter((r) => r.score === top);
    chosen = tied.length > 1 ? shuffle(tied)[0].cell : tied[0].cell;
  }

  return chosen;
}

/**
 * Negamax with alpha-beta. Scores are always from the side-to-move's point of
 * view, which is why the caller negates: it halves the code against a minimax
 * that has to carry a maximising flag down every branch.
 *
 * Handles Reversi's two structural oddities directly:
 *   - a player with no move PASSES rather than losing their turn, so the
 *     recursion hands the same board back to the opponent at the same depth;
 *   - if neither side can move the game is OVER, whatever the board looks
 *     like. That is the non-fullness end condition, and getting it wrong here
 *     would have the search evaluating dead positions as live ones.
 */
function negamax(board, player, size, depth, alpha, beta, state) {
  // Checked on a node count rather than every node: Date.now() is not free,
  // and at these depths the search visits tens of thousands of positions.
  // 255 rather than something larger because a 10x10 node costs enough that
  // a coarser interval overshoots the budget by a visible fraction of it.
  if ((++state.nodes & 255) === 0 && state.clock() >= state.deadline) {
    state.out = true;
    return 0;
  }

  const moves = legalMoveMap(board, player, size);

  if (!moves.size) {
    // No move for us. If the opponent has one, we pass; depth is NOT spent,
    // because a pass is not a ply of anybody's plan.
    if (hasLegalMove(board, opponent(player), size)) {
      return -negamax(board, opponent(player), size, depth, -beta, -alpha, state);
    }
    return terminalScore(board, player, state.anti, depth);
  }

  if (depth <= 0) return evaluate(board, player, size, state, moves.size);

  let best = -Infinity;
  for (const [cell, flips] of moves) {
    const next = applyTo(board, cell, player, size, flips);
    const score = -negamax(next, opponent(player), size, depth - 1, -beta, -alpha, state);
    if (state.out) return 0;
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;   // this line is already refuted
  }
  return best;
}

/** Apply a move whose flip list has already been computed. */
function applyTo(board, cell, player, size, flips) {
  const next = cloneBoard(board);
  next[cell] = player;
  const list = flips || flipsFor(board, cell, player, size);
  for (const f of list) next[f] = player;
  return next;
}

/**
 * The game is over on this node. Scored by the REAL win condition, including
 * Anti-Othello, because at a terminal node nothing is heuristic any more.
 */
function terminalScore(board, player, anti, depth) {
  const { black, white } = countDiscs(board);
  const mine = player === BLACK ? black : white;
  const theirs = player === BLACK ? white : black;
  const margin = anti ? theirs - mine : mine - theirs;
  if (margin === 0) return 0;
  // depth is how much search was left when the game ended: larger means it
  // ended sooner, so a faster win scores higher and a slower loss scores less
  // badly. Nudged by the margin so a bigger win is preferred among equals.
  const bonus = depth * DEPTH_BONUS + Math.abs(margin);
  return margin > 0 ? WIN_SCORE + bonus : -(WIN_SCORE + bonus);
}

/**
 * Heuristic value of a non-terminal position, from `player`'s side.
 *
 * Positional weights come from rules.js, which GENERATES them for whatever
 * size the host chose — corners high, the X and C squares beside them
 * negative. That is what makes 6x6 and 10x10 safe: there is no 8x8 matrix to
 * index off the end of, and no mobility-only fallback to maintain.
 *
 * Under Anti-Othello the positional term is negated: if fewest discs wins,
 * owning a corner you can never be flipped out of is a liability, not an
 * asset. Mobility keeps its sign — being able to choose is good under either
 * win condition, and having no move at all is what forces you to take discs
 * you did not want.
 */
function evaluate(board, player, size, state, myMoves) {
  const { weights, anti } = state;
  const foe = opponent(player);

  let positional = 0;
  let mine = 0;
  let theirs = 0;
  for (let i = 0; i < board.length; i++) {
    const v = board[i];
    if (v === EMPTY) continue;
    if (v === player) { positional += weights[i]; mine++; }
    else { positional -= weights[i]; theirs++; }
  }
  if (anti) positional = -positional;

  // myMoves is handed in by the caller, which has already generated it to
  // decide this node was not terminal. Re-running the scan here would double
  // the cost of the single hottest function in the search.
  const foeMoves = legalMoveMap(board, foe, size).size;
  // Normalised rather than a raw difference so that "4 moves to 2" reads as
  // the same dominance late on as "40 to 20" would early, and the +1 keeps a
  // zero-mobility position from dividing by zero.
  const mobility = 100 * (myMoves - foeMoves) / (myMoves + foeMoves + 1);

  const discs = anti ? theirs - mine : mine - theirs;

  return positional + MOBILITY_WEIGHT * mobility + DISC_WEIGHT * discs;
}

// ===========================================================================
// The driver — turning "it is the bot's turn" into a move, at a human pace.
// ===========================================================================

/** How long the bot waits before it starts thinking. Long enough to watch the
 *  discs you just turned finish flipping, short enough that a sixty-move game
 *  does not drag.
 *
 *  The search runs AFTER this window, not inside it, so a hard bot on a big
 *  board can take the pause plus most of SEARCH_BUDGET_MS. That ordering is
 *  deliberate: the search blocks the main thread, and the one moment it must
 *  not block is while the player's own move is still animating. Searching
 *  first would move the freeze onto that animation. */
export const BOT_THINK_MS = 600;

/**
 * A stateful ticker, one per game. Ticked by whoever owns the engine; it holds
 * no timer of its own and time arrives as a parameter.
 *
 * The state is only "which turn am I waiting on, and until when". It is never
 * serialized: a reload rebuilds it from the engine's own turn, so the worst a
 * refresh mid-pause costs is that the bot thinks again.
 */
export function createBotDriver({ thinkMs = BOT_THINK_MS, budgetMs = SEARCH_BUDGET_MS } = {}) {
  let pending = null;

  // Identifies one bot turn. Keyed on plies, which only ever increases. A pass
  // does not advance it, but a pass also cannot leave the same bot to move
  // twice in a row — the engine only passes when the OTHER side has a move —
  // so the key cannot go stale mid-turn.
  function turnKey(engine) {
    const player = engine.currentPlayer;
    if (!player || !player.isBot) return null;
    return { player, key: `${engine.plies}:${player.id}` };
  }

  return {
    /** @returns true if the engine changed and the caller should re-render. */
    tick(engine, now = Date.now()) {
      if (!engine || engine.phase !== PHASES.PLAY) { pending = null; return false; }

      const turn = turnKey(engine);
      if (!turn) { pending = null; return false; }

      if (!pending || pending.key !== turn.key) {
        pending = { key: turn.key, dueAt: now + thinkMs, acted: false };
      }
      if (pending.acted || now < pending.dueAt) return false;

      // Set before acting, not after. Whatever happens below — a refusal, a
      // throw — this turn gets exactly one attempt, so a bot that cannot be
      // satisfied costs one tick rather than spinning forever.
      pending.acted = true;
      return act(engine, turn.player, now + budgetMs);
    },

    /** True while a bot is waiting out its pause — the UI's "thinking" cue. */
    isThinking(engine, now = Date.now()) {
      if (!engine || engine.phase !== PHASES.PLAY) return false;
      const turn = turnKey(engine);
      if (!turn) return false;
      // The key has to be checked, not just the deadline: a pending left over
      // from the PREVIOUS bot turn is already past its due time, and without
      // this the cue would blink off between the move that hands the bot the
      // turn and the first tick that notices.
      return !pending || pending.key !== turn.key || now < pending.dueAt;
    },

    /** Forget the pause in progress. For a host that has just taken over. */
    reset() { pending = null; },
  };
}

function act(engine, player, deadline) {
  let cell = null;
  try {
    cell = chooseMove(engine.board, player.seat, {
      ...engine.config,
      level: player.botLevel,
      deadline,
    });
  } catch (err) {
    // A throw in here is a bug in the scoring. The right response is still to
    // get the game moving: a board stuck behind a bot is a dead game, and the
    // fallback below plays something legal rather than nothing at all.
    console.warn('[bot] chooseMove threw', err);
  }

  if (cell == null) {
    // Unreachable in theory: the engine auto-passes, so a bot that is to move
    // has a legal move by construction. Kept because the alternative to a
    // wrong move is no move, and no move stops the game permanently.
    const fallback = legalMoveMap(engine.board, player.seat, engine.size);
    if (!fallback.size) return false;
    cell = [...fallback.keys()][0];
  }

  const { result } = applyGameIntent(engine, player.id, { type: 'playMove', cell });
  if (result && result.ok) return true;
  console.warn('[bot] move refused:', result && result.error, cell);
  return false;
}
