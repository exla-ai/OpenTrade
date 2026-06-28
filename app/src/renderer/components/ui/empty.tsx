import { cn } from "@renderer/lib/utils";
import type * as React from "react";

/**
 * shadcn/ui Empty, tuned to OpenTrade's minimal empty/error-state look (centered
 * bare icon + small title + muted description), versus shadcn's stock dashed-border
 * card with a boxed icon and large title. Backs the BackendFailed screen; reusable
 * for the app's other empty states.
 */
function Empty({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty"
      className={cn("flex flex-col items-center justify-center gap-6 text-center", className)}
      {...props}
    />
  );
}

function EmptyMedia({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-media"
      className={cn(
        "flex shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function EmptyHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-header"
      className={cn("flex max-w-xs flex-col items-center gap-1 text-center", className)}
      {...props}
    />
  );
}

function EmptyTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="empty-title" className={cn("text-sm text-foreground", className)} {...props} />
  );
}

function EmptyDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="empty-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle };
