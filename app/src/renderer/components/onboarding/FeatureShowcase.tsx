import { StatusDot } from "@renderer/components/layout/StatusDot";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import type { AgentStatus } from "@shared/agent";
import { ArrowRight, Clock, Radio } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

/**
 * Onboarding step shown right before "Create your first agent": three core
 * features side by side, each a tinted card holding a small static preview built
 * from a subset of a real OpenTrade surface (the Scheduled list, the Portfolio
 * panel, the agent sidebar). Purely presentational — no live data, just a taste
 * of what the app does before the user creates anything.
 */
export function FeatureShowcase({ onNext, className }: { onNext: () => void; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)}>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <Feature
          tint="sky"
          title="Persistent timers & crons"
          blurb="Agents schedule their own wake-ups — recurring crons and signal-based monitors that keep firing after you close the app."
          mock={<TimersMock />}
        />
        <Feature
          tint="emerald"
          title="Track your portfolio"
          blurb="See your account's equity, day change, and open positions, updated in real time."
          mock={<PortfolioMock />}
        />
        <Feature
          tint="violet"
          title="Orchestrate multiple agents"
          blurb="Status dots show which are working, need input, or are waiting on your approval."
          mock={<AgentsMock />}
        />
      </div>

      <div className="mt-6 flex justify-end">
        <Button type="button" onClick={onNext}>
          Continue <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feature column: tinted card holding the mock, with copy beneath.    */
/* ------------------------------------------------------------------ */

type Tint = "sky" | "emerald" | "violet";

const TINTS: Record<Tint, string> = {
  sky: "bg-sky-500/10 ring-sky-500/15",
  emerald: "bg-emerald-500/10 ring-emerald-500/15",
  violet: "bg-violet-500/10 ring-violet-500/15",
};

function Feature({
  tint,
  title,
  blurb,
  mock,
}: {
  tint: Tint;
  title: string;
  blurb: string;
  mock: ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <div className={cn("rounded-2xl p-4 ring-1", TINTS[tint])}>
        {/* The inset "app screenshot": a real OpenTrade panel, dark card + border. */}
        <div className="h-60 overflow-hidden rounded-xl border border-border bg-card shadow-xl shadow-black/30">
          {mock}
        </div>
      </div>
      <div className="mt-5 px-1">
        <h3 className="text-base font-medium text-foreground">{title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{blurb}</p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock 1 — Persistent timers & crons (slice of Scheduled / Monitor).  */
/* ------------------------------------------------------------------ */

function TimersMock() {
  return (
    <div className="p-3">
      <SectionLabel>Scheduled</SectionLabel>
      <div className="mt-1 flex flex-col">
        <CronRow
          icon={Clock}
          tone="text-sky-400"
          title="Pre-market review"
          schedule="Weekdays · 9:30 AM ET"
          right="in 3h"
        />
        <CronRow
          icon={Clock}
          tone="text-sky-400"
          title="Midday rebalance"
          schedule="Weekdays · 12:00 PM"
          right="in 6h"
        />
        <CronRow
          icon={Radio}
          tone="text-emerald-400"
          title="SPY drops 2% intraday"
          schedule="On signal"
          right="live"
          rightTone="text-emerald-400"
        />
        <CronRow
          icon={Clock}
          tone="text-sky-400"
          title="Weekly thesis check"
          schedule="Sundays · 6:00 PM"
          right="in 2d"
        />
      </div>
    </div>
  );
}

function CronRow({
  icon: Icon,
  tone,
  title,
  schedule,
  right,
  rightTone = "text-muted-foreground",
}: {
  icon: ComponentType<{ className?: string }>;
  tone: string;
  title: string;
  schedule: string;
  right: string;
  rightTone?: string;
}) {
  return (
    <div className="flex items-start gap-2 border-t border-border py-2 text-sm first:border-t-0">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", tone)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
          <span className={cn("shrink-0 text-[11px] tabular-nums", rightTone)}>{right}</span>
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{schedule}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock 2 — Account portfolio (slice of the Portfolio panel).          */
/* ------------------------------------------------------------------ */

function PortfolioMock() {
  return (
    <div className="p-3">
      <div className="text-2xl font-semibold tabular-nums text-foreground">$1,974.04</div>
      <div className="mt-0.5 flex items-baseline gap-1.5 text-xs font-medium text-success">
        <span aria-hidden>▲</span>
        <span className="tabular-nums">$34.14 (1.78%)</span>
        <span className="font-normal text-muted-foreground">Today</span>
      </div>

      <div className="mt-3 flex flex-col">
        <BalanceRow label="Buying power" value="$16.71" />
        <BalanceRow label="Cash" value="$16.71" />
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between">
          <SectionLabel>Positions</SectionLabel>
          <span className="text-[10px] text-muted-foreground">agentic · ••••4471</span>
        </div>
        <div className="mt-1">
          <PosRow symbol="NVDA" last="$182.11" pnl="+$19.40" dir="up" />
          <PosRow symbol="SNDK" last="$2,091.08" pnl="-$0.93" dir="down" />
        </div>
      </div>
    </div>
  );
}

function BalanceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-1.5 text-sm first:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function PosRow({
  symbol,
  last,
  pnl,
  dir,
}: {
  symbol: string;
  last: string;
  pnl: string;
  dir: "up" | "down";
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 py-1 text-sm">
      <span className="font-medium text-foreground">{symbol}</span>
      <span className="text-right text-[11px] tabular-nums text-muted-foreground">{last}</span>
      <span
        className={cn(
          "w-16 text-right tabular-nums",
          dir === "up" ? "text-success" : "text-destructive",
        )}
      >
        {pnl}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mock 3 — Orchestrating multiple agents (slice of the agent sidebar).*/
/* ------------------------------------------------------------------ */

function AgentsMock() {
  return (
    <div className="h-full bg-sidebar p-2 text-sidebar-foreground">
      <div className="px-2 pb-1 pt-1">
        <SectionLabel>Agents</SectionLabel>
      </div>
      <AgentRow name="Citrini Bot" status="working" note="working" selected />
      <AgentRow name="DCA SPY/VOO" status="idle" />
      <AgentRow
        name="SNDK Earnings"
        status="needs-input"
        note="needs input"
        noteTone="text-amber-400"
      />
      <AgentRow name="Pelosi Tracker" status="awaiting-approval" badge="1" />
      <AgentRow name="13F Scanner" status="idle" />
      <AgentRow name="X stock mentions" status="working" />
    </div>
  );
}

function AgentRow({
  name,
  status,
  note,
  noteTone = "text-muted-foreground",
  badge,
  selected,
}: {
  name: string;
  status: AgentStatus;
  note?: string;
  noteTone?: string;
  badge?: string;
  selected?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        selected && "bg-sidebar-accent font-medium",
      )}
    >
      <StatusDot status={status} />
      <span className="flex-1 truncate">{name}</span>
      {note && <span className={cn("shrink-0 text-[11px]", noteTone)}>{note}</span>}
      {badge && (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-medium text-white">
          {badge}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}
