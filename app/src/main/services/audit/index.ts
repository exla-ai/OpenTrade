import type { AuditEntry, AuditKind } from "@shared/approval";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { auditLog } from "../../db/schema";
import type { AgentRegistry } from "../agents/registry";
import { bus } from "../event-bus";

/**
 * Append-only ledger powering the Activity tab. Records order intents, approval
 * decisions, and session/broker lifecycle events. Never holds agent work product
 * — that lives in the agent folder.
 */
export class AuditLog {
  constructor(
    private db: Db,
    private registry: AgentRegistry,
  ) {}

  append(kind: AuditKind, payload: unknown, agentId: string | null = null): void {
    this.db
      .insert(auditLog)
      .values({ agentId, kind, payload: JSON.stringify(payload ?? null), at: Date.now() })
      .run();
    bus.emitEvent("audit:changed", { agentId });
  }

  /** Most-recent-first feed, optionally scoped to one agent. */
  list(opts?: { agentId?: string; limit?: number }): AuditEntry[] {
    const limit = opts?.limit ?? 200;
    const rows = opts?.agentId
      ? this.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.agentId, opts.agentId))
          .orderBy(desc(auditLog.at))
          .limit(limit)
          .all()
      : this.db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(limit).all();
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      agentName: r.agentId ? (this.registry.get(r.agentId)?.name ?? null) : null,
      kind: r.kind as AuditKind,
      payload: safeParse(r.payload),
      at: r.at,
    }));
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
