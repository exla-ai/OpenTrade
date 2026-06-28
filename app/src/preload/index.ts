import { contextBridge } from "electron";

/**
 * Expose the backend host endpoint to the renderer. The launcher passes the
 * tRPC port + token via `additionalArguments` (see window.ts); the renderer's
 * tRPC client (httpBatchLink + wsLink) reads them off `window.__opentradeHost`.
 * Replaces the old trpc-electron IPC bridge now that services live in the host.
 */
function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

contextBridge.exposeInMainWorld("__opentradeHost", {
  trpcPort: Number(arg("opentrade-trpc-port")) || 0,
  token: arg("opentrade-token"),
});
