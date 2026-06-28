#!/bin/bash
# OpenTrade status hook (Notification / Stop).
#
# Forwards the Claude Code hook payload to the app's local server, which dispatches
# on hook_event_name: Notification → needs-input; Stop → clears needs-input + captures
# session_id for the Resume button. Fire-and-forget with a short timeout so it never
# delays Claude Code; always exits 0.

INPUT=$(cat)

if [ -n "${OPENTRADE_PORT}" ] && [ -n "${OPENTRADE_TOKEN}" ]; then
  printf '%s' "$INPUT" | curl -s --max-time 5 \
    -H "x-opentrade-token: ${OPENTRADE_TOKEN}" \
    -H "x-opentrade-agent: ${OPENTRADE_AGENT_ID}" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "http://127.0.0.1:${OPENTRADE_PORT}/hook/status" >/dev/null 2>&1 || true
fi

exit 0
