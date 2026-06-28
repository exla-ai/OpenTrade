import type { OrderOutcome, ParsedOrder } from "@shared/approval";

/**
 * Best-effort parse of a Robinhood order tool's `tool_input` into a human card.
 * The exact field shapes are only partially confirmed, so every field is a
 * lenient lookup over candidate keys and may come back null — the rawInput on the
 * approval row is always the source of truth.
 */
export function parseOrderInput(toolName: string, input: unknown): ParsedOrder {
  const o = (input ?? {}) as Record<string, unknown>;
  const isCancel = /cancel_/.test(toolName);

  if (isCancel) {
    const orderId = str(pick(o, "order_id", "id", "orderId"));
    return {
      kind: "cancel",
      symbol: str(pick(o, "symbol", "ticker")),
      side: null,
      quantity: null,
      orderType: "cancel",
      limitPrice: null,
      estCost: null,
      cancelsOrderId: orderId,
      summary: orderId ? `Cancel order ${orderId}` : "Cancel order",
    };
  }

  const symbol = up(str(pick(o, "symbol", "ticker", "instrument")));
  const side = low(str(pick(o, "side", "direction")));
  const quantity = numv(pick(o, "quantity", "qty", "shares", "amount_in_shares"));
  const orderType = low(str(pick(o, "type", "order_type", "orderType"))) ?? inferType(o);
  const limitPrice = numv(pick(o, "limit_price", "limitPrice", "price"));
  const dollars = numv(pick(o, "amount", "dollar_amount", "amount_in_dollars", "notional"));

  let estCost: number | null = null;
  if (limitPrice != null && quantity != null) estCost = limitPrice * quantity;
  else if (dollars != null) estCost = dollars;

  return {
    kind: "place",
    symbol,
    side,
    quantity,
    orderType,
    limitPrice,
    estCost,
    cancelsOrderId: null,
    summary: placeSummary({ side, quantity, symbol, orderType, limitPrice, dollars, estCost }),
  };
}

function placeSummary(a: {
  side: string | null;
  quantity: number | null;
  symbol: string | null;
  orderType: string | null;
  limitPrice: number | null;
  dollars: number | null;
  estCost: number | null;
}): string {
  const verb = a.side ? a.side.toUpperCase() : "ORDER";
  const size =
    a.quantity != null
      ? `${trimNum(a.quantity)} `
      : a.dollars != null
        ? `${usd(a.dollars)} of `
        : "";
  const sym = a.symbol ?? "?";
  const price =
    a.orderType === "limit" && a.limitPrice != null ? `@ ${usd(a.limitPrice)} limit` : "@ market";
  const est = a.estCost != null && a.quantity != null ? ` — est. ${usd(a.estCost)}` : "";
  return `${verb} ${size}${sym} ${price}${est}`.replace(/\s+/g, " ").trim();
}

/** A limit_price present without an explicit type strongly implies a limit order. */
function inferType(o: Record<string, unknown>): string | null {
  if (pick(o, "limit_price", "limitPrice") != null) return "limit";
  return null;
}

/**
 * Best-effort classification of an order tool's *result* (from PostToolUse). Its
 * only lasting job now is to capture the **orderId** (the link to RH's
 * authoritative ledger) and the submit-time reject case RH never records as an
 * order (e.g. "market orders not allowed in extended hours" → `ok:false` + a
 * human `message`, no order created). Execution status itself is read live from
 * `get_equity_orders`, not inferred here. `ok:null` means unclassifiable.
 */
export function parseOrderResult(result: unknown, toolName?: string): OrderOutcome {
  const at = Date.now();
  const { text, isError, obj } = unwrapResult(result);
  const structured = obj ?? tryParse(text);

  // Cancels are a different shape: RH returns `{ data: { accepted: true } }` — the
  // broker *accepted* the cancel request (cancellation is async), plus a `guide`
  // string. Classify on that flag, not the place-order error heuristic below: the
  // guide enumerates states like "rejected"/"failed" and would otherwise trip the
  // error-word match and mislabel a successful cancel as a broker rejection.
  if (toolName && /cancel_/.test(toolName)) {
    const data = (pick(structured ?? {}, "data") ?? structured ?? {}) as Record<string, unknown>;
    const accepted = boolish(pick(data, "accepted"));
    let ok: boolean | null;
    if (isError || accepted === false) ok = false;
    else if (accepted === true) ok = true;
    else ok = null;
    const message =
      accepted === true
        ? "Broker accepted the cancel request (cancellation is asynchronous)"
        : extractMessage(text, structured);
    return { ok, orderId: null, message, at };
  }

  const orderId =
    str(pick(structured ?? {}, "order_id", "id", "orderId", "order_number")) ?? findUuid(text);
  const state = low(str(pick(structured ?? {}, "state", "status", "order_state")));

  const rejectedState = state ? /reject|cancel|fail|denied/.test(state) : false;
  const acceptedState = state
    ? /queued|confirmed|unconfirmed|filled|partial|pending|accepted|new|open/.test(state)
    : false;
  const errorWords = /\b(error|not allowed|invalid|insufficient|cannot|denied|failed|reject)\b/i;

  let ok: boolean | null;
  if (isError || rejectedState) ok = false;
  else if (orderId || acceptedState) ok = true;
  else if (errorWords.test(text)) ok = false;
  else ok = null;

  return { ok, orderId, message: extractMessage(text, structured), at };
}

function unwrapResult(result: unknown): {
  text: string;
  isError: boolean;
  obj: Record<string, unknown> | null;
} {
  if (result === null || result === undefined) return { text: "", isError: false, obj: null };
  if (typeof result === "string") return { text: result, isError: false, obj: tryParse(result) };
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    const isError = r.isError === true || r.is_error === true;
    if (Array.isArray(r.content)) {
      const text = r.content
        .map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).text) : null))
        .filter((t): t is string => Boolean(t))
        .join("\n");
      return { text: text || JSON.stringify(r), isError, obj: tryParse(text) };
    }
    return { text: JSON.stringify(r), isError, obj: r };
  }
  return { text: String(result), isError: false, obj: null };
}

function extractMessage(text: string, obj: Record<string, unknown> | null): string | null {
  const fromObj = obj
    ? str(pick(obj, "error", "message", "detail", "reason", "error_message", "errors"))
    : null;
  const t = (fromObj ?? text ?? "").trim();
  if (!t) return null;
  return t.length > 240 ? `${t.slice(0, 240)}…` : t;
}

function tryParse(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function findUuid(text: string): string | null {
  const m = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return undefined;
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}
function boolish(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}
function up(v: string | null): string | null {
  return v ? v.toUpperCase() : null;
}
function low(v: string | null): string | null {
  return v ? v.toLowerCase() : null;
}
function numv(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : null;
}
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}
function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}
