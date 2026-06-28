import { cn } from "@renderer/lib/utils";
import type * as React from "react";

/**
 * shadcn/ui Textarea, tuned to OpenTrade's look (`border-border`, subtle
 * border-brighten focus). Overridable via className.
 */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors",
        "placeholder:text-muted-foreground focus-visible:border-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
