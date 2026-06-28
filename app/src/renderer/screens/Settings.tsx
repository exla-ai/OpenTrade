import {
  Bot,
  Info,
  LineChart,
  Loader2,
  type LucideIcon,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { type CSSProperties, useState } from "react";
import { SegmentedControl } from "../components/settings/SegmentedControl";
import { SettingNumber } from "../components/settings/SettingNumber";
import { SettingsRow } from "../components/settings/SettingsRow";
import { SettingsSection } from "../components/settings/SettingsSection";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { useBrokerStatus } from "../hooks/useBroker";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { trpc } from "../lib/trpc";
import { cn } from "../lib/utils";
import { useUIStore } from "../stores/ui";

type CategoryId = "general" | "agents" | "approvals" | "market-data" | "about";

const CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "market-data", label: "Market data", icon: LineChart },
  { id: "about", label: "About", icon: Info },
];

const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;

/**
 * Full-screen settings. Replaces the agent panes (the sidebar stays). A category
 * rail on the left drives a content pane; every control auto-saves through the
 * settings mutation (no Save button).
 */
export function SettingsScreen() {
  const [category, setCategory] = useState<CategoryId>("general");
  const active = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0];

  return (
    <div className="flex flex-1 min-w-0 bg-background">
      {/* Category rail */}
      <nav className="flex w-56 shrink-0 flex-col border-r border-border bg-card">
        <div className="h-10 shrink-0" style={DRAG} />
        <div className="px-3 pb-2 pt-1">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Settings
          </span>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2" style={NO_DRAG}>
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCategory(c.id)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                  category === c.id
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {c.label}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Content */}
      <div className="flex flex-1 flex-col min-w-0">
        <div
          className="flex h-10 shrink-0 items-center border-b border-border px-6 text-sm font-medium"
          style={DRAG}
        >
          {active.label}
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl p-6">
            {category === "general" && <GeneralPanel />}
            {category === "agents" && <AgentsPanel />}
            {category === "approvals" && <ApprovalsPanel />}
            {category === "market-data" && <MarketDataPanel />}
            {category === "about" && <AboutPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function GeneralPanel() {
  const update = useUpdateSettings();
  const setView = useUIStore((s) => s.setView);

  return (
    <SettingsSection title="Setup" description="First-run onboarding.">
      <SettingsRow
        label="Re-run setup"
        hint="Reopen the onboarding wizard — Claude CLI check, Robinhood, first agent."
      >
        <button
          type="button"
          onClick={() => {
            update.mutate({ onboardingComplete: false });
            setView("agents");
          }}
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
        >
          Re-run setup
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}

function AgentsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;

  return (
    <SettingsSection title="Agents" description="Defaults applied when you create a new agent.">
      <SettingsRow
        label="Default approval mode"
        hint="Full-auto agents place orders without asking (still logged)."
      >
        <SegmentedControl
          options={[
            { value: "approve", label: "Require approval" },
            { value: "auto", label: "Full-auto" },
          ]}
          value={s.defaultApprovalMode}
          onChange={(defaultApprovalMode) => update.mutate({ defaultApprovalMode })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function ApprovalsPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;

  return (
    <SettingsSection title="Approvals" description="The order-approval queue gate.">
      <SettingsRow
        label="Approval timeout"
        hint="A pending order auto-declines after this long with no decision."
      >
        <SettingNumber
          value={s.approvalTimeoutSec}
          min={10}
          max={3600}
          suffix="seconds"
          onCommit={(approvalTimeoutSec) => update.mutate({ approvalTimeoutSec })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

function MarketDataPanel() {
  const settings = useSettings();
  const update = useUpdateSettings();
  const s = settings.data;
  if (!s) return null;

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Polling"
        description="How often OpenTrade refreshes Robinhood data for the panel."
      >
        <SettingsRow label="Focused interval" hint="Window focused, during market hours.">
          <SettingNumber
            value={s.pollIntervalFocusedSec}
            min={1}
            max={120}
            suffix="seconds"
            onCommit={(pollIntervalFocusedSec) => update.mutate({ pollIntervalFocusedSec })}
          />
        </SettingsRow>
        <SettingsRow label="Background interval" hint="Window blurred, or the market is closed.">
          <SettingNumber
            value={s.pollIntervalBlurredSec}
            min={1}
            max={600}
            suffix="seconds"
            onCommit={(pollIntervalBlurredSec) => update.mutate({ pollIntervalBlurredSec })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Robinhood connection"
        description="OpenTrade keeps its own read-only session for the portfolio panel."
      >
        <BrokerConnectionRow />
      </SettingsSection>
    </div>
  );
}

const STATUS_DOT: Record<string, string> = {
  connected: "bg-success",
  connecting: "bg-warning animate-pulse",
  error: "bg-destructive",
  disconnected: "bg-muted-foreground/50",
};

function BrokerConnectionRow() {
  const status = useBrokerStatus();
  const utils = trpc.useUtils();
  const connect = trpc.onboarding.connectBroker.useMutation({
    onSuccess: () => utils.broker.connectionStatus.invalidate(),
  });
  const st = status?.status ?? "disconnected";
  const account = status?.account;

  const hint =
    st === "connected" && account
      ? `${account.agentic ? "agentic" : account.type} · ${account.accountNumber}`
      : st === "connecting"
        ? "Connecting…"
        : "Not connected";

  return (
    <SettingsRow label="Status" hint={hint}>
      <div className="flex items-center gap-2.5">
        <span className={cn("size-2 shrink-0 rounded-full", STATUS_DOT[st])} />
        {st === "connected" ? (
          <span className="text-sm text-muted-foreground">Connected</span>
        ) : (
          <button
            type="button"
            disabled={connect.isPending || st === "connecting"}
            onClick={() => connect.mutate()}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {(connect.isPending || st === "connecting") && (
              <Loader2 className="size-4 animate-spin" />
            )}
            {st === "error" ? "Retry" : "Connect"}
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

function AboutPanel() {
  const info = trpc.system.appInfo.useQuery();
  const claude = trpc.onboarding.checkClaudeCli.useQuery();

  return (
    <SettingsSection
      title="About"
      description="OpenTrade — an open-source control panel for local trading agents."
    >
      <SettingsRow label="Version">
        <span className="text-sm tabular-nums text-muted-foreground">
          {info.data?.version ?? "—"}
        </span>
      </SettingsRow>
      <SettingsRow label="Platform">
        <span className="text-sm text-muted-foreground">{info.data?.platform ?? "—"}</span>
      </SettingsRow>
      <SettingsRow label="Claude Code CLI" hint="Required to run agents.">
        <span className="text-sm text-muted-foreground">
          {claude.isLoading ? "checking…" : claude.data?.found ? claude.data.version : "Not found"}
        </span>
      </SettingsRow>
      <SettingsRow label="Data directory">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="max-w-[18rem] truncate text-xs text-muted-foreground">
              {info.data?.home ?? "—"}
            </span>
          </TooltipTrigger>
          {info.data?.home && <TooltipContent>{info.data.home}</TooltipContent>}
        </Tooltip>
      </SettingsRow>
    </SettingsSection>
  );
}
