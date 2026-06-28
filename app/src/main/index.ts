import { join } from "node:path";
import type { Approval } from "@shared/approval";
import { createTRPCClient, createWSClient, wsLink } from "@trpc/client";
import { app, BrowserWindow, Notification } from "electron";
import superjson from "superjson";
import { WebSocket as NodeWebSocket } from "ws";
import { OPENTRADE_HOME } from "./db/client";
import { ensureHost, type HostManifest } from "./host/manifest";
import type { AppRouter } from "./trpc/routers";
import { initAutoUpdate } from "./updater";
import { createMainWindow } from "./window";

let mainWindow: BrowserWindow | null = null;
let relayClient: ReturnType<typeof createWSClient> | null = null;
let relayTrpc: ReturnType<typeof createTRPCClient<AppRouter>> | null = null;

// Key Electron's per-instance state (including the single-instance lock) to this
// home so parallel dev instances with distinct OPENTRADE_HOME don't collide.
app.setPath("userData", join(OPENTRADE_HOME, "electron"));

if (!app.requestSingleInstanceLock()) {
  // Another OpenTrade GUI is already running for this home — defer to it and exit.
  // (The backend host is separate and keeps running regardless.)
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(main);
}

async function main() {
  // The backend brokers real trades; surface its version to the headless host.
  process.env.OPENTRADE_VERSION = app.getVersion();

  // Adopt a running backend host or spawn one (detached, supervised). This is the
  // only way the GUI reaches state now — services live in the host, not here.
  let host: HostManifest;
  try {
    host = await ensureHost(join(__dirname, "host.js"), app.getVersion());
  } catch (err) {
    console.error("[launcher] backend host unavailable", err);
    // Still open the window, but with a zeroed port. The renderer reads trpcPort===0
    // as "backend failed to start" and shows a dedicated screen (BackendFailed)
    // instead of hanging on a blank screen.
    host = { pid: 0, faucetPort: 0, trpcPort: 0, token: "", startedAt: 0 };
  }

  const win = createMainWindow({ trpcPort: host.trpcPort, token: host.token });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (host.trpcPort) wireApprovalAlerts(win, host);

  // Auto-update against GitHub Releases (no-op in dev / unpackaged). Retires the
  // running backend host on install so the new build's code takes effect.
  initAutoUpdate(win);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow({ trpcPort: host.trpcPort, token: host.token });
    }
  });
}

// macOS: closing the window does not quit the app. The backend host is detached
// and survives regardless, so agent sessions keep running with the GUI closed.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // GUI going away → drop the broker to the blurred poll cadence. We do NOT tear
  // down PTYs here: the host's gui-presence detector already fires on the renderer
  // WS dropping (covers Cmd-Q, window-close, and crash uniformly) and tears down
  // every interactive PTY on `gui:gone` (§12.2). Headless `-p` scheduled runs are
  // PTY-independent, so they run to completion regardless of the GUI.
  relayTrpc?.broker.setFocused.mutate({ focused: false }).catch(() => {});
  relayClient?.close();
});

/**
 * Notification relay. The approval state lives in the backend now, so the macOS
 * Notification + dock badge are driven by a small tRPC-over-WS client subscribing
 * to the host's `approvals.onPending`/`onChanged` — out of the data path.
 */
function wireApprovalAlerts(win: BrowserWindow, host: HostManifest) {
  const wsClient = createWSClient({
    // Tag this connection `&client=relay` so the host's gui-presence detector
    // excludes it — only true renderer connections count as "GUI present" (§12.2).
    url: `ws://127.0.0.1:${host.trpcPort}?token=${encodeURIComponent(host.token)}&client=relay`,
    // Electron main is a Node context; supply a WebSocket implementation.
    WebSocket: NodeWebSocket as unknown as typeof WebSocket,
  });
  relayClient = wsClient;
  const client = createTRPCClient<AppRouter>({
    links: [wsLink({ client: wsClient, transformer: superjson })],
  });
  relayTrpc = client;

  // Relay window focus to the host so it polls the broker at the fast cadence only
  // while the user is watching (the host defaults to the blurred cadence). The
  // window opens focused, so assert that once, then track focus/blur.
  const setFocused = (focused: boolean) =>
    client.broker.setFocused.mutate({ focused }).catch(() => {});
  setFocused(true);
  win.on("focus", () => setFocused(true));
  win.on("blur", () => setFocused(false));

  const updateBadge = async () => {
    try {
      const n = await client.approvals.pendingCount.query();
      app.dock?.setBadge(n > 0 ? String(n) : "");
    } catch {
      // host briefly unreachable — leave the badge as-is
    }
  };

  client.approvals.onPending.subscribe(undefined, {
    onData: (a: Approval) => {
      if (Notification.isSupported()) {
        const n = new Notification({
          title: `Approval needed — ${a.agentName ?? "agent"}`,
          body: a.parsed?.summary ?? a.toolName,
        });
        n.on("click", () => {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        });
        n.show();
      }
      if (!win.isFocused()) win.flashFrame(true);
      win.focus();
      void updateBadge();
    },
  });

  client.approvals.onChanged.subscribe(undefined, {
    onData: () => void updateBadge(),
  });
}
