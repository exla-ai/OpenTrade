import type {
  Approval,
  ApprovalStatus,
  DecidedBy,
  OrderOutcome,
  ParsedOrder,
  PreToolUseDecision,
} from "@shared/approval";
import { DEFAULT_SETTINGS } from "@shared/settings";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../db/client";
import { approvals as approvalsTable, settings as settingsTable } from "../../db/schema";
import type { AgentRegistry } from "../agents/registry";
import type { AuditLog } from "../audit";
import { bus } from "../event-bus";
import type { StatusArbiter } from "../status/arbiter";
import { parseOrderInput, parseOrderResult } from "./parse";

// Shared with SettingsService, which writes the same `approval_timeout_sec` key.
const DEFAULT_TIMEOUT_SEC = DEFAULT_SETTINGS.approvalTimeoutSec;

interface Waiter {
  resolve: (decision: PreToolUseDecision) => void;
  timer: NodeJS.Timeout;
}

/**
 * The approval gate. An intercepted order tool call enters via `request()`, which
 * either resolves immediately (full-auto agents) or registers a pending approval
 * and long-polls — the returned promise settles when the user decides, the
 * timeout fires (auto-deny), or the agent's session ends (`abandon`). Every
 * outcome is written to the audit log; the raw tool input is stored verbatim.
 */
export class ApprovalService {
  private waiters = new Map<string, Waiter>();

  constructor(
    private db: Db,
    private registry: AgentRegistry,
    private audit: AuditLog,
    private arbiter: StatusArbiter,
  ) {}

  /** Seconds the user is given before an order auto-denies. */
  get timeoutSec(): number {
    const row = this.db
      .select()
      .from(settingsTable)
      .where(eq(settingsTable.key, "approval_timeout_sec"))
      .get();
    const n = row ? Number(row.value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_SEC;
  }

  /**
   * Entry point for the PreToolUse hook. Records the intent, then resolves with
   * the allow/deny decision the agent should receive.
   */
  async request(
    args: {
      agentId: string;
      toolName: string;
      rawInput: unknown;
    },
    opts?: { signal?: AbortSignal },
  ): Promise<PreToolUseDecision> {
    const agent = this.registry.get(args.agentId);
    const parsed = parseOrderInput(args.toolName, args.rawInput);
    const id = nanoid();
    const now = Date.now();
    const timeoutSec = this.timeoutSec;

    this.db
      .insert(approvalsTable)
      .values({
        id,
        agentId: args.agentId,
        toolName: args.toolName,
        rawInput: JSON.stringify(args.rawInput ?? null),
        parsed: JSON.stringify(parsed),
        status: "pending",
        decidedBy: null,
        note: null,
        requestedAt: now,
        decidedAt: null,
      })
      .run();

    this.audit.append(
      "order_intent",
      { approvalId: id, toolName: args.toolName, parsed, summary: parsed.summary },
      args.agentId,
    );

    // Full-auto agents (or an unknown agent — fail safe by gating) decide instantly.
    if (agent?.approvalMode === "auto") {
      this.finalize(id, "approved", "auto", null);
      return this.decisionFor(id);
    }

    // Approve mode: surface a card and block until decided.
    this.syncPending(args.agentId);
    bus.emitEvent("approvals:changed", { agentId: args.agentId });
    bus.emitEvent("approval:pending", this.toApproval(id)!);

    return new Promise<PreToolUseDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finalize(
          id,
          "expired",
          "timeout",
          `No decision within ${timeoutSec}s — treated as declined. Do not retry; note it and continue.`,
        );
        this.waiters.delete(id);
        resolve(this.decisionFor(id));
      }, timeoutSec * 1000);
      this.waiters.set(id, { resolve, timer });
      // If the agent's session dies mid-poll, the order is moot — abandon it.
      opts?.signal?.addEventListener("abort", () => this.abandon(id), { once: true });
    });
  }

  /** User pressed Approve/Reject in the UI. */
  decide(args: { id: string; approve: boolean; note?: string }): { ok: boolean } {
    const row = this.getRow(args.id);
    if (!row || row.status !== "pending") return { ok: false };
    this.finalize(
      args.id,
      args.approve ? "approved" : "rejected",
      "user",
      args.note?.trim() || null,
    );
    this.wake(args.id);
    return { ok: true };
  }

  /**
   * The agent's session ended while an order was pending — the tool call is gone,
   * so expire the row and let the (now-dead) long-poll fall through.
   */
  abandon(id: string): void {
    const row = this.getRow(id);
    if (!row || row.status !== "pending") return;
    this.finalize(id, "expired", "timeout", "Agent session ended before a decision.");
    this.wake(id);
  }

  /**
   * Record what the broker actually did with an approved order, reported by the
   * PostToolUse hook (the order tool's *result*). Distinct from the approval
   * decision: an approved order can still be rejected by Robinhood. Correlates to
   * the originating approval by (agentId, toolName, rawInput), taking the oldest
   * approved row that has no outcome yet — tool calls are serialized, so FIFO is
   * exact; identical back-to-back orders still each get one result.
   */
  recordOutcome(args: {
    agentId: string;
    toolName: string;
    rawInput: unknown;
    result: unknown;
  }): void {
    const outcome = parseOrderResult(args.result, args.toolName);
    const rawInput = JSON.stringify(args.rawInput ?? null);

    // Primary: exact input match. Fallback: any approved-but-unrecorded order for
    // this agent+tool (guards against JSON key-order drift between the two hooks).
    const target =
      this.oldestUnrecorded(args.agentId, args.toolName, rawInput) ??
      this.oldestUnrecorded(args.agentId, args.toolName, null);

    if (target) {
      this.db
        .update(approvalsTable)
        .set({ outcome: JSON.stringify(outcome) })
        .where(eq(approvalsTable.id, target.id))
        .run();
    }
    this.audit.append(
      "order_observed",
      { approvalId: target?.id ?? null, toolName: args.toolName, ...outcome },
      args.agentId,
    );
    bus.emitEvent("approvals:changed", { agentId: args.agentId });
  }

  /** Oldest approved order with no outcome yet, optionally matching exact input. */
  private oldestUnrecorded(agentId: string, toolName: string, rawInput: string | null) {
    const conds = [
      eq(approvalsTable.agentId, agentId),
      eq(approvalsTable.toolName, toolName),
      eq(approvalsTable.status, "approved"),
      isNull(approvalsTable.outcome),
    ];
    if (rawInput !== null) conds.push(eq(approvalsTable.rawInput, rawInput));
    return this.db
      .select()
      .from(approvalsTable)
      .where(and(...conds))
      .orderBy(asc(approvalsTable.requestedAt))
      .get();
  }

  listPending(): Approval[] {
    return this.db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.status, "pending"))
      .orderBy(desc(approvalsTable.requestedAt))
      .all()
      .map((r) => this.rowToApproval(r));
  }

  pendingCount(): number {
    return this.listPending().length;
  }

  /** On boot, no hook is still long-polling — expire orphaned pending rows. */
  expireOrphansOnBoot(): void {
    const orphans = this.db
      .select()
      .from(approvalsTable)
      .where(eq(approvalsTable.status, "pending"))
      .all();
    for (const row of orphans) {
      this.finalize(row.id, "expired", "timeout", "App restarted before a decision.");
    }
  }

  // ---- internals ----

  private finalize(id: string, status: ApprovalStatus, decidedBy: DecidedBy, note: string | null) {
    const row = this.getRow(id);
    if (!row) return;
    this.db
      .update(approvalsTable)
      .set({ status, decidedBy, note, decidedAt: Date.now() })
      .where(eq(approvalsTable.id, id))
      .run();
    this.audit.append(
      "approval_decision",
      { approvalId: id, status, decidedBy, note },
      row.agentId,
    );
    this.syncPending(row.agentId);
    bus.emitEvent("approvals:changed", { agentId: row.agentId });
  }

  /** Resolve the long-poll waiting on this approval, if any. */
  private wake(id: string) {
    const w = this.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(this.decisionFor(id));
  }

  /** Recompute the agent's pending count and feed it to the status arbiter. */
  private syncPending(agentId: string) {
    const count = this.db
      .select()
      .from(approvalsTable)
      .where(and(eq(approvalsTable.agentId, agentId), eq(approvalsTable.status, "pending")))
      .all().length;
    this.arbiter.setPendingApprovals(agentId, count);
  }

  private decisionFor(id: string): PreToolUseDecision {
    const row = this.getRow(id);
    const allow = row?.status === "approved";
    if (allow) {
      return {
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      };
    }
    const reason =
      row?.note || "Order declined in OpenTrade. Do not retry; record it and continue.";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  private getRow(id: string) {
    return this.db.select().from(approvalsTable).where(eq(approvalsTable.id, id)).get();
  }

  private toApproval(id: string): Approval | null {
    const row = this.getRow(id);
    return row ? this.rowToApproval(row) : null;
  }

  private rowToApproval(row: typeof approvalsTable.$inferSelect): Approval {
    return {
      id: row.id,
      agentId: row.agentId,
      agentName: this.registry.get(row.agentId)?.name ?? null,
      toolName: row.toolName,
      rawInput: row.rawInput,
      parsed: safeJson<ParsedOrder>(row.parsed),
      status: row.status as ApprovalStatus,
      decidedBy: (row.decidedBy as DecidedBy | null) ?? null,
      note: row.note,
      outcome: safeJson<OrderOutcome>(row.outcome),
      timeoutSec: this.timeoutSec,
      requestedAt: row.requestedAt,
      decidedAt: row.decidedAt,
    };
  }
}

function safeJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
