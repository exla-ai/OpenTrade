#!/bin/bash
# OpenTrade order-approval gate (PreToolUse on Robinhood order tools).
#
# Reads the Claude Code hook payload on stdin, POSTs it to the app's local server,
# and long-polls until the user approves/rejects in the Approvals panel (or the
# request times out). The server's JSON response IS the PreToolUse decision, so we
# echo it verbatim. Fails CLOSED: if the app is unreachable the order is denied,
# so a manually-launched `claude` can't trade while OpenTrade is gone.
#
# The curl --max-time below MUST exceed the app's approval timeout (default 300s),
# and the hook `timeout` in .claude/settings.json must exceed this. See plan risk #2.

INPUT=$(cat)
URL="http://127.0.0.1:${OPENTRADE_PORT}/hook/pretool-approval"

deny() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

if [ -z "${OPENTRADE_PORT}" ] || [ -z "${OPENTRADE_TOKEN}" ]; then
  deny "OpenTrade is not running (no local endpoint); the approval gate fails closed. Open OpenTrade, then retry."
fi

RESP=$(printf '%s' "$INPUT" | curl -s --max-time 360 \
  -H "x-opentrade-token: ${OPENTRADE_TOKEN}" \
  -H "x-opentrade-agent: ${OPENTRADE_AGENT_ID}" \
  -H "Content-Type: application/json" \
  --data-binary @- "$URL")
STATUS=$?

if [ "$STATUS" -ne 0 ] || [ -z "$RESP" ]; then
  deny "OpenTrade did not respond; the approval gate fails closed. Do not retry until the user confirms OpenTrade is running."
fi

printf '%s\n' "$RESP"
exit 0
