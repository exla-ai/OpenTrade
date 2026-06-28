import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, AgentStatus, CreateAgentInput, ExecutionState } from "@shared/agent";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { type Db, OPENTRADE_HOME } from "../../db/client";
import { agents as agentsTable } from "../../db/schema";
import { bus } from "../event-bus";

const AGENTS_DIR = join(OPENTRADE_HOME, "agents");

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Locate the bundled agent templates in dev and packaged layouts. */
function resolveTemplatesDir(): string {
  const candidates = [
    join(process.cwd(), "..", "templates", "agents"),
    join(process.cwd(), "templates", "agents"),
    // out/main -> repo root in dev
    join(__dirname, "..", "..", "..", "templates", "agents"),
    join(process.resourcesPath ?? "", "templates", "agents"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  // Fall back to the first candidate; create() will surface a clear error.
  return candidates[0];
}

/** Locate the bundled hook scripts (resources/hooks) across dev/packaged layouts. */
function resolveHooksDir(): string {
  const candidates = [
    join(process.cwd(), "..", "resources", "hooks"),
    join(process.cwd(), "resources", "hooks"),
    join(__dirname, "..", "..", "..", "resources", "hooks"),
    join(process.resourcesPath ?? "", "resources", "hooks"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * Absolute path to the bundled `opentrade` agent-MCP server (`out/main/agent-mcp.js`),
 * which `claude` spawns per agent. In a packaged app it's spawned as a child process
 * (not by Electron), so it must be the asar-UNPACKED copy (see electron-builder.yml).
 */
function resolveAgentMcp(): string {
  const local = join(__dirname, "agent-mcp.js"); // host bundle lives in out/main
  return local.includes("app.asar") ? local.replace("app.asar", "app.asar.unpacked") : local;
}

/**
 * A template's specialty section — the template's own `CLAUDE.md` (strategy
 * persona, journaling layout, operating principles). This is the *editable* part
 * the New Agent dialog shows; the shared prefix is NOT included. Unknown templates
 * fall back to `default`.
 */
function readTemplateSpecialty(templatesDir: string, template: string): string {
  const templateDir = join(templatesDir, template);
  const src = existsSync(templateDir) ? templateDir : join(templatesDir, "default");
  const claudePath = join(src, "CLAUDE.md");
  return existsSync(claudePath) ? readFileSync(claudePath, "utf8").trim() : "";
}

/**
 * Compose an agent's full `CLAUDE.md` = shared OpenTrade prefix + the given
 * specialty section. The prefix (`templates/agents/CLAUDE.prefix.md`) carries the
 * system mechanics every strategy shares (faucet, Robinhood MCP, approval gate,
 * durable scheduler, wake delivery) and is always prepended at scaffold time — it
 * is never shown in or edited through the New Agent dialog. Missing prefix is a
 * hard error.
 */
function composeClaudeMd(templatesDir: string, specialty: string): string {
  const prefixPath = join(templatesDir, "CLAUDE.prefix.md");
  if (!existsSync(prefixPath)) {
    throw new Error(`shared CLAUDE.md prefix not found: ${prefixPath}`);
  }
  const prefix = readFileSync(prefixPath, "utf8").trim();
  const s = specialty.trim();
  return s ? `${prefix}\n\n${s}\n` : `${prefix}\n`;
}

/**
 * Owns the agents table and the on-disk agent folders under ~/.opentrade/agents.
 * Each agent folder is scaffolded from a template (CLAUDE.md, kickoff.md,
 * .claude/settings.json, .mcp.json); everything else in it is the agent's own
 * work product. Runtime `status` is mirrored into the DB and broadcast on change.
 */
export class AgentRegistry {
  /**
   * Runtime execution state per agent (PTY liveness — a host-side fact, not
   * persisted). Defaults to `offline`; merged into every Agent the registry hands
   * out so the renderer's agent subscription drives the terminal-pane overlays.
   */
  private executionStates = new Map<string, ExecutionState>();

  constructor(private db: Db) {
    if (!existsSync(AGENTS_DIR)) mkdirSync(AGENTS_DIR, { recursive: true });
  }

  list(): Agent[] {
    return this.db
      .select()
      .from(agentsTable)
      .all()
      .map((r) => rowToAgent(r, this.executionStateOf(r.id)))
      .filter((a) => a.archivedAt === null);
  }

  get(id: string): Agent | undefined {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    return row ? rowToAgent(row, this.executionStateOf(id)) : undefined;
  }

  executionStateOf(id: string): ExecutionState {
    return this.executionStates.get(id) ?? "offline";
  }

  /** Set the runtime execution state; broadcasts the agent list on a real change.
   *  Written exclusively by the WakeCoordinator (the agent's wake actor) and the
   *  boot-time spawn-marker reconcile — it IS the actor's state, 1:1. */
  setExecutionState(id: string, state: ExecutionState): void {
    if (this.executionStateOf(id) === state) return;
    if (state === "offline") this.executionStates.delete(id);
    else this.executionStates.set(id, state);
    this.broadcast();
  }

  agentDir(agent: Agent | { slug: string }): string {
    return join(AGENTS_DIR, agent.slug);
  }

  create(input: CreateAgentInput): Agent {
    const id = nanoid();
    const existing = new Set(
      this.db
        .select()
        .from(agentsTable)
        .all()
        .map((r) => r.slug),
    );
    let slug = slugify(input.name) || "agent";
    if (existing.has(slug)) {
      let i = 2;
      while (existing.has(`${slug}-${i}`)) i++;
      slug = `${slug}-${i}`;
    }

    this.scaffoldFolder(slug, input.template, input.claudeMd);

    const now = Date.now();
    this.db
      .insert(agentsTable)
      .values({
        id,
        slug,
        name: input.name,
        template: input.template,
        approvalMode: input.approvalMode,
        lastSessionId: null,
        status: "idle",
        createdAt: now,
        archivedAt: null,
      })
      .run();
    this.broadcast();
    return this.get(id)!;
  }

  private scaffoldFolder(slug: string, template: string, claudeMd?: string) {
    const dir = join(AGENTS_DIR, slug);
    const templatesDir = resolveTemplatesDir();
    const templateDir = join(templatesDir, template);
    const src = existsSync(templateDir) ? templateDir : join(templatesDir, "default");
    if (!existsSync(src)) {
      throw new Error(`agent template not found: ${src}`);
    }
    mkdirSync(dir, { recursive: true });
    cpSync(src, dir, { recursive: true });
    mkdirSync(join(dir, ".opentrade"), { recursive: true });
    mkdirSync(join(dir, "journal"), { recursive: true });

    // The agent's CLAUDE.md = shared prefix + a specialty section. The specialty
    // is the (possibly edited) text from the New Agent dialog, falling back to the
    // template's own CLAUDE.md. The prefix is always prepended here — it is never
    // shown in or edited through the dialog.
    const specialty = claudeMd?.trim() ? claudeMd : readTemplateSpecialty(templatesDir, template);
    writeFileSync(join(dir, "CLAUDE.md"), composeClaudeMd(templatesDir, specialty));
    this.injectOpentradeMcp(dir);

    // Copy executable hook scripts referenced by the template's settings.json.
    const hooksSrc = resolveHooksDir();
    const hooksDest = join(dir, ".claude", "hooks");
    if (existsSync(hooksSrc)) {
      mkdirSync(hooksDest, { recursive: true });
      for (const file of readdirSync(hooksSrc)) {
        const destFile = join(hooksDest, file);
        cpSync(join(hooksSrc, file), destFile);
        try {
          chmodSync(destFile, 0o755);
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * A template's editable specialty section (its own `CLAUDE.md`, WITHOUT the
   * shared prefix). Seeds the New Agent dialog's text field; the dialog passes the
   * (possibly edited) result back as `CreateAgentInput.claudeMd`, and `create`
   * re-prepends the prefix. Returns the specialty only — never the prefix.
   */
  templateClaudeMd(template: string): string {
    return readTemplateSpecialty(resolveTemplatesDir(), template);
  }

  /**
   * Add the `opentrade` stdio MCP server to the agent's `.mcp.json` (alongside the
   * template's Robinhood entry). Carries only the command + resolved binary path —
   * NO token/port (R5); those are injected via the inherited spawn env at launch.
   * Run as Node via the Electron binary (ELECTRON_RUN_AS_NODE) so packaged apps need
   * no separate node on PATH.
   */
  private injectOpentradeMcp(dir: string): void {
    const mcpPath = join(dir, ".mcp.json");
    let config: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpPath)) {
      try {
        config = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        config = {};
      }
    }
    config.mcpServers = {
      ...(config.mcpServers ?? {}),
      opentrade: {
        command: process.execPath,
        args: [resolveAgentMcp()],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    };
    writeFileSync(mcpPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Mutate editable fields (name, approval mode). Returns the updated agent. */
  update(
    id: string,
    patch: { name?: string; approvalMode?: Agent["approvalMode"] },
  ): Agent | undefined {
    const set: Partial<typeof agentsTable.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.approvalMode !== undefined) set.approvalMode = patch.approvalMode;
    if (Object.keys(set).length > 0) {
      this.db.update(agentsTable).set(set).where(eq(agentsTable.id, id)).run();
      this.broadcast();
    }
    return this.get(id);
  }

  archive(id: string): void {
    this.db.update(agentsTable).set({ archivedAt: Date.now() }).where(eq(agentsTable.id, id)).run();
    this.broadcast();
  }

  setStatus(id: string, status: AgentStatus): void {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    if (!row || row.status === status) return;
    this.db.update(agentsTable).set({ status }).where(eq(agentsTable.id, id)).run();
    this.broadcast();
  }

  setLastSessionId(id: string, sessionId: string): void {
    this.db
      .update(agentsTable)
      .set({ lastSessionId: sessionId })
      .where(eq(agentsTable.id, id))
      .run();
  }

  // ---- on-disk session-state helpers ----

  hasStarted(id: string): boolean {
    const agent = this.get(id);
    if (!agent) return false;
    return existsSync(join(this.agentDir(agent), ".opentrade", "started"));
  }

  markStarted(id: string): void {
    const agent = this.get(id);
    if (!agent) return;
    const marker = join(this.agentDir(agent), ".opentrade", "started");
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, String(Date.now()));
  }

  readKickoff(agent: Agent): string | null {
    const path = join(this.agentDir(agent), "kickoff.md");
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim();
  }

  /** On boot, no daemon sessions are confirmed yet — reset stale statuses to idle. */
  resetStatusesOnBoot(): void {
    for (const a of this.list()) {
      if (a.status !== "idle") this.setStatus(a.id, "idle");
    }
  }

  private broadcast() {
    bus.emitEvent("agents:changed", this.list());
  }
}

function rowToAgent(row: typeof agentsTable.$inferSelect, executionState: ExecutionState): Agent {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    template: row.template,
    approvalMode: row.approvalMode as Agent["approvalMode"],
    lastSessionId: row.lastSessionId,
    status: row.status as Agent["status"],
    executionState,
    createdAt: row.createdAt,
    archivedAt: row.archivedAt,
  };
}
