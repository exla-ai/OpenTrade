import { describe, expect, test } from "bun:test";
import { CronTimer } from "./cron-timer";

describe("CronTimer", () => {
  test("isValid accepts 5-field expressions and rejects junk", () => {
    expect(CronTimer.isValid("30 9 * * 1-5")).toBe(true);
    expect(CronTimer.isValid("*/5 * * * *")).toBe(true);
    expect(CronTimer.isValid("not a cron")).toBe(false);
    expect(CronTimer.isValid("99 99 99 99 99")).toBe(false);
  });

  test("arm returns a future next-fire time and nextRun matches", () => {
    const t = new CronTimer();
    const next = t.arm("a", "*/5 * * * *", true, () => {});
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(Date.now());
    expect(t.nextRun("a")).toBe(next);
    t.disarmAll();
  });

  test("disarm stops a job and forgets its next run", () => {
    const t = new CronTimer();
    t.arm("b", "0 0 * * *", true, () => {});
    expect(t.nextRun("b")).not.toBeNull();
    t.disarm("b");
    expect(t.nextRun("b")).toBeNull();
  });

  test("re-arming the same id replaces the prior timer", () => {
    const t = new CronTimer();
    const first = t.arm("c", "0 9 * * *", true, () => {});
    const second = t.arm("c", "0 17 * * *", true, () => {});
    expect(second).not.toBe(first);
    expect(t.nextRun("c")).toBe(second);
    t.disarmAll();
  });
});
