import type { AuditEntry } from "@shared/approval";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const activityRouter = router({
  /** Audit feed, newest first; optionally scoped to one agent. */
  feed: publicProcedure
    .input(z.object({ agentId: z.string().optional(), limit: z.number().optional() }).optional())
    .query(({ ctx, input }) => ctx.audit.list(input)),

  onChanged: publicProcedure.subscription(() =>
    observable<{ agentId: string | null }>((emit) => {
      // Emit on (re)subscribe so the renderer refetches after a WS reconnect
      // (host restart) — matches agents/approvals/settings onChanged.
      emit.next({ agentId: null });
      const off = bus.onEvent("audit:changed", (p) => emit.next(p));
      return () => off();
    }),
  ),
});

// Re-exported for renderer typing convenience.
export type { AuditEntry };
