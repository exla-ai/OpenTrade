import type { ExecutionState } from "@shared/agent";
import { hostLog } from "../../../host/log";
import type { AgentRegistry } from "../../agents/registry";
import type { HeadlessExitReason, HeadlessWakeStrategy, WakeTransport } from "./types";

/** Hard ceiling on a single headless run, INCLUDING time parked at the approval gate.
 *  The only timer in the wake layer. On expiry we SIGTERM the child; its exit drives
 *  `headlessExited`. (If the kill lands mid-approval, the severed gate curl trips the
 *  existing `req.on("close")` → ApprovalService.abandon, so no row corruption.) */
const MAX_HEADLESS_RUN_MS = 30 * 60_000;
/** Consecutive headless resume-fails before an agent is declared unresumable. Each
 *  failure drops its own wake; the Nth in a row flips the agent to `broken`. Any clean
 *  exit resets the streak — normal timeouts throughout, no backoff. */
const MAX_RESUME_FAILS = 3;

/**
 * Per-agent state machine. One state at a time, 1:1 with the four `executionState`
 * values the renderer consumes:
 *  - `OFFLINE`             — no live PTY; wakes drain via the `-p` transport
 *  - `INTERACTIVE_RUNNING` — a live PTY exists; wakes deliver via `claude/channel`
 *  - `HEADLESS_RUNNING`    — a `-p` child is delivering the head (kill timer armed)
 *  - `BROKEN`              — unresumable (3 consecutive resume-fails, or a spawn error)
 */
type WriterState = "OFFLINE" | "INTERACTIVE_RUNNING" | "HEADLESS_RUNNING" | "BROKEN";

const TO_EXECUTION_STATE: Record<WriterState, ExecutionState> = {
  OFFLINE: "offline",
  INTERACTIVE_RUNNING: "interactive",
  HEADLESS_RUNNING: "headless",
  BROKEN: "broken",
};

/**
 * The per-agent wake actor. Owns ONE FIFO queue (`pending`) drained through one of two
 * delivery transports — the `claude/channel` while a PTY is live, or a headless
 * `claude --resume -p` child while none is. The transports differ in exactly one
 * property: **when the head leaves the queue**.
 *  - **channel (interactive):** advance on *handoff* — the instant the head is handed
 *    to a parked poll it shifts out, because the channel owns ordered, reliable
 *    delivery from there (no lock, no completion-gate, no turn-awareness).
 *  - **`-p` (headless):** advance on *exit* — the head stays at `pending[0]` until the
 *    child exits, so a crash mid-run never loses it (the single-writer "no lost wake").
 *
 * The actor's state IS the agent's `executionState` (pushed to the registry on every
 * transition); there is no internal-vs-UI projection.
 */
class AgentWriter {
  private state: WriterState = "OFFLINE";
  /** The one wake queue (FIFO). Advanced on handoff (interactive) or on exit (headless). */
  private pending: string[] = [];
  /** A currently-parked `/wake-stream` long-poll (one poller per agent), or undefined. */
  private interactivePoll?: (prompt: string | null) => void;
  /** Max-runtime kill for the active `-p` child (HEADLESS_RUNNING only). */
  private headlessKillTimer?: NodeJS.Timeout;
  /** Consecutive headless resume-fails; reset by any clean exit. */
  private resumeFailCount = 0;
  /** Set when a user Stop SIGTERMs an in-flight child, so its exit is treated as a
   *  deliberate stop (→ OFFLINE) rather than a resume failure. */
  private stopping = false;

  constructor(
    private id: string,
    private registry: AgentRegistry,
    private headless: HeadlessWakeStrategy,
    private maxHeadlessRunMs: number,
  ) {
    // Seed BROKEN from a boot-time spawn-marker reconcile: single-writer crash recovery
    // sets `executionState = broken` directly, before this coordinator exists.
    if (registry.executionStateOf(id) === "broken") this.state = "BROKEN";
  }

  // ---- producer / consumer ----

  /** A wake was produced (cron/monitor fire). Route by state. */
  enqueue(prompt: string): void {
    switch (this.state) {
      case "OFFLINE":
        this.pending.push(prompt);
        this.startHeadless();
        break;
      case "INTERACTIVE_RUNNING":
        this.pending.push(prompt);
        this.serveInteractive(); // hand to a parked poll if one's waiting
        break;
      case "HEADLESS_RUNNING":
        this.pending.push(prompt); // drains when the active child exits
        break;
      case "BROKEN":
        // Unresumable; drop. A recurring cron re-fires after a manual Restart.
        hostLog.warn("dropping wake for broken agent", this.id);
        break;
    }
  }

  /** The `/wake-stream` consumer parks here. Served only in INTERACTIVE_RUNNING (the
   *  channel transport); in every other state the poll parks inertly (a headless `-p`
   *  run's MCP also polls, but its channel is inert and must never be served). */
  awaitPoll(signal: AbortSignal, holdMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const finish = (prompt: string | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (this.interactivePoll === handoff) this.interactivePoll = undefined;
        resolve(prompt);
      };
      const handoff = (prompt: string | null) => finish(prompt);
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), holdMs);
      signal.addEventListener("abort", onAbort);
      this.interactivePoll = handoff; // one poller per agent; replace any stale one
      this.serveInteractive(); // serve immediately if a wake is already queued
    });
  }

  // ---- PTY lifecycle (reported by TerminalService) ----

  onInteractiveUp(): void {
    if (this.state === "HEADLESS_RUNNING") return; // single-writer: no PTY during a `-p` run
    this.resumeFailCount = 0; // a fresh interactive session is healthy
    this.transition("INTERACTIVE_RUNNING");
    this.serveInteractive();
  }

  onInteractiveDown(): void {
    if (this.state !== "INTERACTIVE_RUNNING") return;
    // The live writer is gone; the head + any queued wakes re-route to the `-p` transport.
    this.transition("OFFLINE");
    this.drain();
  }

  // ---- EC1 stop / shutdown ----

  /** EC1 "Stop task" / archive: drop queued wakes + end any active headless run. The
   *  interactive session itself is torn down by TerminalService, not here. */
  stop(): boolean {
    this.pending = [];
    if (this.interactivePoll) {
      const poll = this.interactivePoll;
      this.interactivePoll = undefined;
      poll(null);
    }
    // Only a headless run can be stopped (single-writer: a child is alive iff
    // HEADLESS_RUNNING). Its exit is then a deliberate stop, not a resume failure.
    if (this.state !== "HEADLESS_RUNNING") return false;
    this.stopping = true;
    this.clearKillTimer();
    return this.headless.stop(this.id);
  }

  /** Host shutdown: clear the kill timer (the children are SIGTERM'd via stopAll). */
  dispose(): void {
    this.clearKillTimer();
  }

  // ---- internals ----

  /** Hand the queue head to a parked poll, if both a poll and a wake are present and a
   *  PTY is live. Advance-on-handoff: the head shifts out the instant it's handed off. */
  private serveInteractive(): void {
    if (this.state !== "INTERACTIVE_RUNNING") return;
    if (!this.interactivePoll || this.pending.length === 0) return;
    const poll = this.interactivePoll;
    const head = this.pending.shift()!;
    poll(head); // resolves the parked /wake-stream long-poll; finish() clears the slot
  }

  /** OFFLINE with a queued wake → start the `-p` transport for the head. */
  private drain(): void {
    if (this.state !== "OFFLINE" || this.pending.length === 0) return;
    this.startHeadless();
  }

  private startHeadless(): void {
    this.transition("HEADLESS_RUNNING");
    this.armKillTimer();
    const head = this.pending[0]; // kept at the head until exit (no lost wake on crash)
    this.headless.run(this.id, head, (reason) => this.headlessExited(reason));
  }

  private headlessExited(reason: HeadlessExitReason): void {
    this.clearKillTimer();
    if (this.stopping) {
      // A deliberate user Stop killed the child — don't count it as a resume failure.
      this.stopping = false;
      this.transition("OFFLINE");
      this.drain(); // in case a fresh wake arrived during the stop window
      return;
    }
    if (reason === "spawnFail") {
      // A spawn error is a config fault, not a flaky session: one-strike broken.
      this.pending = [];
      this.transition("BROKEN");
      return;
    }
    if (reason === "resumeFail") {
      this.pending.shift(); // drop the failed wake
      this.resumeFailCount += 1;
      if (this.resumeFailCount >= MAX_RESUME_FAILS) {
        this.pending = []; // genuinely unresumable — drop the rest
        this.transition("BROKEN");
        return;
      }
      this.transition("OFFLINE");
      this.drain();
      return;
    }
    // ok (clean exit, or the max-runtime backstop): complete the head, drain the next.
    this.resumeFailCount = 0;
    this.pending.shift();
    this.transition("OFFLINE");
    this.drain();
  }

  private armKillTimer(): void {
    this.clearKillTimer();
    this.headlessKillTimer = setTimeout(() => {
      hostLog.warn("headless run exceeded max runtime; killing", this.id);
      this.headless.stop(this.id); // SIGTERM; its exit drives headlessExited(ok)
    }, this.maxHeadlessRunMs);
  }

  private clearKillTimer(): void {
    if (this.headlessKillTimer) {
      clearTimeout(this.headlessKillTimer);
      this.headlessKillTimer = undefined;
    }
  }

  /** Set the state and publish it as the agent's `executionState` (1:1, no projection). */
  private transition(next: WriterState): void {
    this.state = next;
    this.registry.setExecutionState(this.id, TO_EXECUTION_STATE[next]);
  }
}

/**
 * The single authority for agent wake delivery: owns a `Map<agentId, AgentWriter>` and
 * fans the seam's calls to the right per-agent actor. `Scheduler` enqueues via
 * `enqueue`; the `/wake-stream` HTTP long-poll consumes via `awaitPoll`;
 * `TerminalService` reports PTY up/down via `onInteractiveUp`/`onInteractiveDown`.
 *
 * Each `AgentWriter` is one queue drained through two transports (channel vs `-p`),
 * differing only in their advance point — see {@link AgentWriter}.
 */
export class WakeCoordinator implements WakeTransport {
  private writers = new Map<string, AgentWriter>();

  constructor(
    private registry: AgentRegistry,
    private headless: HeadlessWakeStrategy,
    private maxHeadlessRunMs = MAX_HEADLESS_RUN_MS,
  ) {}

  private writer(id: string): AgentWriter {
    let w = this.writers.get(id);
    if (!w) {
      w = new AgentWriter(id, this.registry, this.headless, this.maxHeadlessRunMs);
      this.writers.set(id, w);
    }
    return w;
  }

  enqueue(agentId: string, prompt: string): void {
    this.writer(agentId).enqueue(prompt);
  }

  awaitPoll(agentId: string, signal: AbortSignal, holdMs: number): Promise<string | null> {
    return this.writer(agentId).awaitPoll(signal, holdMs);
  }

  onInteractiveUp(agentId: string): void {
    this.writer(agentId).onInteractiveUp();
  }

  onInteractiveDown(agentId: string): void {
    // No writer ⇒ nothing ever queued for this agent; a stray PTY exit is a no-op.
    this.writers.get(agentId)?.onInteractiveDown();
  }

  stop(agentId: string): boolean {
    return this.writers.get(agentId)?.stop() ?? false;
  }

  stopAll(): void {
    for (const w of this.writers.values()) w.dispose();
    this.headless.stopAll();
  }
}
