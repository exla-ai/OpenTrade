import type {
  Account,
  BrokerConnectionStatus,
  OrderStatus,
  Portfolio,
  Position,
  Quote,
} from "@shared/broker";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { brokerCache } from "../../db/schema";
import { bus } from "../event-bus";
import type { SettingsService } from "../settings";
import type { BrokerAdapter } from "./adapter";

/**
 * The order ledger is kept *complete* via two tiers: a full history sweep that
 * rebuilds the whole map (at startup and once a day), plus a cheap recent window
 * fetched every poll to keep in-flight orders live. A complete ledger is what lets
 * the UI treat "no matching order" as a definitive non-execution rather than gray.
 */
const LEDGER_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const FULL_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Robinhood's MCP rate limits are generous, so we poll often for a near-live
// panel. The cadence (focused-during-market-hours vs otherwise) is user-tunable
// in Settings; see SettingsService.pollInterval{Focused,Blurred}Ms.

/** True during NY regular + extended hours on a weekday (holidays not handled). */
function marketActive(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return minutes >= 4 * 60 && minutes < 20 * 60; // 4:00–20:00 ET
}

/**
 * Owns the app's own read-only broker connection. Runs a single poller that
 * keeps a pull-through cache warm (Portfolio panel) and serves agents'
 * market-data faucet. The cache is freshness-tracked so faucet reads with a
 * maxAge can trigger an immediate live refetch.
 */
export class BrokerService {
  private status: BrokerConnectionStatus = "disconnected";
  private account: Account | null = null;
  private timer: NodeJS.Timeout | null = null;
  // Default to blurred: the host runs headless (often with no GUI), so it should
  // poll at the slower cadence until a connected GUI reports focus (see the
  // launcher's relay → broker.setFocused). Avoids hammering RH with the app closed.
  private focused = false;
  /** Guards against overlapping polls when a poll outlasts the poll interval. */
  private polling = false;
  /** Canonical order ledger, merged across full sweeps + recent polls, keyed by id. */
  private ledger = new Map<string, OrderStatus>();
  /** When the last full-history sweep ran; 0 forces a sweep on the next poll. */
  private lastFullSweepAt = 0;

  constructor(
    private db: Db,
    private adapter: BrokerAdapter,
    private settings: SettingsService,
  ) {
    // Re-apply the poll cadence live when the user changes it in Settings.
    bus.onEvent("settings:changed", () => {
      if (this.timer) this.startPolling();
    });
  }

  getStatus(): BrokerConnectionStatus {
    return this.status;
  }

  getAccount(): Account | null {
    return this.account;
  }

  orderToolNames(): string[] {
    return this.adapter.orderToolNames();
  }

  mcpServerConfig() {
    return this.adapter.mcpServerConfig();
  }

  private setStatus(status: BrokerConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    bus.emitEvent("broker:status", { status });
  }

  /** Connect (running OAuth consent if needed) and start polling. */
  async connect(): Promise<void> {
    if (this.status === "connected") return;
    this.setStatus("connecting");
    try {
      await this.adapter.connect();
      const accounts = await this.adapter.listAccounts();
      this.account = pickAccount(accounts);
      this.setStatus("connected");
      await this.pollOnce();
      this.startPolling();
    } catch (err) {
      this.setStatus("error");
      throw err;
    }
  }

  /** True if we already have tokens and can connect without a browser. */
  isAuthorized(): boolean {
    return "hasTokens" in this.adapter
      ? (this.adapter as { hasTokens(): boolean }).hasTokens()
      : false;
  }

  setFocused(focused: boolean) {
    if (this.focused === focused) return;
    this.focused = focused;
    if (this.timer) this.startPolling();
  }

  private startPolling() {
    if (this.timer) clearInterval(this.timer);
    const interval =
      this.focused && marketActive()
        ? this.settings.pollIntervalFocusedMs
        : this.settings.pollIntervalBlurredMs;
    this.timer = setInterval(() => void this.pollOnce(), interval);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- pull-through cache ----

  private writeCache(key: string, payload: unknown) {
    this.db
      .insert(brokerCache)
      .values({ key, payload: JSON.stringify(payload), fetchedAt: Date.now() })
      .onConflictDoUpdate({
        target: brokerCache.key,
        set: { payload: JSON.stringify(payload), fetchedAt: Date.now() },
      })
      .run();
  }

  private readCache<T>(key: string): { value: T; fetchedAt: number } | null {
    const row = this.db.select().from(brokerCache).where(eq(brokerCache.key, key)).get();
    if (!row) return null;
    try {
      return { value: JSON.parse(row.payload) as T, fetchedAt: row.fetchedAt };
    } catch {
      return null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.account || this.polling) return;
    this.polling = true;
    const acct = this.account.accountNumber;
    const updated: string[] = [];
    try {
      const portfolio = await this.adapter.getPortfolio(acct);

      // Positions carry no price (RH: "call get_equity_quotes and multiply"), so
      // fetch quotes for the held symbols and fold last/marketValue/PnL into them
      // before caching — the Portfolio table and faucet read the enriched rows.
      const positions = await this.adapter.getPositions(acct);
      const symbols = positions.map((p) => p.symbol).filter(Boolean);
      let quotes: Quote[] = [];
      if (symbols.length > 0) {
        quotes = await this.adapter.getQuotes(symbols);
        for (const q of quotes) this.writeCache(`quote:${q.symbol}`, q);
        updated.push(...quotes.map((q) => `quote:${q.symbol}`));
      }
      const quoteBySymbol = new Map(quotes.map((q) => [q.symbol, q]));
      const enriched = positions.map((p) => enrichPosition(p, quoteBySymbol.get(p.symbol)));
      this.writeCache("positions", enriched);
      updated.push("positions");

      // Today's account move: derived here because get_portfolio doesn't carry it.
      this.writeCache("portfolio", withDayChange(portfolio, positions, quoteBySymbol));
      updated.push("portfolio");

      await this.syncLedger(acct);
      this.writeCache("agentic_orders", [...this.ledger.values()]);
      updated.push("agentic_orders");

      bus.emitEvent("broker:updated", { keys: updated });
    } catch (err) {
      console.error("[broker] poll failed", err);
    } finally {
      this.polling = false;
    }
  }

  // ---- reads (cache-first) ----

  getCachedPortfolio(): { value: Portfolio; fetchedAt: number } | null {
    return this.readCache<Portfolio>("portfolio");
  }
  getCachedPositions(): { value: Position[]; fetchedAt: number } | null {
    return this.readCache<Position[]>("positions");
  }
  getAgenticOrdersCached(): { value: OrderStatus[]; fetchedAt: number } | null {
    return this.readCache<OrderStatus[]>("agentic_orders");
  }

  /** Single-order lookup by id (resolves orders aged out of the poll window). */
  async getOrder(orderId: string): Promise<OrderStatus | null> {
    if (!this.account) return null;
    return this.adapter.getOrder(this.account.accountNumber, orderId);
  }

  /**
   * Force a full-history sweep now, write the cache, and notify the GUI. Backs the
   * Activity "refresh" button — resolves only once the whole ledger is rebuilt, so
   * the button can spin until it returns.
   */
  async refreshOrders(): Promise<void> {
    if (!this.account) return;
    const acct = this.account.accountNumber;
    await this.fullSweep(acct);
    this.writeCache("agentic_orders", [...this.ledger.values()]);
    bus.emitEvent("broker:updated", { keys: ["agentic_orders"] });
  }

  /**
   * Keep the in-memory ledger complete. Every poll fetches the recent window
   * (cheap) and upserts it so in-flight orders stay live; once a day (and at
   * startup, since `lastFullSweepAt` begins at 0) it also rebuilds the whole map
   * from a full-history sweep so aged-out orders never silently disappear.
   */
  private async syncLedger(account: string): Promise<void> {
    if (Date.now() - this.lastFullSweepAt >= FULL_SWEEP_INTERVAL_MS) {
      await this.fullSweep(account);
    }
    const since = new Date(Date.now() - LEDGER_RECENT_WINDOW_MS).toISOString();
    for (const o of await this.fetchHistory(account, { createdAtGte: since })) {
      this.ledger.set(o.id, o); // recent wins: freshest state for in-flight orders
    }
  }

  /** Rebuild the ledger from the account's entire order history. */
  private async fullSweep(account: string): Promise<void> {
    const all = await this.fetchHistory(account, {});
    this.ledger = new Map(all.map((o) => [o.id, o]));
    this.lastFullSweepAt = Date.now();
  }

  /**
   * Page through the account's order history via the pagination cursor. With no
   * `createdAtGte` this walks the *entire* history (higher page cap); with one it
   * fetches just that recent window. RH's list for this account is small, so even
   * a full sweep is a handful of calls; the page guard caps it defensively.
   */
  private async fetchHistory(
    account: string,
    opts: { createdAtGte?: string },
  ): Promise<OrderStatus[]> {
    const maxPages = opts.createdAtGte ? 20 : 100;
    const all: OrderStatus[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const { orders, cursor: next } = await this.adapter.getAgenticOrders(account, {
        createdAtGte: opts.createdAtGte,
        cursor,
      });
      all.push(...orders);
      if (!next) break;
      cursor = next;
    }
    return all;
  }

  /** Faucet: return cached quote if fresher than maxAgeMs, else fetch live. */
  async getQuote(symbol: string, maxAgeMs: number): Promise<Quote | null> {
    const cached = this.readCache<Quote>(`quote:${symbol}`);
    if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) return cached.value;
    if (this.status !== "connected") return cached?.value ?? null;
    const [quote] = await this.adapter.getQuotes([symbol]);
    if (quote) {
      this.writeCache(`quote:${symbol}`, quote);
      bus.emitEvent("broker:updated", { keys: [`quote:${symbol}`] });
    }
    return quote ?? cached?.value ?? null;
  }

  async getPositionsLive(maxAgeMs: number): Promise<Position[]> {
    const cached = this.readCache<Position[]>("positions");
    if (cached && Date.now() - cached.fetchedAt <= maxAgeMs) return cached.value;
    if (this.status === "connected") await this.pollOnce();
    return this.readCache<Position[]>("positions")?.value ?? cached?.value ?? [];
  }
}

/** Prefer the funded agentic sub-account; fall back to default, then first. */
function pickAccount(accounts: Account[]): Account | null {
  return (
    accounts.find((a) => a.agentic) ?? accounts.find((a) => a.isDefault) ?? accounts[0] ?? null
  );
}

/** Fold a symbol's live quote into its position (last price, market value, PnL). */
function enrichPosition(p: Position, quote: Quote | undefined): Position {
  const last = quote?.last ?? p.lastPrice;
  if (last === null || last === undefined) return p;
  return {
    ...p,
    lastPrice: last,
    marketValue: last * p.quantity,
    unrealizedPnl: p.averageCost !== null ? (last - p.averageCost) * p.quantity : p.unrealizedPnl,
  };
}

/**
 * Derive today's account $/% move and attach it to the portfolio. Robinhood
 * doesn't return a daily figure, so we sum each position's intraday-aware change
 * (RH's own method): shares held since yesterday move from previous_close; shares
 * bought today move from their cost basis. % is against the prior account value
 * (total − today's change). Positions without a usable quote are skipped.
 */
export function withDayChange(
  portfolio: Portfolio,
  positions: Position[],
  quotes: Map<string, Quote>,
): Portfolio {
  let dayChange = 0;
  let counted = 0;
  for (const p of positions) {
    const q = quotes.get(p.symbol);
    if (!q || q.last === null || q.previousClose === null) continue;
    const intraday = p.intradayQuantity ?? 0;
    const overnight = p.quantity - intraday;
    const costToday = p.averageCost ?? q.last; // best available basis for today's shares
    dayChange += (q.last - q.previousClose) * overnight + (q.last - costToday) * intraday;
    counted++;
  }
  if (counted === 0) return { ...portfolio, dayChange: null, dayChangePct: null };

  const prior = portfolio.equity !== null ? portfolio.equity - dayChange : null;
  const dayChangePct = prior !== null && prior > 0 ? dayChange / prior : null;
  return { ...portfolio, dayChange, dayChangePct };
}
