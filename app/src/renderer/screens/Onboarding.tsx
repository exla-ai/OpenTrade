import { AlertTriangle, ArrowRight, Check, Loader2, Terminal } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { useUpdateSettings } from "../hooks/useSettings";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useUIStore } from "../stores/ui";

type Step = "claude" | "broker" | "agent";
const STEPS: Step[] = ["claude", "broker", "agent"];
const STEP_LABELS: Record<Step, string> = {
  claude: "Claude Code",
  broker: "Robinhood",
  agent: "First agent",
};

/**
 * First-run wizard. Three lightweight steps — confirm the Claude Code CLI is
 * installed, connect Robinhood (optional; the panel degrades without it), and
 * create the first agent. Finishing (or skipping the last step) persists
 * `onboardingComplete`, which is what App.tsx gates on.
 */
export function Onboarding() {
  const [step, setStep] = useState<Step>("claude");
  const finishSettings = useUpdateSettings();

  const finish = () => finishSettings.mutate({ onboardingComplete: true });
  const next = () => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1]);
    else finish();
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-8">
      <div className="w-[30rem]">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-foreground">OpenTrade</h1>
        </div>

        <Stepper current={step} />

        <Card className="mt-6 rounded-lg p-5">
          {step === "claude" && <ClaudeStep onNext={next} />}
          {step === "broker" && <BrokerStep onNext={next} />}
          {step === "agent" && <AgentStep onDone={finish} pending={finishSettings.isPending} />}
        </Card>

        <button
          type="button"
          onClick={finish}
          className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
        >
          Skip setup
        </button>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: Step }) {
  const currentIdx = STEPS.indexOf(current);
  return (
    <div className="flex items-center justify-center gap-2">
      {STEPS.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={cn(
              "flex size-6 items-center justify-center rounded-full text-xs font-medium",
              i < currentIdx && "bg-success text-white",
              i === currentIdx && "bg-primary text-primary-foreground",
              i > currentIdx && "bg-muted text-muted-foreground",
            )}
          >
            {i < currentIdx ? <Check className="size-3.5" /> : i + 1}
          </div>
          <span
            className={cn(
              "text-xs",
              i === currentIdx ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {STEP_LABELS[s]}
          </span>
          {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function ClaudeStep({ onNext }: { onNext: () => void }) {
  const probe = trpc.onboarding.checkClaudeCli.useQuery();
  const found = probe.data?.found;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Terminal className="mt-0.5 size-5 text-muted-foreground" />
        <div>
          <h2 className="text-sm font-medium">Claude Code CLI</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Each agent runs as a Claude Code session in an embedded terminal, so the{" "}
            <code className="rounded bg-muted px-1">claude</code> CLI must be installed.
          </p>
        </div>
      </div>

      <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
        {probe.isLoading ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Checking…
          </span>
        ) : found ? (
          <span className="flex items-center gap-2 text-success">
            <Check className="size-4" /> Found {probe.data?.version}
          </span>
        ) : (
          <span className="flex items-center gap-2 text-warning">
            <AlertTriangle className="size-4" /> Not found on your PATH
          </span>
        )}
      </div>

      {!found && !probe.isLoading && (
        <p className="text-xs text-muted-foreground">
          Install it from <span className="font-mono">claude.com/code</span>, then re-check. You can
          continue anyway, but agents won't start until it's available.
        </p>
      )}

      <div className="flex justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={() => probe.refetch()}
          className="text-muted-foreground"
        >
          Re-check
        </Button>
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function BrokerStep({ onNext }: { onNext: () => void }) {
  const status = trpc.broker.connectionStatus.useQuery();
  const utils = trpc.useUtils();
  const connect = trpc.onboarding.connectBroker.useMutation({
    onSuccess: () => utils.broker.connectionStatus.invalidate(),
  });
  const connected = status.data?.status === "connected";

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">Connect Robinhood</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          OpenTrade keeps its own read-only Robinhood session to power the portfolio panel. This
          opens a browser for a one-time login. You can skip and connect later — the panel just
          stays empty until you do.
        </p>
      </div>

      {connected ? (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <span className="flex items-center gap-2 text-success">
            <Check className="size-4" /> Connected
            {status.data?.account && (
              <span className="text-muted-foreground">
                · {status.data.account.agentic ? "agentic" : status.data.account.type}{" "}
                {status.data.account.accountNumber}
              </span>
            )}
          </span>
        </div>
      ) : (
        <Button
          type="button"
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
          className="justify-center gap-2 py-2"
        >
          {connect.isPending && <Loader2 className="size-4 animate-spin" />}
          Connect Robinhood
        </Button>
      )}

      {connect.isError && (
        <p className="text-xs text-destructive">Connection failed. You can try again or skip.</p>
      )}

      <div className="flex justify-between">
        <Button type="button" variant="ghost" onClick={onNext} className="text-muted-foreground">
          Skip for now
        </Button>
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function AgentStep({ onDone, pending }: { onDone: () => void; pending: boolean }) {
  const [name, setName] = useState("My first agent");
  const select = useUIStore((s) => s.select);
  const settings = trpc.settings.get.useQuery();
  const create = trpc.agents.create.useMutation({
    onSuccess: (agent) => {
      select(agent.id);
      onDone();
    },
  });

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    create.mutate({
      name: trimmed,
      template: "default",
      approvalMode: settings.data?.defaultApprovalMode ?? "approve",
    });
  };

  const busy = create.isPending || pending;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">Create your first agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The agent opens a Claude Code session in its own folder and interviews you about your
          goals. Order-placing tools require your approval by default.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-agent-name">Name</Label>
        <Input
          id="onboarding-agent-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          maxLength={80}
          className="px-2"
        />
      </div>

      {create.isError && <p className="text-xs text-destructive">Couldn't create the agent.</p>}

      <div className="flex justify-between">
        <Button
          type="button"
          variant="ghost"
          onClick={onDone}
          disabled={busy}
          className="text-muted-foreground"
        >
          Skip
        </Button>
        <Button type="button" onClick={submit} disabled={busy || !name.trim()}>
          {busy && <Loader2 className="size-4 animate-spin" />}
          Create agent
        </Button>
      </div>
    </div>
  );
}
