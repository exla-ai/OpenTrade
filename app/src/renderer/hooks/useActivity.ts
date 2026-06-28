import { trpc } from "../lib/trpc";

/** Audit feed, optionally scoped to one agent, live via the onChanged subscription. */
export function useActivity(agentId?: string) {
  const utils = trpc.useUtils();
  const feed = trpc.activity.feed.useQuery(agentId ? { agentId } : undefined);

  trpc.activity.onChanged.useSubscription(undefined, {
    onData: () => utils.activity.feed.invalidate(),
  });

  return feed.data ?? [];
}
