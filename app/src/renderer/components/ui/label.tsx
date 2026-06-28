import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@renderer/lib/utils";
import type * as React from "react";

/**
 * shadcn/ui Label (Radix). Default look is shadcn-standard
 * (`text-sm font-medium`); OpenTrade's compact field labels override to
 * `text-xs text-muted-foreground` via className.
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm font-medium leading-none select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Label };
