import { hostLog } from "../host/log";
import { bus } from "./event-bus";

/** Grace after the last renderer disconnects before declaring the GUI gone, so a
 *  renderer reload / brief reconnect doesn't flap `gui:gone`. */
const GONE_GRACE_MS = 6_000;

/**
 * Tracks whether a GUI (renderer) is connected to the host, by counting renderer
 * tRPC WebSocket connections. The launcher's notification-relay WS is excluded — it
 * tags its URL `&client=relay`; the renderer's subscription socket carries no such
 * tag and stays open for the renderer's whole lifetime, so the count is a faithful
 * "GUI present" proxy. Host-side detection covers window-close, Cmd-Q, **and**
 * crash/SIGKILL uniformly (a dying launcher can't message us).
 *
 * Emits `gui:gone` on the ≥1→0 transition (after `GONE_GRACE_MS`). That's the host's
 * reliable "the GUI went away" signal — `TerminalService` tears down every interactive
 * PTY on it, so none are maintained outside the GUI (the BUG-1 fix).
 */
export class GuiPresence {
  private renderers = new Set<object>();
  /** Whether a GUI is currently declared present. Stays `true` through the disconnect
   *  grace so a quick reconnect doesn't flap, and gates the single `gui:gone` emit. */
  private present = false;
  private goneTimer: NodeJS.Timeout | null = null;

  constructor(private graceMs = GONE_GRACE_MS) {}

  /** Register a renderer WS connection (`key` is the socket, used to dedupe on close). */
  add(key: object): void {
    this.renderers.add(key);
    if (this.goneTimer) {
      clearTimeout(this.goneTimer);
      this.goneTimer = null;
    }
    if (!this.present) {
      this.present = true;
      hostLog.info("gui present");
    }
  }

  /** Deregister a renderer WS; declare the GUI gone after the grace if none reconnect. */
  remove(key: object): void {
    if (!this.renderers.delete(key)) return;
    if (this.renderers.size > 0) return;
    if (this.goneTimer) clearTimeout(this.goneTimer);
    this.goneTimer = setTimeout(() => {
      this.goneTimer = null;
      if (this.renderers.size === 0 && this.present) {
        this.present = false;
        hostLog.info("gui gone");
        bus.emitEvent("gui:gone", undefined);
      }
    }, this.graceMs);
  }
}

/** The host-wide GUI presence tracker (fed by the tRPC server's WS connect/close). */
export const guiPresence = new GuiPresence();

/** True if a tRPC WS connection is the launcher's notification relay (not the GUI). */
export function isRelayConnection(reqUrl: string | undefined): boolean {
  if (!reqUrl) return false;
  try {
    return new URL(reqUrl, "http://localhost").searchParams.get("client") === "relay";
  } catch {
    return false;
  }
}
