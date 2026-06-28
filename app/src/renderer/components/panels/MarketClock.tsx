import { useEffect, useState } from "react";
import { getMarketClock, type MarketState } from "../../lib/market-clock";
import { cn } from "../../lib/utils";

const LABEL: Record<MarketState, string> = {
  "pre-market": "Pre-market",
  open: "Open",
  "after-hours": "After-hours",
  closed: "Closed",
};

const TONE: Record<MarketState, string> = {
  "pre-market": "text-warning",
  open: "text-success",
  "after-hours": "text-warning",
  closed: "text-muted-foreground",
};

export function MarketClock() {
  const [clock, setClock] = useState(() => getMarketClock());
  useEffect(() => {
    const t = setInterval(() => setClock(getMarketClock()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-sm tabular-nums">{clock.time}</span>
        <span className="text-xs text-muted-foreground">{clock.weekday} · NY</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className={cn("size-1.5 rounded-full bg-current", TONE[clock.state])} />
        <span className={cn("text-xs font-medium", TONE[clock.state])}>{LABEL[clock.state]}</span>
      </div>
    </div>
  );
}
