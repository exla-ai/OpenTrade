import type { AgentStatus } from "@shared/agent";
import { cn } from "../../lib/utils";

const COLORS: Record<AgentStatus, string> = {
  idle: "bg-muted-foreground/50",
  working: "bg-sky-400 animate-pulse",
  "needs-input": "bg-amber-400",
  "awaiting-approval": "bg-red-500",
};

export function StatusDot({ status }: { status: AgentStatus }) {
  return <span className={cn("size-2 shrink-0 rounded-full", COLORS[status])} />;
}
