# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately – do not open a public issue.

Contact: use [GitHub security advisories](https://github.com/ChaosChild/subtrk/security/advisories/new)
("Report a vulnerability"). You'll get an acknowledgement within a few days.

## What subtrk handles

subtrk reads live credential files owned by other CLIs (Claude Code, ZCode,
agy) and stores its own API keys in `~/.subtrk/env` (plaintext, inside your
user profile). The security model, trust boundaries, and accepted risks are
documented in [`docs/spec.md`](docs/spec.md) §Configuration & secrets and
summarized in the README's Security notes. The short version:

- Secrets are mechanically redacted from all output; the cache stores
  normalized quota data only.
- All vendor calls are read-only; no state-changing call exists.
- The web console binds 127.0.0.1 with per-run token auth (see the spec).

## Scope

- The `subtrk` code in this repository.
- Out of scope: the vendors' own endpoints (report abuse to them), and
  anything requiring code execution as your user – that boundary is already
  the documented trust model.
