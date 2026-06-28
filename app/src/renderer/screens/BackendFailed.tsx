import { ServerCrash } from "lucide-react";
import type { CSSProperties } from "react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

/**
 * Shown when the backend host failed to start (the launcher couldn't spawn/adopt a
 * host, so the renderer got trpcPort===0 and can never reach state). Replaces the
 * blank-screen hang with a clear explanation; the user quits and reopens OpenTrade.
 */
export function BackendFailed() {
  return (
    <Empty
      className="h-full w-full bg-background"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <EmptyMedia>
        <ServerCrash className="size-12 text-foreground" strokeWidth={1.5} />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>OpenTrade failed to start</EmptyTitle>
        <EmptyDescription>
          Failed to connect to the backend. Please restart OpenTrade to try again.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
