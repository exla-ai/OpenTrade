import type { Account, OrderStatus, Portfolio, Position, Quote } from "@shared/broker";

/**
 * Robinhood Agentic Trading MCP tool names (confirmed live, 2026-06-11) and
 * lenient response mappers. RH wraps results as
 *   { content: [{ type: "text", text: "<json>" }] }
 * and frequently returns numbers as strings, so we unwrap + coerce defensively.
 * Exact non-account field names are best-effort and refined after live testing.
 */
export const RH_TOOLS = {
  getAccounts: "get_accounts",
  getPortfolio: "get_portfolio",
  getEquityPositions: "get_equity_positions",
  getEquityOrders: "get_equity_orders",
  getEquityQuotes: "get_equity_quotes",
  placeEquityOrder: "place_equity_order",
  placeOptionOrder: "place_option_order",
  cancelEquityOrder: "cancel_equity_order",
  cancelOptionOrder: "cancel_option_order",
} as const;

export const RH_ORDER_TOOLS = [
  RH_TOOLS.placeEquityOrder,
  RH_TOOLS.placeOptionOrder,
  RH_TOOLS.cancelEquityOrder,
  RH_TOOLS.cancelOptionOrder,
];

type McpResult = { content?: Array<{ type: string; text?: string }> };

/** Unwrap the MCP text-content envelope into the inner JSON payload. */
export function unwrap(result: unknown): unknown {
  const r = result as McpResult;
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) if (rec[k] !== undefined) return rec[k] as T;
  return undefined;
}

function asArray(payload: unknown, ...keys: string[]): unknown[] {
  const data = (pick(payload, "data") ?? payload) as unknown;
  for (const k of keys) {
    const v = pick(data, k);
    if (Array.isArray(v)) return v;
  }
  if (Array.isArray(data)) return data;
  return [];
}

export function mapAccounts(payload: unknown): Account[] {
  return asArray(payload, "accounts").map((a) => ({
    accountNumber: String(pick(a, "account_number", "rhs_account_number") ?? ""),
    type: String(pick(a, "brokerage_account_type", "type") ?? ""),
    agentic: Boolean(pick(a, "agentic_allowed")),
    isDefault: Boolean(pick(a, "is_default")),
  }));
}

export function mapPortfolio(payload: unknown, accountNumber: string): Portfolio {
  const data = (pick(payload, "data") ?? payload) as unknown;
  // buying_power is a nested object ({ buying_power, unleveraged_buying_power, … }),
  // but tolerate a flat number too.
  const bp = pick(data, "buying_power", "buying_power_amount");
  const buyingPower =
    bp && typeof bp === "object"
      ? num(pick(bp, "buying_power", "unleveraged_buying_power"))
      : num(bp);
  return {
    accountNumber,
    // total_value = whole-account value (cash + holdings); equity_value = holdings only.
    equity: num(pick(data, "total_value", "equity", "total_equity")),
    marketValue: num(pick(data, "equity_value", "market_value", "portfolio_market_value")),
    buyingPower,
    cash: num(pick(data, "cash", "uninvested_cash", "cash_available")),
    // Day change isn't in get_portfolio — the poller derives it from quotes.
    dayChange: null,
    dayChangePct: null,
  };
}

export function mapPositions(payload: unknown): Position[] {
  return asArray(payload, "positions", "equity_positions").map((p) => {
    const qty = num(pick(p, "quantity", "shares")) ?? 0;
    const avg = num(pick(p, "average_cost", "average_buy_price", "avg_cost"));
    const last = num(pick(p, "last_price", "price", "mark_price"));
    const mv = num(pick(p, "market_value")) ?? (last !== null ? last * qty : null);
    const pnl = avg !== null && last !== null ? (last - avg) * qty : num(pick(p, "unrealized_pnl"));
    return {
      symbol: String(pick(p, "symbol", "ticker", "chain_symbol") ?? ""),
      quantity: qty,
      intradayQuantity: num(pick(p, "intraday_quantity")),
      averageCost: avg,
      lastPrice: last,
      marketValue: mv,
      unrealizedPnl: pnl,
    };
  });
}

/**
 * Map a `get_equity_orders` envelope into the authoritative OrderStatus[]. The
 * fill fields are taken exactly: `average_price` → avgPrice (VWAP),
 * `cumulative_quantity` → cumulativeQuantity (executed). `price` is the limit
 * price (null for market orders) and is kept as `limitPrice` only. `quantity` is
 * the *ordered* size. `dollar_based_amount` is a nested `{ amount }`.
 */
export function mapOrderStatuses(payload: unknown): OrderStatus[] {
  return asArray(payload, "orders", "equity_orders").map(mapOrderStatus);
}

export function mapOrderStatus(o: unknown): OrderStatus {
  const dollar = pick(o, "dollar_based_amount");
  return {
    id: String(pick(o, "id", "order_id") ?? ""),
    symbol: (pick(o, "symbol", "chain_symbol") as string) ?? null,
    side: (pick(o, "side", "direction") as string) ?? null,
    type: (pick(o, "type", "order_type") as string) ?? null,
    state: (pick(o, "state", "status") as string) ?? null,
    quantity: num(pick(o, "quantity", "shares")),
    cumulativeQuantity: num(pick(o, "cumulative_quantity", "filled_quantity")),
    avgPrice: num(pick(o, "average_price")),
    limitPrice: num(pick(o, "price", "limit_price")),
    fees: num(pick(o, "fees")),
    dollarAmount: dollar && typeof dollar === "object" ? num(pick(dollar, "amount")) : num(dollar),
    createdAt: (pick(o, "created_at") as string) ?? null,
    lastTransactionAt: (pick(o, "last_transaction_at", "updated_at") as string) ?? null,
  };
}

/**
 * Extract the pagination cursor from a `get_equity_orders` response, if any. RH
 * returns a `next` URL carrying a `cursor` query param; null when there's no
 * further page (the agentic list is small, so this is usually null).
 */
export function nextCursor(payload: unknown): string | null {
  const data = (pick(payload, "data") ?? payload) as unknown;
  const next = pick(data, "next", "next_url");
  if (typeof next !== "string" || !next) return null;
  try {
    return new URL(next).searchParams.get("cursor");
  } catch {
    const m = next.match(/[?&]cursor=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
}

export function mapQuotes(payload: unknown): Quote[] {
  // Each result pairs a live `quote` with the prior-session `close`; the quote
  // fields live one level down under `.quote`.
  return asArray(payload, "results", "quotes").map((r) => {
    const q = (pick(r, "quote") ?? r) as unknown;
    return {
      symbol: String(pick(q, "symbol", "ticker") ?? ""),
      last: num(
        pick(
          q,
          "last_trade_price",
          "last_non_reg_trade_price",
          "last_price",
          "price",
          "mark_price",
        ),
      ),
      previousClose: num(
        pick(q, "adjusted_previous_close", "previous_close", "last_session_close"),
      ),
      askPrice: num(pick(q, "ask_price", "ask")),
      bidPrice: num(pick(q, "bid_price", "bid")),
    };
  });
}
