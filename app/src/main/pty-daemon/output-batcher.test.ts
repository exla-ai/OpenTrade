import { describe, expect, test } from "bun:test";
import { createBatchedWsSink, type WsLike } from "./output-batcher";

const SLOW_CODE = 4408;

class FakeWs implements WsLike {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Buffer | string> = [];
  closed: { code?: number; reason?: string } | null = null;

  send(data: Buffer | string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createBatchedWsSink", () => {
  test("coalesces multiple writes into one frame on the flush timer", async () => {
    const ws = new FakeWs();
    const sink = createBatchedWsSink(ws, { slowConsumerCode: SLOW_CODE, flushMs: 10 });
    sink.output(Buffer.from("foo"));
    sink.output(Buffer.from("bar"));
    expect(ws.sent).toHaveLength(0); // not yet flushed
    await delay(20);
    expect(ws.sent).toHaveLength(1);
    expect((ws.sent[0] as Buffer).toString()).toBe("foobar");
  });

  test("flushes immediately when the byte threshold is crossed", () => {
    const ws = new FakeWs();
    const sink = createBatchedWsSink(ws, { slowConsumerCode: SLOW_CODE, flushBytes: 4 });
    sink.output(Buffer.from("abcde")); // 5 >= 4
    expect(ws.sent).toHaveLength(1);
    expect((ws.sent[0] as Buffer).toString()).toBe("abcde");
  });

  test("trips the backpressure valve instead of sending when buffer is full", () => {
    const ws = new FakeWs();
    ws.bufferedAmount = 100 * 1024 * 1024; // way past the cap
    const sink = createBatchedWsSink(ws, { slowConsumerCode: SLOW_CODE, flushBytes: 1 });
    sink.output(Buffer.from("x"));
    expect(ws.sent).toHaveLength(0);
    expect(ws.closed?.code).toBe(SLOW_CODE);
  });

  test("exit flushes pending output, then sends exit JSON, then closes 1000", () => {
    const ws = new FakeWs();
    const sink = createBatchedWsSink(ws, { slowConsumerCode: SLOW_CODE, flushMs: 1000 });
    sink.output(Buffer.from("tail"));
    sink.exit(0, null);
    // order: binary tail, then exit control frame
    expect((ws.sent[0] as Buffer).toString()).toBe("tail");
    expect(JSON.parse(ws.sent[1] as string)).toEqual({ type: "exit", code: 0, signal: null });
    expect(ws.closed?.code).toBe(1000);
  });

  test("a late flush after close drops the batch instead of throwing", async () => {
    const ws = new FakeWs();
    const sink = createBatchedWsSink(ws, { slowConsumerCode: SLOW_CODE, flushMs: 10 });
    sink.output(Buffer.from("data"));
    ws.readyState = 3; // socket closed before the timer fires
    await delay(20);
    expect(ws.sent).toHaveLength(0);
  });

  test("dispose cancels a pending flush", async () => {
    const ws = new FakeWs();
    const sink = createBatchedWsSink(ws, { slowConsumerCode: SLOW_CODE, flushMs: 10 });
    sink.output(Buffer.from("data"));
    sink.dispose();
    await delay(20);
    expect(ws.sent).toHaveLength(0);
  });
});
