import { afterEach, describe, expect, test } from "bun:test";
import { derivePort } from "./endpoint";

describe("derivePort", () => {
  afterEach(() => {
    delete process.env.OPENTRADE_API_PORT;
  });

  test("is deterministic for the same home (stable across restarts)", () => {
    expect(derivePort("/home/a/.opentrade")).toBe(derivePort("/home/a/.opentrade"));
  });

  test("differs across homes (parallel dev instances don't collide)", () => {
    expect(derivePort("/home/a/.opentrade")).not.toBe(derivePort("/home/b/.opentrade"));
  });

  test("stays within the chosen range", () => {
    for (const home of ["/x", "/y/z", "/home/u/.opentrade", "/tmp/t"]) {
      const port = derivePort(home);
      expect(port).toBeGreaterThanOrEqual(20000);
      expect(port).toBeLessThan(30000);
    }
  });

  test("honors the OPENTRADE_API_PORT override", () => {
    process.env.OPENTRADE_API_PORT = "41234";
    expect(derivePort("/home/a/.opentrade")).toBe(41234);
  });

  test("ignores an out-of-range override", () => {
    process.env.OPENTRADE_API_PORT = "70000";
    expect(derivePort("/home/a/.opentrade")).toBe(derivePort("/home/a/.opentrade"));
    expect(derivePort("/home/a/.opentrade")).toBeLessThan(30000);
  });
});
