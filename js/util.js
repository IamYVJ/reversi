// ============================================================================
// util.js — DOM helpers, identity, and localStorage.
//
// Every storage key is prefixed `reversi.` so this app cannot collide with the
// sibling games served from neighbouring paths on the same origin.
// ============================================================================

// --- DOM -------------------------------------------------------------------

// Tiny element builder. `on*` keys become listeners, `class`/`html`/`style`
// are special-cased, everything else becomes an attribute. `false`, `null` and
// `undefined` attribute values are dropped so `{ disabled: cond }` works.
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// --- Storage ---------------------------------------------------------------

const PREFIX = 'reversi.';
const CLIENT_KEY = `${PREFIX}clientId`;
const NAME_KEY = `${PREFIX}name`;
const ENGINE_KEY = `${PREFIX}engine`;
const SESSION_KEY = `${PREFIX}session`;
const LAST_CODE_KEY = `${PREFIX}lastCode`;

// A resumable session expires rather than lingering forever: a snapshot from
// last week is almost never what someone opening the page wants to see.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

// Private browsing and some enterprise policies make localStorage throw on
// ACCESS, not just on write, so every read goes through a try/catch and the
// app degrades to in-memory rather than failing to boot.
function read(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function write(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

function drop(key) {
  try { localStorage.removeItem(key); } catch (_) { /* nothing to do */ }
}

// --- Identity --------------------------------------------------------------

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
let volatileClientId = null;

function newClientId() {
  const bytes = new Uint8Array(16);   // 128 bits
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// This browser's permanent identity. Generated ONCE and never regenerated: it
// is the only thing a seat in a live game is bound to, so a fresh id is simply
// a different device as far as the host is concerned, and the original player
// is locked out of their own colour for the rest of the game.
//
// This is exactly why the "Clear cache & reload" button in index.html touches
// Cache Storage and service workers but never localStorage.
export function clientId() {
  const stored = read(CLIENT_KEY);
  if (stored && CLIENT_ID_RE.test(stored)) return stored;
  const fresh = newClientId();
  if (!write(CLIENT_KEY, fresh)) {
    // No storage at all. Hold one for this page load so at least a reconnect
    // within the session works; it will not survive a reload.
    if (!volatileClientId) volatileClientId = newClientId();
    return volatileClientId;
  }
  return fresh;
}

export function loadName() {
  return read(NAME_KEY) || '';
}

export function saveName(name) {
  if (name) write(NAME_KEY, String(name).slice(0, 20));
  else drop(NAME_KEY);
}

// --- Room codes ------------------------------------------------------------

// No O/0 or I/1: these get read aloud and typed in by hand.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 4;

export function generateRoomCode() {
  const buf = new Uint32Array(CODE_LENGTH);
  (globalThis.crypto || window.crypto).getRandomValues(buf);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(raw) {
  if (typeof raw !== 'string') return '';
  return [...raw.toUpperCase()].filter((ch) => CODE_ALPHABET.includes(ch)).join('').slice(0, CODE_LENGTH);
}

export function loadLastCode() {
  return normalizeCode(read(LAST_CODE_KEY) || '');
}

export function saveLastCode(code) {
  const clean = normalizeCode(code);
  if (clean.length === CODE_LENGTH) write(LAST_CODE_KEY, clean);
}

// --- Session and engine snapshots -----------------------------------------

// What this tab was doing, so a reload lands back in the same game instead of
// on the home screen.
export function saveSession(session) {
  write(SESSION_KEY, JSON.stringify({ ...session, at: Date.now() }));
}

export function loadSession() {
  const raw = read(SESSION_KEY);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Number.isFinite(parsed.at) || Date.now() - parsed.at > SESSION_TTL_MS) {
    clearSession();
    return null;
  }
  return parsed;
}

export function clearSession() {
  drop(SESSION_KEY);
  drop(ENGINE_KEY);
}

// The authoritative game state, written on every change by whichever tab is
// running the engine. In P2P this device holds the only copy in existence.
export function saveEngineSnapshot(snapshot) {
  write(ENGINE_KEY, JSON.stringify(snapshot));
}

export function loadEngineSnapshot() {
  const raw = read(ENGINE_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

// --- Misc ------------------------------------------------------------------

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to the legacy path */ }
  try {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.append(box);
    box.select();
    const done = document.execCommand('copy');
    box.remove();
    return done;
  } catch (_) {
    return false;
  }
}
