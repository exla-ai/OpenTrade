import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    // Bundle `ws` into the daemon bundle (pure JS, no native code) rather than
    // externalizing it: a detached ELECTRON_RUN_AS_NODE child resolving a
    // bundled dep avoids the asar/runtime-require fragility that bites native
    // modules. node-pty stays externalized (native, ABI-rebuilt).
    plugins: [externalizeDepsPlugin({ exclude: ["ws"] })],
    resolve: {
      alias: {
        "@main": resolve("src/main"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      sourcemap: true,
      rollupOptions: {
        // ws's optional perf deps — left as runtime requires so ws's internal
        // try/catch falls back to its pure-JS implementations.
        external: ["bufferutil", "utf-8-validate"],
        input: {
          index: resolve("src/main/index.ts"),
          // Persistent, headless backend host; spawned detached by the app via
          // ELECTRON_RUN_AS_NODE. Owns DB/broker/gate/PTYs and serves the GUI.
          host: resolve("src/main/host/index.ts"),
          // Per-agent MCP server (`opentrade`): cron/monitor tools over stdio,
          // spawned by `claude` (interactive + headless) per each agent's .mcp.json.
          // Dependency-free → self-contained bundle, robust under asar.
          "agent-mcp": resolve("src/agent-mcp/index.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve("src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer"),
        "@shared": resolve("src/shared"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve("src/renderer/index.html") },
      },
    },
  },
});
