import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

/** A small segmented toggle for a closed set of string options, on Radix ToggleGroup. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      // Single ToggleGroup yields "" when the active item is re-clicked; ignore
      // that so the control always keeps a selection.
      onValueChange={(v) => v && onChange(v as T)}
      className="gap-1 rounded-md border border-border p-0.5"
    >
      {options.map((opt) => (
        <ToggleGroupItem
          key={opt.value}
          value={opt.value}
          className="rounded px-3 py-1 text-sm text-muted-foreground hover:bg-accent data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {opt.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
