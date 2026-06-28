import { createHash } from "node:crypto";
import { OPENTRADE_HOME } from "../../db/client";

/**
 * Stable bind port for the local API / approval gate.
 *
 * Derived deterministically from OPENTRADE_HOME so the port is the SAME across
 * app restarts (the fix for the stale-endpoint bug: PTYs baked with OPENTRADE_PORT
 * at spawn stay valid forever), yet DIFFERENT for parallel dev instances that use
 * distinct homes (so they don't collide). Overridable via OPENTRADE_API_PORT.
 *
 * Range 20000–29999 (well clear of the OAuth callback's fixed 8771 and the
 * ephemeral range).
 */
export function derivePort(home: string = OPENTRADE_HOME): number {
  const override = Number(process.env.OPENTRADE_API_PORT);
  if (Number.isInteger(override) && override >= 1024 && override <= 65535) return override;
  const digest = createHash("sha256").update(home).digest();
  return 20000 + (digest.readUInt16BE(0) % 10000);
}
