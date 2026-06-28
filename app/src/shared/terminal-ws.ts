// The terminal WebSocket contract: the wire shape between an xterm.js renderer
// and whatever process owns the PTY. Today that owner is the local pty-daemon;
// the SAME contract is what a future cloud terminal host implements, so the
// renderer transport stays identical for local and remote agents.
//
// Data plane:
//   server -> client : BINARY frames = raw PTY output bytes (replay snapshot
//                       first, then live output). Fed straight into
//                       xterm.write(Uint8Array) — no decode hop.
//   client -> server : TEXT frames = JSON (TermWsClientMsg). xterm's onData
//                       already emits complete UTF-8 strings.
//   server -> client : TEXT frames = JSON (TermWsServerMsg) for control (hello,
//                       exit). Binary vs text is the channel discriminator.
//
// A WebSocket close means DETACH, never kill — the PTY outlives the socket.

export const TERMINAL_WS_PROTOCOL = 1;

/** Client -> server control messages (JSON text frames). */
export type TermWsClientMsg =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Server -> client control messages (JSON text frames; output is binary). */
export type TermWsServerMsg =
  | { type: "hello"; protocol: number }
  | { type: "exit"; code: number | null; signal: number | null };

/**
 * Application close codes (4000-4999 = private use per RFC 6455). 1000 is the
 * normal close sent right after an `exit` control frame.
 */
export const TERM_WS_CLOSE = {
  /** Session id not found on the host (e.g. daemon restarted, session gone). */
  NOT_FOUND: 4404,
  /** Backpressure valve tripped: consumer too slow, buffered output too large. */
  SLOW_CONSUMER: 4408,
} as const;
