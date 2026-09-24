# Security Policy

## Reporting a vulnerability

Please report security issues privately through GitHub's [private vulnerability reporting](https://github.com/mandofever78/oPius/security/advisories/new), not in public issues.

Include the affected version, steps to reproduce, and the impact. You can expect an acknowledgement within a few days.

## Scope

oPius sits between pi and the Claude Code CLI, so these are in scope:

- Anything that exposes Claude Code's credentials or authorization headers.
- Other local users or processes reaching the loopback relay or its MCP endpoint.
- Requests being billed to an API key or backend other than the signed-in subscription.
- Model output causing a tool call outside pi's current tool inventory.

Vulnerabilities in pi or Claude Code themselves should go to their maintainers.

## Supported versions

Only the latest release receives fixes.
