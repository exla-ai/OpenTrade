// Auto-update for the packaged macOS app, via electron-updater against GitHub
// Releases (publish config in electron-builder.yml bakes app-update.yml into the
// build, which electron-updater reads — no feed URL needed here).
//
// OpenTrade-specific wrinkle: the backend host is a DETACHED process that survives
// the GUI quitting. After an update swaps the .app and the app relaunches, the new
// launcher's `ensureHost` already refuses to adopt a version-mismatched host and
// respawns a fresh one (see host/manifest.ts). As belt-and-suspenders we also
// SIGTERM the running host the moment an update is staged, so nothing old lingers
// across the quit/install.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { app, type BrowserWindow, Notification } from "electron";
import electronUpdater from "electron-updater";
import { OPENTRADE_HOME } from "./db/client";

const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4h

/** SIGTERM the running backend host so the post-install relaunch spawns fresh. */
function retireHost(): void {
  try {
    const m = JSON.parse(readFileSync(join(OPENTRADE_HOME, "host.json"), "utf8")) as {
      pid?: number;
    };
    if (m.pid) process.kill(m.pid, "SIGTERM");
  } catch {
    // no manifest / already gone
  }
}

export function initAutoUpdate(_win: BrowserWindow): void {
  // electron-updater requires a packaged app with a baked app-update.yml.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Differential downloads are flaky on macOS zip updates; full download is robust.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on("update-downloaded", (info) => {
    // Stage is complete; autoInstallOnAppQuit will apply it on the next quit.
    retireHost();
    if (Notification.isSupported()) {
      new Notification({
        title: "OpenTrade update ready",
        body: `Version ${info.version} will install when you quit OpenTrade.`,
      }).show();
    }
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater]", err);
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch((err) => console.error("[updater] check failed", err));
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS);
}
