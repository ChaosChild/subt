# subt — Phases

## M1 — CLI spike (current)

`subt status` + `subt init`, all six providers per spec, TTL cache, tests, live
verification. Scope and DoD: `docs/implementation-plan.md`.

## M2 — Web console

`subt serve`: `node:http` server on 127.0.0.1 (random port + random local auth token
— see the open security item in `docs/implementation-plan.md`), serving one static HTML dashboard + `/api/status` JSON
from the same cache. One page replaces the six vendor tabs: per-provider windows,
credits, staleness, next reset countdown. No framework, no build step.

## M3 — Combined usage views

Per-model workload analytics on top of provider history endpoints: OpenRouter
`/api/v1/activity` + `/api/v1/analytics/query`, GLM `/api/monitor/usage/model-usage`,
Alibaba billing trend, Claude local JSONL estimates (ccusage-style). Combined token
usage, spend efficiency, model mix across all six.

## Parked (deliberately out of scope)

- cedar_ember reset grants — API verified readable+redeemable; un-park when wanted.
- TOON serializer (AXI) — payload too small to pay for it.
- Ambient context: statusline hooks (Claude Code / ZCode), installable agent skill.
- TTL/threshold config knobs — defaults are the policy.

(Un-parked 2026-09-25: agy keyring extraction via PowerShell CredRead; Claude OAuth
self-refresh. Both shipped in M1.1 after live verification.)
