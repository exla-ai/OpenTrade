import type { Agent } from "@shared/agent";
import { Bot, RotateCw, ShieldCheck, Zap } from "lucide-react";
import { type CSSProperties, useEffect, useRef } from "react";
import { comboKeys, SHORTCUTS } from "../../lib/shortcuts";
import { terminalController } from "../../lib/terminal/session-controller";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useConnectionStore } from "../../stores/connection";
import { useTerminalStore } from "../../stores/terminal";
import { useUIStore } from "../../stores/ui";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { BrokenAgentOverlay } from "./BrokenAgentOverlay";
import { HeadlessRunOverlay } from "./HeadlessRunOverlay";

export function TerminalPane({ agent }: { agent: Agent | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const liveness = useTerminalStore((s) => (agent ? s.liveness[agent.id] : undefined));
  const openNewAgent = useUIStore((s) => s.openNewAgent);
  const backendConnected = useConnectionStore((s) => s.backendConnected);
  const agentId = agent?.id;
  // No live PTY to attach while a headless wake runs (EC1) or the session is
  // broken (EC13); an overlay covers the terminal in those states instead.
  const attachable =
    agent != null && (agent.executionState === "offline" || agent.executionState === "interactive");

  // Mount the single reused terminal runtime once.
  useEffect(() => {
    if (containerRef.current) terminalController.mount(containerRef.current);
  }, []);

  // Show the selected agent (or nothing). The controller resets + reattaches. When
  // a headless run finishes the executionState flips to offline → we attach, so the
  // interactive session comes up automatically (EC1).
  useEffect(() => {
    if (agentId && attachable) terminalController.attach(agentId);
    else terminalController.detach();
  }, [agentId, attachable]);

  // The host auto-respawns a dead `--resume` session as a fresh `claude`;
  // reattach the focused agent so the new stream appears without a Resume click.
  trpc.terminal.onRespawn.useSubscription(undefined, {
    onData: ({ agentId }) => terminalController.reconnect(agentId),
  });

  return (
    // Backend down: grey the whole agent pane (opacity only — keeps the title bar's
    // window-drag region working) and block interaction in the body + header actions.
    <div
      className={cn(
        "flex h-full flex-1 flex-col bg-background min-w-0",
        !backendConnected && "opacity-50",
      )}
    >
      <div
        className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4 text-sm"
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <span className="text-muted-foreground">{agent ? agent.name : "OpenTrade"}</span>
        <div
          className={cn("flex items-center gap-2", !backendConnected && "pointer-events-none")}
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          {agent && <ApprovalModeToggle agent={agent} />}
          {agent && attachable && liveness === "dead" && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => terminalController.resume(agent.id)}
            >
              <RotateCw className="size-3" /> Resume
            </Button>
          )}
        </div>
      </div>

      <div className={cn("relative flex-1 min-h-0", !backendConnected && "pointer-events-none")}>
        {/* The reused xterm runtime is always mounted here. When no agent is
            selected the placeholder below covers it (solid bg) so a stale/empty
            terminal never shows through. */}
        <div
          ref={containerRef}
          className={`absolute inset-0 p-2 ${agent ? "" : "pointer-events-none"}`}
        />
        {agent?.executionState === "headless" && <HeadlessRunOverlay agentId={agent.id} />}
        {agent?.executionState === "broken" && <BrokenAgentOverlay agentId={agent.id} />}
        {!agent && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-background">
            <Bot className="size-12 text-muted-foreground/30" strokeWidth={1.5} />
            <Button
              type="button"
              variant="ghost"
              onClick={openNewAgent}
              className="gap-3 px-2 text-muted-foreground"
            >
              <span>Create Agent</span>
              <span className="flex items-center gap-1">
                {comboKeys(SHORTCUTS["create-agent"].combo).map((k) => (
                  <kbd
                    key={k}
                    className="flex size-5 items-center justify-center rounded border border-border bg-muted/60 text-[11px] font-medium"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Per-agent approval mode. "Require approval" routes order tools through the
 * approval queue; "Full-auto" lets them through (still audited). The live agent
 * row comes from the agents subscription, so the label updates after the mutation.
 */
function ApprovalModeToggle({ agent }: { agent: Agent }) {
  const update = trpc.agents.update.useMutation();
  const auto = agent.approvalMode === "auto";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={update.isPending}
          onClick={() => update.mutate({ id: agent.id, approvalMode: auto ? "approve" : "auto" })}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs disabled:opacity-50",
            auto
              ? "bg-warning/15 text-warning hover:bg-warning/25"
              : "bg-secondary text-muted-foreground hover:bg-accent",
          )}
        >
          {auto ? <Zap className="size-3" /> : <ShieldCheck className="size-3" />}
          {auto ? "Full-auto" : "Approval"}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {auto
          ? "Full-auto: orders execute without approval (still logged). Click to require approval."
          : "Require approval: orders wait for your decision. Click to switch to full-auto."}
      </TooltipContent>
    </Tooltip>
  );
}
