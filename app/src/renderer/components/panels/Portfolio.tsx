import { Loader2 } from "lucide-react";
import { useBrokerData, useBrokerStatus } from "../../hooks/useBroker";
import { ago, num, pct, signedUsd, usd } from "../../lib/format";
import { trpc } from "../../lib/trpc";
import { cn } from "../../lib/utils";
import { useUIStore } from "../../stores/ui";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

/** Placeholder shown in place of a dollar amount when balances are hidden. */
const MASK = "****";

export function Portfolio() {
  const status = useBrokerStatus();
  const connect = trpc.onboarding.connectBroker.useMutation();
  const data = useBrokerData();
  const balancesHidden = useUIStore((s) => s.balancesHidden);
  const toggleBalances = useUIStore((s) => s.toggleBalances);

  if (!status || status.status === "disconnected" || status.status === "error") {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          Connect your Robinhood account to see live portfolio data. This opens a browser for a
          one-time login; OpenTrade keeps a read-only session.
        </p>
        <Button
          type="button"
          disabled={connect.isPending}
          onClick={() => connect.mutate()}
          className="gap-2"
        >
          {connect.isPending && <Loader2 className="size-4 animate-spin" />}
          Connect Robinhood
        </Button>
        {status?.status === "error" && (
          <p className="text-xs text-destructive">Connection failed. Try again.</p>
        )}
      </div>
    );
  }

  if (status.status === "connecting") {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connecting…
      </div>
    );
  }

  const p = data.portfolio?.value;
  const positions = data.positions?.value ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        {/* Click the value to hide/show all dollar balances (masked as ****). */}
        <button
          type="button"
          onClick={toggleBalances}
          aria-label={balancesHidden ? "Show balances" : "Hide balances"}
          className="cursor-pointer text-3xl font-semibold tabular-nums outline-none transition-opacity hover:opacity-70"
        >
          {balancesHidden ? MASK : usd(p?.equity)}
        </button>
        <DayChange change={p?.dayChange} fraction={p?.dayChangePct} hidden={balancesHidden} />
      </div>

      <div className="flex flex-col">
        <Row label="Buying power" value={balancesHidden ? MASK : usd(p?.buyingPower)} />
        <Row label="Cash" value={balancesHidden ? MASK : usd(p?.cash)} />
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Positions
          </span>
          {status.account && (
            <span className="text-[11px] text-muted-foreground">
              {status.account.agentic ? "agentic" : status.account.type} ·{" "}
              {status.account.accountNumber}
            </span>
          )}
        </div>
        {positions.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No open positions.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Last</TableHead>
                <TableHead className="text-right">P&L</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {positions.map((pos) => (
                <TableRow key={pos.symbol}>
                  <TableCell className="font-medium">{pos.symbol}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(pos.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(pos.lastPrice)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      (pos.unrealizedPnl ?? 0) > 0 && "text-success",
                      (pos.unrealizedPnl ?? 0) < 0 && "text-destructive",
                    )}
                  >
                    {signedUsd(pos.unrealizedPnl)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {isStale(data.portfolio?.fetchedAt) && (
        <p className="text-[11px] text-muted-foreground">as of {ago(data.portfolio?.fetchedAt)}</p>
      )}
    </div>
  );
}

/** True when the last successful broker update is missing or older than a minute. */
function isStale(ts: number | null | undefined): boolean {
  if (!ts) return true;
  return Date.now() - ts > 60_000;
}

/** Today's account move: ▲/▼ $X (Y%) Today, colored green/red. The dollar amount
 *  masks with the other balances; the direction arrow and percentage stay visible. */
function DayChange({
  change,
  fraction,
  hidden,
}: {
  change: number | null | undefined;
  fraction: number | null | undefined;
  hidden: boolean;
}) {
  if (change === null || change === undefined) {
    return <div className="mt-1 text-sm text-muted-foreground">— Today</div>;
  }
  const up = change >= 0;
  return (
    <div
      className={cn(
        "mt-1 flex items-baseline gap-1.5 text-sm font-medium",
        up ? "text-success" : "text-destructive",
      )}
    >
      <span aria-hidden>{up ? "▲" : "▼"}</span>
      <span className="tabular-nums">
        {hidden ? MASK : usd(Math.abs(change))} ({pct(fraction)})
      </span>
      <span className="font-normal text-muted-foreground">Today</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-border py-2 text-sm first:border-t-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
