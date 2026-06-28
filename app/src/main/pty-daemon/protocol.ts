// Shared shape for the terminal session list. The old unix-socket wire protocol
// (length-prefixed frames, hello-ack, client/daemon message types) was removed
// when the PTY daemon was folded in-process (see services/terminal/manager.ts);
// only this summary type survives, used by the session store + manager.

export interface SessionInfo {
  id: string;
  pid: number;
  alive: boolean;
  exitCode: number | null;
}
