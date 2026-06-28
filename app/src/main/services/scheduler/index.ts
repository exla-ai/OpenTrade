import type {
  CronCreateInput,
  Monitor,
  MonitorCreateInput,
  Schedule,
  Wake,
} from "@shared/schedule";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../db/client";
import {
  monitors as monitorsTable,
  schedules as schedulesTable,
  wakes as wakesTable,
} from "../../db/schema";
import { hostLog } from "../../host/log";
import type { AgentRegistry } from "../agents/registry";
import { bus } from "../event-bus";
import type { LocalApiServer } from "../local-api";
import { buildAgentEnv } from "../terminal/env";
import { CronTimer } from "./cron-timer";
import { MonitorRunner } from "./monitor-runner";
import type { WakeTransport } from "./wake/types";

/**
 * Durable autonomy scheduler, owned by the always-on backend host. Arms cron
 * timers and supervises monitor children that survive the GUI closing (unlike
 * Claude Code's session-scoped CronCreate/Monitor). When a trigger fires it
 * records a wake in the Run History feed and hands a wake to the `WakeTransport`, which delivers
 * it either warm (a `claude/channel` inject into the live PTY) or cold (a headless
 * `claude --resume -p` run) — the Scheduler doesn't care which.
 */
export class Scheduler {
  private cron = new CronTimer();
  private runners = new Map<string, MonitorRunner>();

  constructor(
    private db: Db,
    private wake: WakeTransport,
    private registry: AgentRegistry,
    private localApi: LocalApiServer,
  ) {}

  /** Load enabled rows and arm their timers / monitor children. */
  start(): void {
    for (const row of this.db.select().from(schedulesTable).all()) {
      if (!row.enabled) continue;
      // Self-heal: a schedule whose agent was archived/deleted is orphaned — drop it
      // (covers leaks from before archival cascaded to the scheduler).
      if (this.isAgentGone(row.agentId)) {
        this.db.delete(schedulesTable).where(eq(schedulesTable.id, row.id)).run();
        continue;
      }
      // Catch-up: if we were down past a recurring fire, run it once, then re-arm
      // from the expression (never trust the stored next_fire_at).
      if (row.nextFireAt != null && row.nextFireAt < Date.now()) {
        this.fire(row.agentId, row.prompt, "cron");
        this.markCronFired(row.id);
        if (!row.recurring) {
          this.db
            .update(schedulesTable)
            .set({ enabled: false })
            .where(eq(schedulesTable.id, row.id))
            .run();
          continue;
        }
      }
      this.armCron(row.id, row.agentId, row.cronExpr, row.prompt, row.recurring);
    }

    for (const row of this.db.select().from(monitorsTable).all()) {
      if (!row.enabled) continue;
      if (this.isAgentGone(row.agentId)) {
        this.db.delete(monitorsTable).where(eq(monitorsTable.id, row.id)).run();
        continue;
      }
      this.startMonitor(row.id, row.agentId, row.command);
    }
    hostLog.info(`scheduler started: ${this.runners.size} monitor(s), crons armed`);
  }

  /** True if the agent no longer exists or has been archived (orphaned schedules). */
  private isAgentGone(agentId: string): boolean {
    const agent = this.registry.get(agentId);
    return !agent || agent.archivedAt !== null;
  }

  /**
   * An agent was archived/deleted: disarm and delete all of its schedules and
   * monitors so nothing keeps ticking. Called from the archive path.
   */
  removeAgent(agentId: string): void {
    for (const row of this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.agentId, agentId))
      .all()) {
      this.cron.disarm(row.id);
    }
    this.db.delete(schedulesTable).where(eq(schedulesTable.agentId, agentId)).run();

    for (const row of this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.agentId, agentId))
      .all()) {
      this.runners.get(row.id)?.stop();
      this.runners.delete(row.id);
    }
    this.db.delete(monitorsTable).where(eq(monitorsTable.agentId, agentId)).run();
    bus.emitEvent("scheduler:changed", { agentId });
  }

  // ---- list-all (across every agent) for the Scheduled view ----
  // Enabled-only: a spent one-shot cron is disabled but kept as a record; the
  // Scheduled view shows only what's still active, so it's filtered out here.

  /** Every enabled cron schedule on every agent, for the global Scheduled view. */
  listAllCron(): Schedule[] {
    return this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.enabled, true))
      .all()
      .map(rowToSchedule);
  }

  /** Every enabled monitor on every agent, for the global Scheduled view. */
  listAllMonitors(): Monitor[] {
    return this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.enabled, true))
      .all()
      .map(rowToMonitor);
  }

  // ---- cron CRUD ----

  createCron(agentId: string, input: CronCreateInput): Schedule {
    if (!CronTimer.isValid(input.cron)) {
      throw new Error(`invalid cron expression: ${input.cron}`);
    }
    const id = nanoid();
    const now = Date.now();
    this.db
      .insert(schedulesTable)
      .values({
        id,
        agentId,
        cronExpr: input.cron,
        prompt: input.prompt,
        recurring: input.recurring,
        enabled: true,
        nextFireAt: null,
        lastFiredAt: null,
        createdAt: now,
      })
      .run();
    this.armCron(id, agentId, input.cron, input.prompt, input.recurring);
    bus.emitEvent("scheduler:changed", { agentId });
    return this.getCron(id)!;
  }

  listCron(agentId: string): Schedule[] {
    return this.db
      .select()
      .from(schedulesTable)
      .where(eq(schedulesTable.agentId, agentId))
      .all()
      .map(rowToSchedule);
  }

  deleteCron(agentId: string, id: string): boolean {
    const row = this.db.select().from(schedulesTable).where(eq(schedulesTable.id, id)).get();
    if (!row || row.agentId !== agentId) return false;
    this.cron.disarm(id);
    this.db.delete(schedulesTable).where(eq(schedulesTable.id, id)).run();
    bus.emitEvent("scheduler:changed", { agentId });
    return true;
  }

  // ---- monitor CRUD ----

  createMonitor(agentId: string, input: MonitorCreateInput): Monitor {
    const id = nanoid();
    const now = Date.now();
    this.db
      .insert(monitorsTable)
      .values({
        id,
        agentId,
        command: input.command,
        description: input.description ?? null,
        enabled: true,
        lastFiredAt: null,
        createdAt: now,
      })
      .run();
    this.startMonitor(id, agentId, input.command);
    bus.emitEvent("scheduler:changed", { agentId });
    return this.getMonitor(id)!;
  }

  listMonitors(agentId: string): Monitor[] {
    return this.db
      .select()
      .from(monitorsTable)
      .where(eq(monitorsTable.agentId, agentId))
      .all()
      .map(rowToMonitor);
  }

  // ---- wake history ----

  /** This agent's recorded wakes, newest first, for the Run History pane. */
  listWakes(agentId: string, limit = 100): Wake[] {
    return this.db
      .select()
      .from(wakesTable)
      .where(eq(wakesTable.agentId, agentId))
      .orderBy(desc(wakesTable.firedAt))
      .limit(limit)
      .all()
      .map(rowToWake);
  }

  stopMonitor(agentId: string, id: string): boolean {
    const row = this.db.select().from(monitorsTable).where(eq(monitorsTable.id, id)).get();
    if (!row || row.agentId !== agentId) return false;
    this.runners.get(id)?.stop();
    this.runners.delete(id);
    this.db.delete(monitorsTable).where(eq(monitorsTable.id, id)).run();
    bus.emitEvent("scheduler:changed", { agentId });
    return true;
  }

  /** Host shutdown: stop every timer and monitor child. */
  stop(): void {
    this.cron.disarmAll();
    for (const r of this.runners.values()) r.stop();
    this.runners.clear();
  }

  // ---- internals ----

  private armCron(
    id: string,
    agentId: string,
    cronExpr: string,
    prompt: string,
    recurring: boolean,
  ): void {
    const next = this.cron.arm(id, cronExpr, recurring, () => {
      this.fire(agentId, prompt, "cron");
      this.markCronFired(id);
      if (recurring) {
        this.db
          .update(schedulesTable)
          .set({ nextFireAt: this.cron.nextRun(id) })
          .where(eq(schedulesTable.id, id))
          .run();
      } else {
        this.cron.disarm(id);
        this.db
          .update(schedulesTable)
          .set({ enabled: false })
          .where(eq(schedulesTable.id, id))
          .run();
      }
      // Re-broadcast after the post-fire writes land so the Scheduled view reflects
      // the final state (fresh next-fire, or a spent one-shot dropping out) rather
      // than the pre-write state fire() emitted. (fire() already emitted once; the
      // refetch is deduped, so the extra emit is harmless.)
      bus.emitEvent("scheduler:changed", { agentId });
    });
    this.db.update(schedulesTable).set({ nextFireAt: next }).where(eq(schedulesTable.id, id)).run();
  }

  private markCronFired(id: string): void {
    this.db
      .update(schedulesTable)
      .set({ lastFiredAt: Date.now() })
      .where(eq(schedulesTable.id, id))
      .run();
  }

  private startMonitor(id: string, agentId: string, command: string): void {
    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) return;
    const runner = new MonitorRunner({
      command,
      cwd: this.registry.agentDir(agent),
      env: buildAgentEnv(agentId, {
        OPENTRADE_PORT: String(this.localApi.port),
        OPENTRADE_TOKEN: this.localApi.token,
      }),
      onTrigger: (line) => {
        this.db
          .update(monitorsTable)
          .set({ lastFiredAt: Date.now() })
          .where(eq(monitorsTable.id, id))
          .run();
        this.fire(agentId, `Monitor triggered: ${line}`, "monitor");
      },
    });
    runner.start();
    this.runners.set(id, runner);
  }

  /**
   * Record the fire in the Monitor tab and hand the wake to the coordinator. The
   * coordinator owns routing (interactive via the channel / headless via `-p`) and
   * per-agent queueing, so a fire is fire-and-forget here — never blocks the timer/monitor.
   */
  private fire(agentId: string, prompt: string, sourceKind: "cron" | "monitor"): void {
    const agent = this.registry.get(agentId);
    if (!agent || agent.archivedAt !== null) return;
    // How this wake will be delivered: a live interactive session (the channel) takes it
    // warm; anything else (offline/headless) routes to a background `-p` run. The
    // coordinator decides this synchronously off the same execution state, so reading it
    // here — before enqueue — captures the routing the wake will get.
    const background = this.registry.executionStateOf(agentId) !== "interactive";
    // The wake row is the Monitor tab's record of this fire; the `scheduler:changed`
    // emit below re-queries it (and the upcoming schedules) — no separate bus event needed.
    this.db
      .insert(wakesTable)
      .values({ id: nanoid(), agentId, sourceKind, prompt, background, firedAt: Date.now() })
      .run();
    this.wake.enqueue(agentId, prompt);
    // Surface the new wake + updated last/next-fire times in the Monitor tab live.
    bus.emitEvent("scheduler:changed", { agentId });
  }

  private getCron(id: string): Schedule | undefined {
    const row = this.db.select().from(schedulesTable).where(eq(schedulesTable.id, id)).get();
    return row ? rowToSchedule(row) : undefined;
  }

  private getMonitor(id: string): Monitor | undefined {
    const row = this.db.select().from(monitorsTable).where(eq(monitorsTable.id, id)).get();
    return row ? rowToMonitor(row) : undefined;
  }
}

function rowToSchedule(row: typeof schedulesTable.$inferSelect): Schedule {
  return {
    id: row.id,
    agentId: row.agentId,
    cronExpr: row.cronExpr,
    prompt: row.prompt,
    recurring: row.recurring,
    enabled: row.enabled,
    nextFireAt: row.nextFireAt,
    lastFiredAt: row.lastFiredAt,
    createdAt: row.createdAt,
  };
}

function rowToMonitor(row: typeof monitorsTable.$inferSelect): Monitor {
  return {
    id: row.id,
    agentId: row.agentId,
    command: row.command,
    description: row.description,
    enabled: row.enabled,
    lastFiredAt: row.lastFiredAt,
    createdAt: row.createdAt,
  };
}

function rowToWake(row: typeof wakesTable.$inferSelect): Wake {
  return {
    id: row.id,
    agentId: row.agentId,
    sourceKind: row.sourceKind as Wake["sourceKind"],
    prompt: row.prompt,
    background: row.background,
    firedAt: row.firedAt,
  };
}
