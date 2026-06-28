import { RotateCw, TriangleAlert } from "lucide-react";
import { trpc } from "../../lib/trpc";

/**
 * EC13: the agent's session is unresumable (broken). Covers the terminal with a
 * warning placeholder + a "Restart" button that starts a brand-new session via the
 * normal respawn path. Chat history is lost, but the agent re-reads STRATEGY.md on
 * startup so the strategy survives.
 */
export function BrokenAgentOverlay({ agentId }: { agentId: string }) {
  const restart = trpc.terminal.restart.useMutation();
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-background">
      <TriangleAlert className="size-12 text-warning/40" strokeWidth={1.5} />
      <div className="flex max-w-xs flex-col items-center gap-1 text-center">
        <p className="text-sm text-muted-foreground">This agent's session can't be resumed</p>
        <p className="text-xs text-muted-foreground/50">
          Restarting begins a fresh session. Chat history is lost, but the agent re-reads
          STRATEGY.md on startup so the strategy continues.
        </p>
      </div>
      <button
        type="button"
        disabled={restart.isPending}
        onClick={() => restart.mutate({ agentId })}
        className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        <RotateCw className="size-3" /> Restart
      </button>
    </div>
  );
}
