import { type ChildProcess, spawn } from "node:child_process";

/** Min interval between wakes from a single monitor (mirrors native Monitor's debounce). */
const DEFAULT_RATE_LIMIT_MS = 30_000;
const INITIAL_RESTART_MS = 1_000;
const MAX_RESTART_MS = 60_000;
/** A child that survives this long is considered healthy → reset the backoff. */
const HEALTHY_AFTER_MS = 10_000;

/**
 * A supervised backend child for one monitor. Each non-empty stdout line is a
 * trigger (rate-limited), exactly like Claude Code's native Monitor — except this
 * runs in the always-on host, so signal wakes fire with the GUI closed. The child
 * is restarted with exponential backoff if it exits; `stop()` ends supervision.
 */
export class MonitorRunner {
  private child: ChildProcess | null = null;
  private stopped = false;
  private buf = "";
  private lastFire = 0;
  private restartDelay = INITIAL_RESTART_MS;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(
    private opts: {
      command: string;
      cwd: string;
      env: Record<string, string>;
      onTrigger: (line: string) => void;
      rateLimitMs?: number;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.spawnChild();
  }

  private spawnChild(): void {
    if (this.stopped) return;
    this.startedAt = Date.now();
    const child = spawn(this.opts.command, {
      shell: true,
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.on("error", () => {
      /* spawn failure surfaces via the exit handler's restart */
    });
    child.on("exit", () => {
      this.child = null;
      if (this.stopped) return;
      // Reset backoff if the child ran long enough to be considered healthy.
      if (Date.now() - this.startedAt > HEALTHY_AFTER_MS) this.restartDelay = INITIAL_RESTART_MS;
      this.restartTimer = setTimeout(() => this.spawnChild(), this.restartDelay);
      this.restartDelay = Math.min(this.restartDelay * 2, MAX_RESTART_MS);
    });
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) this.maybeFire(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private maybeFire(line: string): void {
    const now = Date.now();
    if (now - this.lastFire < (this.opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS)) return;
    this.lastFire = now;
    this.opts.onTrigger(line);
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        // already gone
      }
      this.child = null;
    }
  }
}
