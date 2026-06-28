import type { Agent } from "@shared/agent";
import { useState } from "react";
import { trpc } from "../lib/trpc";

/** Live agent list. The onChanged subscription emits the current list on
 *  connect and on every change, so it is the single source of truth — no
 *  seeding query, nothing to invalidate. */
export function useAgents(): Agent[] {
  const [agents, setAgents] = useState<Agent[]>([]);

  trpc.agents.onChanged.useSubscription(undefined, {
    onData: (list) => {
      // Cross-delivered IPC response guard (see trpcClient comment in lib/trpc.ts):
      // refuse non-arrays loudly instead of corrupting state and unmounting the app.
      if (!Array.isArray(list)) {
        console.error("agents.onChanged delivered a non-array — tRPC id collision?", list);
        return;
      }
      setAgents(list);
    },
  });

  return agents;
}
