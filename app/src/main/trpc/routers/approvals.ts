import type { Approval } from "@shared/approval";
import { DecideInput } from "@shared/approval";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const approvalsRouter = router({
  listPending: publicProcedure.query(({ ctx }) => ctx.approvals.listPending()),
  pendingCount: publicProcedure.query(({ ctx }) => ctx.approvals.pendingCount()),

  decide: publicProcedure
    .input(DecideInput)
    .mutation(({ ctx, input }) => ctx.approvals.decide(input)),

  /** Signals that pending approvals changed; the renderer re-queries. */
  onChanged: publicProcedure.subscription(() =>
    observable<{ agentId: string | null }>((emit) => {
      emit.next({ agentId: null });
      const off = bus.onEvent("approvals:changed", (p) => emit.next(p));
      return () => off();
    }),
  ),

  /** Pushes each new pending approval (for in-renderer toasts, if desired). */
  onPending: publicProcedure.subscription(() =>
    observable<Approval>((emit) => {
      const off = bus.onEvent("approval:pending", (a) => emit.next(a));
      return () => off();
    }),
  ),
});
