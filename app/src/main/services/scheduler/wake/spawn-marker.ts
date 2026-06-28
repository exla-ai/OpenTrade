import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENTRADE_HOME } from "../../../db/client";
import { hostLog } from "../../../host/log";
import { isAlive } from "../../../host/manifest";
import type { AgentRegistry } from "../../agents/registry";

/**
 * Durable single-writer marker for cold (headless `-p`) wake runs. A marker file exists
 * exactly while a headless child is live: written right after spawn, removed on exit.
 *
 * Its purpose is crash recovery. `executionState` is in-memory and reset on boot, so a
 * `-p` child orphaned by a host crash would be invisible — and a fresh wake could spawn a
 * second `claude --resume <same uuid>` (two writers on one transcript, E1). A clean
 * shutdown kills children + clears markers, so a *surviving* marker on boot means the
 * previous host crashed mid-wake; `reconcileSpawnMarkers` handles that.
 *
 * Marker files (not a DB column): the `agents` table has no migration system, and this
 * matches the existing `host.json`/`host.lock` lockfile idiom (see `host/manifest.ts`).
 */
export interface SpawnMarker {
  agentId: string;
  pid: number;
  sessionId: string;
  startedAt: number;
}

/** Default location: `OPENTRADE_HOME/wake-runs/`. Injectable for tests. */
function wakeRunsDir(): string {
  return join(OPENTRADE_HOME, "wake-runs");
}

function markerPath(dir: string, agentId: string): string {
  return join(dir, `${encodeURIComponent(agentId)}.json`);
}

/** Record that a headless wake child is live for an agent. */
export function writeSpawnMarker(marker: SpawnMarker, dir = wakeRunsDir()): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(markerPath(dir, marker.agentId), JSON.stringify(marker), { mode: 0o600 });
  } catch (err) {
    hostLog.warn("writeSpawnMarker failed", marker.agentId, String(err));
  }
}

/** Clear an agent's spawn marker (the headless child exited). Idempotent. */
export function clearSpawnMarker(agentId: string, dir = wakeRunsDir()): void {
  try {
    unlinkSync(markerPath(dir, agentId));
  } catch {
    // already gone
  }
}

/** Every surviving spawn marker (used by the boot reconcile). Corrupt files are dropped. */
export function readSpawnMarkers(dir = wakeRunsDir()): SpawnMarker[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // dir missing → nothing was in flight
  }
  const out: SpawnMarker[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, name), "utf8")) as SpawnMarker;
      if (m && typeof m.agentId === "string" && typeof m.pid === "number") out.push(m);
    } catch {
      try {
        unlinkSync(join(dir, name));
      } catch {
        // best effort
      }
    }
  }
  return out;
}

/**
 * Boot recovery for headless wake runs orphaned by an unclean host exit (crash). A
 * surviving marker means the previous host died mid-wake without clearing it. We do NOT
 * respawn: if the orphan is still alive we SIGTERM it (restore the single-writer
 * invariant), then mark the agent `broken` so the user Restarts with a fresh session.
 * (A dead orphan is just cleared — the crash already warranted surfacing the agent.)
 */
export function reconcileSpawnMarkers(registry: AgentRegistry, dir = wakeRunsDir()): void {
  for (const m of readSpawnMarkers(dir)) {
    if (isAlive(m.pid)) {
      hostLog.warn(
        "orphaned headless wake survived a host crash; killing",
        m.agentId,
        `pid=${m.pid}`,
      );
      try {
        process.kill(m.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    if (registry.get(m.agentId)) {
      hostLog.warn("marking agent broken after an interrupted wake (host crash)", m.agentId);
      registry.setExecutionState(m.agentId, "broken");
    }
    clearSpawnMarker(m.agentId, dir);
  }
}
