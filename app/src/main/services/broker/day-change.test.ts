import { describe, expect, test } from "bun:test";
import type { Portfolio, Position, Quote } from "@shared/broker";
import { withDayChange } from "./index";

const portfolio = (equity: number): Portfolio => ({
  accountNumber: "X",
  equity,
  marketValue: null,
  buyingPower: null,
  cash: null,
  dayChange: null,
  dayChangePct: null,
});

const position = (over: Partial<Position> & { symbol: string; quantity: number }): Position => ({
  intradayQuantity: 0,
  averageCost: null,
  lastPrice: null,
  marketValue: null,
  unrealizedPnl: null,
  ...over,
});

const quote = (symbol: string, last: number, previousClose: number): Quote => ({
  symbol,
  last,
  previousClose,
  askPrice: null,
  bidPrice: null,
});

describe("withDayChange", () => {
  test("overnight-held shares move from previous_close", () => {
    const out = withDayChange(
      portfolio(11000),
      [position({ symbol: "AAPL", quantity: 10, intradayQuantity: 0, averageCost: 90 })],
      new Map([["AAPL", quote("AAPL", 110, 100)]]),
    );
    // (110 - 100) * 10 = 100; prior = 11000 - 100 = 10900
    expect(out.dayChange).toBe(100);
    expect(out.dayChangePct).toBeCloseTo(100 / 10900, 6);
  });

  test("shares bought today move from their cost basis, not previous_close", () => {
    // The INTC repro: bought 1 share today at 125.40, prev close 116.96, last 124.54.
    const out = withDayChange(
      portfolio(2000),
      [position({ symbol: "INTC", quantity: 1, intradayQuantity: 1, averageCost: 125.4 })],
      new Map([["INTC", quote("INTC", 124.54, 116.96)]]),
    );
    // fully intraday → (124.54 - 125.40) * 1 = -0.86  (NOT +7.58 from prev close)
    expect(out.dayChange).toBeCloseTo(-0.86, 6);
    expect(out.dayChange).toBeLessThan(0);
  });

  test("mixed overnight + intraday shares split correctly", () => {
    // 3 held overnight, 2 bought today at 50; prevClose 40, last 55.
    const out = withDayChange(
      portfolio(10000),
      [position({ symbol: "Z", quantity: 5, intradayQuantity: 2, averageCost: 50 })],
      new Map([["Z", quote("Z", 55, 40)]]),
    );
    // overnight: (55-40)*3 = 45 ; intraday: (55-50)*2 = 10 ; total 55
    expect(out.dayChange).toBe(55);
  });

  test("positions without a usable quote are skipped → null when none count", () => {
    const out = withDayChange(
      portfolio(2000),
      [position({ symbol: "INTC", quantity: 1 })],
      new Map(),
    );
    expect(out.dayChange).toBeNull();
    expect(out.dayChangePct).toBeNull();
  });
});
