import { router } from "../trpc";
import { activityRouter } from "./activity";
import { agentsRouter } from "./agents";
import { approvalsRouter } from "./approvals";
import { brokerRouter } from "./broker";
import { onboardingRouter } from "./onboarding";
import { scheduleRouter } from "./schedule";
import { settingsRouter } from "./settings";
import { systemRouter } from "./system";
import { terminalRouter } from "./terminal";

export const appRouter = router({
  system: systemRouter,
  agents: agentsRouter,
  terminal: terminalRouter,
  broker: brokerRouter,
  onboarding: onboardingRouter,
  approvals: approvalsRouter,
  activity: activityRouter,
  settings: settingsRouter,
  schedule: scheduleRouter,
});

export type AppRouter = typeof appRouter;
