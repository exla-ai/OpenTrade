import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { OPENTRADE_HOME } from "../db/client";

/**
 * Durable host log. The backend runs detached and headless (no terminal, stdout
 * goes nowhere), yet it brokers real trades — so lifecycle, supervision, gate
 * decisions and broker errors must land in a file the user (and we) can inspect
 * after the fact. Appends to ~/.opentrade/host.log; also mirrors to stderr so a
 * foreground dev run still shows output.
 */
const LOG_FILE = join(OPENTRADE_HOME, "host.log");

function write(level: string, args: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ")}\n`;
  try {
    mkdirSync(OPENTRADE_HOME, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch {
    // best-effort; never let logging crash the host
  }
  // Mirror to stderr (visible when the host is run in the foreground for dev).
  process.stderr.write(line);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const hostLog = {
  info: (...args: unknown[]) => write("info", args),
  warn: (...args: unknown[]) => write("warn", args),
  error: (...args: unknown[]) => write("error", args),
  file: LOG_FILE,
};
