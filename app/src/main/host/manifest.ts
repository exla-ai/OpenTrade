import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { basename, dirname, join } from "node:path";
import { OPENTRADE_HOME } from "../db/client";

/**
 * Discovery + supervision for the persistent backend host.
 *
 * The host is a singleton per OPENTRADE_HOME. The launcher (Electron app) and any
 * other starter use `ensureHost()` to adopt a live host or spawn one — guarded by
 * an exclusive lockfile so two concurrent starters (e.g. a GUI launch racing a
 * CLI/test) can never spawn two backends that fight over the stable faucet port.
 */
export interface HostManifest {
  pid: number;
  /** Stable faucet/approval-gate port (baked into agent PTYs). */
  faucetPort: number;
  /** tRPC HTTP/WS port for the GUI (discovered here; need not be stable). */
  trpcPort: number;
  /** Shared bearer token (faucet + tRPC + terminal WS). */
  token: string;
  startedAt: number;
  /**
   * App version the host was built from (= `app.getVersion()` at spawn). The
   * launcher only adopts a host whose version matches its own; after an
   * auto-update the old detached host keeps running old code, so a mismatch
   * forces a clean respawn (see `ensureHost`). Optional for forward-compat:
   * a manifest without it is treated as version "0.0.0".
   */
  version?: string;
}

const MANIFEST_FILE = join(OPENTRADE_HOME, "host.json");
const LOCK_FILE = join(OPENTRADE_HOME, "host.lock");

export function readManifest(): HostManifest | null {
  try {
    return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as HostManifest;
  } catch {
    return null;
  }
}

export function writeManifest(m: HostManifest): void {
  writeFileSync(MANIFEST_FILE, JSON.stringify(m), { mode: 0o600 });
}

export function clearManifest(): void {
  try {
    unlinkSync(MANIFEST_FILE);
  } catch {
    // already gone
  }
}

/** Whether a pid is alive (signal 0 throws ESRCH when the process is gone). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Ping the host's faucet /health (no token needed) to confirm it's serving. */
export function pingHost(faucetPort: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: "127.0.0.1", port: faucetPort, path: "/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** A live, reachable host for this home — or null. */
export async function liveHost(): Promise<HostManifest | null> {
  const m = readManifest();
  if (m && isAlive(m.pid) && (await pingHost(m.faucetPort))) return m;
  return null;
}

const versionOf = (m: HostManifest): string => m.version ?? "0.0.0";

/**
 * Retire a host whose code is stale (its version differs from the launcher's —
 * e.g. right after an auto-update, when the old detached host is still running).
 * SIGTERM it and wait for it to exit (it has a graceful handler that clears the
 * manifest), so the fresh build can reclaim the stable faucet port and spawn a
 * host running the new code.
 */
async function terminateStaleHost(m: HostManifest): Promise<void> {
  try {
    process.kill(m.pid, "SIGTERM");
  } catch {
    // already gone
  }
  for (let i = 0; i < 50; i++) {
    if (!isAlive(m.pid)) break;
    await delay(100);
  }
  clearManifest();
}

/**
 * Acquire the exclusive spawn lock (O_EXCL). Reclaims a stale lock whose holder
 * pid is dead. Returns a release fn, or null if another live starter holds it.
 */
function acquireLock(): (() => void) | null {
  try {
    const fd = openSync(LOCK_FILE, "wx");
    writeFileSync(LOCK_FILE, String(process.pid));
    return () => {
      try {
        closeSync(fd);
      } catch {}
      try {
        unlinkSync(LOCK_FILE);
      } catch {}
    };
  } catch {
    // Lock exists — reclaim if the holder is dead.
    const holder = Number(safeRead(LOCK_FILE));
    if (Number.isInteger(holder) && holder > 0 && !isAlive(holder)) {
      try {
        unlinkSync(LOCK_FILE);
      } catch {}
      return acquireLock();
    }
    return null;
  }
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Max consecutive spawn attempts before giving up (crash circuit-breaker). */
let spawnFailures = 0;
const MAX_SPAWN_FAILURES = 3;

/**
 * Adopt a live host or spawn one. Safe under concurrency: the spawn path runs
 * under an exclusive lock and re-checks for a live host inside it.
 *
 * @param hostEntry absolute path to the bundled host.js
 * @param expectedVersion the launcher's app version; a live host whose version
 *   differs is retired and respawned (so an auto-update's new code actually runs).
 *   Defaults to `OPENTRADE_VERSION` (which the launcher sets to `app.getVersion()`).
 */
export async function ensureHost(
  hostEntry: string,
  expectedVersion: string = process.env.OPENTRADE_VERSION ?? "0.0.0",
): Promise<HostManifest> {
  // Adopt only a host running the same version; retire a stale one before spawning.
  const adopt = async (): Promise<HostManifest | null> => {
    const m = await liveHost();
    if (!m) return null;
    if (versionOf(m) === expectedVersion) return m;
    await terminateStaleHost(m);
    return null;
  };

  const fast = await adopt();
  if (fast) return fast;

  // Acquire the spawn lock; if another starter holds it, wait for the host it's
  // bringing up rather than spawning our own.
  let release = acquireLock();
  for (let i = 0; i < 50 && !release; i++) {
    await delay(100);
    const adopted = await adopt();
    if (adopted) return adopted;
    release = acquireLock();
  }
  if (!release) {
    const m = await adopt();
    if (m) return m;
    throw new Error("could not acquire host spawn lock");
  }

  try {
    // Re-check inside the lock.
    const inside = await adopt();
    if (inside) return inside;

    if (spawnFailures >= MAX_SPAWN_FAILURES) {
      throw new Error(`backend host failed to start ${spawnFailures}× — giving up (see host.log)`);
    }

    clearManifest();
    spawnHost(hostEntry);

    // Wait for the host to write a fresh manifest and start serving.
    for (let i = 0; i < 100; i++) {
      await delay(100);
      const m = readManifest();
      if (m && isAlive(m.pid) && (await pingHost(m.faucetPort))) {
        spawnFailures = 0;
        return m;
      }
    }
    spawnFailures++;
    throw new Error("backend host did not start within timeout (see host.log)");
  } finally {
    release();
  }
}

/**
 * The Electron binary to launch the detached host with. On macOS, spawning the
 * host from the **main app binary** (`process.execPath`) makes LaunchServices
 * check it in as a second *Foreground* app — a spurious "OpenTrade" dock icon with
 * the generic executable icon (`ELECTRON_RUN_AS_NODE` doesn't prevent this for a
 * detached launch of the bundle's main Mach-O). The bundled **`<Product> Helper.app`**
 * has `LSUIElement = true` in its Info.plist, so running the host from it stays
 * dockless. Falls back to `process.execPath` (dev / non-mac / helper missing).
 */
function hostLauncherBinary(): string {
  if (process.platform === "darwin") {
    const product = basename(process.execPath); // e.g. "OpenTrade" (or "Electron" in dev)
    const helper = join(
      dirname(process.execPath), // .../Contents/MacOS
      "..",
      "Frameworks",
      `${product} Helper.app`,
      "Contents",
      "MacOS",
      `${product} Helper`,
    );
    if (existsSync(helper)) return helper;
  }
  return process.execPath;
}

function spawnHost(hostEntry: string): void {
  if (!existsSync(hostEntry)) throw new Error(`host entry not found: ${hostEntry}`);
  const child = spawn(hostLauncherBinary(), [hostEntry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", OPENTRADE_HOME },
  });
  child.unref();
}
