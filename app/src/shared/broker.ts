import { z } from "zod";

export const Account = z.object({
  accountNumber: z.string(),
  type: z.string(),
  agentic: z.boolean(),
  isDefault: z.boolean(),
});
export type Account = z.infer<typeof Account>;

export const Portfolio = z.object({
  accountNumber: z.string(),
  equity: z.number().nullable(),
  marketValue: z.number().nullable(),
  buyingPower: z.number().nullable(),
  cash: z.number().nullable(),
  /** Today's account $ move (Σ per-position intraday-aware change); null if unknown. */
  dayChange: z.number().nullable(),
  /** Today's move as a fraction of the prior account value (e.g. 0.0072 = +0.72%). */
  dayChangePct: z.number().nullable(),
});
export type Portfolio = z.infer<typeof Portfolio>;

export const Position = z.object({
  symbol: z.string(),
  quantity: z.number(),
  /** Shares acquired today (drives the intraday-aware day-change split). */
  intradayQuantity: z.number().nullable(),
  averageCost: z.number().nullable(),
  lastPrice: z.number().nullable(),
  marketValue: z.number().nullable(),
  unrealizedPnl: z.number().nullable(),
});
export type Position = z.infer<typeof Position>;

/**
 * The broker's authoritative view of an order's execution, read from
 * `get_equity_orders` (the agentic ledger). This is the source of truth for the
 * Activity dot — never inferred from our own events. `state` is RH's own status
 * (`filled` / `partially_filled` / `queued` / `cancelled` / `rejected` / …).
 *
 * Fill fields are exact: `avgPrice` is the VWAP (`average_price`) and
 * `cumulativeQuantity` the executed shares (`cumulative_quantity`) — distinct
 * from the *ordered* `quantity` and the limit `limitPrice` (`price`, null for
 * market orders), which is what the old mapper wrongly used.
 */
export const OrderStatus = z.object({
  id: z.string(),
  symbol: z.string().nullable(),
  side: z.string().nullable(),
  /** "market" | "limit" | … (RH `type`). */
  type: z.string().nullable(),
  /** RH lifecycle state, verbatim. */
  state: z.string().nullable(),
  /** Ordered quantity (shares). Null for some dollar-based orders until filled. */
  quantity: z.number().nullable(),
  /** Executed shares so far (drives partial-fill display). */
  cumulativeQuantity: z.number().nullable(),
  /** Volume-weighted average fill price; null until something executes. */
  avgPrice: z.number().nullable(),
  /** Limit price for limit orders; null for market orders. */
  limitPrice: z.number().nullable(),
  fees: z.number().nullable(),
  /** Notional for a dollar-based order ($ amount), else null. */
  dollarAmount: z.number().nullable(),
  createdAt: z.string().nullable(),
  lastTransactionAt: z.string().nullable(),
});
export type OrderStatus = z.infer<typeof OrderStatus>;

export const Quote = z.object({
  symbol: z.string(),
  last: z.number().nullable(),
  previousClose: z.number().nullable(),
  askPrice: z.number().nullable(),
  bidPrice: z.number().nullable(),
});
export type Quote = z.infer<typeof Quote>;

export const BrokerConnectionStatus = z.enum(["disconnected", "connecting", "connected", "error"]);
export type BrokerConnectionStatus = z.infer<typeof BrokerConnectionStatus>;
