import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostLog } from "../../../host/log";
import type { AgentRegistry } from "../../agents/registry";
import type { LocalApiServer } from "../../local-api";
import { buildAgentEnv } from "../../terminal/env";
import { clearSpawnMarker, writeSpawnMarker } from "./spawn-marker";
import type { HeadlessExitReason, HeadlessWakeStrategy } from "./types";

/** A `--resume` of an unresumable session errors out almost immediately; a
 *  non-zero exit within this window is reported as a resume failure (→ the
 *  coordinator's resume-fail streak). */
const RESUME_FAIL_MS = 10_000;
/** Prepended to a cold (headless) wake prompt so the agent can tell a system wake from a
 *  real user turn. The agent templates' CLAUDE.md document what it means. The wake's
 *  fire time (ISO 8601) is appended so the agent knows *when* it was woken — relevant for
 *  trading decisions (market hours, staleness) and for reasoning across catch-up fires. */
const WAKE_PREFIX = "OPENTRADE WAKE";

/**
 * The headless transport (the autonomy backbone). Spawns a one-shot
 * `claude --resume <uuid> -p "<prompt>"` backend child: it resumes the agent's
 * on-disk conversation, does the task, and exits. No PTY, no output capture — the
 * run's detail lives in the resumable transcript; only the wake row in the Run
 * History feed is recorded.
 *
 * Runs with `--dangerously-skip-permissions` so the agent's non-order tools
 * (journaling, watch scripts, reads) execute without an interactive prompt — the
 * order-placing tools stay gated by the PreToolUse approval hook, which fires and can
 * `deny` even under this flag (validated in Phase 0).
 *
 * The strategy doesn't own state or timers: it spawns, classifies the exit, and
 * reports `ok | resumeFail | spawnFail` to the coordinator (which owns the queue, the
 * resume-fail streak, and the max-runtime kill timer).
 */
export class HeadlessRunStrategy implements HeadlessWakeStrategy {
  /** Active headless children by agent id, so the "Stop task" button + the
   *  coordinator's max-runtime kill can SIGTERM one. */
  private children = new Map<string, ChildProcess>();

  constructor(
    private registry: AgentRegistry,
    private localApi: LocalApiServer,
  ) {}

  /** EC1 "Stop task" / max-runtime kill: SIGTERM the running headless child; its exit
   *  reports the outcome. Returns whether a child was actually signalled. */
  stop(agentId: string): boolean {
    const child = this.children.get(agentId);
    if (!child) return false;
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    return true;
  }

  /**
   * Clean host shutdown: SIGTERM every live headless child and clear its marker, so the
   * next boot doesn't mistake an in-flight run for a crash orphan (which would flip the
   * agent to `broken`). Markers are cleared eagerly here because the host exits right
   * after — the children's own exit handlers may not run in time.
   */
  stopAll(): void {
    for (const [agentId, child] of this.children) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      clearSpawnMarker(agentId);
    }
    this.children.clear();
  }

  run(agentId: string, prompt: string, onExit: (reason: HeadlessExitReason) => void): void {
    const agent = this.registry.get(agentId);
    // Archived/missing agent — nothing to run; report a clean completion so the
    // coordinator releases the head and returns to OFFLINE.
    if (!agent || agent.archivedAt !== null) {
      onExit("ok");
      return;
    }

    // I3: OpenTrade owns the session id. Resume the known one, or mint+store one for a
    // never-started agent (begins the conversation headlessly).
    let resuming = false;
    let sessionId: string;
    let sessionArgs: string[];
    if (agent.lastSessionId) {
      sessionId = agent.lastSessionId;
      sessionArgs = ["--resume", sessionId];
      resuming = true;
    } else {
      sessionId = randomUUID();
      this.registry.setLastSessionId(agentId, sessionId);
      sessionArgs = ["--session-id", sessionId];
    }

    // A headless `-p` wake lands as a plain user turn — indistinguishable from a real
    // user message. Prefix it (with the fire timestamp) so the agent knows the system woke
    // it and when (CLAUDE.md explains the marker). The interactive path needs no prefix: it
    // self-identifies as `<channel source="opentrade">`.
    const startedAt = Date.now();
    const wakePrompt = `[${WAKE_PREFIX} ${new Date(startedAt).toISOString()}] ${prompt}`;
    const args = [...sessionArgs, "--dangerously-skip-permissions", "-p", wakePrompt];
    const env = buildAgentEnv(agentId, {
      OPENTRADE_PORT: String(this.localApi.port),
      OPENTRADE_TOKEN: this.localApi.token,
    });

    const child = spawn("claude", args, {
      cwd: this.registry.agentDir(agent),
      env,
      stdio: "ignore",
    });
    this.children.set(agentId, child);
    // Durable single-writer marker (crash recovery, E1): exists while this child is
    // live. A surviving marker on the next boot ⇒ the host crashed mid-wake.
    if (child.pid) writeSpawnMarker({ agentId, pid: child.pid, sessionId, startedAt });

    // Report the outcome exactly once (error and exit can't both meaningfully fire).
    let settled = false;
    const settle = (reason: HeadlessExitReason) => {
      if (settled) return;
      settled = true;
      this.children.delete(agentId);
      clearSpawnMarker(agentId);
      onExit(reason);
    };

    child.on("error", (err) => {
      hostLog.error("headless spawn failed", agentId, String(err));
      settle("spawnFail");
    });
    child.on("exit", (code) => {
      if (resuming && code !== 0 && Date.now() - startedAt < RESUME_FAIL_MS) {
        // EC13: the session was unresumable. Reported as a resume-fail — the coordinator
        // drops the wake and, after 3 in a row, flips the agent to `broken`.
        hostLog.warn("headless resume failed", agentId, `code=${code}`);
        settle("resumeFail");
      } else {
        settle("ok");
      }
    });
  }
}
