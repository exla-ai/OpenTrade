import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { cn } from "@renderer/lib/utils";
import { CircleIcon } from "lucide-react";
import type * as React from "react";

/**
 * shadcn/ui RadioGroup (Radix). `RadioGroupItem` is the standard dot control;
 * `RadioGroupCard` is OpenTrade's selectable-card item (the New Agent template /
 * environment / approval pickers) — a bordered card that highlights on
 * `data-[state=checked]`, replacing the old hand-rolled EnvCard/ApprovalCard.
 * Mark the card `group` so inner bits can react via `group-data-[state=checked]`.
 */
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-4 shrink-0 rounded-full border border-input text-primary shadow-xs outline-none",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="relative flex items-center justify-center">
        <CircleIcon className="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 fill-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

function RadioGroupCard({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-card"
      className={cn(
        "rounded-md border border-border text-left outline-none transition-colors hover:bg-accent",
        "data-[state=checked]:border-primary data-[state=checked]:bg-primary/10 data-[state=checked]:hover:bg-primary/10",
        "focus-visible:border-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { RadioGroup, RadioGroupCard, RadioGroupItem };
