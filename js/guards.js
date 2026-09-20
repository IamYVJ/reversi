// ============================================================================
// guards.js — Validation for anything that arrives from another device.
//
// IMPORTS NOTHING. Every other module can depend on this one without creating
// a cycle, and it drops straight into Node for the test suite.
//
// The threat model is worth being precise about. Reversi is a perfect-
// information game, so there is nothing here to STEAL: a peer already knows
// the whole board. What a hostile peer can still do is corrupt state or crash
// the tab — a cell index of 1e9, a config patch with ten thousand keys, a
// 40MB frame, or a flood of messages that pins the main thread. That is what
// these functions bound.
//
// These are NOT authentication and NOT rule enforcement. The rules live in
// state.js, and they run on every message regardless of what passes here.
// ============================================================================

export const MAX_TYPE_LEN = 40;

// The minimum shape every message must have before anything looks at it.
// Arrays are rejected explicitly: `typeof [] === 'object'` and an array with a
// `type` property would otherwise sail through.
export function validEnvelope(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  if (typeof msg.type !== 'string' || !msg.type || msg.type.length > MAX_TYPE_LEN) return null;
  return msg;
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function validClientId(raw) {
  return typeof raw === 'string' && CLIENT_ID_RE.test(raw) ? raw : null;
}

// A board cell. The upper bound is the caller's cell count, because the board
// can be 6x6, 8x8 or 10x10 — a fixed 64 would silently reject half of a 10x10
// board and accept off-board indices on a 6x6.
export function validCell(raw, cellCount) {
  if (!Number.isInteger(raw) || raw < 0 || raw >= cellCount) return null;
  return raw;
}

// Bounded so one peer cannot hand the host a million-key object to iterate.
// The contents are re-derived key by key in rules.js; this only caps the work.
const MAX_PATCH_KEYS = 16;

export function validConfigPatch(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (!keys.length || keys.length > MAX_PATCH_KEYS) return null;
  return raw;
}

const MAX_NAME_LEN = 64;

// Length only. The real cleaning (control characters, whitespace, the 20-char
// display cap) is cleanName in rules.js; this just stops a megabyte of text
// reaching it.
export function validNameField(raw) {
  return typeof raw === 'string' && raw.length <= MAX_NAME_LEN ? raw : null;
}

// A leaky-bucket rate limiter. Deliberately generous: a human clicks a few
// times a second, so this only bites on a flood.
//
// `now` is a parameter rather than a Date.now() call inside, for the same
// reason the engine has no timers — the test suite drives it by hand.
export class TokenBucket {
  constructor({ capacity = 40, refillPerSec = 15, now = Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.tokens = capacity;
    this.last = now;
  }

  take(now = Date.now()) {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

// 64KB. A legitimate message in this game is a few hundred bytes — the largest
// is a full state broadcast, which is a 100-cell board plus two player records.
export const MAX_FRAME_BYTES = 65536;

// The only place a raw PeerJS payload becomes an object. Binary frames are
// rejected outright rather than decoded: this app never sends any, so one can
// only be an attempt to find a parser bug.
export function decodePeerFrame(raw, { maxBytes = MAX_FRAME_BYTES } = {}) {
  if (typeof raw === 'string') {
    if (raw.length > maxBytes) return null;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return null; }
    return validEnvelope(msg);
  }
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) return null;
  return validEnvelope(raw);
}

// How many simultaneous peer connections the host will hold open. Reversi
// seats exactly two, so anything past a small allowance for a reconnecting
// player mid-handshake is either a bug or an attempt to exhaust the tab.
export const MAX_CONNECTIONS = 4;

// The widest board this app offers is 10x10. The bounds here are looser than
// rules.js allows on purpose: this is a crash guard, not a rules check, and
// duplicating the exact size list would mean two places to update.
const MIN_SIZE = 4;
const MAX_SIZE = 12;
const MAX_LOG = 64;

function isPlainObject(raw) {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

/**
 * The host's whole-game broadcast, as received by a guest.
 *
 * This is the most trusted message in the protocol and deserves the most
 * scrutiny: the guest renders it directly, so a board array of the wrong
 * length or a `flips` that is a string rather than an array is a crashed tab
 * mid-game. A guest cannot verify the game was played LEGALLY — it has no
 * engine of its own and host-authoritative is the whole design — so this
 * deliberately checks shape and bounds only.
 *
 * Returns the object unchanged, or null. Values inside the board are coerced
 * downstream by boardFrom() in state.js, so only the length matters here.
 */
export function validPublicState(raw) {
  if (!isPlainObject(raw)) return null;

  const size = raw.size;
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) return null;
  if (!Array.isArray(raw.board) || raw.board.length !== size * size) return null;

  if (!isPlainObject(raw.config)) return null;
  if (!isPlainObject(raw.score)) return null;
  if (typeof raw.phase !== 'string') return null;
  if (!Number.isInteger(raw.plies) || raw.plies < 0) return null;

  // Two seats, never more. A third would be rendered by the lobby and would
  // never be reachable by the engine.
  if (!Array.isArray(raw.players) || raw.players.length > 2) return null;
  for (const p of raw.players) {
    if (!isPlainObject(p)) return null;
    if (typeof p.id !== 'string' || !p.id) return null;
    if (typeof p.name !== 'string') return null;
  }

  if (!Array.isArray(raw.log) || raw.log.length > MAX_LOG) return null;
  for (const entry of raw.log) {
    if (!isPlainObject(entry) || typeof entry.text !== 'string') return null;
  }

  // lastMove.flips is spread into a Set and iterated by the renderer, so a
  // non-array here is a TypeError rather than a wrong-looking board.
  if (raw.lastMove !== null && raw.lastMove !== undefined) {
    if (!isPlainObject(raw.lastMove)) return null;
    if (!Array.isArray(raw.lastMove.flips)) return null;
    if (raw.lastMove.flips.length > size * size) return null;
  }
  if (raw.lastPass !== null && raw.lastPass !== undefined && !isPlainObject(raw.lastPass)) {
    return null;
  }
  if (raw.finalScore !== null && raw.finalScore !== undefined && !isPlainObject(raw.finalScore)) {
    return null;
  }

  return raw;
}
