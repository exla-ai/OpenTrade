/**
 * App-wide keyboard shortcut registry. One place to declare a shortcut's combo
 * + label; `useShortcuts` (see hooks) binds handlers to these, and UI can render
 * the combo via `formatCombo`. Add new entries here as the app grows.
 */

export type ShortcutId = "create-agent";

export interface KeyCombo {
  /** Requires the platform command key (⌘ on macOS, Ctrl elsewhere). */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** `KeyboardEvent.key`, matched case-insensitively. */
  key: string;
}

export interface ShortcutDef {
  id: ShortcutId;
  combo: KeyCombo;
  label: string;
}

export const SHORTCUTS: Record<ShortcutId, ShortcutDef> = {
  "create-agent": {
    id: "create-agent",
    combo: { mod: true, key: "t" },
    label: "Create Agent",
  },
};

export const isMac =
  typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

/** True when `event` matches `combo` (modifier state must match exactly). */
export function matchesCombo(event: KeyboardEvent, combo: KeyCombo): boolean {
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (Boolean(combo.mod) !== mod) return false;
  if (Boolean(combo.shift) !== event.shiftKey) return false;
  if (Boolean(combo.alt) !== event.altKey) return false;
  return event.key.toLowerCase() === combo.key.toLowerCase();
}

/** The combo as individual key tokens, e.g. ["⌘", "T"] or ["Ctrl", "T"]. */
export function comboKeys(combo: KeyCombo): string[] {
  const parts: string[] = [];
  if (combo.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (combo.shift) parts.push(isMac ? "⇧" : "Shift");
  if (combo.alt) parts.push(isMac ? "⌥" : "Alt");
  parts.push(combo.key.toUpperCase());
  return parts;
}

/** Human-readable combo, e.g. "⌘T" on macOS or "Ctrl+T" elsewhere. */
export function formatCombo(combo: KeyCombo): string {
  const parts = comboKeys(combo);
  return isMac ? parts.join("") : parts.join("+");
}
