// ============================================================================
// ui.js — render(root, app, intents). A FULL REBUILD on every draw.
//
// There is no diffing and no component state. render() is called with the
// engine's public state and produces the whole screen from it, which means a
// bug can never be "the DOM drifted out of step" — the DOM is a pure function
// of app.pub.
//
// The two things a full rebuild costs are handled deliberately:
//
//   Focus and scroll are captured and restored by draw() in main.js, keyed on
//   the data-focus attributes set here.
//
//   Animations would otherwise replay on every rebuild. main.js puts a
//   `fresh-move` class on the root for exactly the one render that follows a
//   real move, and the CSS keys every disc animation off it. Without that,
//   the entire board flips again each time anyone takes a turn.
//
// The ONE piece of DOM mutation outside render() is the flip preview, which
// toggles classes on hover. Rebuilding a 100-cell board on mousemove is not
// something a phone would forgive.
// ============================================================================

import { el, CODE_LENGTH } from './util.js';
import { BLACK, WHITE, EMPTY, cellName, cellAt, rowOf, colOf, legalMoveMap, COLUMN_LETTERS } from './board.js';
import { boardFrom, PHASES, DRAW } from './state.js';
import {
  BOARD_SIZES, BOT_LEVELS, describeHouseRules,
  legalDotsOn, flipPreviewOn, discCounterOn, antiOthelloOn,
} from './rules.js';

// Roving tabindex cursor, kept at module scope so it survives the rebuild.
// One tab stop for the whole board rather than up to a hundred; arrow keys
// move within it, which is what a grid widget is supposed to do.
let cursor = null;

export function render(root, app, intents) {
  if (app.screen === 'game' && app.pub) root.append(gameScreen(app, intents));
  else if (app.screen === 'lobby' && app.pub) root.append(lobbyScreen(app, intents));
  else root.append(homeScreen(app, intents));
}

// --- Home ------------------------------------------------------------------

function homeScreen(app, intents) {
  return el('div', { class: 'shell shell-home', 'data-announce': 'Reversi. Choose how to play.' },
    el('header', { class: 'masthead' },
      el('h1', { class: 'wordmark' }, 'Reversi'),
      el('p', { class: 'tagline' }, 'Flank a line of discs, turn them over, hold the corners.'),
    ),
    el('div', { class: 'mode-list' },
      modeCard({
        title: 'Same device',
        blurb: 'Two players, one screen. Pass it back and forth.',
        label: 'Play hotseat',
        onClick: intents.startHotseat,
      }),
      modeCard({
        title: 'Against the bot',
        blurb: 'Three strengths, from careless to genuinely awkward.',
        label: 'Play the bot',
        onClick: intents.startBot,
      }),
      p2pCard(app, intents),
    ),
  );
}

function modeCard({ title, blurb, label, onClick, disabled = false }, ...extra) {
  return el('section', { class: `mode-card${disabled ? ' is-soon' : ''}` },
    el('h2', { class: 'mode-title' }, title),
    el('p', { class: 'mode-blurb' }, blurb),
    el('button', {
      class: 'btn btn-primary',
      type: 'button',
      disabled,
      onClick: onClick || null,
    }, label),
    ...extra,
  );
}

// The only card with two doors. Hosting and joining are the same mode from
// the engine's point of view and completely different acts from the player's,
// so they sit side by side rather than behind a second screen.
function p2pCard(app, intents) {
  const ready = app.joinCode.length === CODE_LENGTH;
  return modeCard({
    title: 'With a friend',
    blurb: 'Share a four-letter code. Peer to peer, no server.',
    label: 'Host a game',
    onClick: intents.startP2P,
  },
  // A real <form>, so Enter in the code box joins. Without it the keyboard on
  // a phone shows "Go" and does nothing.
  el('form', {
    class: 'join-row',
    onSubmit: (e) => { e.preventDefault(); intents.joinRoom(app.joinCode); },
  },
  el('input', {
    class: 'code-input',
    type: 'text',
    value: app.joinCode,
    placeholder: 'CODE',
    maxlength: String(CODE_LENGTH),
    // The code alphabet has no O, I, zero or one, and is upper case only.
    // The browser's own helpfulness works against all three.
    autocomplete: 'off',
    autocapitalize: 'characters',
    autocorrect: 'off',
    spellcheck: 'false',
    inputmode: 'text',
    'aria-label': 'Room code',
    'data-focus': 'join-code',
    onInput: (e) => intents.setJoinCode(e.target.value),
  }),
  el('button', {
    class: 'btn btn-ghost',
    type: 'submit',
    disabled: !ready,
    'data-focus': 'join-game',
  }, 'Join')));
}

// --- Lobby -----------------------------------------------------------------

function lobbyScreen(app, intents) {
  const pub = app.pub;
  const house = describeHouseRules(pub.config);
  // Read off the state rather than app.mode, so a resumed session shows the
  // difficulty picker without the controller having to tell the UI anything.
  const bot = pub.players.find((p) => p.isBot) || null;

  return el('div', { class: 'shell shell-lobby', 'data-announce': lobbyAnnouncement(app, pub) },
    topBar(app, intents, 'Setup'),
    notice(app, intents),
    netLine(app),
    roomPanel(app, intents),

    el('section', { class: 'panel' },
      el('h2', { class: 'panel-title' }, 'Players'),
      el('div', { class: 'seat-list' },
        ...pub.players.map((p) => seatRow(p, app, intents)),
        // Only p2p can sit at a half-filled table. Hotseat and bot seat both
        // players the instant the mode opens.
        app.mode === 'p2p' && pub.players.length < 2 ? emptySeat(pub) : null,
      ),
      app.me.isOwner && el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        'data-focus': 'swap-seats',
        onClick: () => intents.send({ type: 'swapSeats' }),
      }, 'Swap colours'),
    ),

    bot && el('section', { class: 'panel' },
      el('h2', { class: 'panel-title' }, 'Difficulty'),
      el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Bot difficulty' },
        ...BOT_LEVELS.map((level) => el('button', {
          class: `chip${bot.botLevel === level.id ? ' is-on' : ''}`,
          type: 'button',
          'aria-pressed': bot.botLevel === level.id ? 'true' : 'false',
          disabled: !app.me.isOwner,
          'data-focus': `level-${level.id}`,
          onClick: () => intents.send({ type: 'setBotLevel', playerId: bot.id, level: level.id }),
        }, level.name)),
      ),
      el('p', { class: 'chip-hint' }, blurbFor(bot.botLevel)),
    ),

    el('section', { class: 'panel' },
      el('h2', { class: 'panel-title' }, 'Board'),
      el('div', { class: 'chip-row', role: 'group', 'aria-label': 'Board size' },
        ...BOARD_SIZES.map((size) => el('button', {
          class: `chip${pub.config.boardSize === size ? ' is-on' : ''}`,
          type: 'button',
          'aria-pressed': pub.config.boardSize === size ? 'true' : 'false',
          disabled: !app.me.isOwner,
          'data-focus': `size-${size}`,
          onClick: () => intents.send({ type: 'setConfig', config: { boardSize: size } }),
        }, `${size}x${size}`)),
      ),
      toggleRow({
        app, intents, key: 'antiOthello',
        label: 'Anti-Othello',
        hint: 'Fewest discs wins.',
      }),
    ),

    el('section', { class: 'panel' },
      el('h2', { class: 'panel-title' }, 'Assists'),
      toggleRow({ app, intents, key: 'legalDots', label: 'Legal-move dots', hint: 'Mark playable squares.' }),
      toggleRow({ app, intents, key: 'flipPreview', label: 'Flip preview', hint: 'Show what a move would turn over.' }),
      toggleRow({ app, intents, key: 'discCounter', label: 'Live disc count', hint: 'Keep score as you play.' }),
    ),

    el('p', { class: 'rules-summary' },
      house.length ? house.join(' · ') : 'Official rules.'),

    el('button', {
      class: 'btn btn-primary btn-wide',
      type: 'button',
      // Reversi needs exactly two. The engine refuses a short table anyway;
      // this is so the owner is not invited to press a button that cannot work
      // while they are still waiting for someone to arrive.
      disabled: !app.me.isOwner || pub.players.length !== 2,
      'data-focus': 'start-game',
      onClick: () => {
        intents.send({ type: 'startGame' });
        intents.enterGame();
      },
    }, 'Start game'),
  );
}

function seatRow(player, app, intents) {
  // You rename yourself. In the two local modes one human sits in both seats,
  // so the owner edits both rows; across the wire a player edits only their
  // own, which is also all the engine's setName intent will accept.
  const editable = !player.isBot
    && (app.mode === 'p2p' ? player.id === app.me.id : app.me.isOwner);
  const away = player.connected === false;

  return el('div', { class: `seat${away ? ' is-away' : ''}` },
    el('span', { class: 'disc disc-sm', 'data-disc': player.seat === BLACK ? 'black' : 'white',
      'aria-hidden': 'true' }),
    editable
      ? el('input', {
        class: 'name-input',
        type: 'text',
        value: player.name,
        maxlength: '20',
        'aria-label': `${player.seat === BLACK ? 'Black' : 'White'} player name`,
        'data-focus': `name-${player.id}`,
        onInput: (e) => intents.setPlayerName(player.id, e.target.value),
      })
      : el('span', { class: 'seat-name' },
        player.isBot ? `${player.name} · ${nameFor(player.botLevel)}` : player.name),
    el('span', { class: 'seat-colour' },
      away ? 'Reconnecting…' : (player.seat === BLACK ? 'Black · moves first' : 'White')),
  );
}

function emptySeat(pub) {
  const seat = pub.players.some((p) => p.seat === BLACK) ? WHITE : BLACK;
  return el('div', { class: 'seat seat-empty' },
    el('span', { class: 'disc disc-sm disc-ghost',
      'data-disc': seat === BLACK ? 'black' : 'white', 'aria-hidden': 'true' }),
    el('span', { class: 'seat-name' }, 'Waiting for a player'),
    el('span', { class: 'seat-colour' }, seat === BLACK ? 'Black · moves first' : 'White'),
  );
}

// --- Peer-to-peer chrome ---------------------------------------------------

function roomPanel(app, intents) {
  if (app.mode !== 'p2p') return null;
  const host = app.me.isHost;
  return el('section', { class: 'panel panel-room' },
    el('h2', { class: 'panel-title' }, 'Room code'),
    el('div', { class: 'code-row' },
      el('span', { class: 'room-code' }, app.code || '····'),
      host ? el('button', {
        class: 'btn btn-ghost btn-small',
        type: 'button',
        'data-focus': 'copy-code',
        onClick: intents.copyCode,
      }, 'Copy') : null,
    ),
    el('p', { class: 'chip-hint' }, host
      ? 'Read these four letters out. Your opponent picks “With a friend” and types them in.'
      : 'Connected to this room. The host sets the rules and starts the game.'),
  );
}

// One line, one state. Deliberately absent when the connection is live —
// a permanent green "connected" badge is noise, and its absence is the signal.
const NET_TEXT = Object.freeze({
  opening: 'Opening the room…',
  waiting: 'Waiting for your opponent to join…',
  dialling: 'Looking for that game…',
  retrying: 'Connection dropped — trying again…',
  broker: 'Matchmaking is unreachable. A game already under way is unaffected.',
  lost: 'Connection lost. Go back home and try the code again.',
});

function netLine(app) {
  if (app.mode !== 'p2p') return null;
  // "waiting" means the same thing to the code in both places — no guest on the
  // wire — but it means something different to the player. Nobody has joined
  // yet in the lobby; mid-game somebody left, and the reassuring part is that
  // the engine is still holding their colour for them.
  const text = app.net === 'waiting' && app.screen === 'game'
    ? 'Your opponent has dropped out. Their seat is held until they come back.'
    : NET_TEXT[app.net];
  if (!text) return null;
  return el('p', { class: `net-line is-${app.net}` }, text);
}

// The lobby's live-region text. Unlike the game screen it is mostly static,
// so the connection state is the one thing worth saying out loud — a blind
// player otherwise has no way to know their opponent has arrived.
function lobbyAnnouncement(app, pub) {
  if (app.mode !== 'p2p') return 'Game setup.';
  const text = NET_TEXT[app.net];
  if (text) return `Game setup. Room code ${[...(app.code || '')].join(' ')}. ${text}`;
  const names = pub.players.map((p) => p.name).join(' and ');
  return `Game setup. ${pub.players.length === 2 ? `${names} are in the room.` : 'Waiting for a player.'}`;
}

function levelInfo(id) {
  return BOT_LEVELS.find((l) => l.id === id) || BOT_LEVELS[0];
}

function nameFor(id) {
  return levelInfo(id).name;
}

function blurbFor(id) {
  return levelInfo(id).blurb;
}

function toggleRow({ app, intents, key, label, hint }) {
  const on = !!app.pub.config[key];
  return el('label', { class: 'toggle' },
    el('input', {
      type: 'checkbox',
      checked: on,
      disabled: !app.me.isOwner,
      'data-focus': `toggle-${key}`,
      onChange: (e) => intents.send({ type: 'setConfig', config: { [key]: e.target.checked } }),
    }),
    el('span', { class: 'toggle-text' },
      el('span', { class: 'toggle-label' }, label),
      el('span', { class: 'toggle-hint' }, hint),
    ),
  );
}

// --- Game ------------------------------------------------------------------

function gameScreen(app, intents) {
  const pub = app.pub;
  const over = pub.phase === PHASES.GAME_OVER;
  const board = boardFrom(pub);
  // The board is live only when this device may actually move. In hotseat one
  // human plays both colours so it always is; against a bot or a peer it is
  // not, and an empty legal map is what stops a tap during the opponent's turn
  // firing an intent the engine only has to refuse.
  const live = !over && canAct(app, pub);
  const legal = live ? legalMoveMap(board, pub.turn, pub.size) : new Map();

  return el('div', { class: 'shell shell-play', 'data-announce': announcement(pub) },
    topBar(app, intents, over ? 'Result' : 'Playing'),
    notice(app, intents),
    netLine(app),
    scoreboard(pub),
    over ? resultBanner(pub) : turnBanner(app, pub),
    boardGrid({ app, intents, pub, board, legal, over }),
    over ? resultActions(app, intents) : null,
    moveLog(pub),
  );
}

function canAct(app, pub) {
  if (app.mode === 'hotseat') return true;
  const mine = pub.players.find((p) => p.id === app.me.id);
  return !!mine && mine.seat === pub.turn;
}

// What the screen reader hears. One string, recomputed each draw; main.js
// only writes it into the live region when it actually differs, so a rebuild
// that changes nothing stays silent.
// Deliberately says nothing about the bot thinking. The pause resolves in
// well under a second, and interrupting a screen reader to say "thinking",
// then again to say what was played, is worse than just saying what was
// played — which the next draw does anyway.
function announcement(pub) {
  if (pub.phase === PHASES.GAME_OVER) {
    const { black, white } = pub.finalScore || pub.score;
    if (pub.winner === DRAW) return `Game over. Drawn, ${black} to ${white}.`;
    const name = pub.players.find((p) => p.seat === pub.winner);
    return `Game over. ${name ? name.name : colourWord(pub.winner)} wins, ${Math.max(black, white)} to ${Math.min(black, white)}.`;
  }
  const parts = [];
  if (pub.lastMove) {
    parts.push(`${seatLabel(pub, pub.lastMove.player)} played ${cellName(pub.lastMove.cell, pub.size)}, turning ${pub.lastMove.flips.length}.`);
  }
  if (pub.lastPass) parts.push(`${seatLabel(pub, pub.lastPass.player)} has no legal move and passes.`);
  parts.push(`${seatLabel(pub, pub.turn)} to play.`);
  return parts.join(' ');
}

function colourWord(seat) {
  return seat === BLACK ? 'Black' : 'White';
}

function seatLabel(pub, seat) {
  const player = pub.players.find((p) => p.seat === seat);
  return player ? player.name : colourWord(seat);
}

function scoreboard(pub) {
  const show = discCounterOn(pub.config);
  const { black, white } = pub.score;
  return el('div', { class: 'scoreboard' },
    scoreSide(pub, BLACK, show ? black : null, pub.turn === BLACK && pub.phase === PHASES.PLAY),
    el('span', { class: 'score-sep' }, antiOthelloOn(pub.config) ? 'fewest wins' : 'vs'),
    scoreSide(pub, WHITE, show ? white : null, pub.turn === WHITE && pub.phase === PHASES.PLAY),
  );
}

function scoreSide(pub, seat, count, active) {
  return el('div', { class: `score-side${active ? ' is-active' : ''}` },
    el('span', { class: 'disc disc-sm', 'data-disc': seat === BLACK ? 'black' : 'white', 'aria-hidden': 'true' }),
    el('span', { class: 'score-name' }, seatLabel(pub, seat)),
    count === null ? null : el('span', { class: 'score-count' }, String(count)),
  );
}

function turnBanner(app, pub) {
  const thinking = app.thinking;
  return el('div', { class: `banner${thinking ? ' is-thinking' : ''}` },
    pub.lastPass
      ? el('p', { class: 'banner-pass' },
        `${seatLabel(pub, pub.lastPass.player)} has no legal move — turn passes back.`)
      : null,
    el('p', { class: 'banner-turn' },
      el('span', { class: 'disc disc-sm', 'data-disc': pub.turn === BLACK ? 'black' : 'white', 'aria-hidden': 'true' }),
      thinking ? `${seatLabel(pub, pub.turn)} is thinking` : `${seatLabel(pub, pub.turn)} to play`,
      thinking ? el('span', { class: 'ellipsis', 'aria-hidden': 'true' }, '···') : null),
  );
}

function resultBanner(pub) {
  const { black, white, empty } = pub.finalScore || { ...pub.score, empty: 0 };
  const drawn = pub.winner === DRAW;
  return el('div', { class: 'banner banner-result' },
    el('p', { class: 'result-line' },
      drawn ? 'Drawn game' : `${seatLabel(pub, pub.winner)} wins`),
    el('p', { class: 'result-score' }, `${black} – ${white}`),
    // Worth saying out loud: a Reversi game can end with squares still empty,
    // and a player seeing 33 blank cells deserves to know that was the rules
    // and not a crash.
    empty > 0
      ? el('p', { class: 'result-note' },
        `Neither player had a legal move with ${empty} ${empty === 1 ? 'square' : 'squares'} still empty.`)
      : null,
  );
}

function resultActions(app, intents) {
  if (!app.me.isOwner) return null;
  return el('div', { class: 'action-row' },
    el('button', {
      class: 'btn btn-primary', type: 'button', 'data-focus': 'play-again',
      onClick: () => intents.send({ type: 'playAgain' }),
    }, 'Play again'),
    el('button', {
      class: 'btn btn-ghost', type: 'button', 'data-focus': 'to-lobby',
      onClick: () => {
        intents.send({ type: 'backToLobby' });
        intents.toLobby();
      },
    }, 'Change settings'),
  );
}

// --- The board -------------------------------------------------------------

function boardGrid({ app, intents, pub, board, legal, over }) {
  const size = pub.size;
  const dots = legalDotsOn(pub.config);
  const preview = flipPreviewOn(pub.config) && !over;
  const lastMove = pub.lastMove;
  const flipped = new Set(lastMove ? lastMove.flips : []);

  // Keep the roving cursor somewhere sensible: the first legal move if there
  // is one, otherwise the top-left. A stale cursor from a larger board would
  // point off the end of this one.
  if (cursor === null || cursor >= size * size) cursor = null;
  if (cursor === null) cursor = legal.size ? [...legal.keys()][0] : 0;

  const grid = el('div', {
    class: 'board',
    role: 'grid',
    'aria-label': `Reversi board, ${size} by ${size}`,
    style: `--size:${size}`,
    // The legal-move dots have to be the mover's colour, and CSS cannot read
    // the turn out of the engine — so it comes down as an attribute.
    'data-turn': pub.turn === BLACK ? 'black' : 'white',
    onKeydown: (e) => onBoardKey(e, size),
  });

  // The felt. A single grid item spanning the playing area only, so the
  // coordinate gutter sits OUTSIDE the board surface rather than on top of
  // it. Painted behind the cells via z-index, not DOM order.
  grid.append(el('span', { class: 'felt', 'aria-hidden': 'true' }));

  // Row 0 of the grid is the column gutter. The labels sit OUTSIDE the playing
  // surface rather than inside the corner of each square, so they stay legible
  // at a 32px cell on a phone and never overlap a disc.
  grid.append(el('span', { class: 'gut gut-corner', 'aria-hidden': 'true' }));
  for (let c = 0; c < size; c++) {
    grid.append(el('span', { class: 'gut gut-col', 'aria-hidden': 'true' }, COLUMN_LETTERS[c]));
  }

  for (let r = 0; r < size; r++) {
    grid.append(el('span', { class: 'gut gut-row', 'aria-hidden': 'true' }, String(r + 1)));
    for (let c = 0; c < size; c++) {
      const cell = cellAt(r, c, size);
      grid.append(cellButton({
        cell, size, app, intents, board, legal, dots, preview, lastMove, flipped,
      }));
    }
  }
  return el('div', { class: 'board-wrap' }, grid);
}

function cellButton({ cell, size, app, intents, board, legal, dots, preview, lastMove, flipped }) {
  const value = board[cell];
  const flips = legal.get(cell);
  const playable = !!flips;
  const classes = ['cell'];
  if (playable && dots) classes.push('is-legal');
  if (lastMove && lastMove.cell === cell) classes.push('is-last');
  if (flipped.has(cell)) classes.push('is-flipped');

  const node = el('button', {
    class: classes.join(' '),
    type: 'button',
    role: 'gridcell',
    'data-cell': String(cell),
    'data-focus': `cell-${cell}`,
    tabindex: cell === cursor ? '0' : '-1',
    'aria-label': cellLabel(cell, size, value, playable, flips),
    onClick: () => {
      cursor = cell;
      if (playable) intents.send({ type: 'playMove', cell });
    },
    onFocus: () => { cursor = cell; },
  });

  if (value !== EMPTY) {
    node.append(el('span', { class: 'disc', 'data-disc': value === BLACK ? 'black' : 'white' }));
  } else if (playable && dots) {
    node.append(el('span', { class: 'dot', 'aria-hidden': 'true' }));
  }

  // Preview toggles classes directly instead of re-rendering. A full rebuild
  // per pointermove would drop frames on any board bigger than 6x6.
  if (preview && playable) {
    const on = () => setPreview(node, flips, true);
    const off = () => setPreview(node, flips, false);
    node.addEventListener('pointerenter', on);
    node.addEventListener('pointerleave', off);
    node.addEventListener('focus', on);
    node.addEventListener('blur', off);
  }

  return node;
}

function setPreview(node, flips, on) {
  const grid = node.closest('.board');
  if (!grid) return;
  grid.classList.toggle('is-previewing', on);
  for (const target of flips) {
    const other = grid.querySelector(`[data-cell="${target}"]`);
    if (other) other.classList.toggle('will-flip', on);
  }
}

// Deliberately NOT gated on the legal-dots assist, even though the dots are.
//
// The dots are a shortcut: a sighted player who turns them off can still read
// legality straight off the board, because the rules are fully determined by
// the position in front of them. A screen-reader user has no equivalent —
// without this they would have to hold all 64 squares in their head and
// compute the flips themselves. So the label is the accessible substitute for
// LOOKING, not a second copy of the assist, and the host's toggle does not
// reach it. The two are not the same feature and should not share a switch.
function cellLabel(cell, size, value, playable, flips) {
  const name = cellName(cell, size);
  if (value === BLACK) return `${name}, black`;
  if (value === WHITE) return `${name}, white`;
  if (playable) {
    const n = flips.length;
    return `${name}, empty, legal move, turns ${n} ${n === 1 ? 'disc' : 'discs'}`;
  }
  return `${name}, empty`;
}

const ARROWS = {
  ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
};

function onBoardKey(event, size) {
  const step = ARROWS[event.key];
  if (!step) return;
  event.preventDefault();
  const from = cursor === null ? 0 : cursor;
  const row = Math.min(size - 1, Math.max(0, rowOf(from, size) + step[0]));
  const col = Math.min(size - 1, Math.max(0, colOf(from, size) + step[1]));
  const target = cellAt(row, col, size);
  if (target === from) return;
  cursor = target;
  const node = event.currentTarget.querySelector(`[data-cell="${target}"]`);
  if (node) node.focus({ preventScroll: true });
}

// --- Shared chrome ---------------------------------------------------------

function topBar(app, intents, label) {
  return el('div', { class: 'topbar' },
    el('button', {
      class: 'link-btn', type: 'button', 'data-focus': 'go-home',
      onClick: intents.goHome,
    }, '← Home'),
    el('span', { class: 'topbar-label' }, label),
  );
}

function notice(app, intents) {
  if (!app.notice) return null;
  return el('div', { class: 'notice', role: 'alert' },
    el('span', {}, app.notice),
    el('button', {
      class: 'link-btn', type: 'button', 'aria-label': 'Dismiss',
      onClick: intents.dismissNotice,
    }, 'Dismiss'),
  );
}

function moveLog(pub) {
  if (!pub.log.length) return null;
  return el('section', { class: 'log', 'data-keep-scroll': 'log' },
    el('h2', { class: 'sr-only' }, 'Move log'),
    el('ul', { class: 'log-list' },
      ...[...pub.log].reverse().map((entry) => el('li', { class: 'log-item' },
        entry.seat
          ? el('span', {
            class: 'disc disc-xs',
            'data-disc': entry.seat === BLACK ? 'black' : 'white',
            'aria-hidden': 'true',
          })
          : null,
        entry.text)),
    ),
  );
}
