# subtrk – Phases

## M1 – CLI (done)

`subtrk status` + `subtrk init`, six providers, TTL cache, tests.

## M2 – Web console (done)

`subtrk serve`: loopback-only server (random port + per-run token auth – see
`docs/spec.md` §`subtrk serve`), static dashboard + `/api/status` from the same
cache. One page per provider: windows, credits,
staleness, reset timeline and countdowns.

## M3 – Combined usage views

Per-model workload analytics on top of provider history endpoints: OpenRouter
`/api/v1/activity` + `/api/v1/analytics/query`, GLM `/api/monitor/usage/model-usage`,
Alibaba billing trend, Claude local JSONL estimates. Combined token usage,
spend efficiency, model mix across every tracked provider.

## Parked (deliberately out of scope)

- cedar_ember reset grants – API verified readable+redeemable; un-park when wanted.
- TOON serializer (AXI) – payload too small to pay for it.
- Ambient context: statusline hooks (Claude Code / ZCode), installable agent skill.
- TTL/threshold config knobs – defaults are the policy.
- Non-Windows keyring reads (macOS Keychain / libsecret) for agy tokens.
