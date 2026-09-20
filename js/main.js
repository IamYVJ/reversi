// ============================================================================
// main.js — Controller. Owns app state, the render loop, and the wiring
// between a click and the engine.
//
// The engine itself lives in state.js and is reached ONLY through
// applyGameIntent (js/intents.js). Nothing in this file applies a move.
// ============================================================================

import { GameEngine, PHASES } from './state.js';
import { applyGameIntent } from './intents.js';
import { createBotDriver } from './bot.js';
import { createHost, joinHost, describePeerError } from './net.js';
import { validClientId, validNameField, validPublicState } from './guards.js';
import { render } from './ui.js';
import {
  clientId, loadName, saveName, clear, copyText,
  generateRoomCode, normalizeCode, loadLastCode, saveLastCode, CODE_LENGTH,
  saveEngineSnapshot, loadEngineSnapshot, saveSession, loadSession, clearSession,
} from './util.js';
import { cleanName } from './rules.js';
// Blank in v1. Read anyway, at the two lines where "who runs the engine"
// stops being the same question as "who holds the room controls".
import { serverConfigured } from './config.js';

const root = document.getElementById('app');
const engine = new GameEngine();

// Local seats are fixed ids, not this browser's clientId: the engine keys
// players by id and both seats have to be distinguishable. The humans are
// numbered rather than coloured because playAgain swaps colours.
const LOCAL_IDS = Object.freeze({ one: 'player-1', two: 'player-2', bot: 'bot' });

// The modes this tab runs the engine for, and can therefore rebuild from a
// snapshot after a reload. A P2P guest holds no authoritative state.
const LOCAL_MODES = Object.freeze(['hotseat', 'bot']);

const app = {
  screen: 'home',          // 'home' | 'lobby' | 'game'
  mode: null,              // 'hotseat' | 'p2p' | 'bot'
  // isHost means "this tab runs the engine", and it is what routes an intent
  // locally instead of over the wire. isOwner means "this player holds the
  // room's controls". They are the same person in hotseat and in p2p, and
  // different things under a server, so every control in the UI is gated on
  // isOwner and only sendIntent looks at isHost.
  me: { id: clientId(), name: loadName(), isHost: false, isOwner: false },
  pub: null,               // the engine's public state; the only thing ui.js reads
  notice: '',              // transient message, cleared on the next successful intent
  thinking: false,         // a bot is waiting out its pause; purely a UI cue
  code: '',                // the room code, in p2p only
  net: '',                 // transport status; see NET below. '' means offline modes
  joinCode: loadLastCode(),// the join box's contents, seeded with the last room
};

// What the connection is doing, in the guest's and host's own words. Held as a
// string rather than a set of booleans because exactly one is ever true, and
// because ui.js only ever needs to print one line about it.
const NET = Object.freeze({
  OPENING: 'opening',      // host: asking the broker for our room code
  WAITING: 'waiting',      // host: room is live, nobody has arrived
  DIALLING: 'dialling',    // guest: reaching for the host
  LIVE: 'live',            // both: a data channel is open
  RETRYING: 'retrying',    // the channel dropped; re-dialling on a backoff
  BROKER: 'broker',        // matchmaking is down; an open game keeps working
  LOST: 'lost',            // gave up. the only state the user must act on
});

// --- Intent routing --------------------------------------------------------

// The one funnel every game action passes through. isHost — NOT isOwner — is
// what decides the branch: the question here is "does this tab hold the
// engine", not "is this player allowed". Permission is settled inside
// applyGameIntent, on whichever device actually runs it.
function sendIntent(msg) {
  if (!msg || typeof msg.type !== 'string') return;
  if (app.me.isHost) {
    dispatchIntent(actorFor(msg), msg);
    return;
  }
  // Guest. The message goes out exactly as written and carries no actor id —
  // the host derives that from the connection it arrived on, which is the
  // whole reason a peer cannot act as their opponent.
  if (link && !link.send(msg)) {
    app.notice = 'Not connected to the host.';
    draw();
  }
}

// Which player this tab is acting AS. In hotseat one human plays both
// colours, so the actor is whoever the screen says; everywhere else it is this
// device. This is identity routing, not game logic, which is why it lives
// here and not behind the intents seam.
function actorFor(msg) {
  if (app.mode === 'hotseat') {
    // The mover for a move, the edited row for a rename. Trusting msg.playerId
    // is safe here and ONLY here: a hotseat tab is its own authority and there
    // is one human at the keyboard. A guest's message never reaches this
    // function — the host maps its connection to an id instead.
    if (msg.type === 'playMove') {
      const current = engine.currentPlayer;
      if (current) return current.id;
    }
    if (msg.type === 'setName' && typeof msg.playerId === 'string') return msg.playerId;
  }
  return app.me.id;
}

function dispatchIntent(actorId, msg) {
  const { handled, result } = applyGameIntent(engine, actorId, msg);
  if (!handled) return;
  if (!result.ok) {
    app.notice = result.error;
    draw();
    return;
  }
  app.notice = '';
  hostSync();
}

// Publishes the engine's new state everywhere it needs to go: to this tab's
// view, to storage, and to every connected peer. THE ONLY PLACE STATE LEAVES
// THE ENGINE, which is why a guest can never see a half-applied move.
//
// One whole-state broadcast per change rather than a diff or an event stream.
// The payload is a few hundred bytes and a guest that has just reconnected,
// or reloaded, or missed a frame is correct again after the very next one —
// no replay log, no sequence numbers, no resync path to get wrong.
function hostSync() {
  app.pub = engine.publicState();
  saveEngineSnapshot(engine.serialize());
  saveSession({ mode: app.mode, screen: app.screen, code: app.code });
  syncBotTick();
  if (link && link.broadcast) link.broadcast({ type: 'state', pub: app.pub });
  draw();
}

// --- Peer-to-peer ----------------------------------------------------------
//
// The transport handle for this tab: a host's hub or a guest's single channel,
// never both, and null in the two offline modes. Everything below is protocol
// — net.js moves opaque JSON and knows nothing about any of these types.
//
//   guest -> host   hello      { clientId, name }  once, on connect
//                   <intents>  playMove, setName, and the owner intents
//   host  -> guest  state      { pub }             after every change
//                   notice     { text }            an intent was refused
//                   refused    { reason }          you are not getting in
let link = null;

// connId -> clientId. The host's ONLY source of truth about who is speaking.
// A guest's own claim about their identity is accepted exactly once, in hello,
// and never re-read from a later message.
const guestIds = new Map();

function setNet(status) {
  if (app.net === status) return;
  app.net = status;
  draw();
}

function dropLink() {
  if (link) { link.destroy(); link = null; }
  guestIds.clear();
  idRetried = false;
  app.net = '';
}

// Reclaiming a room code after a reload races the broker, which can still be
// holding the old socket open for a second or two and answers 'unavailable-id'
// — fatal only if you ask exactly once. One retry on a generous delay is the
// difference between a mid-game reload resuming and the host being told to go
// and start a new game. The flag makes it one retry, not a loop: if the code
// is genuinely taken by someone else, the second answer is the real one.
const ID_RETRY_MS = 2000;
let idRetried = false;

function reclaimCode() {
  const code = app.code;
  if (link) { link.destroy(); link = null; }
  app.net = NET.OPENING;
  setTimeout(() => {
    // The player may well have gone home in those two seconds.
    if (app.mode !== 'p2p' || !app.me.isHost || app.code !== code) return;
    if (!openLink(() => createHost(code, hostHandlers()))) return;
    hostSync();
  }, ID_RETRY_MS);
  draw();
}

// --- Hosting ---------------------------------------------------------------

function startP2P() {
  const code = generateRoomCode();
  engine.reset();
  engine.addPlayer(app.me.id, app.me.name || 'Player 1');

  app.mode = 'p2p';
  app.screen = 'lobby';
  app.code = code;
  // The one place the two ideas come apart, written as the branch it really
  // is rather than as two hardcoded `true`s.
  //
  //   isOwner  this player opened the room, so they hold its controls. True
  //            either way — a server does not take the controls off them.
  //   isHost   this tab RUNS THE ENGINE. True only because there is no server
  //            to run it instead. Set SERVER_URL and this becomes false, the
  //            engine moves to the server, and every call site that already
  //            asks `isHost` starts getting the right answer for free.
  //
  // Currently always true, which is the point: the branch exists so that
  // turning a server on is a config change and not a refactor.
  app.me.isOwner = true;
  app.me.isHost = !serverConfigured();
  app.notice = '';
  app.net = NET.OPENING;

  if (!openLink(() => createHost(code, hostHandlers()))) return;
  saveLastCode(code);
  hostSync();
}

function hostHandlers() {
  return {
    onOpen: () => setNet(guestIds.size ? NET.LIVE : NET.WAITING),
    // Nothing happens on a bare connection. A channel that has not said hello
    // has no identity, so it cannot be seated and cannot act.
    onConnect: () => {},
    onData: onGuestMessage,
    onDisconnect: (connId) => {
      const id = guestIds.get(connId);
      guestIds.delete(connId);
      if (!id) { setNet(guestIds.size ? NET.LIVE : NET.WAITING); return; }
      // In the lobby this frees the seat; mid-game the engine keeps it and
      // only marks them away, so a reload lands back in the same colour.
      engine.removePlayer(id);
      app.net = guestIds.size ? NET.LIVE : NET.WAITING;
      hostSync();
    },
    onBrokerDown: () => setNet(NET.BROKER),
    onBrokerUp: () => setNet(guestIds.size ? NET.LIVE : NET.WAITING),
    onBrokerLost: () => setNet(NET.LOST),
    onError: (err) => {
      if (err && err.type === 'unavailable-id' && !idRetried && app.code) {
        idRetried = true;
        reclaimCode();
        return;
      }
      app.notice = describePeerError(err);
      draw();
    },
  };
}

function onGuestMessage(connId, msg) {
  if (msg.type === 'hello') {
    seatGuest(connId, msg);
    return;
  }

  const actorId = guestIds.get(connId);
  if (!actorId) return;   // silence until they have introduced themselves

  const { handled, result } = applyGameIntent(engine, actorId, msg);
  if (!handled) return;   // not a game intent, and there is nothing else
  if (!result.ok) {
    // Told to the ONE guest who asked, not broadcast. A refusal is about
    // their click; their opponent has no reason to see it.
    link.sendTo(connId, { type: 'notice', text: result.error });
    return;
  }
  hostSync();
}

function seatGuest(connId, msg) {
  const id = validClientId(msg.clientId);
  const raw = validNameField(msg.name);
  if (!id || raw === null) return;

  // One identity per channel, fixed at the first hello. Without this a single
  // peer could introduce itself twice and occupy both seats.
  const known = guestIds.get(connId);
  if (known && known !== id) return;
  // And one channel per identity, so a peer cannot claim the seat someone
  // else is already sitting in by guessing their clientId.
  for (const [otherConn, otherId] of guestIds) {
    if (otherId === id && otherConn !== connId) return;
  }

  const seated = engine.addPlayer(id, cleanName(raw) || 'Player 2');
  if (!seated.ok) {
    link.sendTo(connId, { type: 'refused', reason: seated.error });
    return;
  }

  guestIds.set(connId, id);
  app.net = NET.LIVE;
  hostSync();
}

// --- Joining ---------------------------------------------------------------

function joinRoom(raw) {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) {
    app.notice = `A room code is ${CODE_LENGTH} letters.`;
    draw();
    return;
  }

  engine.reset();
  app.mode = 'p2p';
  app.screen = 'lobby';
  app.code = code;
  app.me.id = clientId();
  app.me.isHost = false;
  app.me.isOwner = false;
  app.pub = null;
  app.notice = '';
  app.net = NET.DIALLING;

  if (!openLink(() => joinHost(code, guestHandlers()))) return;
  saveLastCode(code);
  // A guest writes a session but never an engine snapshot: it holds no
  // authoritative state, and resuming means re-joining, not rebuilding.
  saveSession({ mode: 'p2p', screen: 'lobby', code });
  draw();
}

function guestHandlers() {
  return {
    onOpen: () => {
      app.net = NET.LIVE;
      // The only message a guest sends unprompted. Re-sent on every
      // reconnect, and idempotent on the host: a returning clientId updates
      // the name and marks them present rather than taking a second seat.
      link.send({ type: 'hello', clientId: app.me.id, name: app.me.name });
      draw();
    },
    onData: onHostMessage,
    onRetry: () => setNet(NET.RETRYING),
    onClose: () => setNet(NET.LOST),
    onBrokerDown: () => { if (app.net !== NET.LIVE) setNet(NET.BROKER); },
    onBrokerUp: () => { if (app.net === NET.BROKER) setNet(NET.DIALLING); },
    onBrokerLost: () => { if (app.net !== NET.LIVE) setNet(NET.LOST); },
    onError: (err) => {
      app.notice = describePeerError(err);
      draw();
    },
  };
}

function onHostMessage(msg) {
  switch (msg.type) {
    case 'state': {
      // The one message this tab renders straight into the DOM, so it is the
      // one that gets the full shape check. The host is not assumed friendly
      // merely because we dialled it — "the host" is whatever answered that
      // room code.
      const pub = validPublicState(msg.pub);
      if (!pub) return;
      app.pub = pub;
      // Ownership is READ off the state, never assumed. If the host hands the
      // room over, the controls follow without a separate message.
      app.me.isOwner = pub.ownerId === app.me.id;
      // A guest has no screen of its own: the host's phase decides. This is
      // what makes "Start game" on one device open the board on the other.
      app.screen = pub.phase === PHASES.LOBBY ? 'lobby' : 'game';
      app.notice = '';
      saveSession({ mode: 'p2p', screen: app.screen, code: app.code });
      draw();
      return;
    }

    case 'notice': {
      const text = validNameField(msg.text);
      app.notice = text || 'The host refused that.';
      draw();
      return;
    }

    case 'refused': {
      const why = validNameField(msg.reason);
      app.notice = why === 'full' ? 'That game is already full.' : (why || 'The host turned you away.');
      dropLink();
      draw();
      return;
    }

    default:
      // Unknown types are dropped. Answering would confirm someone is here.
  }
}

// Both entry points construct their transport the same way, and both have the
// same one failure that is not a PeerJS error at all: the CDN script missing,
// which net.js reports by throwing rather than by calling a handler.
function openLink(build) {
  try {
    link = build();
    return true;
  } catch (err) {
    link = null;
    goHome();
    app.notice = err && err.message ? err.message : 'Peer-to-peer is unavailable.';
    draw();
    return false;
  }
}

// --- The bot's turn --------------------------------------------------------
//
// The engine holds no timer and the driver holds no clock; this interval is
// the only thing in the app that knows what time it is on the bot's behalf. It
// exists purely to prod the driver and hand it `now`.
//
// A browser throttles timers in a backgrounded tab to roughly once a minute
// and suspends them on a locked phone, so a hidden tab means a bot that stops
// playing until the screen comes back. There is no fixing that from in here —
// a background tab is not allowed to run — and in a strictly two-player local
// game the only person kept waiting is the one who backgrounded it.
let botTimer = null;

// Finer than sequence's one-second host tick because nothing else rides this
// one: at 1000ms a 600ms pause would quantise to a full second and the bot
// would feel laggy rather than thoughtful.
const BOT_TICK_MS = 120;

// One driver for this tab, rebuilt nowhere. It keys its pause off the engine's
// own turn, so a reload re-syncs it without being told.
const bots = createBotDriver();

// Arms and disarms itself to match the game. Called from hostSync(), which
// runs after every intent, so the interval starts when a bot is seated and a
// game begins, and stops at game over, back in the lobby, or when this tab
// stops holding the engine — without any of those places knowing it exists.
function syncBotTick() {
  const wanted = !!(app.me.isHost
    && engine.phase === PHASES.PLAY
    && engine.players.some((p) => p.isBot));
  if (wanted === (botTimer !== null)) return;
  if (!wanted) { stopBotTick(); return; }
  botTimer = setInterval(() => {
    // tick() re-checks the phase itself, so a tick is never trusted to still
    // be relevant by the time it fires.
    if (bots.tick(engine, Date.now())) hostSync();
    else refreshThinking();
  }, BOT_TICK_MS);
}

function stopBotTick() {
  if (botTimer !== null) { clearInterval(botTimer); botTimer = null; }
}

// The "thinking" cue is the one piece of state that changes without an intent,
// so it gets its own minimal path: redraw ONLY when it actually flips. draw()
// is what recomputes it; ticking the board ten times a second to re-render an
// unchanged screen is exactly what a full-rebuild renderer must not do.
function refreshThinking() {
  if (bots.isThinking(engine, Date.now()) !== app.thinking) draw();
}

// --- Render loop -----------------------------------------------------------

let lastView = null;
let lastMoveKey = null;

function viewKey() {
  return app.screen === 'game' && app.pub ? `game:${app.pub.phase}` : `${app.screen}:${app.mode}`;
}

// Identifies the most recent move. Discs should animate when they are
// actually played and flipped, not every time a rebuild re-creates them.
//
// The cell alone is NOT enough to identify a move: in Reversi a square holds a
// disc that changes colour repeatedly, so "the last move was at D3" is true
// for many different board states. Pairing it with the ply count — which only
// ever increases — makes the key unique per move.
function moveKey() {
  const m = app.pub && app.pub.lastMove;
  return m ? `${app.pub.plies}:${m.cell}` : null;
}

function draw() {
  app.thinking = bots.isThinking(engine, Date.now());

  const view = viewKey();
  const sameView = view === lastView;
  lastView = view;

  // render() rebuilds #app from scratch, so anything the browser was holding
  // on to inside it — focus, the caret, a scroll offset — has to be captured
  // and put back by hand.
  const active = document.activeElement;
  const focusKey = active && root.contains(active) ? active.getAttribute('data-focus') : null;
  const caret = focusKey && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd]
    : null;
  const pageY = window.scrollY;

  const move = moveKey();
  const freshMove = move !== null && move !== lastMoveKey;
  lastMoveKey = move;

  root.classList.toggle('rerender', sameView);
  root.classList.toggle('fresh-move', freshMove);

  clear(root);
  render(root, app, intents);

  if (focusKey) {
    const next = root.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`);
    if (next) {
      next.focus({ preventScroll: true });
      if (caret && typeof next.setSelectionRange === 'function') {
        next.setSelectionRange(caret[0], caret[1]);
      }
    }
  }

  if (sameView) window.scrollTo(0, pageY);
  else window.scrollTo(0, 0);

  announce(root.querySelector('[data-announce]'));
}

function announce(source) {
  say(source ? source.getAttribute('data-announce') : '');
}

// The live region is a SIBLING of #app, never a child: render() empties #app
// on every draw, and a live region only fires when text changes inside a node
// that was already in the document. Rebuilt regions announce nothing.
function say(text) {
  const region = document.getElementById('announce');
  if (!region) return;
  if (region.textContent !== text) region.textContent = text;
}

// --- Mode entry ------------------------------------------------------------

function startHotseat() {
  startLocal('hotseat', () => {
    engine.addPlayer(LOCAL_IDS.one, app.me.name || 'Player 1');
    engine.addPlayer(LOCAL_IDS.two, 'Player 2');
  });
}

function startBot() {
  startLocal('bot', () => {
    // The human joins first, which takes both the black seat and the room
    // controls — addPlayer refuses ownership to a bot, so the order matters
    // less than it looks, but a human on black means the player opens.
    engine.addPlayer(LOCAL_IDS.one, app.me.name || 'You');
    engine.addPlayer(LOCAL_IDS.bot, 'Bot', { isBot: true });
  });
}

// Shared entry for the two modes this tab runs the engine for.
function startLocal(mode, seat) {
  dropLink();
  engine.reset();
  seat();
  app.mode = mode;
  app.screen = 'lobby';
  // One human owns the room and runs the engine. Still two separate flags:
  // the moment a second device is involved they stop moving together.
  app.me.id = LOCAL_IDS.one;
  app.me.isHost = true;
  app.me.isOwner = true;
  app.notice = '';
  hostSync();
}

function goHome() {
  engine.reset();
  clearSession();
  stopBotTick();
  bots.reset();
  // Hanging up is what tells the other device we have gone. Without it the
  // host holds a seat for a player who has walked away, and the room stays
  // discoverable on a code nobody is watching.
  dropLink();
  app.mode = null;
  app.screen = 'home';
  app.code = '';
  app.me.id = clientId();
  app.me.isHost = false;
  app.me.isOwner = false;
  app.pub = null;
  app.notice = '';
  lastMoveKey = null;
  draw();
}

// Renaming goes through the dispatcher like everything else, so a guest's
// change reaches the host and comes back in the next broadcast. The only part
// that stays local is remembering the name for next time.
function setPlayerName(playerId, raw) {
  const name = cleanName(raw);
  if (playerId === app.me.id) {
    app.me.name = name;
    saveName(name);
  }
  sendIntent({ type: 'setName', playerId, name });
}

const intents = {
  send: sendIntent,
  goHome,
  startHotseat,
  startBot,
  startP2P,
  joinRoom,
  setPlayerName,
  setJoinCode(raw) {
    app.joinCode = normalizeCode(raw);
    // Redraws even when the value did not change, which is the case that
    // matters: a rejected character — a lowercase o, a zero, a fifth letter —
    // is still sitting in the box, and the rebuild is what takes it back out.
    draw();
  },
  copyCode() {
    // Fire and forget: the button already reads "Copy", and a failure on a
    // non-secure origin is not something the player can do anything about.
    if (app.code) copyText(app.code);
  },
  enterGame() {
    app.screen = 'game';
    hostSync();
  },
  toLobby() {
    app.screen = 'lobby';
    hostSync();
  },
  dismissNotice() {
    if (!app.notice) return;
    app.notice = '';
    draw();
  },
};

// --- Boot ------------------------------------------------------------------

// A hard reload mid-game should land back in the game, not on the home screen.
// How that happens depends entirely on who was holding the state.
function boot() {
  const session = loadSession();
  if (session && session.mode === 'p2p') {
    if (resumeP2P(session)) return;
  } else if (session && resumeLocal(session)) {
    hostSync();
    return;
  }
  draw();
}

function resumeLocal(session) {
  if (!LOCAL_MODES.includes(session.mode)) return false;
  const snapshot = loadEngineSnapshot();
  if (!snapshot) return false;

  engine.restore(snapshot);
  if (engine.phase === PHASES.LOBBY && !engine.players.length) return false;

  app.mode = session.mode;
  app.screen = engine.phase === PHASES.LOBBY ? 'lobby' : 'game';
  app.me.id = engine.ownerId || LOCAL_IDS.one;
  app.me.isHost = true;
  app.me.isOwner = true;

  // The restored move was played before this page existed, so it must not
  // animate as though it had just landed. lastMoveKey starts null, which the
  // first draw() would read as "brand new"; seeding it marks the move as
  // already seen and the resumed board renders settled.
  app.pub = engine.publicState();
  lastMoveKey = moveKey();
  return true;
}

// Resuming a peer-to-peer game is two completely different jobs depending on
// which end this tab was, and the snapshot is what tells them apart: only a
// host writes one, and only under its own clientId.
//
// Returns true if it took responsibility for the screen, drawing included.
function resumeP2P(session) {
  const code = normalizeCode(session.code || '');
  if (code.length !== CODE_LENGTH) return false;

  // Only a tab that ran the engine ever wrote a snapshot, so its presence
  // plus a matching owner id is what distinguishes a host reload from a guest
  // one. Under a server nobody local runs the engine, so there is no snapshot
  // to find and every reload is a re-join — which is already what the guest
  // branch below does.
  const snapshot = serverConfigured() ? null : loadEngineSnapshot();
  const wasHost = !!snapshot && snapshot.ownerId === app.me.id;

  if (!wasHost) {
    // A guest rebuilds by re-joining, not from storage. It never held
    // authoritative state, and the host's copy is the only one that counts —
    // the first broadcast after hello restores the whole screen.
    joinRoom(code);
    return true;
  }

  engine.restore(snapshot);
  if (!engine.players.length) return false;
  // Every data channel died with the page. Showing the guest as present until
  // they happen to dial back would be a lie the UI acts on; hello puts it
  // right, and mid-game the engine has held their seat regardless.
  for (const p of engine.players) p.connected = p.id === engine.ownerId;

  app.mode = 'p2p';
  app.screen = engine.phase === PHASES.LOBBY ? 'lobby' : 'game';
  app.code = code;
  app.me.isOwner = true;
  app.me.isHost = !serverConfigured();   // same branch as startP2P
  app.net = NET.OPENING;
  app.pub = engine.publicState();
  lastMoveKey = moveKey();

  if (!openLink(() => createHost(code, hostHandlers()))) return true;
  hostSync();
  return true;
}

boot();

// --- Service worker --------------------------------------------------------

// Relative path, so it works under a GitHub Pages subpath. Registered after
// `load` rather than immediately: the install fetches the whole shell, and
// doing that while the first paint is still in flight competes with the very
// assets the player is waiting for.
//
// The failure is swallowed. An offline shell is an enhancement — the app runs
// perfectly well straight from the network — and a page that refused to work
// because its cache would not install would be strictly worse than one that
// quietly goes without.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline shell optional */ });
  });
}
