import { EventEmitter } from "node:events";
import * as pty from "node-pty";
import type { SessionInfo } from "../../pty-daemon/protocol";
import { SessionStore } from "../../pty-daemon/session-store";

/** What to launch for a session (the `claude` PTY). */
export interface SpawnMeta {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/**
 * In-process PTY lifecycle, owned by the backend host (replaces the out-of-process
 * pty-daemon's unix-socket control plane). Spawns each agent's `claude` directly,
 * fans output to the shared SessionStore's sinks (the renderer's terminal WebSocket
 * attaches there), and emits `output`/`exit` so the TerminalService status heuristic
 * can track working/idle without a separate transport.
 *
 * PTYs live and die with the host process. That's intentional: agent sessions are
 * short-lived (opened to deliver a task or for an interactive view), CC persists the
 * conversation to disk, and the host is supervised — so we trade the old daemon's
 * cross-restart survival for a single, simpler process boundary.
 */
export class TerminalManager extends EventEmitter {
  readonly store = new SessionStore();

  list(): SessionInfo[] {
    return this.store.list();
  }

  isLive(id: string): boolean {
    const s = this.store.get(id);
    return !!s && !s.exited;
  }

  /** Spawn a session (no-op if one is already live for this id). */
  open(id: string, meta: SpawnMeta): void {
    const existing = this.store.get(id);
    if (existing && !existing.exited) return; // never double-spawn
    if (existing) this.store.delete(id);

    const proc = pty.spawn(meta.command, meta.args, {
      name: "xterm-256color",
      cols: meta.cols,
      rows: meta.rows,
      cwd: meta.cwd,
      env: meta.env,
    });
    const session = this.store.add(id, proc);

    proc.onData((data) => {
      const buf = Buffer.from(data, "utf8");
      this.store.appendOutput(session, buf);
      for (const sink of session.sinks) sink.output(buf);
      this.emit("output", { id });
    });
    proc.onExit(({ exitCode, signal }) => {
      session.exited = true;
      session.exitCode = exitCode;
      session.exitSignal = signal ?? null;
      for (const sink of session.sinks) sink.exit(exitCode, signal ?? null);
      this.emit("exit", { id });
    });
  }

  close(id: string, signal: NodeJS.Signals = "SIGTERM"): void {
    const session = this.store.get(id);
    if (!session) return;
    if (!session.exited) {
      try {
        session.pty.kill(signal);
      } catch {
        // already gone
      }
    }
    this.store.delete(id);
  }

  /** Terminate every live session (host shutdown). */
  closeAll(signal: NodeJS.Signals = "SIGTERM"): void {
    for (const info of this.store.list()) this.close(info.id, signal);
  }
}
