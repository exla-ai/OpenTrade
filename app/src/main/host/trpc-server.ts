import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TRPCError } from "@trpc/server";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import superjson from "superjson";
import { WebSocketServer } from "ws";
import { guiPresence, isRelayConnection } from "../services/gui-presence";
import { appRouter } from "../trpc/routers";
import type { Context } from "../trpc/trpc";

/**
 * Serves the app's tRPC router to the GUI over localhost HTTP (queries/mutations,
 * via httpBatchLink) and WebSocket (subscriptions, via wsLink) — replacing the
 * in-process trpc-electron IPC bridge now that the services live in the detached
 * backend. Bound to 127.0.0.1 on an ephemeral port (discovered via the manifest);
 * authorized by the shared host token (HTTP header / WS url query).
 */
export class HostTrpcServer {
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private _port = 0;

  constructor(
    private ctx: Context,
    private token: string,
  ) {}

  get port(): number {
    return this._port;
  }

  listen(): Promise<void> {
    const handler = createHTTPHandler({
      router: appRouter,
      createContext: ({ req }) => {
        this.assertToken(headerToken(req));
        return this.ctx;
      },
    });

    const http = createServer((req, res) => {
      setCors(res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      handler(req, res);
    });
    this.http = http;

    const wss = new WebSocketServer({ server: http });
    this.wss = wss;
    // GUI-presence detection (§12.2 / R2.2): every renderer holds a subscription WS
    // for its whole lifetime, so counting non-relay connections tracks whether a GUI
    // is watching. The launcher relay tags its URL `&client=relay` and is excluded.
    wss.on("connection", (ws, req) => {
      if (isRelayConnection(req.url)) return;
      guiPresence.add(ws);
      ws.once("close", () => guiPresence.remove(ws));
    });
    applyWSSHandler({
      wss,
      router: appRouter,
      createContext: ({ req }) => {
        this.assertToken(urlToken(req.url));
        return this.ctx;
      },
    });

    return new Promise((resolve) => {
      http.listen(0, "127.0.0.1", () => {
        const addr = http.address();
        if (addr && typeof addr === "object") this._port = addr.port;
        resolve();
      });
    });
  }

  private assertToken(provided: string | undefined): void {
    if (!provided || !tokensEqual(provided, this.token)) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
  }

  close(): void {
    this.wss?.close();
    this.http?.close();
  }
}

/** The superjson transformer the GUI client must mirror (httpBatchLink/wsLink). */
export const trpcTransformer = superjson;

function headerToken(req: IncomingMessage): string | undefined {
  const v = req.headers["x-opentrade-token"];
  return typeof v === "string" ? v : undefined;
}

function urlToken(reqUrl: string | undefined): string | undefined {
  if (!reqUrl) return undefined;
  try {
    return new URL(reqUrl, "http://localhost").searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

function tokensEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-opentrade-token");
}
