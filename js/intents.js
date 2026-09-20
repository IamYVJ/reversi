// ============================================================================
// intents.js — The single dispatcher. THE ONLY PLACE A MOVE IS APPLIED.
//
// Three play modes drive this game: hotseat, peer-to-peer, and against the
// bot. All three go through applyGameIntent(). If mode-specific game logic
// ever starts appearing anywhere, this seam is in the wrong place.
//
// TRANSPORT-NEUTRAL ON PURPOSE. No sockets, no peer ids, no broadcasting, no
// awareness of whether the actor is sitting at this keyboard or on the other
// side of a WebRTC channel. Connection lifecycle — join, leave, reconnect —
// belongs to the transports, not here.
//
// Two ideas that must never be conflated, and are separate from day one:
//
//   isHost   this tab runs the engine. Decides whether an intent is applied
//            locally or sent over the wire. ONLY the transport looks at it.
//   isOwner  this player holds the room's controls. Gates the setup intents
//            below. EVERY control in the UI is gated on this.
//
// In P2P they happen to be the same person. Under a server they are not: the
// server runs the engine and the owner is a client like anyone else. Merging
// them is the mistake that forced real rework in the sibling projects.
// ============================================================================

import { validConfigPatch, validCell, validNameField } from './guards.js';

export const PLAYER_INTENTS = Object.freeze(['playMove', 'setName']);

export const OWNER_INTENTS = Object.freeze([
  'setConfig', 'swapSeats', 'setBotLevel',
  'startGame', 'endGame', 'playAgain', 'backToLobby',
]);

export const GAME_INTENTS = Object.freeze([...PLAYER_INTENTS, ...OWNER_INTENTS]);

// Owner-gated here rather than in state.js, because the engine's job is the
// rules of Reversi and "who is allowed to press the button" is a room policy.
const NEEDS_OWNER = new Set(OWNER_INTENTS);

function done(result) {
  return { handled: true, result: result || { ok: true } };
}

const UNHANDLED = Object.freeze({ handled: false, result: null });

/**
 * Applies one intent from one actor.
 *
 * Returns { handled, result }. `handled: false` means this dispatcher does not
 * own the message type at all — the caller should treat it as transport
 * business or drop it. `handled: true` with `result.ok === false` means the
 * intent was understood and refused, and `result.error` is shown to the actor.
 *
 * The engine mutates nothing on a refusal, so a rejected intent never needs
 * unwinding.
 */
export function applyGameIntent(engine, actorId, msg) {
  const type = msg && msg.type;
  if (typeof type !== 'string') return UNHANDLED;

  if (NEEDS_OWNER.has(type) && !engine.isOwner(actorId)) {
    return done({ ok: false, error: 'Only the host can change the game.' });
  }

  switch (type) {
    case 'playMove': {
      // Bounds-checked against THIS board's size, then handed to the engine,
      // which is the only thing that decides whether it is legal.
      const cell = validCell(msg.cell, engine.size * engine.size);
      if (cell === null) return done({ ok: false, error: 'That is not a square.' });
      return done(engine.playMove(actorId, cell));
    }

    case 'setName': {
      // Length-capped here, character-cleaned in the engine. Rejected rather
      // than truncated, because a megabyte of text is not a typo.
      const name = validNameField(msg.name);
      if (name === null) return done({ ok: false, error: 'That name is too long.' });
      return done(engine.setName(actorId, name));
    }

    case 'setConfig': {
      const patch = validConfigPatch(msg.config);
      if (!patch) return done({ ok: false, error: 'Those settings make no sense.' });
      return done(engine.setConfig(patch));
    }

    case 'swapSeats':
      return done(engine.swapSeats());

    case 'setBotLevel':
      return done(engine.setBotLevel(msg.playerId, msg.level));

    case 'startGame':
      return done(engine.startGame());

    case 'endGame':
      return done(engine.endGame());

    case 'playAgain':
      return done(engine.playAgain());

    case 'backToLobby':
      return done(engine.backToLobby());

    default:
      return UNHANDLED;
  }
}
