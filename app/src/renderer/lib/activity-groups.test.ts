import { describe, expect, test } from "bun:test";
import type { AuditEntry } from "@shared/approval";
import type { OrderStatus } from "@shared/broker";
import { type ActivityGroup, groupActivity, orderState } from "./activity-groups";

/** Minimal OrderStatus stub for the join — only the fields orderState reads. */
function rh(state: string): OrderStatus {
  return {
    id: "o1",
    symbol: "AAPL",
    side: "buy",
    type: "market",
    state,
    quantity: 1,
    cumulativeQuantity: state === "filled" ? 1 : 0,
    avgPrice: state === "filled" ? 100 : null,
    limitPrice: null,
    fees: 0,
    dollarAmount: null,
    createdAt: null,
    lastTransactionAt: null,
  };
}

function entry(
  id: number,
  kind: AuditEntry["kind"],
  at: number,
  payload: Record<string, unknown>,
  agentId = "a1",
): AuditEntry {
  return { id, agentId, agentName: "Agent", kind, payload, at };
}

describe("groupActivity", () => {
  test("collapses the three lifecycle entries of one order into a single group", () => {
    // Feed is newest-first (DESC by `at`), as the audit list returns it.
    const feed: AuditEntry[] = [
      entry(3, "order_observed", 300, { approvalId: "ap1", ok: true }),
      entry(2, "approval_decision", 200, { approvalId: "ap1", status: "approved" }),
      entry(1, "order_intent", 100, { approvalId: "ap1", summary: "BUY 10 AAPL @ market" }),
    ];

    const groups = groupActivity(feed);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("ap1");
    expect(groups[0].latest.id).toBe(3);
    // entries kept chronological ascending for the expanded timeline
    expect(groups[0].entries.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  test("entries without an approvalId stay standalone (keyed by entry id)", () => {
    const feed: AuditEntry[] = [
      entry(2, "order_observed", 200, { approvalId: null, ok: false }),
      entry(1, "session_started", 100, {}),
    ];

    const groups = groupActivity(feed);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key)).toEqual(["entry-2", "entry-1"]);
    expect(groups.every((g) => g.entries.length === 1)).toBe(true);
  });

  test("folds a cancel into the order it targets instead of a new group", () => {
    // A place order (orderId o1) and its later cancellation, newest-first.
    const feed: AuditEntry[] = [
      entry(6, "order_observed", 600, {
        approvalId: "cap",
        toolName: "mcp__robinhood__cancel_equity_order",
        ok: true,
      }),
      entry(5, "approval_decision", 500, { approvalId: "cap", status: "approved" }),
      entry(4, "order_intent", 400, {
        approvalId: "cap",
        toolName: "mcp__robinhood__cancel_equity_order",
        parsed: { kind: "cancel", summary: "Cancel order o1", cancelsOrderId: "o1" },
      }),
      entry(3, "order_observed", 300, {
        approvalId: "pap",
        toolName: "mcp__robinhood__place_equity_order",
        ok: true,
        orderId: "o1",
      }),
      entry(2, "approval_decision", 200, { approvalId: "pap", status: "approved" }),
      entry(1, "order_intent", 100, {
        approvalId: "pap",
        toolName: "mcp__robinhood__place_equity_order",
        parsed: { kind: "place", summary: "BUY 1 AAPL @ market" },
      }),
    ];

    const groups = groupActivity(feed);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("pap"); // the original order's card, not a new one
    expect(groups[0].entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(groups[0].latest.id).toBe(6); // floats by the cancel's newest activity
  });

  test("falls back to the summary order id for rows without cancelsOrderId", () => {
    const oid = "6a3b77da-f040-4cdd-8718-f1da61a0d700";
    const feed: AuditEntry[] = [
      entry(4, "order_intent", 400, {
        approvalId: "cap",
        toolName: "mcp__robinhood__cancel_equity_order",
        // no cancelsOrderId — only the legacy summary string
        parsed: { kind: "cancel", summary: `Cancel order ${oid}` },
      }),
      entry(2, "order_observed", 200, {
        approvalId: "pap",
        toolName: "mcp__robinhood__place_equity_order",
        ok: true,
        orderId: oid,
      }),
      entry(1, "order_intent", 100, {
        approvalId: "pap",
        toolName: "mcp__robinhood__place_equity_order",
        parsed: { kind: "place", summary: "BUY 1 AAPL @ market" },
      }),
    ];

    const groups = groupActivity(feed);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("pap");
    expect(groups[0].entries.map((e) => e.id)).toEqual([1, 2, 4]);
  });

  test("a cancel whose target isn't in the feed window stays standalone", () => {
    const feed: AuditEntry[] = [
      entry(2, "approval_decision", 200, { approvalId: "cap", status: "approved" }),
      entry(1, "order_intent", 100, {
        approvalId: "cap",
        toolName: "mcp__robinhood__cancel_equity_order",
        parsed: { kind: "cancel", summary: "Cancel order zzz", cancelsOrderId: "zzz" },
      }),
    ];

    const groups = groupActivity(feed);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("cap");
  });

  test("group order follows the newest entry across interleaved orders", () => {
    const feed: AuditEntry[] = [
      entry(4, "approval_decision", 400, { approvalId: "ap2", status: "approved" }),
      entry(3, "approval_decision", 300, { approvalId: "ap1", status: "rejected" }),
      entry(2, "order_intent", 200, { approvalId: "ap2", summary: "SELL 5 TSLA" }),
      entry(1, "order_intent", 100, { approvalId: "ap1", summary: "BUY 10 AAPL" }),
    ];

    const groups = groupActivity(feed);

    // ap2 owns the most recent entry (id 4), so it sorts first.
    expect(groups.map((g) => g.key)).toEqual(["ap2", "ap1"]);
    expect(groups[0].entries.map((e) => e.id)).toEqual([2, 4]);
    expect(groups[1].entries.map((e) => e.id)).toEqual([1, 3]);
  });
});

describe("orderState (pure join with RH's ledger)", () => {
  const NOW = 1_000_000_000;
  // A clock well past the settle grace, so approved-but-unlinked orders resolve.
  const LATER = NOW + 10 * 60_000;
  const grp = (entries: AuditEntry[]): ActivityGroup => ({
    key: "k",
    agentId: "a1",
    agentName: "Agent",
    entries,
    latest: entries.reduce((a, b) => (b.at > a.at ? b : a)),
  });
  const intent = () => entry(1, "order_intent", NOW, { approvalId: "ap" });
  const approved = () =>
    entry(2, "approval_decision", NOW, { approvalId: "ap", status: "approved" });

  test("RH state drives everything when the order is matched", () => {
    const g = grp([intent(), approved()]);
    expect(orderState(g, rh("filled"), "o1", LATER, true)).toBe("filled");
    expect(orderState(g, rh("partially_filled"), "o1", LATER, true)).toBe("working");
    expect(orderState(g, rh("queued"), "o1", LATER, true)).toBe("working");
    expect(orderState(g, rh("confirmed"), "o1", LATER, true)).toBe("working");
    expect(orderState(g, rh("cancelled"), "o1", LATER, true)).toBe("failed");
    expect(orderState(g, rh("rejected"), "o1", LATER, true)).toBe("failed");
  });

  test("a submit-time rejection (ok:false) is `failed`, no RH order", () => {
    const g = grp([intent(), entry(3, "order_observed", NOW, { ok: false })]);
    expect(orderState(g, null, null, LATER, true)).toBe("failed");
  });

  test("a gate rejection / expiry is `failed`", () => {
    expect(
      orderState(
        grp([intent(), entry(2, "approval_decision", NOW, { status: "rejected" })]),
        null,
        null,
        LATER,
        true,
      ),
    ).toBe("failed");
    expect(
      orderState(
        grp([intent(), entry(2, "approval_decision", NOW, { status: "expired" })]),
        null,
        null,
        LATER,
        true,
      ),
    ).toBe("failed");
  });

  test("approved with an orderId but not yet in the ledger is `working`", () => {
    expect(orderState(grp([intent(), approved()]), null, "o1", LATER, true)).toBe("working");
  });

  test("approved, no link, no match, ledger loaded, past grace → `failed` (never reached RH)", () => {
    expect(orderState(grp([intent(), approved()]), null, null, LATER, true)).toBe("failed");
  });

  test("approved, no link, within the settle grace → `working` (placement may lag)", () => {
    expect(orderState(grp([intent(), approved()]), null, null, NOW + 1000, true)).toBe("working");
  });

  test("approved, no link, ledger not loaded yet → `unknown` (can't assert)", () => {
    expect(orderState(grp([intent(), approved()]), null, null, LATER, false)).toBe("unknown");
  });

  test("only an intent (awaiting a decision) is `proposed`; non-order activity is `other`", () => {
    expect(orderState(grp([intent()]), null, null, LATER, true)).toBe("proposed");
    expect(orderState(grp([entry(9, "session_started", NOW, {})]), null, null, LATER, true)).toBe(
      "other",
    );
  });
});
