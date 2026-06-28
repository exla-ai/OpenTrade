import { describe, expect, test } from "bun:test";
import { bus } from "./event-bus";
import { GuiPresence, isRelayConnection } from "./gui-presence";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("GuiPresence", () => {
  test("gui:gone fires after the grace once the last renderer disconnects", async () => {
    const events: string[] = [];
    const offG = bus.onEvent("gui:gone", () => events.push("gone"));
    const gp = new GuiPresence(20);
    const a = {};
    const b = {};

    gp.add(a);
    gp.add(b);

    gp.remove(a);
    expect(events).toEqual([]); // b still connected
    gp.remove(b);
    expect(events).toEqual([]); // within the grace, not yet declared gone

    await wait(40);
    expect(events).toEqual(["gone"]);
    offG();
  });

  test("a reconnect within the grace cancels gui:gone (no flap)", async () => {
    const events: string[] = [];
    const offG = bus.onEvent("gui:gone", () => events.push("gone"));
    const gp = new GuiPresence(30);
    const a = {};
    const b = {};

    gp.add(a);
    gp.remove(a);
    await wait(10);
    gp.add(b); // reconnect before the grace elapses
    await wait(40);

    expect(events).toEqual([]); // no gone
    offG();
  });

  test("isRelayConnection detects the relay tag", () => {
    expect(isRelayConnection("/?token=x&client=relay")).toBe(true);
    expect(isRelayConnection("/?token=x")).toBe(false);
    expect(isRelayConnection(undefined)).toBe(false);
  });
});
