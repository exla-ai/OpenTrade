import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { cn } from "@renderer/lib/utils";
import type * as React from "react";

/**
 * shadcn/ui ToggleGroup (Radix), kept deliberately unstyled beyond layout so each
 * use-site reproduces its own look via className + `data-[state=on]:…`. Backs the
 * Settings SegmentedControl (bordered, primary active) and the Activity scope
 * filter (borderless, muted active).
 */
function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("flex items-center gap-1", className)}
      {...props}
    />
  );
}

function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex items-center justify-center outline-none transition-colors disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { ToggleGroup, ToggleGroupItem };
