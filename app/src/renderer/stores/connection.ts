import { create } from "zustand";

/**
 * Liveness of the renderer → backend-host tRPC WebSocket. The services live in
 * the detached host now, so the host can be briefly unreachable (mid-restart,
 * circuit-breaker, not yet spawned) — a failure mode the old in-process IPC never
 * had. The wsLink client drives this (onOpen/onClose) and the app shows a banner
 * when disconnected.
 */
interface ConnectionState {
  /** Optimistic: starts true to avoid a banner flash during the initial connect. */
  backendConnected: boolean;
  setConnected: (connected: boolean) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  backendConnected: true,
  setConnected: (backendConnected) => set({ backendConnected }),
}));
