import { type AppSettings, SettingsUpdate } from "@shared/settings";
import { observable } from "@trpc/server/observable";
import { bus } from "../../services/event-bus";
import { publicProcedure, router } from "../trpc";

export const settingsRouter = router({
  get: publicProcedure.query(({ ctx }) => ctx.settings.get()),

  update: publicProcedure
    .input(SettingsUpdate)
    .mutation(({ ctx, input }) => ctx.settings.update(input)),

  /** Pushes the full settings object on connect and on every change. */
  onChanged: publicProcedure.subscription(({ ctx }) =>
    observable<AppSettings>((emit) => {
      emit.next(ctx.settings.get());
      const off = bus.onEvent("settings:changed", (s) => emit.next(s));
      return () => off();
    }),
  ),
});
