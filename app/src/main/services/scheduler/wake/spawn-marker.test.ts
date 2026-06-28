import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionState } from "@shared/agent";
import type { AgentRegistry } from "../../agents/registry";
import {
  clearSpawnMarker,
  readSpawnMarkers,
  reconcileSpawnMarkers,
  type SpawnMarker,
  writeSpawnMarker,
} from "./spawn-marker";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Minimal AgentRegistry stand-in: only the surface reconcile touches. */
class FakeRegistry {
  agents = new Set<string>();
  states = new Map<string, ExecutionState>();
  get(id: string) {
    return this.agents.has(id) ? ({ id } as ReturnType<AgentRegistry["get"]>) : undefined;
  }
  setExecutionState(id: string, s: ExecutionState): void {
    this.states.set(id, s);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wake-runs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const marker = (over: Partial<SpawnMarker> = {}): SpawnMarker => ({
  agentId: "a1",
  pid: 999999,
  sessionId: "sess-1",
  startedAt: 1,
  ...over,
});

describe("spawn-marker", () => {
  test("write / read / clear round-trip", () => {
    expect(readSpawnMarkers(dir)).toEqual([]);
    writeSpawnMarker(marker(), dir);
    expect(readSpawnMarkers(dir)).toEqual([marker()]);
    clearSpawnMarker("a1", dir);
    expect(readSpawnMarkers(dir)).toEqual([]);
  });

  test("readSpawnMarkers on a missing dir returns []", () => {
    expect(readSpawnMarkers(join(dir, "nope"))).toEqual([]);
  });

  test("clearSpawnMarker is idempotent", () => {
    expect(() => clearSpawnMarker("ghost", dir)).not.toThrow();
  });

  test("reconcile marks broken + clears for a dead-pid marker (no orphan to kill)", () => {
    const reg = new FakeRegistry();
    reg.agents.add("a1");
    writeSpawnMarker(marker({ pid: 999999 }), dir); // pid not alive
    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);
    expect(reg.states.get("a1")).toBe("broken");
    expect(readSpawnMarkers(dir)).toEqual([]);
  });

  test("reconcile SIGTERMs a live orphan, then marks broken + clears", async () => {
    const reg = new FakeRegistry();
    reg.agents.add("a2");
    const child = spawn("sleep", ["30"]);
    await wait(20); // let it come up
    expect(child.pid && isAlive(child.pid)).toBe(true);
    writeSpawnMarker(marker({ agentId: "a2", pid: child.pid ?? 0 }), dir);

    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);

    expect(reg.states.get("a2")).toBe("broken");
    expect(readSpawnMarkers(dir)).toEqual([]);
    await wait(50);
    expect(child.pid && isAlive(child.pid)).toBe(false); // orphan was killed
  });

  test("reconcile clears a marker for an unknown agent without marking it", () => {
    const reg = new FakeRegistry(); // a3 not registered (archived/deleted)
    writeSpawnMarker(marker({ agentId: "a3", pid: 999999 }), dir);
    reconcileSpawnMarkers(reg as unknown as AgentRegistry, dir);
    expect(reg.states.has("a3")).toBe(false);
    expect(readSpawnMarkers(dir)).toEqual([]);
  });
});
