import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { TERM_WS_CLOSE, TERMINAL_WS_PROTOCOL, type TermWsClientMsg } from "@shared/terminal-ws";
import { type WebSocket, WebSocketServer } from "ws";
import { createBatchedWsSink } from "./output-batcher";
import type { SessionStore } from "./session-store";
import { parseTerminalWsUrl } from "./ws-url";

/**
 * WebSocket data plane: PTY output streamed directly to the renderer's xterm,
 * bypassing the main process. Shares the session store with DaemonServer, so
 * sinks registered here receive output from the same pty.onData fan-out.
 *
 * The connection handler is fully synchronous (token check happens earlier, in
 * the upgrade handler) so attach-with-replay stays atomic on the event loop.
 */
export class TerminalWsServer {
  readonly token: string;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private _port = 0;

  /** `token` shares the host's bearer token; omit (→ random) for standalone use. */
  constructor(
    private store: SessionStore,
    token?: string,
  ) {
    this.token = token ?? randomBytes(24).toString("hex");
  }

  get port(): number {
    return this._port;
  }

  listen(): Promise<void> {
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true });
    this.http = http;
    this.wss = wss;

    http.on("upgrade", (req, socket, head) => {
      const parsed = parseTerminalWsUrl(req.url);
      if (!parsed || !this.tokenValid(parsed.token)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        this.onConnection(ws, parsed.id, parsed.replay);
      });
    });

    return new Promise((resolve) => {
      http.listen(0, "127.0.0.1", () => {
        const addr = http.address();
        if (addr && typeof addr === "object") this._port = addr.port;
        resolve();
      });
    });
  }

  private tokenValid(provided: string): boolean {
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private onConnection(ws: WebSocket, id: string, replay: boolean) {
    const session = this.store.get(id);
    if (!session) {
      ws.close(TERM_WS_CLOSE.NOT_FOUND, "session not found");
      return;
    }

    // Control hello (text) precedes any binary output frame.
    ws.send(JSON.stringify({ type: "hello", protocol: TERMINAL_WS_PROTOCOL }));

    const sink = createBatchedWsSink(ws, { slowConsumerCode: TERM_WS_CLOSE.SLOW_CONSUMER });
    this.store.attachSink(session, sink, replay);

    ws.on("message", (raw) => {
      let msg: TermWsClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const s = this.store.get(id);
      if (!s || s.exited) return;
      if (msg.type === "input") {
        s.pty.write(msg.data);
      } else if (msg.type === "resize") {
        try {
          s.pty.resize(msg.cols, msg.rows);
        } catch {
          // pty may have just exited
        }
      }
    });

    const cleanup = () => {
      sink.dispose();
      session.sinks.delete(sink);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  }

  close(): void {
    this.wss?.close();
    this.http?.close();
  }
}
