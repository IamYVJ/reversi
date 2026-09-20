// ============================================================================
// net.js — The peer-to-peer transport. PeerJS/WebRTC, star topology.
//
// The host's tab is the hub: it runs the engine and holds one DataConnection
// per guest. Guests talk only to the host, never to each other. Reversi seats
// exactly two people, so "the star" is in practice one spoke — but the shape
// is the same one the sibling projects use, and it is what makes the
// connection cap and the per-connection rate limit below meaningful.
//
// THERE IS NO DISCOVERY SERVICE. The host's peer id is DERIVED from the room
// code (PEER_PREFIX + code), so a guest who is told four letters can
// reconstruct the id and dial it directly. That is the entire reason room
// codes exist here. The prefix namespaces them: the PeerJS cloud broker is
// shared with every other app using it, and a bare "QK4T" would collide.
//
// TRANSPORT ONLY. This file knows nothing about Reversi. It does not know what
// a move is, who the owner is, or what the board looks like; it moves opaque
// JSON and reports lifecycle events. The protocol lives in main.js and the
// rules live in state.js. Keeping that line sharp is what lets the same engine
// serve hotseat, bot and P2P without a mode-specific branch.
//
// SECURITY POSTURE: assume the peer is hostile. Perfect information means
// there is nothing to steal — a peer can already see the whole board — but a
// malformed frame, an illegal move or a flood can still corrupt state or pin
// the main thread. So every inbound frame is size-capped, JSON-parsed inside a
// try, envelope-checked and rate-limited BEFORE it reaches a handler, and the
// number of open connections is capped. Junk is dropped silently rather than
// answered: a reply would tell a prober that someone is listening.
// ============================================================================

import { decodePeerFrame, TokenBucket, MAX_CONNECTIONS, MAX_FRAME_BYTES } from './guards.js';
import { normalizeCode } from './util.js';

// Bumping this retires every room code in flight, which is exactly what you
// want if the wire format ever changes incompatibly: an old tab dialling a new
// host simply fails to find it, rather than connecting and desynchronising.
export const PEER_PREFIX = 'reversi-v1-';

export function peerIdForCode(code) {
  return PEER_PREFIX + normalizeCode(code);
}

export function codeFromPeerId(id) {
  if (typeof id !== 'string' || !id.startsWith(PEER_PREFIX)) return '';
  return normalizeCode(id.slice(PEER_PREFIX.length));
}

// --- Timings ---------------------------------------------------------------
//
// NOTHING HERE IS TIGHT, on purpose. The lesson that produced these numbers:
// the first connection of a session pays a cold TLS handshake to the broker
// and measured ~4.6s against 0.8-1.2s once warm, so a 4-second budget failed
// the very first attempt every single time and reported a perfectly healthy
// broker as dead. Every budget below is at least ten seconds, and everything
// that can be retried is retried before anything is declared lost.

/** How long a guest waits for the host to answer before giving up. Covers the
 *  cold handshake, the broker lookup and ICE negotiation with room to spare. */
const JOIN_TIMEOUT = 12000;

/** Broker socket drops. The broker is only needed for introductions — an
 *  established DataConnection keeps working without it — so these retries are
 *  about being able to accept NEW guests, not about the game in progress. */
const BROKER_RETRIES = 5;

/** A guest whose data channel closed re-dials this many times. Same backoff,
 *  so roughly 31 seconds of trying before it reports the host gone. */
const RECONNECT_TRIES = 6;

// Exponential with a ceiling: fast enough that a blip recovers before anyone
// notices, slow enough that a genuinely dead broker is not hammered.
function backoffFor(tries) {
  return Math.min(1000 * 2 ** tries, 8000);
}

/** Frames refused by the rate limiter before the connection is closed. A human
 *  cannot produce this many; something that does is not playing Reversi. */
const MAX_REFUSED_FRAMES = 120;

// --- Error classification --------------------------------------------------

// Errors where retrying is pointless: the environment or the id is wrong, and
// it will still be wrong in eight seconds. Everything NOT in here is treated
// as transient and retried.
const UNRECOVERABLE = new Set([
  'browser-incompatible',
  'invalid-id',
  'invalid-key',
  'unavailable-id',
  'ssl-unavailable',
]);

export function isFatalPeerError(err) {
  return !!(err && UNRECOVERABLE.has(err.type));
}

// PeerJS error messages are written for developers. These are written for
// someone who just wanted to play a game with a friend.
export function describePeerError(err) {
  const type = err && err.type;
  switch (type) {
    case 'peer-unavailable':
      return 'No game found with that code. Check the letters, or ask for a fresh one.';
    case 'unavailable-id':
      return 'That code is already in use. Start a new game to get another.';
    case 'browser-incompatible':
      return 'This browser cannot do peer-to-peer. Try Chrome, Edge, Firefox or Safari.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Lost touch with the matchmaking server. Reconnecting…';
    case 'webrtc':
    case 'disconnected':
      return 'The connection dropped. Trying again…';
    case 'ssl-unavailable':
      return 'This page must be served over HTTPS for peer-to-peer to work.';
    default:
      return 'Something went wrong with the connection.';
  }
}

// --- Shared plumbing -------------------------------------------------------

function requirePeer() {
  // PeerJS arrives as a plain <script> tag in index.html, NOT as an npm
  // dependency and NOT as a module import — this project has a zero-dependency
  // package.json and no build step. If the CDN is blocked or the user is
  // offline on a cold load, window.Peer is simply absent, and that is a
  // perfectly ordinary thing that has to produce a readable message rather
  // than a ReferenceError halfway through a click handler.
  const Peer = globalThis.Peer;
  if (typeof Peer !== 'function') {
    throw new Error('Peer-to-peer support failed to load. Check your connection and reload.');
  }
  return Peer;
}

// Every outbound send is wrapped. A DataConnection can close between the check
// and the call, and `send` on a dead channel throws — which would otherwise
// take down the render loop that called it.
function trySend(conn, msg) {
  if (!conn || !conn.open) return false;
  try {
    conn.send(JSON.stringify(msg));
    return true;
  } catch (_) {
    return false;
  }
}

// The broker is the introduction service, not the game. Losing it does NOT
// interrupt a connection that is already established, so this recovers quietly
// in the background and only tells the caller when it has given up for good.
function attachBrokerRecovery(peer, handlers) {
  let tries = 0;
  let timer = null;

  peer.on('disconnected', () => {
    if (peer.destroyed) return;
    handlers.onBrokerDown && handlers.onBrokerDown();
    if (tries >= BROKER_RETRIES) {
      handlers.onBrokerLost && handlers.onBrokerLost();
      return;
    }
    const delay = backoffFor(tries);
    tries++;
    timer = setTimeout(() => {
      if (peer.destroyed || !peer.disconnected) return;
      try { peer.reconnect(); } catch (_) { /* the 'error' handler reports it */ }
    }, delay);
  });

  peer.on('open', () => {
    // Reaching 'open' again means the reconnect worked, so the budget resets —
    // otherwise a long session with five separate blips would exhaust it.
    if (tries > 0) handlers.onBrokerUp && handlers.onBrokerUp();
    tries = 0;
  });

  return () => { if (timer !== null) clearTimeout(timer); };
}

// --- Host ------------------------------------------------------------------

/**
 * Opens a room. The peer id is derived from `code`, so the caller must have
 * generated the code already — there is nothing to look up.
 *
 * handlers:
 *   onOpen(code)              the room is live and reachable
 *   onConnect(connId)         a guest's data channel opened
 *   onData(connId, msg)       a validated, rate-limited frame arrived
 *   onDisconnect(connId)      a guest's channel closed
 *   onFull(connId)            a guest was turned away at the connection cap
 *   onBrokerDown/Up/Lost()    matchmaking socket state
 *   onError(err)              a PeerJS error; check isFatalPeerError
 *
 * Returns { peer, connections, sendTo, broadcast, dropConnection, destroy }.
 */
export function createHost(code, handlers = {}) {
  const Peer = requirePeer();
  const peer = new Peer(peerIdForCode(code));
  const connections = new Map();   // connId -> { conn, bucket, refused }
  const stopRecovery = attachBrokerRecovery(peer, handlers);

  peer.on('open', () => { handlers.onOpen && handlers.onOpen(code); });

  peer.on('connection', (conn) => {
    // The cap is checked on ARRIVAL, before any listener is attached, so a
    // flood costs one close() each rather than a growing map of live channels.
    // It is deliberately larger than the two seats this game has: a player
    // reloading mid-game is briefly present twice, and refusing them their own
    // seat back would be a worse bug than holding a spare slot.
    if (connections.size >= MAX_CONNECTIONS) {
      handlers.onFull && handlers.onFull(conn.peer);
      // Tell them why before hanging up. This one IS answered, unlike a
      // malformed frame: a guest at the cap is almost certainly a real person
      // who deserves better than a silent failure.
      conn.on('open', () => {
        trySend(conn, { type: 'refused', reason: 'full' });
        setTimeout(() => { try { conn.close(); } catch (_) { /* already gone */ } }, 250);
      });
      return;
    }

    const connId = conn.peer;
    const entry = { conn, bucket: new TokenBucket(), refused: 0 };
    connections.set(connId, entry);

    conn.on('open', () => { handlers.onConnect && handlers.onConnect(connId); });

    conn.on('data', (raw) => {
      const msg = decodePeerFrame(raw, { maxBytes: MAX_FRAME_BYTES });
      // Silence is the right answer to junk. An error reply is a free oracle
      // for anyone probing what this endpoint accepts.
      if (!msg) return;

      if (!entry.bucket.take(Date.now())) {
        entry.refused++;
        if (entry.refused >= MAX_REFUSED_FRAMES) dropConnection(connId);
        return;
      }

      handlers.onData && handlers.onData(connId, msg);
    });

    const close = () => {
      if (!connections.has(connId)) return;
      connections.delete(connId);
      handlers.onDisconnect && handlers.onDisconnect(connId);
    };
    conn.on('close', close);
    // A channel that errors is finished even if 'close' never fires, which it
    // sometimes does not on an abrupt network drop.
    conn.on('error', close);
  });

  peer.on('error', (err) => { handlers.onError && handlers.onError(err); });

  function sendTo(connId, msg) {
    const entry = connections.get(connId);
    return entry ? trySend(entry.conn, msg) : false;
  }

  function broadcast(msg) {
    // One serialisation per connection rather than one shared string, because
    // trySend owns the stringify. With at most four peers that is not a cost
    // worth optimising, and it keeps the send path single.
    for (const entry of connections.values()) trySend(entry.conn, msg);
  }

  function dropConnection(connId) {
    const entry = connections.get(connId);
    if (!entry) return;
    connections.delete(connId);
    try { entry.conn.close(); } catch (_) { /* already gone */ }
    handlers.onDisconnect && handlers.onDisconnect(connId);
  }

  function destroy() {
    stopRecovery();
    connections.clear();
    try { peer.destroy(); } catch (_) { /* nothing to do */ }
  }

  return { peer, connections, sendTo, broadcast, dropConnection, destroy };
}

// --- Guest -----------------------------------------------------------------

/**
 * Dials the host for `code`. The guest's own peer id is left unset so the
 * broker assigns a random one — only the HOST's id has to be predictable.
 *
 * handlers:
 *   onOpen(conn)              the data channel is live
 *   onData(msg)               a validated, rate-limited frame arrived
 *   onClose()                 the channel closed for good, after retries
 *   onRetry(attempt)          a re-dial is under way
 *   onBrokerDown/Up/Lost()    matchmaking socket state
 *   onError(err)              a PeerJS error; check isFatalPeerError
 *
 * Returns { peer, send, isOpen, destroy }.
 */
export function joinHost(code, handlers = {}) {
  const Peer = requirePeer();
  const hostId = peerIdForCode(code);
  const peer = new Peer();
  const stopRecovery = attachBrokerRecovery(peer, handlers);
  // The guest rate-limits the HOST too. Not because the host is expected to
  // misbehave, but because "the host" is whatever answered that peer id, and
  // this side has no way to verify it is the tab the code was meant for.
  const bucket = new TokenBucket();

  let conn = null;
  let tries = 0;
  let timer = null;
  let dead = false;
  let everConnected = false;
  // Which dial attempt is the live one. A dial that times out leaves a
  // DataConnection that can still fire events minutes later, and without this
  // a stale attempt finishing late would tear down the channel that replaced
  // it — a reconnect that appears to succeed and then instantly drops.
  let generation = 0;

  peer.on('open', () => {
    // Guard against a SECOND dial. attachBrokerRecovery calls peer.reconnect()
    // on a broker blip, which fires 'open' again — and without this the guest
    // would open a duplicate channel to a host that already has it seated.
    if (conn || dead || timer !== null) return;
    dial();
  });

  peer.on('error', (err) => {
    handlers.onError && handlers.onError(err);
    if (isFatalPeerError(err)) { finish(); return; }

    if (err && err.type === 'peer-unavailable') {
      // The broker saying "nobody is listening on that id". Two very
      // different situations, told apart by whether we ever got in:
      //
      //   never connected — the code is wrong or the room is closed. Say so
      //     now; grinding through six retries to report a typo is worse.
      //   previously connected — the host is mid-reload and its peer id is
      //     briefly gone. This is exactly the gap the retry budget is for,
      //     and giving up here is what would turn a host's refresh into a
      //     dead game for the guest.
      if (!everConnected) { finish(); return; }
      // A connect to an id that was never found does not reliably emit
      // 'close' on the DataConnection, so the retry has to be kicked here.
      retry();
    }
  });

  function dial() {
    const myGen = ++generation;
    const pending = peer.connect(hostId, { reliable: true });
    if (!pending) { retry(); return; }

    // PeerJS does not time out a connect that never negotiates — it simply
    // never fires anything — so the deadline has to be imposed from out here.
    const deadline = setTimeout(() => {
      if (myGen !== generation) return;
      try { pending.close(); } catch (_) { /* nothing to do */ }
      retry();
    }, JOIN_TIMEOUT);

    pending.on('open', () => {
      clearTimeout(deadline);
      if (dead || myGen !== generation) {
        try { pending.close(); } catch (_) { /* nothing to do */ }
        return;
      }
      conn = pending;
      everConnected = true;
      tries = 0;   // a successful dial refills the retry budget
      handlers.onOpen && handlers.onOpen(conn);
    });

    pending.on('data', (raw) => {
      const msg = decodePeerFrame(raw, { maxBytes: MAX_FRAME_BYTES });
      if (!msg) return;
      if (!bucket.take(Date.now())) return;
      handlers.onData && handlers.onData(msg);
    });

    const lost = () => {
      clearTimeout(deadline);
      if (myGen !== generation) return;
      if (conn === pending) conn = null;
      retry();
    };
    pending.on('close', lost);
    pending.on('error', lost);
  }

  function retry() {
    // One re-dial in flight at a time. Several things can report the same
    // failure — the deadline, the connection's close, the peer's error — and
    // each must not buy its own attempt out of a shared budget.
    if (dead || timer !== null) return;
    if (tries >= RECONNECT_TRIES) { finish(); return; }
    const delay = backoffFor(tries);
    tries++;
    handlers.onRetry && handlers.onRetry(tries);
    timer = setTimeout(() => {
      timer = null;
      if (dead || peer.destroyed) return;
      dial();
    }, delay);
  }

  function finish() {
    if (dead) return;
    dead = true;
    if (timer !== null) clearTimeout(timer);
    handlers.onClose && handlers.onClose();
  }

  function destroy() {
    // Set first: destroying the peer fires 'close' on the open channel, and
    // without this the guest would announce a lost host on its way out of a
    // room it chose to leave.
    dead = true;
    if (timer !== null) clearTimeout(timer);
    stopRecovery();
    conn = null;
    try { peer.destroy(); } catch (_) { /* nothing to do */ }
  }

  return {
    peer,
    send(msg) { return trySend(conn, msg); },
    isOpen() { return !!(conn && conn.open); },
    destroy,
  };
}
