import { createServer, type Server } from "node:http";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Account, OrderStatus, Portfolio, Position, Quote } from "@shared/broker";
import type { Db } from "../../../db/client";
import type { BrokerAdapter, McpServerConfig } from "../adapter";
import {
  mapAccounts,
  mapOrderStatuses,
  mapPortfolio,
  mapPositions,
  mapQuotes,
  nextCursor,
  RH_ORDER_TOOLS,
  RH_TOOLS,
  unwrap,
} from "./mapping";
import { BrokerOAuthProvider } from "./oauth";

const SERVER_URL = "https://agent.robinhood.com/mcp/trading";
const CALLBACK_PORT = 8771;
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export interface RobinhoodAdapterOptions {
  db: Db;
  openBrowser: (url: string) => void;
}

export class RobinhoodAdapter implements BrokerAdapter {
  readonly id = "robinhood";
  private provider: BrokerOAuthProvider;
  private client: Client | null = null;

  constructor(opts: RobinhoodAdapterOptions) {
    this.provider = new BrokerOAuthProvider({
      db: opts.db,
      redirectUrl: REDIRECT_URL,
      openBrowser: opts.openBrowser,
    });
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  hasTokens(): boolean {
    return this.provider.hasTokens();
  }

  reset() {
    this.provider.reset();
    this.client = null;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    // Cached tokens (or a refreshable session) connect with no browser.
    if (this.provider.hasTokens()) {
      try {
        await this.doConnect();
        return;
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
        // refresh failed → fall through to interactive consent
      }
    }
    await this.interactiveConnect();
  }

  private async doConnect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
      // biome-ignore lint/suspicious/noExplicitAny: provider matches SDK's structural OAuthClientProvider
      authProvider: this.provider as any,
    });
    const client = new Client({ name: "opentrade", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
  }

  private async interactiveConnect(): Promise<void> {
    const { server, codePromise } = this.startLoopback();
    try {
      try {
        await this.doConnect();
        return;
      } catch (err) {
        if (!(err instanceof UnauthorizedError)) throw err;
      }
      const code = await codePromise;
      const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
        // biome-ignore lint/suspicious/noExplicitAny: structural provider
        authProvider: this.provider as any,
      });
      await transport.finishAuth(code);
      await this.doConnect();
    } finally {
      server.close();
    }
  }

  private startLoopback(): { server: Server; codePromise: Promise<string> } {
    let resolve!: (code: string) => void;
    let reject!: (err: Error) => void;
    const codePromise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URL);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font-family:-apple-system,sans-serif;padding:3rem;background:#1c1c1c;color:#fafafa">` +
          `<h2>${code ? "OpenTrade connected ✓" : "Authorization failed"}</h2>` +
          `<p>You can close this tab and return to OpenTrade.</p></body></html>`,
      );
      if (code) resolve(code);
      else reject(new Error(`oauth error: ${error ?? "unknown"}`));
    });
    server.on("error", (err) => reject(err));
    server.listen(CALLBACK_PORT, "127.0.0.1");
    return { server, codePromise };
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.client) throw new Error("broker not connected");
    const result = await this.client.callTool({ name, arguments: args });
    return unwrap(result);
  }

  async listAccounts(): Promise<Account[]> {
    return mapAccounts(await this.call(RH_TOOLS.getAccounts));
  }

  async getPortfolio(accountNumber: string): Promise<Portfolio> {
    return mapPortfolio(
      await this.call(RH_TOOLS.getPortfolio, { account_number: accountNumber }),
      accountNumber,
    );
  }

  async getPositions(accountNumber: string): Promise<Position[]> {
    return mapPositions(
      await this.call(RH_TOOLS.getEquityPositions, { account_number: accountNumber }),
    );
  }

  async getAgenticOrders(
    accountNumber: string,
    opts: { createdAtGte?: string; cursor?: string } = {},
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }> {
    // No `placed_agent` filter: we want *every* order on the agentic account,
    // including ones placed manually in the RH app, so Activity can show them all.
    const args: Record<string, unknown> = {
      account_number: accountNumber,
    };
    if (opts.createdAtGte) args.created_at_gte = opts.createdAtGte;
    if (opts.cursor) args.cursor = opts.cursor;
    const payload = await this.call(RH_TOOLS.getEquityOrders, args);
    return { orders: mapOrderStatuses(payload), cursor: nextCursor(payload) };
  }

  async getOrder(accountNumber: string, orderId: string): Promise<OrderStatus | null> {
    const payload = await this.call(RH_TOOLS.getEquityOrders, {
      account_number: accountNumber,
      order_id: orderId,
    });
    return mapOrderStatuses(payload)[0] ?? null;
  }

  async getQuotes(symbols: string[]): Promise<Quote[]> {
    if (symbols.length === 0) return [];
    return mapQuotes(await this.call(RH_TOOLS.getEquityQuotes, { symbols }));
  }

  orderToolNames(): string[] {
    return RH_ORDER_TOOLS;
  }

  mcpServerConfig(): { name: string; config: McpServerConfig } {
    return { name: "robinhood", config: { type: "http", url: SERVER_URL } };
  }
}
