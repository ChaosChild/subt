# subt — Decision Log

All decisions from the research and architecture phases (2026-09-23, revised 2026-09-25). Every provider fact below was verified against working source code or live endpoints during research; corrections discovered later are recorded as dated amendments.

## D1 · Zen PAYG balance — no tracking at all

**Decided:** No balance tracking for OpenCode Zen pay-as-you-go — no API (verified
against sst/opencode source + live probes: PAYG keys get `403 EntitlementError` on the
usage endpoint; dollar balance is console-session-only), and no manual entry either.
Signals only: key presence + the constant honest note. Revisit only if Zen ships an API.

## D2 · Alibaba read path — official `bl` CLI

**Decided:** Shell out to `bl usage token-plan` + `bl token-plan harness-quota`.
One-time auth is `bl auth login --open-api` (Aliyun AK, least-privilege RAM
sub-account) — verified from `bl` source that Token Plan accounts **cannot** use the
browser `--console` login, and that one `--open-api` login provisions both the openapi
and console credential domains. Nothing expires on a schedule; re-login only on logout,
rotation, or preset upgrade. Our own AK-signed OpenAPI calls remain the phase-2 upgrade
if we drop the `bl` dependency. DashScope API keys cannot read usage at all.

## D3 · CLI name & surface — `subt`

**Decided:** `subt status [--json] [--provider X]` (and bare `subt` = status, per
AXI content-first). Short because agents type it often.

## D4 · Claude polling discipline — hard 300s floor, claude-code UA, shared cache

**Decided:** Poll the usage endpoint at most every 5 minutes, always with a
`claude-code/<version>` User-Agent (non-claude-code UAs land in persistent 429
buckets), always through the one shared cache. Header harvesting from live inference
traffic is a phase-2 idea.

## D5 · Language & runtime — TypeScript on Node ≥22.18, zero dependencies

**Decided (blessed after architecture review):** Node ≥22.18 executes erasable-syntax
TypeScript directly — no build step, no tsc, no dependencies at all. Builtin `fetch`,
`node:util parseArgs`, `node:fs`, `node:child_process`, `node:http` (M2),
`node:test`. Same ecosystem as `bl`/opencode around it; provider parsers are
the churn surface and TS iterates fastest there. Go (single binary) and Rust were
considered and declined: new toolchain, zero shared ecosystem, slower iteration.
Bun single-exe compile was deleted from the roadmap entirely.

## D6 · Credential store — `subt init` + `~/.subt/env`, no global env vars

**Decided (user):** API keys are project/task-specific and do not belong in global
environment variables. subt's own keys live in `~/.subt/env` (dotenv format, tiny
builtin parser, no dependency; real process env still wins as override).
`subt init` is the one-time interactive setup: runs the Alibaba `bl` login flow,
prompts for OpenRouter keys (hidden input) and saves them, checks every provider's
credential presence, reports what's missing. It is the only interactive command;
everything agents call is non-interactive. Also stored here: the Google OAuth
client constants (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
`ANTIGRAVITY_CLIENT_ID`) — public installed-app values fetched from upstream by
init, kept out of the repo so secret scanners stay quiet (added 2026-09-25 at
publish time).

**security:** plaintext keys in `~/.subt/env` — same per-user trust envelope as the
vendor credential files we already read; accepted (rationale in this decision).

## D7 · Google credential sources — agy keyring read (supersedes file-only M1 scope)

**Decided (revised 2026-09-25):** Google sunset consumer Gemini CLI service on
2026-06-18; consumers use the closed-source `agy` binary, whose tokens live in
Windows Credential Manager under target `gemini:antigravity` — a plaintext JSON
blob (`token.{access_token, refresh_token, expiry}`). M1.1 reads it directly with a
fixed-literal PowerShell `CredReadW` P/Invoke snippet spawned via `execFile`
(verified working, no elevation, no dependencies). Fallbacks: the two legacy file
lineages. `implicit/*.pb` files are encrypted trajectory data, never tokens.
Quota endpoint correction from live verification: `retrieveUserQuotaSummary` takes
body `{}` — no `ideType`, no `loadCodeAssist` (that recipe belongs to the legacy
`retrieveUserQuota`). Keyring tokens are never self-refreshed (agy owns refresh and
rewrites the credential in place; on 401 subt re-reads and retries once). The
user's "re-login every couple of hours" symptom was diagnosed as network-failure
and pre-1.2.5 bug artifacts, not short sessions.

## D8 · Claude OAuth self-refresh (un-parked)

**Decided (2026-09-25):** Claude Code only refreshes `~/.claude/.credentials.json`
while running, so the stored token is routinely expired when agents read it. When
the access token is expired but the refresh token is live, subt refreshes via
`console.anthropic.com/v1/oauth/token` with Claude Code's public client id and
best-effort write-back (the refresh **rotates the refresh token** — persisting the
new one is mandatory or the file goes stale; in-memory use continues if write-back
fails). Failure degrades to `expired-token` with a "start Claude Code once" hint.

## D2 amendment 2 · Token Plan quota via `bl console call` (2026-09-25)

`bl usage token-plan` / `bl token-plan harness-quota` are unusable for
international personal Token Plans as of bl 2.0.1: the former's formatter drops
the monthly fields (monthly-only since 2026-09-22) and prints `{}`; the latter's
equity API returns `items: []` for personal accounts. The verified path is bl's
raw gateway passthrough — `bl console call --api
zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/{usage,subscription,quota-config}`
— with credits derived by joining `per1MonthPercentage` (a ratio) with the
specCode's monthly total from quota-config (standard = 45,000). Terminology
corrected throughout: the product is **Token Plan**; "Subscription Plan" is not a
distinct product (official EN docs group Token/Coding Plans under "My
Subscriptions"). Verified live against the actual account (specCode "standard",
300 remaining days).

## D2 amendment 1 · bl 2.0.1 console login (2026-09-25)

The verified setup for bl 2.0.1 is: `bl auth login --api-key sk-sp-<plan key>`
**first** (prevents the console flow from auto-creating an ordinary pay-as-you-go
key — plan keys are detected by the `sk-sp-` prefix), then `bl auth login --console
[--console-site international]` (browser flow; no CLI-side plan restriction in
2.0.1; the usage commands resolve strictly from the stored console access token).
AK/SK `--open-api` is now the fallback, not the default. Console sessions have no
auto-refresh — on expiry bl says "Console session is not logged in or has expired";
re-run the console step. AK/SK cannot be passed via env for login (flags only;
one-time argv exposure documented in the threat model).

## Research-era decisions folded in

- **Reset grants parked.** Claude's cedar_ember grants are API-readable
  (`GET /api/oauth/usage?cedar_ember=1`) and redeemable
  (`POST /api/organizations/{org}/reset_rate_limits`) — the API exists and works, but
  the feature is out of v0 scope per round-1 review. Un-parking is cheap when wanted.
- **AXI adopted** (axi.md, 10 principles): no-args = live status; `help:` next-step
  line; structured errors on stdout, debug on stderr; exit codes 0/1/2/3; minimal
  default schema + `--fields`; secrets redacted by default. TOON serializer deferred
  with rationale (~200-token payload; serializer costs more than it saves).
- **Cache design after two-agent critique** (23 findings): best-effort rename writes
  (empirical EPERM on Windows), existence-only lock with pid-GC (stealing cut),
  stale-on-error fallback, `nextEvent.at = max(resetsAt, fetchedAt + ttl)`,
  `recheckAfter` heartbeat, `schemaVersion`, corrupt-cache-as-miss.
- **Provider-integration corrections:** corrected gemini OAuth client id
  (`681255809395-…` — earlier research dropped a digit); GLM host derived from ZCode's
  `baseURL` (CN-issued keys need `open.bigmodel.cn`); `bl` spawned with fixed literal
  commands; OpenRouter /credits never attempted with the inference key.
