import { describe, expect, test } from "bun:test";
import { buildTerminalWsUrl, parseTerminalWsUrl } from "./ws-url";

describe("parseTerminalWsUrl", () => {
  test("parses id, token, replay", () => {
    expect(parseTerminalWsUrl("/sessions/abc?token=secret&replay=1")).toEqual({
      id: "abc",
      token: "secret",
      replay: true,
    });
  });

  test("replay defaults false when absent or not '1'", () => {
    expect(parseTerminalWsUrl("/sessions/abc?token=t")?.replay).toBe(false);
    expect(parseTerminalWsUrl("/sessions/abc?token=t&replay=0")?.replay).toBe(false);
  });

  test("missing token yields empty string (rejected later by token check)", () => {
    expect(parseTerminalWsUrl("/sessions/abc")?.token).toBe("");
  });

  test("decodes a url-encoded agent id", () => {
    expect(parseTerminalWsUrl("/sessions/a%2Fb%20c?token=t")?.id).toBe("a/b c");
  });

  test("returns null for non-session paths and undefined", () => {
    expect(parseTerminalWsUrl("/health")).toBeNull();
    expect(parseTerminalWsUrl("/")).toBeNull();
    expect(parseTerminalWsUrl(undefined)).toBeNull();
  });
});

describe("buildTerminalWsUrl", () => {
  test("round-trips through the parser", () => {
    const url = buildTerminalWsUrl("ws://127.0.0.1:9000", "agent-1", "tok123", true);
    const path = url.replace("ws://127.0.0.1:9000", "");
    expect(parseTerminalWsUrl(path)).toEqual({ id: "agent-1", token: "tok123", replay: true });
  });

  test("encodes ids with reserved characters", () => {
    const url = buildTerminalWsUrl("ws://h:1", "a/b c", "t", true);
    expect(url).toContain("/sessions/a%2Fb%20c");
    const path = url.replace("ws://h:1", "");
    expect(parseTerminalWsUrl(path)?.id).toBe("a/b c");
  });

  test("omits replay when false", () => {
    const url = buildTerminalWsUrl("ws://h:1", "a", "t", false);
    expect(url).not.toContain("replay");
  });
});
