import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Quote } from "@shared/broker";
import { LocalApiServer } from "./index";

// Minimal broker stub — the faucet only calls getQuote / getPositionsLive.
const stubBroker = {
  getQuote: async (symbol: string): Promise<Quote> => ({
    symbol,
    last: 123.45,
    previousClose: 120,
    askPrice: null,
    bidPrice: null,
  }),
  getPositionsLive: async () => [
    {
      symbol: "AAPL",
      quantity: 5,
      averageCost: 100,
      lastPrice: 110,
      marketValue: 550,
      unrealizedPnl: 50,
    },
  ],
};

// biome-ignore lint/suspicious/noExplicitAny: stubs stand in for the real services
const server = new LocalApiServer({ broker: stubBroker as any } as any);
let base = "";

beforeAll(async () => {
  await server.start();
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop());

describe("market-data faucet", () => {
  test("/health needs no token", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  test("rejects missing token", async () => {
    const res = await fetch(`${base}/quotes/AAPL`);
    expect(res.status).toBe(401);
  });

  test("serves a quote with a valid token", async () => {
    const res = await fetch(`${base}/quotes/aapl?maxAge=5`, {
      headers: { "x-opentrade-token": server.token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Quote;
    expect(body.symbol).toBe("AAPL");
    expect(body.last).toBe(123.45);
  });

  test("serves positions with a valid token", async () => {
    const res = await fetch(`${base}/positions`, {
      headers: { "x-opentrade-token": server.token },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });
});
