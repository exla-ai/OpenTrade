import { ApprovalMode } from "@shared/agent";
import { type AppSettings, DEFAULT_SETTINGS, SettingsUpdate } from "@shared/settings";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { settings as settingsTable } from "../../db/schema";
import { bus } from "../event-bus";

/** kv keys backing each AppSettings field. `approval_timeout_sec` is shared with
 *  ApprovalService (which reads it directly), so keep that name in sync. */
const KEYS: Record<keyof AppSettings, string> = {
  approvalTimeoutSec: "approval_timeout_sec",
  pollIntervalFocusedSec: "poll_interval_focused_sec",
  pollIntervalBlurredSec: "poll_interval_blurred_sec",
  defaultApprovalMode: "default_approval_mode",
  onboardingComplete: "onboarding_complete",
};

/**
 * Typed accessor over the `settings` kv table for the app's global tunables.
 * Reads coerce + fall back to `DEFAULT_SETTINGS`; `update()` validates against the
 * shared schema and broadcasts `settings:changed` so live consumers (the broker
 * poller, the renderer) re-read.
 */
export class SettingsService {
  constructor(private db: Db) {}

  get(): AppSettings {
    return {
      approvalTimeoutSec: this.readNumber(
        KEYS.approvalTimeoutSec,
        DEFAULT_SETTINGS.approvalTimeoutSec,
      ),
      pollIntervalFocusedSec: this.readNumber(
        KEYS.pollIntervalFocusedSec,
        DEFAULT_SETTINGS.pollIntervalFocusedSec,
      ),
      pollIntervalBlurredSec: this.readNumber(
        KEYS.pollIntervalBlurredSec,
        DEFAULT_SETTINGS.pollIntervalBlurredSec,
      ),
      defaultApprovalMode: this.readApprovalMode(
        KEYS.defaultApprovalMode,
        DEFAULT_SETTINGS.defaultApprovalMode,
      ),
      onboardingComplete: this.readBool(
        KEYS.onboardingComplete,
        DEFAULT_SETTINGS.onboardingComplete,
      ),
    };
  }

  update(patch: SettingsUpdate): AppSettings {
    const clean = SettingsUpdate.parse(patch);
    for (const [field, value] of Object.entries(clean)) {
      if (value === undefined) continue;
      this.write(KEYS[field as keyof AppSettings], serialize(value));
    }
    const next = this.get();
    bus.emitEvent("settings:changed", next);
    return next;
  }

  /**
   * Get a persisted opaque value, generating + storing it on first access.
   * For internal kv (not part of the typed `AppSettings`) — e.g. the stable
   * local-API bearer token, which must survive restarts so baked-in PTY env
   * stays valid.
   */
  getOrCreate(key: string, factory: () => string): string {
    const existing = this.readRaw(key);
    if (existing !== undefined) return existing;
    const value = factory();
    this.write(key, value);
    return value;
  }

  // ---- convenience for services (ms where the consumer wants ms) ----
  get pollIntervalFocusedMs(): number {
    return this.get().pollIntervalFocusedSec * 1000;
  }
  get pollIntervalBlurredMs(): number {
    return this.get().pollIntervalBlurredSec * 1000;
  }

  // ---- internals ----

  private readRaw(key: string): string | undefined {
    return this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get()?.value;
  }

  private write(key: string, value: string) {
    this.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
  }

  private readNumber(key: string, fallback: number): number {
    const n = Number(this.readRaw(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  private readBool(key: string, fallback: boolean): boolean {
    const v = this.readRaw(key);
    if (v === undefined) return fallback;
    return v === "1" || v === "true";
  }

  private readApprovalMode(key: string, fallback: AppSettings["defaultApprovalMode"]) {
    const parsed = ApprovalMode.safeParse(this.readRaw(key));
    return parsed.success ? parsed.data : fallback;
  }
}

function serialize(value: unknown): string {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}
