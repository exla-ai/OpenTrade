import { describe, expect, test } from "bun:test";
import type { ExecutionState } from "@shared/agent";
import type { AgentRegistry } from "../../agents/registry";
import { WakeCoordinator } from "./coordinator";
import type { HeadlessExitReason, HeadlessWakeStrategy } from "./types";

const tick = () => new Promise((r) => setTimeout(r, 0));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal AgentRegistry stand-in: just the execution-state surface the coordinator
 *  reads (seed) and writes (publish). It IS the actor's state, 1:1. */
class FakeRegistry {
  states = new Map<string, ExecutionState>();
  executionStateOf(id: string): ExecutionState {
    return this.states.get(id) ?? "offline";
  }
  setExecutionState(id: string, s: ExecutionState): void {
    if (s === "offline") this.states.delete(id);
    else this.states.set(id, s);
  }
}

/** Headless runs report their outcome only when the test calls `finishNext(reason)`. */
class FakeHeadless implements HeadlessWakeStrategy {
  calls: string[] = [];
  stops = 0;
  private exits: Array<(reason: HeadlessExitReason) => void> = [];
  run(id: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void {
    this.calls.push(`${id}:${prompt}`);
    this.exits.push(onExit);
  }
  /** Simulate the active `-p` child exiting with the given outcome. */
  finishNext(reason: HeadlessExitReason = "ok"): void {
    this.exits.shift()?.(reason);
  }
  stop(): boolean {
    this.stops++;
    return true;
  }
  stopAll(): void {}
}

function make(maxHeadlessRunMs = 10_000) {
  const reg = new FakeRegistry();
  const headless = new FakeHeadless();
  const coord = new WakeCoordinator(reg as unknown as AgentRegistry, headless, maxHeadlessRunMs);
  return { reg, headless, coord };
}

/** Start a `/wake-stream` poll; returns the promise + its abort controller. */
function poll(c: WakeCoordinator, id: string, holdMs = 10_000) {
  const ac = new AbortController();
  return { p: c.awaitPoll(id, ac.signal, holdMs), ac };
}

describe("WakeCoordinator — headless transport (ported)", () => {
  test("offline agent runs headless, completion-gated on exit", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("a", "p1");
    expect(headless.calls).toEqual(["a:p1"]);
    expect(reg.executionStateOf("a")).toBe("headless");
    headless.finishNext("ok");
    expect(reg.executionStateOf("a")).toBe("offline");
  });

  test("a second headless wake queues behind the active run, then drains in order", () => {
    const { headless, coord } = make();
    coord.enqueue("b", "p1");
    coord.enqueue("b", "p2");
    expect(headless.calls).toEqual(["b:p1"]); // p2 queued, held at the head until exit
    headless.finishNext("ok");
    expect(headless.calls).toEqual(["b:p1", "b:p2"]);
    headless.finishNext("ok");
  });

  test("never serves a poll while a headless run holds the agent", async () => {
    const { headless, coord } = make();
    coord.enqueue("f", "p1"); // offline → headless run
    expect(headless.calls).toEqual(["f:p1"]);
    const ac = new AbortController();
    expect(await coord.awaitPoll("f", ac.signal, 20)).toBeNull(); // channel inert under -p
    expect(headless.calls).toEqual(["f:p1"]); // unchanged
    headless.finishNext("ok");
  });

  test("a headless run is killed by the max-runtime timer", async () => {
    const { headless, coord } = make(20); // tiny max-runtime
    coord.enqueue("x", "p1");
    expect(headless.calls).toEqual(["x:p1"]);
    await wait(40); // kill timer fires → SIGTERM the child
    expect(headless.stops).toBe(1);
  });
});

describe("WakeCoordinator — interactive transport (channel)", () => {
  test("a wake queued before any poll is handed to the next poll", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("d");
    coord.enqueue("d", "p1");
    expect(headless.calls).toEqual([]); // interactive, no poll yet → queued, never headless
    const { p } = poll(coord, "d");
    expect(await p).toBe("p1"); // handed off from the queue head
  });

  test("the head is delivered to a parked poll immediately (no turn gating)", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("c");
    const { p } = poll(coord, "c");
    await tick();
    coord.enqueue("c", "p1"); // mid-turn or not, the channel accepts the push
    expect(await p).toBe("p1");
    expect(headless.calls).toEqual([]); // never headless while interactive
  });

  test("two wakes fired back-to-back are handed to successive polls in order", async () => {
    const { coord } = make();
    coord.onInteractiveUp("t");
    coord.enqueue("t", "p1");
    coord.enqueue("t", "p2"); // both queued (no poll parked yet)
    const { p: p1 } = poll(coord, "t");
    expect(await p1).toBe("p1");
    const { p: p2 } = poll(coord, "t");
    expect(await p2).toBe("p2");
  });

  test("an undelivered head re-routes to headless when the PTY dies before handoff", () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("m");
    coord.enqueue("m", "p1"); // interactive, no poll → queued
    expect(headless.calls).toEqual([]);
    coord.onInteractiveDown("m"); // PTY dies (crash / GUI quit) before any handoff
    expect(headless.calls).toEqual(["m:p1"]); // re-routed to the -p transport
    headless.finishNext("ok");
  });

  test("awaitPoll returns null when the hold elapses", async () => {
    const { coord } = make();
    const ac = new AbortController();
    expect(await coord.awaitPoll("e", ac.signal, 10)).toBeNull();
  });

  test("awaitPoll returns null when the request aborts", async () => {
    const { coord } = make();
    const ac = new AbortController();
    const p = coord.awaitPoll("e2", ac.signal, 10_000);
    await tick();
    ac.abort();
    expect(await p).toBeNull();
  });
});

describe("WakeCoordinator — broken / resume-fail", () => {
  test("a broken agent drops its queued wakes and is never served", async () => {
    const { reg, headless, coord } = make();
    reg.setExecutionState("h", "broken"); // seed from a boot-time reconcile
    coord.enqueue("h", "p1");
    expect(headless.calls).toEqual([]);
    expect(reg.executionStateOf("h")).toBe("broken");
    const ac = new AbortController();
    expect(await coord.awaitPoll("h", ac.signal, 10)).toBeNull();
  });

  test("broken only after 3 consecutive resume-fails; each drops its own wake", () => {
    const { reg, headless, coord } = make();
    for (let i = 1; i <= 2; i++) {
      coord.enqueue("r", `p${i}`);
      expect(reg.executionStateOf("r")).toBe("headless");
      headless.finishNext("resumeFail"); // drops the wake, increments the streak
      expect(reg.executionStateOf("r")).toBe("offline"); // not broken yet
    }
    coord.enqueue("r", "p3");
    headless.finishNext("resumeFail"); // 3rd in a row
    expect(reg.executionStateOf("r")).toBe("broken");
    expect(headless.calls).toEqual(["r:p1", "r:p2", "r:p3"]); // each ran once, then dropped
  });

  test("a clean exit resets the resume-fail streak", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("s", "p1");
    headless.finishNext("resumeFail"); // streak = 1
    coord.enqueue("s", "p2");
    headless.finishNext("ok"); // streak reset to 0
    coord.enqueue("s", "p3");
    headless.finishNext("resumeFail"); // streak = 1 again, NOT 3
    expect(reg.executionStateOf("s")).toBe("offline");
  });

  test("a spawn error is one-strike broken and drops the queue", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("z", "p1");
    coord.enqueue("z", "p2"); // queued behind the active run
    headless.finishNext("spawnFail");
    expect(reg.executionStateOf("z")).toBe("broken");
    expect(headless.calls).toEqual(["z:p1"]); // p2 dropped, never ran
  });

  test("restart (onInteractiveUp) clears broken back to interactive", () => {
    const { reg, coord } = make();
    reg.setExecutionState("w", "broken");
    coord.enqueue("w", "p1"); // creates the writer, seeded broken
    expect(reg.executionStateOf("w")).toBe("broken");
    coord.onInteractiveUp("w"); // manual Restart spawns a fresh PTY
    expect(reg.executionStateOf("w")).toBe("interactive");
  });
});

describe("WakeCoordinator — stop", () => {
  test("stop() clears pending and ends an in-flight headless run", () => {
    const { reg, headless, coord } = make();
    coord.enqueue("i", "p1"); // headless run in flight
    coord.enqueue("i", "p2"); // queued
    expect(coord.stop("i")).toBe(true);
    expect(headless.stops).toBe(1);
    headless.finishNext("ok"); // the SIGTERM'd child exits (treated as a deliberate stop)
    expect(reg.executionStateOf("i")).toBe("offline");
    expect(headless.calls).toEqual(["i:p1"]); // p2 was cleared, never ran
  });

  test("stop() on an interactive agent clears the queue and reports no headless run", async () => {
    const { headless, coord } = make();
    coord.onInteractiveUp("j");
    coord.enqueue("j", "p1"); // queued (no poll)
    expect(coord.stop("j")).toBe(false); // nothing headless to stop
    const { p } = poll(coord, "j", 10);
    expect(await p).toBeNull(); // queue cleared → a fresh poll parks, then the hold elapses
    expect(headless.calls).toEqual([]);
  });

  test("stop() on an unknown agent is a no-op", () => {
    const { coord } = make();
    expect(coord.stop("nope")).toBe(false);
  });
});
