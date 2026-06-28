import { useEffect, useRef } from "react";
import { matchesCombo, SHORTCUTS, type ShortcutId } from "../lib/shortcuts";

type Handlers = Partial<Record<ShortcutId, () => void>>;

/**
 * Bind handlers to the declared {@link SHORTCUTS}. Listens on the capture phase
 * so app shortcuts win over the focused terminal (xterm) before it consumes the
 * keystroke; a matched combo is preventDefault'd and stops propagating.
 */
export function useShortcuts(handlers: Handlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      for (const def of Object.values(SHORTCUTS)) {
        const handler = handlersRef.current[def.id];
        if (handler && matchesCombo(event, def.combo)) {
          event.preventDefault();
          event.stopPropagation();
          handler();
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
