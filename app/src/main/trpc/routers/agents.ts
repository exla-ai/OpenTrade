import type { Agent } from "@shared/agent";
import { ApprovalMode, CreateAgentInput } from "@shared/agent";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const agentsRouter = router({
  list: publicProcedure.query(({ ctx }) => ctx.registry.list()),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => ctx.registry.get(input.id) ?? null),

  /** The default composed CLAUDE.md for a template — seeds the New Agent dialog's
   *  editable text field; the (possibly edited) result rides back on `create`. */
  templateClaudeMd: publicProcedure
    .input(z.object({ template: z.string() }))
    .query(({ ctx, input }) => ctx.registry.templateClaudeMd(input.template)),

  create: publicProcedure
    .input(CreateAgentInput)
    .mutation(({ ctx, input }) => ctx.registry.create(input)),

  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(80).optional(),
        approvalMode: ApprovalMode.optional(),
      }),
    )
    .mutation(({ ctx, input }) => ctx.registry.update(input.id, input) ?? null),

  archive: publicProcedure.input(z.object({ id: z.string() })).mutation(({ ctx, input }) => {
    // Tear down the live PTY before dropping the agent from the list, so the
    // daemon isn't left running an orphaned `claude` for a deleted agent.
    ctx.terminal.kill(input.id);
    // Kill any in-flight headless wake + clear its queued/warm wakes, so an archived
    // agent can't keep trading (the headless `archivedAt` guard only checks at spawn).
    ctx.wake.stop(input.id);
    // Disarm + delete the agent's schedules/monitors so nothing keeps firing.
    ctx.scheduler.removeAgent(input.id);
    ctx.registry.archive(input.id);
    return { ok: true };
  }),

  /** Pushes the full agent list (with statuses) on every change. */
  onChanged: publicProcedure.subscription(({ ctx }) =>
    observable<Agent[]>((emit) => {
      emit.next(ctx.registry.list());
      const off = bus.onEvent("agents:changed", (list) => emit.next(list));
      return () => off();
    }),
  ),
});
