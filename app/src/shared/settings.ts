import { z } from "zod";
import { ApprovalMode } from "./agent";

/**
 * Global app settings (the `settings` kv table, distinct from per-agent config
 * and from the encrypted OAuth/token rows). This is the single source of truth
 * for every tunable: bounds live here, defaults live in `DEFAULT_SETTINGS`, and
 * both main services and the renderer read this shape.
 */
export const AppSettings = z.object({
  /** Seconds the user is given before a pending order auto-denies. */
  approvalTimeoutSec: z.number().int().min(10).max(3600),
  /** Broker poll cadence when the window is focused during market hours. */
  pollIntervalFocusedSec: z.number().int().min(1).max(120),
  /** Broker poll cadence when blurred or the market is closed. */
  pollIntervalBlurredSec: z.number().int().min(1).max(600),
  /** Approval mode applied to newly created agents. */
  defaultApprovalMode: ApprovalMode,
  /** Set once the first-run onboarding wizard has been completed or skipped. */
  onboardingComplete: z.boolean(),
});
export type AppSettings = z.infer<typeof AppSettings>;

export const DEFAULT_SETTINGS: AppSettings = {
  approvalTimeoutSec: 300,
  pollIntervalFocusedSec: 5,
  pollIntervalBlurredSec: 10,
  defaultApprovalMode: "approve",
  onboardingComplete: false,
};

/** A partial update of the editable settings. */
export const SettingsUpdate = AppSettings.partial();
export type SettingsUpdate = z.infer<typeof SettingsUpdate>;
