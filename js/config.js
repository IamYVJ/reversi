// ============================================================================
// config.js — Server seams. DELIBERATELY BLANK.
//
// v1 of this game is peer-to-peer only. There is no backend, and these three
// exports are empty strings and a `false`.
//
// So why does the file exist at all? Because the sibling projects in this
// family added server support LATER, and retrofitting the question "is there a
// server?" into code that had never asked it forced real rework: every call
// site had to learn the difference between routing an intent locally and
// sending it over a socket, and between the tab that runs the engine and the
// player who holds the room's controls.
//
// Shipping the seam blank from day one costs one branch that is currently
// always false. Filling it in later is then a matter of setting SERVER_URL and
// writing the transport, with no call site needing to change shape.
//
// To ENABLE server mode later: set both constants. serverConfigured() gates
// every consumer, so nothing else needs a flag.
// ============================================================================

export const SERVER_URL = '';
export const SERVER_HEALTH = '';

export function serverConfigured() {
  return !!(SERVER_URL && SERVER_HEALTH);
}

// A cold TLS handshake to a sleeping host measured around 4.6 seconds in this
// family of projects, against 0.8-1.2s once warm. A 4-second budget therefore
// failed the FIRST request of every session and reported a perfectly healthy
// server as down. Ten seconds plus one retry is the setting that stopped it.
//
// Unused while serverConfigured() is false, and kept here so the number and
// its reasoning survive until the transport that needs them is written.
export const HEALTH_TIMEOUT_MS = 10000;
export const HEALTH_RETRIES = 1;
