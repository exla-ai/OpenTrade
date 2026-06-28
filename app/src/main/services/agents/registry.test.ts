import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";

// Isolate OPENTRADE_HOME to a throwaway dir before the registry module (which derives
// AGENTS_DIR from it) loads — hence the dynamic import in beforeAll.
const HOME = mkdtempSync(join(tmpdir(), "registry-home-"));
process.env.OPENTRADE_HOME = HOME;

let AgentRegistry: typeof import("./registry").AgentRegistry;
beforeAll(async () => {
  ({ AgentRegistry } = await import("./registry"));
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function memRegistry() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT NOT NULL, template TEXT NOT NULL,
    approval_mode TEXT NOT NULL, last_session_id TEXT, status TEXT NOT NULL,
    created_at INTEGER NOT NULL, archived_at INTEGER);`);
  return new AgentRegistry(drizzle(sqlite, { schema }) as unknown as Db);
}

describe("AgentRegistry — executionState", () => {
  test("defaults to offline; tracks the wake actor's state; offline drops the entry", () => {
    const r = memRegistry();
    expect(r.executionStateOf("a")).toBe("offline"); // default

    r.setExecutionState("a", "interactive");
    expect(r.executionStateOf("a")).toBe("interactive");
    r.setExecutionState("a", "headless");
    expect(r.executionStateOf("a")).toBe("headless");
    r.setExecutionState("a", "broken");
    expect(r.executionStateOf("a")).toBe("broken");

    r.setExecutionState("a", "offline"); // back to the default → entry removed
    expect(r.executionStateOf("a")).toBe("offline");
  });
});

describe("AgentRegistry — CLAUDE.md composition", () => {
  // Markers unique to each half of the composed file.
  const PREFIX_MARKER = "## Self-scheduling — staying awake on the user's behalf";

  function claudeMdFor(template: string): string {
    const r = memRegistry();
    const agent = r.create({ name: `compose ${template}`, template, approvalMode: "approve" });
    return readFileSync(join(r.agentDir(agent), "CLAUDE.md"), "utf8");
  }

  test("prepends the shared OpenTrade prefix to every template's specialty section", () => {
    for (const [template, specialtyMarker] of [
      ["default", "## Your specialty — general purpose"],
      ["dca", "## Your specialty — dollar-cost averaging (DCA)"],
      ["momentum", "## Your specialty — momentum / trend-following"],
    ] as const) {
      const md = claudeMdFor(template);
      expect(md).toContain(PREFIX_MARKER); // shared mechanics present…
      expect(md).toContain(specialtyMarker); // …followed by the template's own section
      // Prefix comes first, specialty after.
      expect(md.indexOf(PREFIX_MARKER)).toBeLessThan(md.indexOf(specialtyMarker));
      // The shared title appears exactly once (the specialty file no longer carries its own H1).
      expect(md.startsWith("# OpenTrade Agent\n")).toBe(true);
      expect(md.split("# OpenTrade Agent").length - 1).toBe(1);
    }
  });

  test("unknown templates fall back to default but still get the prefix", () => {
    const md = claudeMdFor("does-not-exist");
    expect(md).toContain(PREFIX_MARKER);
    expect(md).toContain("## Your specialty — general purpose");
  });
});
