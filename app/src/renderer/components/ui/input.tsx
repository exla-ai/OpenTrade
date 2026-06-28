import { cn } from "@renderer/lib/utils";
import type * as React from "react";

/**
 * shadcn/ui Input, tuned to OpenTrade's compact look: `px-3 py-1.5 text-sm`,
 * `border-border`, and a subtle focus (border brightens to `--ring`, no glow
 * ring) to match the inline inputs it replaces. Overridable via className.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none transition-colors",
        "placeholder:text-muted-foreground/60 focus-visible:border-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
