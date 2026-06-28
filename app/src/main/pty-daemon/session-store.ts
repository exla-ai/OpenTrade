import type { IPty } from "node-pty";
import type { SessionInfo } from "./protocol";

// The ring buffer is the scrollback source of truth in the viewport model:
// only the focused agent's terminal is attached, and every attach (incl.
// reconnect/agent-switch) replays this buffer to repaint. 1 MiB ≈ a few full
// screens of dense output — enough to redraw, bounded for memory.
const DEFAULT_BUFFER_BYTES = 1024 * 1024;

/**
 * A consumer of a session's output + exit. Both transports register one:
 * unix-socket clients (the main process, for the status heuristic) and
 * WebSocket connections (the renderer's terminal). Sessions own their sinks so
 * fan-out doesn't care which transport a subscriber arrived on.
 */
export interface SessionSink {
  output(data: Buffer): void;
  exit(code: number | null, signal: number | null): void;
}

export interface Session {
  id: string;
  pty: IPty;
  /** Ring buffer of recent output for replay-on-attach (in-memory only). */
  buffer: Buffer[];
  bufferBytes: number;
  bufferCap: number;
  exited: boolean;
  exitCode: number | null;
  exitSignal: number | null;
  /** Live subscribers (unix-socket clients and WebSocket connections). */
  sinks: Set<SessionSink>;
}

/**
 * In-memory map of live sessions. Ring buffer is a byte-capped FIFO replayed on
 * attach so a reconnecting renderer can redraw the screen. Larger scrollback is
 * the renderer's xterm.js serialize-addon responsibility.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  add(id: string, pty: IPty, bufferCap = DEFAULT_BUFFER_BYTES): Session {
    const session: Session = {
      id,
      pty,
      buffer: [],
      bufferBytes: 0,
      bufferCap,
      exited: false,
      exitCode: null,
      exitSignal: null,
      sinks: new Set(),
    };
    this.sessions.set(id, session);
    return session;
  }

  /**
   * Atomically subscribe a sink and replay scrollback. Synchronous by design:
   * on the single-threaded event loop no pty `onData` can interleave between
   * the snapshot and joining `sinks`, so the replayed bytes and the first live
   * bytes never overlap or gap. Keep it await-free.
   */
  attachSink(session: Session, sink: SessionSink, replay: boolean): void {
    if (replay) {
      const snap = this.snapshot(session);
      if (snap.byteLength > 0) sink.output(snap);
    }
    session.sinks.add(sink);
    if (session.exited) sink.exit(session.exitCode, session.exitSignal);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  delete(id: string): boolean {
    return this.sessions.delete(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      pid: s.pty.pid,
      alive: !s.exited,
      exitCode: s.exitCode,
    }));
  }

  appendOutput(session: Session, chunk: Buffer): void {
    session.buffer.push(chunk);
    session.bufferBytes += chunk.byteLength;
    while (session.bufferBytes > session.bufferCap && session.buffer.length > 0) {
      const head = session.buffer.shift();
      if (head) session.bufferBytes -= head.byteLength;
    }
  }

  snapshot(session: Session): Buffer {
    return Buffer.concat(session.buffer);
  }
}
