# Security Policy

OpenTrade runs autonomous agents that can place real trades with real money, so
we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately through GitHub's
[private vulnerability reporting](https://github.com/exla-ai/OpenTrade/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab). This keeps the
details confidential until a fix is available.

When reporting, please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept.
- Affected version(s) and platform.

We will acknowledge your report, investigate, and keep you updated on remediation.
Please give us a reasonable window to ship a fix before any public disclosure.

## Scope

Security-relevant areas of particular interest:

- The **order-approval gate** and anything that could let an agent place or cancel
  orders without passing through it.
- Handling of **broker OAuth tokens and credentials** (storage, transport, scope).
- The **local API / IPC surface** between the GUI, the backend host, and agents.
- The **auto-update** path and release artifact integrity.

## Out of scope

- Losses resulting from agent trading decisions or market risk — OpenTrade is
  experimental software and you are responsible for what your agents do (see the
  disclaimer in the README).
- Vulnerabilities in third-party dependencies that are already publicly tracked
  upstream (please report those to the upstream project).
