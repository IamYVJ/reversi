// ============================================================================
// rules.js — House toggles, presets, and the positional weight tables.
//
// Every default here is OFFICIAL Othello, so a host who touches nothing plays
// the real game. The toggles are deliberately cheap: three of them only change
// what is drawn, and the two that change play (board size, Anti-Othello) are a
// single parameter each.
//
// Also the home of the shared randomness helpers, for the same reason as the
// other games in this family: the test harness swaps `globalThis.crypto` for a
// seeded PRNG, and that only works if there is exactly one place that reads it.
// ============================================================================

// Always EVEN. The four-disc centre opening in board.js is defined as
// `size / 2`, which has no meaning on an odd board — there is no centre 2x2.
export const BOARD_SIZES = Object.freeze([6, 8, 10]);

export const DEFAULTS = Object.freeze({
  boardSize: 8,        // official
  antiOthello: false,  // official: MOST discs wins
  legalDots: true,     // assist: mark playable squares
  flipPreview: false,  // assist: highlight what a hovered move would turn
  discCounter: true,   // assist: live score
});

// Numeric bounds, checked on every inbound config patch. boardSize is also
// membership-checked against BOARD_SIZES below, because 7 is inside this range
// and would break the opening.
export const LIMITS = Object.freeze({
  boardSize: Object.freeze({ min: 6, max: 10 }),
});

// The keys that define a ruleset. normalizeConfig rebuilds from THIS LIST
// rather than copying the object it was handed, so a hostile or stale peer
// cannot smuggle extra keys into engine state.
export const RULE_KEYS = Object.freeze(Object.keys(DEFAULTS));

export function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

// Rebuilds a config from scratch, key by key. Unknown keys vanish, wrong types
// fall back to the official value, and boardSize must be one we can actually
// deal an opening on.
export function normalizeConfig(cfg) {
  const src = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const out = {};
  for (const key of RULE_KEYS) {
    if (key === 'boardSize') {
      const n = clampInt(src.boardSize, LIMITS.boardSize.min, LIMITS.boardSize.max, DEFAULTS.boardSize);
      out.boardSize = BOARD_SIZES.includes(n) ? n : DEFAULTS.boardSize;
    } else {
      out[key] = asBool(src[key], DEFAULTS[key]);
    }
  }
  return out;
}

// Readers, not property access. `restore()` rehydrates a serialized engine with
// a plain Object.assign, so a snapshot saved before a key existed will be
// missing it — these tolerate that instead of yielding undefined deep inside
// the flip scan.
export function boardSizeFor(config) {
  const n = config && config.boardSize;
  return BOARD_SIZES.includes(n) ? n : DEFAULTS.boardSize;
}

export function antiOthelloOn(config) {
  return asBool(config && config.antiOthello, DEFAULTS.antiOthello);
}

export function legalDotsOn(config) {
  return asBool(config && config.legalDots, DEFAULTS.legalDots);
}

export function flipPreviewOn(config) {
  return asBool(config && config.flipPreview, DEFAULTS.flipPreview);
}

export function discCounterOn(config) {
  return asBool(config && config.discCounter, DEFAULTS.discCounter);
}

// Bot strengths. Lives here rather than in bot.js because state.js has to
// validate a level coming off the wire, and state.js importing bot.js would
// close a cycle — bot.js needs PHASES from state.js.
export const BOT_LEVELS = Object.freeze([
  Object.freeze({ id: 'easy', name: 'Easy', blurb: 'Grabs the most discs it can see.' }),
  Object.freeze({ id: 'medium', name: 'Medium', blurb: 'Looks a few moves ahead.' }),
  Object.freeze({ id: 'hard', name: 'Hard', blurb: 'Plays corners and squeezes your options.' }),
]);

export const DEFAULT_BOT_LEVEL = 'medium';

export function botLevelFor(level) {
  return BOT_LEVELS.some((l) => l.id === level) ? level : DEFAULT_BOT_LEVEL;
}

// Presets list only what they CHANGE; presetConfig fills the rest from
// DEFAULTS, so adding a new toggle later does not silently alter any preset.
export const PRESETS = Object.freeze([
  Object.freeze({
    id: 'classic',
    name: 'Classic',
    blurb: 'Official Othello. 8x8, most discs wins.',
    config: Object.freeze({}),
  }),
  Object.freeze({
    id: 'quick',
    name: 'Quick',
    blurb: '6x6. Same rules, about half the moves.',
    config: Object.freeze({ boardSize: 6 }),
  }),
  Object.freeze({
    id: 'grand',
    name: 'Grand',
    blurb: '10x10. Longer game, more room to manoeuvre.',
    config: Object.freeze({ boardSize: 10 }),
  }),
  Object.freeze({
    id: 'reversed',
    name: 'Anti-Othello',
    blurb: 'Fewest discs wins. Everything else is unchanged.',
    config: Object.freeze({ antiOthello: true }),
  }),
]);

export function presetConfig(id) {
  const preset = PRESETS.find((p) => p.id === id);
  return normalizeConfig(preset ? preset.config : {});
}

// The inverse: which preset, if any, this exact config matches. Only the keys
// that affect PLAY are compared — flipping an assist on should not knock the
// lobby out of "Classic", because it has not changed the rules.
const PLAY_KEYS = Object.freeze(['boardSize', 'antiOthello']);

export function presetOf(config) {
  const cfg = normalizeConfig(config);
  for (const preset of PRESETS) {
    const candidate = presetConfig(preset.id);
    if (PLAY_KEYS.every((k) => candidate[k] === cfg[k])) return preset.id;
  }
  return null;
}

// Short phrases for the lobby summary. Returns [] for official play, so the
// caller can render "Official rules" rather than an empty list.
export function describeHouseRules(config) {
  const cfg = normalizeConfig(config);
  const out = [];
  if (cfg.boardSize !== DEFAULTS.boardSize) out.push(`${cfg.boardSize}x${cfg.boardSize} board`);
  if (cfg.antiOthello) out.push('Anti-Othello: fewest discs wins');
  return out;
}

export function describeAssists(config) {
  const cfg = normalizeConfig(config);
  const out = [];
  if (cfg.legalDots) out.push('Legal-move dots');
  if (cfg.flipPreview) out.push('Flip preview');
  if (cfg.discCounter) out.push('Live disc count');
  return out;
}

// --- Positional weights ----------------------------------------------------
//
// The classic Othello weight table is written for 8x8, and a 6x6 or 10x10 board
// would index straight off the end of it. So it is GENERATED from a square's
// distance to the nearest edge instead of being a literal table — which
// reproduces the canonical 8x8 numbers exactly (verified in the test suite) and
// gives the same shape at any even size.
//
// The shape, and why:
//   corner   +100  can never be flipped, and anchors whole edges
//   X-square  -50  the diagonal neighbour of a corner; occupying it is what
//                  usually hands the corner over
//   C-square  -20  the edge neighbour of a corner; same trap, milder
//   A-square  +10  edge, two from the corner — genuinely good
//   edge       +5  everything else on the rim
//   near-edge  -2  the ring just inside the rim, which feeds the rim
//   interior   -1  slightly bad: early discs in the middle cost mobility
function weightAt(row, col, size) {
  const last = size - 1;
  const dr = Math.min(row, last - row);
  const dc = Math.min(col, last - col);

  if (dr === 0 && dc === 0) return 100;
  if (dr <= 1 && dc <= 1) return dr === 1 && dc === 1 ? -50 : -20;
  if (dr === 0 || dc === 0) return (dr === 0 ? dc : dr) === 2 ? 10 : 5;
  return dr === 1 || dc === 1 ? -2 : -1;
}

// Built once per size and cached. The bot calls this inside its search loop, so
// it must not rebuild a 100-element array per node.
//
// Not frozen: Object.freeze throws on a typed array that has elements. The
// contract is "treat as read-only", enforced by nobody writing to it.
const WEIGHT_CACHE = new Map();

export function weightsFor(size) {
  const cached = WEIGHT_CACHE.get(size);
  if (cached) return cached;
  const table = new Int16Array(size * size);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) table[row * size + col] = weightAt(row, col, size);
  }
  WEIGHT_CACHE.set(size, table);
  return table;
}

// --- Randomness ------------------------------------------------------------
//
// One reader of `crypto`, called lazily. The test harness replaces the global
// before constructing anything; capturing it at module load would pin the real
// one and make every seeded test non-deterministic.
export function randomBelow(n) {
  if (!Number.isInteger(n) || n <= 0) return 0;
  const source = globalThis.crypto || (typeof window !== 'undefined' ? window.crypto : null);
  if (!source || !source.getRandomValues) return Math.floor(Math.random() * n);
  // Rejection sampling: taking a plain modulo of a uint32 skews towards the
  // low values whenever n does not divide 2^32.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  let value;
  do {
    source.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % n;
}

export function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Display names. Strips control characters (which can wreck a line of layout),
// collapses runs of whitespace, and caps the length so one player cannot push
// the scoreboard off a phone screen.
export function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 20);
}
