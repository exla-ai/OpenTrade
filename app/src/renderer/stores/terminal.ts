import { create } from "zustand";

export type Liveness = "connecting" | "live" | "dead";

interface TerminalState {
  liveness: Record<string, Liveness>;
  setLiveness: (agentId: string, value: Liveness) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  liveness: {},
  setLiveness: (agentId, value) => set((s) => ({ liveness: { ...s.liveness, [agentId]: value } })),
}));
