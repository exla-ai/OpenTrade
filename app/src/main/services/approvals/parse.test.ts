import { describe, expect, test } from "bun:test";
import { parseOrderInput, parseOrderResult } from "./parse";

describe("parseOrderInput", () => {
  test("limit buy computes est cost and a clean summary", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "aapl",
      side: "buy",
      quantity: 10,
      type: "limit",
      limit_price: "215.00",
    });
    expect(p.kind).toBe("place");
    expect(p.symbol).toBe("AAPL");
    expect(p.side).toBe("buy");
    expect(p.quantity).toBe(10);
    expect(p.orderType).toBe("limit");
    expect(p.limitPrice).toBe(215);
    expect(p.estCost).toBe(2150);
    expect(p.summary).toBe("BUY 10 AAPL @ $215.00 limit — est. $2,150.00");
  });

  test("market sell has no est cost and reads as market", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "TSLA",
      side: "sell",
      quantity: 3,
      type: "market",
    });
    expect(p.orderType).toBe("market");
    expect(p.estCost).toBeNull();
    expect(p.summary).toBe("SELL 3 TSLA @ market");
  });

  test("a bare limit_price infers a limit order", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "MSFT",
      side: "buy",
      quantity: 1,
      limit_price: 400,
    });
    expect(p.orderType).toBe("limit");
  });

  test("dollar-based order surfaces notional in the summary", () => {
    const p = parseOrderInput("place_equity_order", {
      symbol: "VOO",
      side: "buy",
      amount: 500,
    });
    expect(p.quantity).toBeNull();
    expect(p.estCost).toBe(500);
    expect(p.summary).toBe("BUY $500.00 of VOO @ market");
  });

  test("cancel order is summarized by id and links back via cancelsOrderId", () => {
    const p = parseOrderInput("cancel_equity_order", { order_id: "abc-123" });
    expect(p.kind).toBe("cancel");
    expect(p.cancelsOrderId).toBe("abc-123");
    expect(p.summary).toBe("Cancel order abc-123");
  });

  test("missing fields degrade gracefully, never throw", () => {
    const p = parseOrderInput("place_equity_order", {});
    expect(p.kind).toBe("place");
    expect(p.symbol).toBeNull();
    expect(p.summary).toBe("ORDER ? @ market");
  });
});

describe("parseOrderResult", () => {
  test("isError MCP result is rejected with its message", () => {
    const o = parseOrderResult({
      isError: true,
      content: [{ type: "text", text: "Market orders not allowed in extended hours." }],
    });
    expect(o.ok).toBe(false);
    expect(o.message).toBe("Market orders not allowed in extended hours.");
  });

  test("error text without an isError flag is still caught", () => {
    const o = parseOrderResult({
      content: [{ type: "text", text: "Error: market orders are not allowed after hours" }],
    });
    expect(o.ok).toBe(false);
  });

  test("accepted order with id + state reads as ok", () => {
    const o = parseOrderResult({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            order_id: "6a2c9cb7-aaaa-bbbb-cccc-1234567890ab",
            state: "queued",
          }),
        },
      ],
    });
    expect(o.ok).toBe(true);
    expect(o.orderId).toBe("6a2c9cb7-aaaa-bbbb-cccc-1234567890ab");
  });

  test("a rejected state is a failure even without isError", () => {
    const o = parseOrderResult(JSON.stringify({ id: "x", state: "rejected" }));
    expect(o.ok).toBe(false);
  });

  test("an unclassifiable result is ok:null, never throws", () => {
    const o = parseOrderResult({ content: [{ type: "text", text: "ok" }] });
    expect(o.ok).toBeNull();
    expect(typeof o.at).toBe("number");
  });

  test("a bare uuid in plain text is picked up as the order id", () => {
    const o = parseOrderResult("Submitted order 6a2c9cb7-aaaa-bbbb-cccc-1234567890ab successfully");
    expect(o.orderId).toBe("6a2c9cb7-aaaa-bbbb-cccc-1234567890ab");
    expect(o.ok).toBe(true);
  });

  test("a cancel's `accepted:true` is ok, despite the guide text mentioning rejections", () => {
    // The real RH shape: the guide enumerates states like "rejected"/"failed",
    // which would trip the place-order error heuristic if not handled as a cancel.
    const o = parseOrderResult(
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              data: { accepted: true },
              guide:
                "accepted=true means the broker accepted the cancel request. state 'rejected'/'failed' are terminal.",
            }),
          },
        ],
      },
      "mcp__robinhood__cancel_equity_order",
    );
    expect(o.ok).toBe(true);
    expect(o.orderId).toBeNull();
    expect(o.message).toContain("accepted the cancel request");
  });

  test("a cancel with accepted:false is a failure", () => {
    const o = parseOrderResult(
      { content: [{ type: "text", text: JSON.stringify({ data: { accepted: false } }) }] },
      "mcp__robinhood__cancel_equity_order",
    );
    expect(o.ok).toBe(false);
  });

  test("the outcome carries only the link + classification (no fill numbers)", () => {
    const o = parseOrderResult({
      content: [{ type: "text", text: '{"id":"abc","state":"unconfirmed"}' }],
    });
    // Execution status is read live from get_equity_orders, not stored here.
    expect(Object.keys(o).sort()).toEqual(["at", "message", "ok", "orderId"]);
    expect(o.orderId).toBe("abc");
    expect(o.ok).toBe(true);
  });
});
