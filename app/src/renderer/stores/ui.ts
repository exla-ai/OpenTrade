import { create } from "zustand";

export type RightTab = "portfolio" | "activity" | "monitor";
/** Top-level pane: the agent workspace, the full-screen Scheduled view, or Settings. */
export type AppView = "agents" | "scheduled" | "settings";

interface UIState {
  selectedAgentId: string | null;
  rightTab: RightTab;
  view: AppView;
  /** Whether the New Agent configuration dialog is open. */
  newAgentOpen: boolean;
  /** Hide dollar balances in the Portfolio pane (masked as ****). Session-only. */
  balancesHidden: boolean;
  select: (id: string | null) => void;
  setRightTab: (tab: RightTab) => void;
  setView: (view: AppView) => void;
  openNewAgent: () => void;
  closeNewAgent: () => void;
  toggleBalances: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  selectedAgentId: null,
  rightTab: "portfolio",
  view: "agents",
  newAgentOpen: false,
  balancesHidden: false,
  select: (id) => set({ selectedAgentId: id }),
  setRightTab: (tab) => set({ rightTab: tab }),
  setView: (view) => set({ view }),
  openNewAgent: () => set({ newAgentOpen: true }),
  closeNewAgent: () => set({ newAgentOpen: false }),
  toggleBalances: () => set((s) => ({ balancesHidden: !s.balancesHidden })),
}));
