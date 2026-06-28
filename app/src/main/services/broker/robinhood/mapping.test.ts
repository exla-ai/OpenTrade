import { describe, expect, test } from "bun:test";
import {
  mapAccounts,
  mapOrderStatuses,
  mapPortfolio,
  mapPositions,
  mapQuotes,
  nextCursor,
  unwrap,
} from "./mapping";

// Real envelope shape observed from the live Robinhood MCP (get_accounts).
const accountsEnvelope = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        data: {
          accounts: [
            {
              account_number: "991422569",
              rhs_account_number: "991422569",
              type: "margin",
              brokerage_account_type: "individual",
              is_default: true,
              agentic_allowed: false,
              state: "active",
            },
            {
              account_number: "AGENT123",
              brokerage_account_type: "individual",
              is_default: false,
              agentic_allowed: true,
              state: "active",
            },
          ],
        },
      }),
    },
  ],
};

describe("unwrap", () => {
  test("extracts inner JSON from the MCP text envelope", () => {
    const payload = unwrap(accountsEnvelope) as { data: { accounts: unknown[] } };
    expect(payload.data.accounts).toHaveLength(2);
  });

  test("passes through non-enveloped values", () => {
    expect(unwrap({ foo: 1 })).toEqual({ foo: 1 });
  });
});

describe("mapAccounts", () => {
  test("maps the real account shape and flags the agentic account", () => {
    const accounts = mapAccounts(unwrap(accountsEnvelope));
    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toEqual({
      accountNumber: "991422569",
      type: "individual",
      agentic: false,
      isDefault: true,
    });
    expect(accounts.find((a) => a.agentic)?.accountNumber).toBe("AGENT123");
  });
});

describe("mapPortfolio", () => {
  // Real shape observed live (get_portfolio): total_value/equity_value, nested
  // buying_power, string numbers.
  test("maps account total vs holdings value and the nested buying power", () => {
    const portfolio = mapPortfolio(
      {
        data: {
          total_value: "1999.99",
          equity_value: "125.39",
          cash: "1874.6",
          buying_power: { buying_power: "1874.6000", unleveraged_buying_power: "1874.6000" },
        },
      },
      "547526228",
    );
    expect(portfolio).toEqual({
      accountNumber: "547526228",
      equity: 1999.99,
      marketValue: 125.39,
      buyingPower: 1874.6,
      cash: 1874.6,
      dayChange: null,
      dayChangePct: null,
    });
  });
});

describe("mapPositions", () => {
  test("coerces string numbers and derives market value + pnl when price is present", () => {
    const positions = mapPositions({
      data: {
        positions: [{ symbol: "AAPL", quantity: "10", average_cost: "100", last_price: "110" }],
      },
    });
    expect(positions[0]).toMatchObject({
      symbol: "AAPL",
      quantity: 10,
      averageCost: 100,
      lastPrice: 110,
      marketValue: 1100,
      unrealizedPnl: 100,
    });
  });

  test("real shape has no price — averageCost from average_buy_price, lastPrice null", () => {
    const positions = mapPositions({
      data: {
        positions: [
          {
            symbol: "INTC",
            quantity: "1.000000",
            intraday_quantity: "1.000000",
            average_buy_price: "125.400000",
            type: "long",
          },
        ],
      },
    });
    expect(positions[0]).toMatchObject({
      symbol: "INTC",
      quantity: 1,
      intradayQuantity: 1,
      averageCost: 125.4,
      lastPrice: null,
      unrealizedPnl: null,
    });
  });
});

describe("mapOrderStatuses", () => {
  // Real shapes from live get_equity_orders (placed_agent=agentic).
  const filledMarket = {
    id: "6a3059a5-ed0b-4726-be61-0b40c0710cc0",
    symbol: "GDX",
    side: "buy",
    type: "market",
    state: "filled",
    quantity: "0.880592",
    cumulative_quantity: "0.880592",
    price: "85.180000",
    average_price: "85.169900",
    fees: "0.000000",
    dollar_based_amount: { amount: "75.000000", currency_code: "USD" },
    created_at: "2026-06-15T19:59:33.173739Z",
    last_transaction_at: "2026-06-15T19:59:33.38Z",
  };
  const filledLimit = {
    id: "6a2c9cb7-a947-4f2d-8771-00c5f3f68b6f",
    symbol: "INTC",
    side: "buy",
    type: "limit",
    state: "filled",
    quantity: "1.000000",
    cumulative_quantity: "1.000000",
    price: "125.500000",
    average_price: "125.400000",
    dollar_based_amount: null,
    created_at: "2026-06-12T23:56:39.475706Z",
    last_transaction_at: "2026-06-12T23:56:39.678Z",
  };

  test("takes avg_price as VWAP and cumulative_quantity as executed — NOT limit/ordered", () => {
    const [o] = mapOrderStatuses({ data: { orders: [filledLimit] } });
    expect(o).toEqual({
      id: "6a2c9cb7-a947-4f2d-8771-00c5f3f68b6f",
      symbol: "INTC",
      side: "buy",
      type: "limit",
      state: "filled",
      quantity: 1,
      cumulativeQuantity: 1,
      avgPrice: 125.4, // average_price, the fill — not the 125.50 limit
      limitPrice: 125.5, // price = the limit, kept separately
      fees: null,
      dollarAmount: null,
      createdAt: "2026-06-12T23:56:39.475706Z",
      lastTransactionAt: "2026-06-12T23:56:39.678Z",
    });
  });

  test("market order: price is null (no limit), dollar amount unwrapped from the nested object", () => {
    const [o] = mapOrderStatuses({ data: { orders: [filledMarket] } });
    expect(o).toMatchObject({
      symbol: "GDX",
      type: "market",
      limitPrice: 85.18, // RH puts the reference price here for market orders
      avgPrice: 85.1699,
      cumulativeQuantity: 0.880592,
      dollarAmount: 75,
    });
  });

  test("partial fill keeps ordered vs executed distinct", () => {
    const [o] = mapOrderStatuses({
      data: {
        orders: [
          {
            id: "p1",
            symbol: "X",
            state: "partially_filled",
            quantity: "10",
            cumulative_quantity: "4",
            average_price: "20",
          },
        ],
      },
    });
    expect(o).toMatchObject({
      state: "partially_filled",
      quantity: 10,
      cumulativeQuantity: 4,
      avgPrice: 20,
    });
  });

  test("empty / wrong-account response yields no orders", () => {
    expect(mapOrderStatuses({ data: { orders: [] } })).toEqual([]);
    expect(mapOrderStatuses({ data: {} })).toEqual([]);
  });
});

describe("nextCursor", () => {
  test("pulls the cursor query param out of a next URL", () => {
    expect(
      nextCursor({ data: { orders: [], next: "https://api.robinhood.com/orders/?cursor=abc123" } }),
    ).toBe("abc123");
  });
  test("null when there is no further page", () => {
    expect(nextCursor({ data: { orders: [] } })).toBeNull();
  });
});

describe("mapQuotes", () => {
  test("reads the flat shape (back-compat)", () => {
    const quotes = mapQuotes({
      quotes: [{ symbol: "SPY", last_trade_price: "500.5", previous_close: "498" }],
    });
    expect(quotes[0]).toMatchObject({ symbol: "SPY", last: 500.5, previousClose: 498 });
  });

  test("descends into results[].quote and uses adjusted_previous_close", () => {
    const quotes = mapQuotes({
      data: {
        results: [
          {
            quote: {
              symbol: "INTC",
              last_trade_price: "124.540000",
              adjusted_previous_close: "116.960000",
              bid_price: "125.210000",
              ask_price: "125.420000",
            },
            close: { symbol: "INTC", price: "116.96" },
          },
        ],
      },
    });
    expect(quotes[0]).toMatchObject({
      symbol: "INTC",
      last: 124.54,
      previousClose: 116.96,
      bidPrice: 125.21,
      askPrice: 125.42,
    });
  });
});
