# subt

**One command for all your AI subscription quotas.** `subt` reports remaining usage
across paid AI plans — Claude Pro, Z.ai GLM Coding Plan, Alibaba Cloud Model Studio,
Google AI Pro, OpenCode Zen, OpenRouter — as one compact view, designed first for the
AI agents that work for you and second for you.

Agents stop hitting brick walls at rate limits: `subt status --json` gives every
window's usage and reset time plus a computed `nextEvent`, so an agent can schedule a
wake-up at the reset instead of dying. Humans stop keeping six vendor tabs open.

```text
$ subt
claude     5h 13% (reset 18:04) · 7d 89% !
glm        5h 4% (reset 19:47) · 7d 61%
alibaba    credits 31,240/45,000 · cycle ends 2026-10-12
google     5h 62% left · weekly 81% left   [stale]
opencode   PAYG · no usage API (signals only)
openrouter $74.75 left · key today $1.20
next: claude 5h at 18:09 (4h 49m)
help: subt status --json | subt status --provider <id> | subt init
```

## Why

Modern AI workstations juggle several subscriptions with different windows (5-hour,
weekly, monthly credit pools) and different dashboards. Without a combined view you
over-plan, under-use, and your agents discover limits by crashing into them. `subt`
reads each vendor's usage the same way their own CLIs do, normalizes it, caches it
politely, and speaks both human and agent.

## Design principles

- **Agents first** — follows the [AXI principles](https://axi.md): token-efficient
  output, pre-computed aggregates (`nextEvent`, `recheckAfter`), structured errors
  you branch on by kind (never by message text), exit codes with meaning, no
  interactive traps in agent paths, content before help.
- **Zero dependencies** — TypeScript executed directly by Node ≥22.18 (type
  stripping). No install beyond `npm link`, no build step, no supply chain.
- **Polite by construction** — one shared TTL cache (`~/.subt/cache.json`) with
  stale-while-revalidate and a hard 300s floor on the one endpoint known to punish
  polling. Six agents checking simultaneously produce one upstream request.
- **Fail soft, per provider** — one broken endpoint never breaks the others; errors
  carry a `kind` and a `hint`, and stale cached numbers beat a wall of text.
- **Secrets stay put** — reads the credential files your CLIs already maintain
  (read-only), stores its own keys in `~/.subt/env` (never global env vars), and
  mechanically redacts every secret from every output. The cache contains no secrets.

## Install

Requires Node ≥22.18.

```bash
git clone https://github.com/ChaosChild/subt.git
cd subt
npm link        # puts `subt` on PATH (subt.cmd on Windows)
subt init       # one-time interactive setup
```

`subt init` checks every provider's credentials, runs the Alibaba login flow
(`bl auth login --api-key` + `--console` browser login), prompts for OpenRouter
keys (hidden input, saved to `~/.subt/env`), and verifies each provider honestly —
`[ok]` only when a credential actually works.

## Providers

| Provider | Plan | Reads | Windows | Status |
|---|---|---|---|---|
| Anthropic | Claude Pro (personal) | `api.anthropic.com/api/oauth/usage` via the OAuth token Claude Code already stores | 5h + 7d | reverse-engineered, de-facto standard |
| Z.ai | GLM Coding Plan | the same monitor endpoint ZCode itself uses | 5h + weekly | unofficial, officially plugin-endorsed |
| Alibaba Cloud | Model Studio Token Plan (intl) | official `bl` CLI raw gateway passthrough (`bl console call`) | 30-day credits pool (monthly-only since 2026-09-22) | official (via bl) |
| Google | AI Pro (personal) | agy's Credential Manager token → Code Assist quota summary (body `{}`, UA `antigravity`) | per-family 5h/weekly (gemini + claude-and-gpt families) | best-effort — degrades to `agy /usage` |
| OpenCode | Zen pay-as-you-go | no usage/balance API exists for PAYG | — | signals only (honest note) |
| OpenRouter | pay-as-you-go | `/api/v1/key` (+ `/api/v1/credits` with a management key) | — | official |

None of these vendors officially supports third-party quota readers except Alibaba
and OpenRouter; the others are the same calls their own CLIs make, and can change.
`subt` isolates that churn in six small provider modules and degrades cleanly.

## For agents

```bash
subt status --json
```

- `providers[].windows[].resetsAt` — ISO-8601 UTC reset instants.
- `nextEvent.at` — the earliest time new information can exist
  (`max(resetsAt, fetchedAt + ttl)`); schedule the wake-up there.
- `recheckAfter` — heartbeat when no `nextEvent` applies.
- `providers[].error.kind` — branch on it: `no-credentials`, `expired-token`,
  `tool-missing`, `rate-limited`, `forbidden`, `not-readable-remotely`,
  `parse-failure`, `subprocess-failed`, `timeout`, `http-error`.
- Exit codes: `0` ran (per-provider errors are in the output) · `1` CLI/runtime
  failure · `2` usage error · `3` `--strict` violation.
- On Windows, spawn `subt.cmd` (or use `shell: true`) — there is no bare `.exe`.

A ZCode/Claude Code-style harness can check before a large task and, at ≥95% of a
window, schedule a wake-up at `nextEvent.at` and continue on another provider in the
meantime — no intervention needed.

## Configuration

- `~/.subt/config.json` — `{ "enabled": ["claude", "glm", ...] }` (absent = all).
- `~/.subt/env` — `OPENROUTER_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`, optional
  `OPENCODE_API_KEY` (dotenv format; process env wins). Written by `subt init`.
- Everything else is read from the credential files your CLIs already own:
  `~/.claude/.credentials.json`, `~/.zcode/cli/config.json`, `~/.gemini/*`,
  `~/.local/share/opencode/auth.json`, `bl`'s own store.

## Security notes

- `subt` is read-only towards vendors (no state-changing calls exist in the codebase).
- Secrets are mechanically redacted from all output; the cache stores normalized
  quota data only. See `docs/spec.md` §Redaction.
- `~/.subt/env` holds plaintext keys inside your user profile — the same trust
  envelope as the vendor credential files it reads. Design decisions and known
  trade-offs are tracked in `docs/decisions.md`.

## Documentation

- [`docs/spec.md`](docs/spec.md) — full CLI specification (output contract, cache,
  provider integrations, `subt init`).
- [`docs/decisions.md`](docs/decisions.md) — design decisions D1–D8 with rationale.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) — implementation
  guide: layout, coding rules, how to add a provider.
- [`docs/phases.md`](docs/phases.md) — roadmap (M2 web console, M3 analytics, parked).

## License

MIT
