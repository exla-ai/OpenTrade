// OpenTrade backend host entry point.
//
// Spawned by the Electron app as a SEPARATE, DETACHED process (Electron binary
// running as Node, ELECTRON_RUN_AS_NODE=1). This is the persistent "brain": it
// owns the DB, the Robinhood connection, the approval gate, the audit log, and
// each agent's `claude` PTY — so agents keep running (and the gate keeps working)
// with the GUI closed. The app is a thin client that adopts-or-spawns this host
// and talks to it over localhost tRPC-HTTP/WS.
//
// No Electron APIs are available here (app/shell/Notification/safeStorage); the
// service chain is headless-clean and the launcher passes app metadata via env.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createDb, OPENTRADE_HOME } from "../db/client";
import { AgentRegistry } from "../services/agents/registry";
import { ApprovalService } from "../services/approvals";
import { AuditLog } from "../services/audit";
import { BrokerService } from "../services/broker";
import { RobinhoodAdapter } from "../services/broker/robinhood/client";
import { bus } from "../services/event-bus";
import { LocalApiServer } from "../services/local-api";
import { derivePort } from "../services/local-api/endpoint";
import { Scheduler } from "../services/scheduler";
import { WakeCoordinator } from "../services/scheduler/wake/coordinator";
import { HeadlessRunStrategy } from "../services/scheduler/wake/headless-strategy";
import { reconcileSpawnMarkers } from "../services/scheduler/wake/spawn-marker";
import { SettingsService } from "../services/settings";
import { StatusArbiter } from "../services/status/arbiter";
import { TerminalService } from "../services/terminal";
import type { Context } from "../trpc/trpc";
import { hostLog } from "./log";
import { clearManifest, writeManifest } from "./manifest";
import { HostTrpcServer } from "./trpc-server";

/** Open a URL in the user's browser headlessly (no Electron shell). */
function openExternal(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], (err) => {
    if (err) hostLog.error("openExternal failed", String(err));
  });
}

async function main() {
  // Name the detached backend so it reads as OpenTrade in `ps`/`top` (it's an
  // ELECTRON_RUN_AS_NODE child of the app binary). See docs/PACKAGING.md.
  process.title = "OpenTrade Host";
  hostLog.info(`host starting (pid ${process.pid}) home=${OPENTRADE_HOME}`);

  const db = createDb();
  const registry = new AgentRegistry(db);
  registry.resetStatusesOnBoot();

  const settings = new SettingsService(db);
  const arbiter = new StatusArbiter(registry);
  const audit = new AuditLog(db, registry);
  const approvals = new ApprovalService(db, registry, audit, arbiter);
  // Fresh host process → no agent hook is still long-polling, so pending rows
  // really are orphans.
  approvals.expireOrphansOnBoot();
  // Recover from a crash that orphaned a headless wake mid-run: kill any survivor and
  // mark the agent broken so we never spawn a second writer on its session (E1).
  reconcileSpawnMarkers(registry);

  const adapter = new RobinhoodAdapter({ db, openBrowser: openExternal });
  const broker = new BrokerService(db, adapter, settings);

  // Stable endpoint: home-derived faucet port + persisted token, shared by the
  // faucet/gate, the terminal WS, and the tRPC server.
  const token = settings.getOrCreate("local_api_token", () => randomBytes(24).toString("hex"));
  const localApi = new LocalApiServer({
    broker,
    approvals,
    registry,
    arbiter,
    port: derivePort(),
    token,
  });
  await localApi.start();

  // Autonomy: the single wake coordinator. It owns one per-agent queue and drains each
  // wake through one of two transports — a `claude/channel` inject into a live PTY
  // (interactive) or a headless `claude --resume -p` (headless). Built before the
  // TerminalService so the latter can report PTY up/down to it.
  const wake = new WakeCoordinator(registry, new HeadlessRunStrategy(registry, localApi));

  const terminal = new TerminalService(registry, localApi, arbiter, wake);
  await terminal.start();

  // Durable scheduler over the coordinator. The scheduler + coordinator are late-bound
  // into the LocalApi so the agent MCP server's /schedules and /wake-stream routes
  // reach them.
  const scheduler = new Scheduler(db, wake, registry, localApi);
  localApi.setScheduler(scheduler);
  localApi.setWake(wake);

  // Reconnect the broker silently if we already have cached tokens.
  if (broker.isAuthorized()) {
    broker.connect().catch((err) => hostLog.error("broker auto-connect failed", String(err)));
  }

  // Arm timers + monitor children after the boot sweep (services are all up).
  scheduler.start();

  const ctx: Context = {
    db,
    registry,
    terminal,
    broker,
    approvals,
    audit,
    settings,
    scheduler,
    wake,
  };
  const trpc = new HostTrpcServer(ctx, token);
  await trpc.listen();

  writeManifest({
    pid: process.pid,
    faucetPort: localApi.port,
    trpcPort: trpc.port,
    token,
    startedAt: Date.now(),
    // App version this host was built from. The launcher refuses to adopt a host
    // whose version differs from its own (post-update the old detached host is
    // still running old code) and respawns a fresh one. See manifest.ensureHost.
    version: process.env.OPENTRADE_VERSION ?? "0.0.0",
  });
  hostLog.info(`host ready: faucet=${localApi.port} trpc=${trpc.port}`);

  // Heartbeat driving the `system.tick` subscription.
  const tick = setInterval(() => bus.emitEvent("system:tick", { at: Date.now() }), 1000);

  const shutdown = (sig: string) => {
    hostLog.info(`host shutting down (${sig})`);
    clearInterval(tick);
    scheduler.stop();
    // Kill in-flight headless wakes + clear their markers so this clean exit isn't
    // mistaken for a crash on the next boot (which would flip agents to broken).
    wake.stopAll();
    terminal.stop();
    localApi.stop();
    trpc.close();
    clearManifest();
    process.exit(0);
  };
  // Survive the launching app going away; quit only on explicit signals/reboot.
  process.on("SIGHUP", () => {});
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  hostLog.error("host failed to start", String(err));
  process.exit(1);
});
