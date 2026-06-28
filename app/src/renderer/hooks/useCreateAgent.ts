import type { CreateAgentInput } from "@shared/agent";
import { useCallback } from "react";
import { trpc } from "../lib/trpc";
import { useUIStore } from "../stores/ui";

/**
 * Create a new agent from a fully-specified config and select it. The New Agent
 * dialog gathers the config (name, template, approval mode); every entry point
 * (sidebar button, empty-state CTA, ⌘T) opens that dialog rather than creating
 * immediately. On success the new agent is selected and the dialog closes.
 */
export function useCreateAgent() {
  const select = useUIStore((s) => s.select);
  const setView = useUIStore((s) => s.setView);
  const closeNewAgent = useUIStore((s) => s.closeNewAgent);
  const mutation = trpc.agents.create.useMutation({
    onSuccess: (agent) => {
      select(agent.id);
      setView("agents");
      closeNewAgent();
    },
  });

  const create = useCallback(
    (input: CreateAgentInput) => {
      if (mutation.isPending) return;
      mutation.mutate(input);
    },
    [mutation],
  );

  return { create, isPending: mutation.isPending };
}
