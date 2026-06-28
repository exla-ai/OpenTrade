import { Clock } from "lucide-react";
import { trpc } from "../../lib/trpc";

/**
 * EC1: the agent was woken by a schedule and is running a headless task (no PTY to
 * attach). Covers the terminal with a clock placeholder + an explicit "Stop task"
 * button. When the run finishes the agent's executionState flips and the
 * interactive session attaches automatically.
 */
export function HeadlessRunOverlay({ agentId }: { agentId: string }) {
  const stop = trpc.terminal.stopHeadlessRun.useMutation();
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-background">
      <Clock className="size-12 text-muted-foreground/30" strokeWidth={1.5} />
      <div className="flex max-w-xs flex-col items-center gap-1 text-center">
        <p className="text-sm text-muted-foreground">Running a scheduled task</p>
        <p className="text-xs text-muted-foreground/50">
          This agent was woken by a schedule and is working in the background. It becomes
          interactive when the task finishes.
        </p>
      </div>
      <button
        type="button"
        disabled={stop.isPending}
        onClick={() => stop.mutate({ agentId })}
        className="rounded-md bg-secondary px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
      >
        Stop task
      </button>
    </div>
  );
}
