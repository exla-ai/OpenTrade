import type { Account, OrderStatus, Portfolio, Position, Quote } from "@shared/broker";

/** MCP server entry the app writes into agents' .mcp.json. */
export interface McpServerConfig {
  type: "http";
  url: string;
}

/**
 * A trading execution + read backend. v1 implements Robinhood only, but the read
 * panel, poller, and faucet all speak this interface so a second broker (e.g.
 * Alpaca) slots in later.
 */
export interface BrokerAdapter {
  readonly id: string;
  /** Run the OAuth handshake (no-op if already authorized). */
  connect(): Promise<void>;
  isConnected(): boolean;
  listAccounts(): Promise<Account[]>;
  getPortfolio(accountNumber: string): Promise<Portfolio>;
  getPositions(accountNumber: string): Promise<Position[]>;
  /**
   * The agentic order ledger (orders this app's agents placed) — the source of
   * truth for execution status. `createdAtGte`/`cursor` bound + paginate it.
   */
  getAgenticOrders(
    accountNumber: string,
    opts?: { createdAtGte?: string; cursor?: string },
  ): Promise<{ orders: OrderStatus[]; cursor: string | null }>;
  /** Single-order lookup by id (resolves orders aged out of the ledger window). */
  getOrder(accountNumber: string, orderId: string): Promise<OrderStatus | null>;
  getQuotes(symbols: string[]): Promise<Quote[]>;
  /** Tool names that place/cancel orders — feeds the approval-gate hook matcher. */
  orderToolNames(): string[];
  /** What to write into an agent's .mcp.json. */
  mcpServerConfig(): { name: string; config: McpServerConfig };
}
