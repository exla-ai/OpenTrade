#!/usr/bin/env bash
#
# dev.sh — run / restart / kill the OpenTrade GUI and backend daemon for THIS worktree.
#
#   ./dev.sh run  gui   (re)start the Electron GUI only — the daemon keeps running
#   ./dev.sh run  all   (re)start the whole stack: kill GUI + daemon, then bring both up
#   ./dev.sh kill gui   stop the GUI only — the daemon keeps running
#   ./dev.sh kill all   stop everything: the GUI and the daemon
#   ./dev.sh status     show what's running for this worktree
#
# By default `run` seeds this worktree's Robinhood auth from ~/.opentrade (the
# rh_oauth_* rows in app.db's settings table) so the dev instance is already
# authorized. Pass --no-auth-copy to skip it; set OPENTRADE_AUTH_SRC to use a
# different source home.
#
# Worktree isolation
# ------------------
# The backend "host" daemon is a singleton per OPENTRADE_HOME (it owns the DB, the
# host.json manifest, the spawn lock, and a port derived from that path). This script
# pins OPENTRADE_HOME to a per-worktree directory, so every worktree gets its own
# isolated daemon / DB / port and they never fight. `bun run dev` inherits the env,
# and the detached host it spawns inherits it in turn (see host/manifest.ts spawnHost).
#
# Why "gui" leaves the daemon alone: the daemon is designed to outlive the GUI (agents
# keep trading with the window closed), so restarting just the GUI is the fast inner
# loop. Restarting via "all" is the full, clean-backend restart.

set -euo pipefail

# --- Worktree-aware paths -----------------------------------------------------
# This script lives at the root of its worktree, so its own directory IS the worktree.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKTREE_ROOT="$SCRIPT_DIR"

export OPENTRADE_HOME="${OPENTRADE_HOME:-$WORKTREE_ROOT/.opentrade-dev}"
mkdir -p "$OPENTRADE_HOME"

APP_PIDFILE="$OPENTRADE_HOME/dev-app.pid"
APP_LOG="$OPENTRADE_HOME/dev-app.log"
HOST_MANIFEST="$OPENTRADE_HOME/host.json"
HOST_LOCK="$OPENTRADE_HOME/host.lock"

# Source home to seed Robinhood auth from (your real instance). The auth lives as
# rows in app.db's `settings` table (rh_oauth_*), not a standalone file, so we copy
# just those rows — never the whole DB (which would share live agents/audit/trades).
AUTH_SRC="${OPENTRADE_AUTH_SRC:-$HOME/.opentrade}"
AUTH_COPY=true   # default on; disable per-run with `run <gui|all> --no-auth-copy`

# Resolve bun even when PATH is minimal (e.g. launched from a non-login shell
# that never sourced the user's profile — the `bun: command not found` case).
# Prepend its dir to PATH so the GUI's child processes can find it too.
BUN=""
if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
else
  for _c in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    [ -x "$_c" ] && { BUN="$_c"; break; }
  done
fi
[ -n "$BUN" ] && export PATH="$(dirname "$BUN"):$PATH"

# --- Helpers ------------------------------------------------------------------
log() { printf '\033[1;34m[dev]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[dev]\033[0m %s\n' "$*" >&2; }

require_bun() {
  [ -n "$BUN" ] && return 0
  err "bun not found on PATH or in ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin."
  err "Install bun or add it to PATH, then retry."
  exit 1
}

alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

# pid of the Electron app launched by this script (the `bun run dev` process).
app_pid() {
  [ -f "$APP_PIDFILE" ] || return 1
  local pid
  pid="$(cat "$APP_PIDFILE" 2>/dev/null || true)"
  alive "$pid" && { echo "$pid"; return 0; }
  return 1
}

# pid of the detached backend host, read from its manifest.
host_pid() {
  [ -f "$HOST_MANIFEST" ] || return 1
  local pid
  pid="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$HOST_MANIFEST" 2>/dev/null || true)"
  alive "$pid" && { echo "$pid"; return 0; }
  return 1
}

# Kill a process and all of its descendants, optionally sparing one subtree.
# `sig` defaults to TERM. `exclude` (a pid) and its descendants are left alone —
# this is how `kill gui` avoids the detached daemon, which is still a PPID-child
# of the Electron main process (detached gives it a new session, not a new PPID).
kill_tree() {
  local pid="$1" sig="${2:-TERM}" exclude="${3:-}" child
  [ -n "$pid" ] || return 0
  [ -n "$exclude" ] && [ "$pid" = "$exclude" ] && return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child" "$sig" "$exclude"
  done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Graceful TERM, then KILL the stragglers after a short grace period.
stop_tree() {
  local pid="$1" exclude="${2:-}" i
  alive "$pid" || return 0
  kill_tree "$pid" TERM "$exclude"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    alive "$pid" || return 0
    sleep 0.3
  done
  kill_tree "$pid" KILL "$exclude"
}

# --- Robinhood auth seeding ---------------------------------------------------
# Copy just the rh_oauth_* rows from the source home's app.db into this worktree's
# app.db so the dev instance is already authorized (no re-consent per worktree).
copy_auth() {
  $AUTH_COPY || { log "auth: copy disabled (--no-auth-copy)"; return 0; }

  local src="$AUTH_SRC/app.db" dst="$OPENTRADE_HOME/app.db"

  # A live daemon holds the DB open and is already past auth init; don't poke it.
  if host_pid >/dev/null 2>&1; then
    log "auth: daemon already running — leaving its DB untouched"
    return 0
  fi
  # Self-copy (OPENTRADE_HOME == AUTH_SRC) would be a no-op at best; skip.
  if [ "$(cd "$AUTH_SRC" 2>/dev/null && pwd)" = "$(cd "$OPENTRADE_HOME" 2>/dev/null && pwd)" ]; then
    return 0
  fi
  command -v sqlite3 >/dev/null 2>&1 || { err "auth: sqlite3 not found — skipping"; return 0; }

  # Seed once, not every run: if this worktree's DB is already authorized, leave it
  # alone (the dev instance may have refreshed its own tokens — don't clobber them).
  if [ -f "$dst" ] && [ "$(sqlite3 "$dst" "SELECT count(*) FROM settings WHERE key='rh_oauth_tokens' AND value<>'';" 2>/dev/null || echo 0)" -ne 0 ]; then
    log "auth: already present in this worktree — skipping copy"
    return 0
  fi

  [ -f "$src" ] || { log "auth: no source DB at $src — skipping"; return 0; }

  local n
  n="$(sqlite3 "$src" "SELECT count(*) FROM settings WHERE key IN ('rh_oauth_tokens','rh_oauth_client','rh_oauth_verifier');" 2>/dev/null || echo 0)"
  if [ "${n:-0}" -eq 0 ]; then
    log "auth: source has no Robinhood auth — skipping (you'll authorize in-app)"
    return 0
  fi

  sqlite3 "$dst" <<SQL
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ATTACH DATABASE '$src' AS src;
INSERT INTO settings (key, value)
  SELECT key, value FROM src.settings
   WHERE key IN ('rh_oauth_tokens','rh_oauth_client','rh_oauth_verifier')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
DETACH DATABASE src;
SQL
  chmod 600 "$dst" 2>/dev/null || true
  log "auth: seeded $n Robinhood key(s) from $src"
}

# --- GUI (Electron app) -------------------------------------------------------
kill_gui() {
  local pid hpid
  if pid="$(app_pid)"; then
    # Spare the detached daemon (PPID-child of Electron main until it exits) so
    # restarting the GUI doesn't take the backend — the whole point of `gui`.
    hpid="$(host_pid || true)"
    log "stopping gui (pid $pid)"
    stop_tree "$pid" "$hpid"
  else
    log "gui not running"
  fi
  rm -f "$APP_PIDFILE"
}

# Ensure the native modules are built for Electron's ABI. `bun install` builds them
# for system Node, but the detached host runs under Electron's Node
# (ELECTRON_RUN_AS_NODE) — a mismatch crashes the host with NODE_MODULE_VERSION and
# `ensureHost` times out ("backend host did not start" → blank window). We probe the
# actual failure mode (load the native modules under Electron's Node) and rebuild only
# on mismatch — so the fix is idempotent and self-heals a node_modules that was populated
# by any other means (e.g. a bare `bun install`), not just a fresh worktree. Cheap: the
# probe is a ~100ms check, and we rebuild only when it fails. We exercise both native
# addons so the probe is faithful to every ABI failure mode — and crucially we must do so
# by actually loading their bindings, not just `require()`-ing the package. better-sqlite3
# LAZY-loads its `.node`: `require("better-sqlite3")` returns the JS wrapper without ever
# dlopen()-ing the addon, so a bare require false-PASSES on an ABI mismatch (the rebuild
# never fires, then the host crashes at runtime opening the DB). Constructing a Database
# forces the dlopen, which is the real failure mode. (node-pty loads its binding eagerly
# at require, so requiring it is already faithful.)
ensure_native_abi() {
  local electron_bin="$WORKTREE_ROOT/app/node_modules/.bin/electron"
  [ -x "$electron_bin" ] || return 0  # nothing built yet; install path handles it
  if ( cd "$WORKTREE_ROOT/app" && ELECTRON_RUN_AS_NODE=1 "$electron_bin" \
        -e 'new (require("better-sqlite3"))(":memory:").close();require("node-pty")' ) >/dev/null 2>&1; then
    return 0
  fi
  log "rebuilding native modules for Electron's ABI (mismatch detected)…"
  ( cd "$WORKTREE_ROOT/app" && "$BUN" run rebuild )
}

# Install deps when they're missing OR stale. We previously only installed on a missing
# node_modules, so a deps change with node_modules already present (a pull/merge/rebase
# that updates package.json + bun.lock) slipped through and `bun run dev` died on an
# unresolved import (e.g. a newly-added @radix-ui/* package). We stamp the install point
# and reinstall whenever bun.lock or app/package.json is newer than that stamp — bun's
# `-nt` test also fires when the stamp is absent, so a node_modules populated by any other
# means self-heals on the first run. `bun install` is a near-instant no-op when up to date.
ensure_deps() {
  local stamp="$WORKTREE_ROOT/app/node_modules/.opentrade-deps-stamp"
  if [ ! -d "$WORKTREE_ROOT/app/node_modules" ]; then
    log "installing deps (first run in this worktree)…"
    ( cd "$WORKTREE_ROOT" && "$BUN" install )
  elif [ "$WORKTREE_ROOT/bun.lock" -nt "$stamp" ] || [ "$WORKTREE_ROOT/app/package.json" -nt "$stamp" ]; then
    log "dependencies changed since last install — reinstalling…"
    ( cd "$WORKTREE_ROOT" && "$BUN" install )
  fi
  # Record the install point so an unchanged lockfile doesn't reinstall next run.
  touch "$stamp" 2>/dev/null || true
}

run_gui() {
  require_bun
  kill_gui
  # Install deps when missing or stale (fresh worktree, or a pull/merge changed the
  # lockfile) so `bun run dev` never starts against an out-of-date node_modules.
  ensure_deps
  # Always verify the native ABI (cheap probe; rebuilds only on mismatch) so a stray
  # `bun install` against system Node can't leave the host unbootable.
  ensure_native_abi
  copy_auth
  log "starting gui  (OPENTRADE_HOME=$OPENTRADE_HOME)"
  log "  logs: $APP_LOG"
  # Backgrounded subshell with exec so $! is the bun process itself; its children
  # (electron-vite, electron) are reached via pgrep -P on teardown. The detached
  # host daemon escapes this tree by design, so `kill gui` won't touch it.
  ( cd "$WORKTREE_ROOT" && exec "$BUN" run dev ) >>"$APP_LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$APP_PIDFILE"
  log "gui started (pid $pid)"
}

# --- All (GUI + backend daemon) -----------------------------------------------
kill_all() {
  # The GUI is useless without its backend, so tearing down the daemon tears down
  # the GUI too — keeps the stack consistent.
  kill_gui
  local pid
  if pid="$(host_pid)"; then
    log "stopping daemon (pid $pid)"
    stop_tree "$pid"
  else
    log "daemon not running"
  fi
  # Clear manifest + any stale spawn lock so the next launch starts clean.
  rm -f "$HOST_MANIFEST" "$HOST_LOCK"
}

run_all() {
  # Full stack: nuke GUI + daemon, then start the GUI — which adopts-or-spawns a
  # fresh daemon via ensureHost(). (The daemon needs out/main/host.js, which
  # `bun run dev` builds, so we bring it up through the GUI rather than alone.)
  kill_all
  run_gui
}

# --- Status -------------------------------------------------------------------
status() {
  log "worktree:      $WORKTREE_ROOT"
  log "OPENTRADE_HOME: $OPENTRADE_HOME"
  local pid
  if pid="$(app_pid)"; then log "gui:    running (pid $pid)"; else log "gui:    stopped"; fi
  if pid="$(host_pid)"; then log "daemon: running (pid $pid)"; else log "daemon: stopped"; fi
}

# --- Dispatch -----------------------------------------------------------------
usage() {
  cat >&2 <<'EOF'
usage: ./dev.sh <run|kill> <gui|all> [--no-auth-copy]
       ./dev.sh status

  run  gui    (re)start the Electron GUI only (daemon keeps running)
  run  all    (re)start the whole stack (GUI + daemon)
  kill gui    stop the GUI only (daemon keeps running)
  kill all    stop everything (GUI + daemon)
  status      show what's running for this worktree

options:
  --no-auth-copy   don't seed Robinhood auth from ~/.opentrade (run only)

By default `run` copies the Robinhood auth (rh_oauth_* rows) from
$OPENTRADE_AUTH_SRC (default ~/.opentrade) into this worktree so the dev
instance is already authorized. Override the source with OPENTRADE_AUTH_SRC.
EOF
  exit 2
}

# Strip the --no-auth-copy flag from anywhere in the args; the rest are positional.
# (No arrays, for bash 3.2 compatibility; our tokens never contain spaces.)
POS=""
for a in "$@"; do
  if [ "$a" = "--no-auth-copy" ]; then AUTH_COPY=false; else POS="$POS $a"; fi
done
# shellcheck disable=SC2086
set -- $POS

cmd="${1:-}"
target="${2:-}"

case "$cmd" in
  status) status ;;
  run)
    case "$target" in
      gui) run_gui ;;
      all) run_all ;;
      *)   usage ;;
    esac ;;
  kill)
    case "$target" in
      gui) kill_gui ;;
      all) kill_all ;;
      *)   usage ;;
    esac ;;
  *) usage ;;
esac
