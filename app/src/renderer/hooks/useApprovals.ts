import { trpc } from "../lib/trpc";

/** Pending approvals (the gate queue), kept live via the onChanged subscription. */
export function useApprovals() {
  const utils = trpc.useUtils();
  const pending = trpc.approvals.listPending.useQuery();

  trpc.approvals.onChanged.useSubscription(undefined, {
    onData: () => utils.approvals.listPending.invalidate(),
  });

  return { pending: pending.data ?? [] };
}
