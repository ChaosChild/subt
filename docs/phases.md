# subt — Phases

## M1 — CLI (done)

`subt status` + `subt init`, all six providers, TTL cache, tests.

## M2 — Web console (next)

`subt serve`: `node:http` server on 127.0.0.1 (random port + random local auth
token — see the security note in `docs/implementation-plan.md`), serving one
static HTML dashboard + `/api/status` JSON from the same cache. One page
replaces the six vendor tabs: per-provider windows, credits, staleness, next
reset countdown. No framework, no build step.

## M3 — Combined usage views

Per-model workload analytics on top of provider history endpoints: OpenRouter
`/api/v1/activity` + `/api/v1/analytics/query`, GLM `/api/monitor/usage/model-usage`,
Alibaba billing trend, Claude local JSONL estimates. Combined token usage,
spend efficiency, model mix across all six.

## Parked (deliberately out of scope)

- cedar_ember reset grants — API verified readable+redeemable; un-park when wanted.
- TOON serializer (AXI) — payload too small to pay for it.
- Ambient context: statusline hooks (Claude Code / ZCode), installable agent skill.
- TTL/threshold config knobs — defaults are the policy.
- Non-Windows keyring reads (macOS Keychain / libsecret) for agy tokens.
