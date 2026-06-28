#!/bin/bash
# OpenTrade order-outcome hook (PostToolUse on Robinhood order tools).
#
# The order tool has already RUN — this reports its *result* (what Robinhood
# actually did: accepted, or rejected like "market orders not allowed in extended
# hours") to the app so the Activity feed reflects execution, not just approval.
# Purely observational: fire-and-forget, short timeout, always exit 0; it never
# blocks or changes the tool flow.

INPUT=$(cat)

if [ -n "${OPENTRADE_PORT}" ] && [ -n "${OPENTRADE_TOKEN}" ]; then
  printf '%s' "$INPUT" | curl -s --max-time 5 \
    -H "x-opentrade-token: ${OPENTRADE_TOKEN}" \
    -H "x-opentrade-agent: ${OPENTRADE_AGENT_ID}" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "http://127.0.0.1:${OPENTRADE_PORT}/hook/order-result" >/dev/null 2>&1 || true
fi

exit 0
