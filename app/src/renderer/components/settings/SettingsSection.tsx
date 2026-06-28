import type { ReactNode } from "react";

/** A titled group of settings rows with hairline separators between them. */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-2 divide-y divide-border">{children}</div>
    </section>
  );
}
