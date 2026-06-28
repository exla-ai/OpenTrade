import type { SessionSink } from "./session-store";

// Coalesce PTY output into ~60fps frames to cap WebSocket sends regardless of
// how fast the PTY produces; xterm can't paint faster than a frame anyway. No
// StringDecoder — xterm's streaming Uint8Array decoder handles multi-byte
// codepoints split across batches.
const FLUSH_MS = 16;
const FLUSH_BYTES = 64 * 1024;
// Backpressure valve: a browser WebSocket can't be paused, so if the OS send
// buffer backs up past this the renderer can't keep up. Close the socket; it
// reconnects with replay and the ring snapshot replaces the skipped backlog
// (bounded recovery instead of unbounded memory growth).
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

/** The slice of the `ws` WebSocket API the batcher needs (so it's testable). */
export interface WsLike {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly OPEN: number;
  send(data: Buffer | string): void;
  close(code?: number, reason?: string): void;
}

export interface BatcherOptions {
  flushMs?: number;
  flushBytes?: number;
  maxBufferedBytes?: number;
  /** Close code used when the backpressure valve trips. */
  slowConsumerCode: number;
}

/** A batching SessionSink plus `dispose` to cancel a pending flush on close. */
export type BatchedWsSink = SessionSink & { dispose(): void };

/**
 * A SessionSink that batches output to a WebSocket and emits the exit control
 * frame. Output is binary; exit is a JSON text frame followed by a 1000 close.
 */
export function createBatchedWsSink(ws: WsLike, opts: BatcherOptions): BatchedWsSink {
  const flushMs = opts.flushMs ?? FLUSH_MS;
  const flushBytes = opts.flushBytes ?? FLUSH_BYTES;
  const maxBuffered = opts.maxBufferedBytes ?? MAX_BUFFERED_BYTES;

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    clearTimer();
    if (pendingBytes === 0) return;
    // Socket closed out from under us — drop the batch, don't throw on send.
    if (ws.readyState !== ws.OPEN) {
      pending = [];
      pendingBytes = 0;
      return;
    }
    if (ws.bufferedAmount > maxBuffered) {
      ws.close(opts.slowConsumerCode, "slow consumer");
      return;
    }
    const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    ws.send(buf);
  };

  return {
    output: (data) => {
      pending.push(data);
      pendingBytes += data.byteLength;
      if (pendingBytes >= flushBytes) flush();
      else if (!timer) timer = setTimeout(flush, flushMs);
    },
    exit: (code, signal) => {
      flush();
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "exit", code, signal }));
        ws.close(1000, "session exited");
      }
    },
    dispose: clearTimer,
  };
}
