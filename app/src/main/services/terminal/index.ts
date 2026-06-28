import { randomUUID } from "node:crypto";
import type { Agent, ExecutionState } from "@shared/agent";
import { TerminalWsServer } from "../../pty-daemon/ws-server";
import { buildTerminalWsUrl } from "../../pty-daemon/ws-url";
import type { AgentRegistry } from "../agents/registry";
import { bus } from "../event-bus";
import type { LocalApiServer } from "../local-api";
import type { WakeTransport } from "../scheduler/wake/types";
import type { StatusArbiter } from "../status/arbiter";
import { buildAgentEnv } from "./env";
import { TerminalManager } from "./manager";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;
const IDLE_AFTER_MS = 1500;
/**
 * A `claude --resume` launch that exits within this window almost always means
 * there was no resumable conversation (the user killed/exited the prior session),
 * so Claude Code printed "no conversation to continue" and bailed. We detect that
 * and transparently respawn a fresh `claude` instead of stranding a dead pane.
 */
const RESPAWN_GUARD_MS = 8000;

/** What we last launched for a session, used to decide on auto-respawn. */
interface LaunchInfo {
  continued: boolean;
  at: number;
}

/**
 * Owns each agent's persistent Claude Code PTY (in-process in the backend host)
 * and drives its working/idle status. The renderer streams terminal output over a
 * direct WebSocket to the host's terminal data plane (see `wsEndpointFor`); the
 * status heuristic rides the TerminalManager's `output`/`exit` events.
 *
 * Interactive PTYs exist only while the GUI is open. The host detects the GUI going
 * away (`gui:gone`, reliable across window-close / Cmd-Q / crash) and **blanket-kills**
 * every interactive PTY immediately — no graceful, turn-aware deferral. Each kill's
 * exit reports `onInteractiveDown` to the wake coordinator, which re-routes any queued
 * wakes to the headless transport (`HeadlessRunStrategy`), so autonomy continues
 * outside the GUI with nothing stranded.
 */
export class TerminalService {
  private manager = new TerminalManager();
  private wsServer: TerminalWsServer;
  private idleTimers = new Map<string, NodeJS.Timeout>();
  /** Most recent launch per session, to detect a dead `--resume` resume. */
  private launches = new Map<string, LaunchInfo>();

  constructor(
    private registry: AgentRegistry,
    private localApi: LocalApiServer,
    private arbiter: StatusArbiter,
    private wake: WakeTransport,
  ) {
    // Terminal bytes ride a WS sharing the host's bearer token.
    this.wsServer = new TerminalWsServer(this.manager.store, this.localApi.token);
    this.manager.on("output", ({ id }: { id: string }) => this.markWorking(id));
    this.manager.on("exit", ({ id }: { id: string }) => {
      this.clearIdleTimer(id);
      this.arbiter.setPty(id, "idle");
      // A dead `--resume` is transparently respawned (the writer stays up); otherwise the
      // interactive writer is gone — tell the coordinator so it re-routes queued wakes
      // (now eligible to run headless) and republishes `executionState`.
      if (!this.maybeRespawnFresh(id)) this.wake.onInteractiveDown(id);
    });
    // The GUI went away (window-close / Cmd-Q / crash, detected host-side) → blanket-kill
    // every interactive PTY so none is maintained outside the GUI (EC5/BUG-1). Quitting
    // mid-turn interrupts that turn (accepted: the conversation resumes and crons re-fire).
    bus.onEvent("gui:gone", () => this.teardownOnGuiGone());
  }

  /** Bring up the terminal WebSocket data plane (called once by the host). */
  async start(): Promise<void> {
    await this.wsServer.listen();
  }

  /**
   * Ensure the agent's persistent session exists (spawn on first run / resume).
   * The renderer attaches separately over its WebSocket (with replay); status is
   * tracked from the manager's output/exit events, so there's no extra attach here.
   */
  async openOrAttach(
    agent: Agent,
    cols = DEFAULT_COLS,
    rows = DEFAULT_ROWS,
    intent: "auto" | "resume" = "auto",
  ): Promise<{ alive: boolean; state: ExecutionState }> {
    const state = this.registry.executionStateOf(agent.id);
    // I1 single-writer: never spawn an interactive PTY alongside a headless run
    // (EC1) or for an unresumable session (EC13) — the renderer shows an overlay
    // for these, driven by `executionState` from the agents subscription.
    if (state === "headless" || state === "broken") return { alive: false, state };
    if (!this.manager.isLive(agent.id)) this.spawn(agent, intent, cols, rows);
    return { alive: true, state: "interactive" };
  }

  /**
   * Spawn the agent's `claude` PTY. OpenTrade owns the session id (I3): it mints a
   * UUID via `--session-id` at first start and `--resume`s it thereafter. `intent`:
   *  - `auto`   first run → `--session-id <uuid> "<kickoff>"`; otherwise `--resume <uuid>`
   *  - `resume` `--resume <uuid>` (the Resume button); mints if none yet
   *  - `fresh`  brand-new `--session-id <uuid>`, no kickoff (auto-respawn / restart)
   *
   * Every interactive PTY loads the `opentrade` channel so a scheduled wake injects
   * into the live session: the `--dangerously-load-development-channels` flag is what
   * registers the channel. (The agent MCP server runs in channel mode by default;
   * headless `-p` runs just don't pass the dev flag, so their channel is inert.)
   */
  private spawn(agent: Agent, intent: "auto" | "resume" | "fresh", cols: number, rows: number) {
    const dir = this.registry.agentDir(agent);
    // `--dangerously-load-development-channels` is a VARIADIC flag (`<servers...>`):
    // passed as two argv tokens (`--flag server:opentrade`) it greedily consumes every
    // following non-`-` token — including the positional kickoff prompt on first run.
    // Claude then parses the whole kickoff as a second channel spec, fails, prints the
    // channel-format usage, and exits immediately (the first-run "session ended — Resume
    // to continue" bug; resume/headless escaped it only because they have no trailing
    // positional). The `=`-bound single-value form binds exactly one channel and stops
    // the variadic there, so the kickoff stays a normal positional prompt.
    const channelArgs = ["--dangerously-load-development-channels=server:opentrade"];
    let args: string[];
    if (intent === "fresh") {
      args = ["--session-id", this.mintSessionId(agent.id), ...channelArgs];
    } else if (intent === "resume") {
      args = agent.lastSessionId
        ? ["--resume", agent.lastSessionId, ...channelArgs]
        : ["--session-id", this.mintSessionId(agent.id), ...channelArgs];
    } else if (this.registry.hasStarted(agent.id) && agent.lastSessionId) {
      args = ["--resume", agent.lastSessionId, ...channelArgs];
    } else {
      const sid = agent.lastSessionId ?? this.mintSessionId(agent.id);
      const kickoff = this.registry.readKickoff(agent);
      // The kickoff is the positional prompt, placed after all flags. Safe only because
      // `channelArgs` uses the `=`-bound form above (a bare variadic would swallow it).
      args = ["--session-id", sid, ...channelArgs, ...(kickoff ? [kickoff] : [])];
      this.registry.markStarted(agent.id);
    }

    const env = buildAgentEnv(agent.id, {
      OPENTRADE_PORT: String(this.localApi.port),
      OPENTRADE_TOKEN: this.localApi.token,
      // Force Claude Code's fullscreen ("no-flicker") renderer for interactive PTYs:
      // it draws on the alternate screen buffer and handles its own scrollback instead
      // of spilling into the terminal's, which keeps memory flat and rendering clean in
      // our embedded xterm. Equivalent to the saved `tui` setting, but enforced here so
      // every session we launch gets it regardless of the user's config.
      // https://code.claude.com/docs/en/fullscreen
      CLAUDE_CODE_NO_FLICKER: "1",
    });
    this.manager.open(agent.id, { command: "claude", args, cwd: dir, env, cols, rows });
    this.launches.set(agent.id, { continued: args.includes("--resume"), at: Date.now() });
    // A live PTY is the interactive transport — tell the coordinator (it publishes
    // `executionState = interactive`). Synchronous, so it's set before the agent's MCP
    // could poll `/wake-stream`.
    this.wake.onInteractiveUp(agent.id);
  }

  /** Mint and persist a fresh session id OpenTrade owns for this agent (I3). */
  private mintSessionId(agentId: string): string {
    const sid = randomUUID();
    this.registry.setLastSessionId(agentId, sid);
    return sid;
  }

  /**
   * If a `--resume` launch died almost immediately, there was no conversation to
   * resume — respawn a fresh `claude` and tell the renderer to reattach. A fresh
   * launch (`continued:false`) that dies is left alone, so we never loop. Returns
   * whether a respawn happened (the exit handler keeps the lock held if so).
   */
  private maybeRespawnFresh(agentId: string): boolean {
    const launch = this.launches.get(agentId);
    if (!launch || !launch.continued) return false;
    if (Date.now() - launch.at > RESPAWN_GUARD_MS) return false;

    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) return false;
    try {
      this.spawn(agent, "fresh", DEFAULT_COLS, DEFAULT_ROWS);
      bus.emitEvent("terminal:respawned", { agentId });
      return true;
    } catch (err) {
      console.error("[terminal] auto-respawn failed", err);
      return false;
    }
  }

  /**
   * EC13 restart: the agent's session was unresumable (broken). Start a brand-new
   * session (fresh uuid) and tell the renderer to reattach. The agent loses chat
   * history but re-reads STRATEGY.md on startup, so strategy continuity survives.
   */
  restart(agentId: string): { alive: boolean } {
    const agent = this.registry.get(agentId);
    if (!agent) return { alive: false };
    this.manager.close(agentId, "SIGTERM");
    this.launches.delete(agentId);
    // `spawn` reports `onInteractiveUp`, which clears BROKEN → interactive on the
    // coordinator (and resets its resume-fail streak for the fresh session).
    this.spawn(agent, "fresh", DEFAULT_COLS, DEFAULT_ROWS);
    bus.emitEvent("terminal:respawned", { agentId });
    return { alive: true };
  }

  /** The WebSocket URL the renderer connects to for this agent's live terminal. */
  async wsEndpointFor(agentId: string): Promise<string> {
    // Opaque to the renderer by contract — a future cloud host returns a
    // different URL (wss://…) and the renderer transport is unchanged.
    return buildTerminalWsUrl(
      `ws://127.0.0.1:${this.wsServer.port}`,
      agentId,
      this.wsServer.token,
      true,
    );
  }

  kill(agentId: string) {
    // Drop launch tracking first so the resulting exit doesn't trigger an
    // auto-respawn (this is a deliberate kill, e.g. the agent was deleted). The exit
    // reports `onInteractiveDown`, which sets `executionState = offline`.
    this.launches.delete(agentId);
    this.arbiter.forget(agentId);
    this.manager.close(agentId, "SIGTERM");
  }

  /**
   * The GUI went away (`gui:gone`): blanket-kill every interactive PTY so none runs
   * outside the GUI. No deferral, no turn-awareness — quitting mid-turn interrupts that
   * turn, accepted because the conversation resumes on the next run and recurring crons
   * re-fire. Each kill's exit reports `onInteractiveDown` → the agent goes offline and
   * any queued wakes re-route to the headless transport.
   */
  private teardownOnGuiGone() {
    for (const info of this.manager.list()) this.killForTeardown(info.id);
  }

  /** Kill a PTY as part of teardown — deliberate, so clear its launch (no auto-respawn).
   *  The exit handler then reports `onInteractiveDown` (re-routes any pending wakes). */
  private killForTeardown(id: string) {
    this.launches.delete(id);
    this.manager.close(id, "SIGTERM");
  }

  /** Tear down all PTYs + the WS server (host shutdown). */
  stop() {
    this.manager.closeAll();
    this.wsServer.close();
  }

  private markWorking(id: string) {
    this.arbiter.setPty(id, "working");
    this.clearIdleTimer(id);
    this.idleTimers.set(
      id,
      setTimeout(() => {
        this.arbiter.setPty(id, "idle");
        this.idleTimers.delete(id);
      }, IDLE_AFTER_MS),
    );
  }

  private clearIdleTimer(id: string) {
    const t = this.idleTimers.get(id);
    if (t) clearTimeout(t);
    this.idleTimers.delete(id);
  }
}
