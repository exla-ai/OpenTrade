import { trpc } from "../lib/trpc";

/** Global app settings, kept live via the onChanged subscription. */
export function useSettings() {
  const utils = trpc.useUtils();
  const query = trpc.settings.get.useQuery();
  trpc.settings.onChanged.useSubscription(undefined, {
    onData: () => utils.settings.get.invalidate(),
  });
  return query;
}

/** Mutation to patch settings; the onChanged subscription refreshes readers. */
export function useUpdateSettings() {
  const utils = trpc.useUtils();
  return trpc.settings.update.useMutation({
    onSuccess: () => utils.settings.get.invalidate(),
  });
}
