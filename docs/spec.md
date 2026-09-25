# subtrk – Specification

Version 1.1

`subtrk` is a zero-dependency CLI (TypeScript on Node ≥22.18, executed directly via type
stripping – no build step) that reports remaining quota across the provider plans it tracks,
designed first for AI agents and second for humans. One process per invocation, one
shared cache so concurrent agents never hammer provider endpoints.

## Commands

| Command | Behavior |
|---|---|
| `subtrk` (no args) | Same as `subtrk status` – live data, never a help screen (AXI: content first) |
| `subtrk status` | Probe all enabled providers, render compact text |
| `subtrk status --json` | Full structured output (schema below) |
| `subtrk status --provider <id>` | Restrict to one provider (repeatable) |
| `subtrk status --fields a,b` | Text mode: opt-in extras (`hints`); `windows`/`credits`/`errors` are default segments |
| `subtrk status --fresh` | Bypass cache TTLs once (Claude's 300s floor still applies – warns) |
| `subtrk status --strict` | Exit 3 if any provider failed |
| `subtrk init` | One-time interactive setup (the only interactive command) |
| `subtrk serve` | Local web console on 127.0.0.1 (see §`subtrk serve`) |

Every subcommand supports `--help`; unknown flags exit 2 (fail loud).

## Output contract

### Text format (default)

```
claude     5h 13% (reset 18:04) · 7d 89% !
glm        5h 4% (reset 19:47) · 7d 61%
alibaba    credits 31,240/45,000 · cycle ends 2026-10-12
google     5h 62% left · weekly 81% left   [stale]
opencode   PAYG · no usage API (signals only)
openrouter $74.75 left · key today $1.20
next: claude 5h at 18:09 (4h 49m)
help: subtrk status --json | subtrk status --provider <id> | subtrk init
```

- One line per provider, always – including failures:
  `google     error: no-credentials – no credential file found (install agy and log in once)`.
  On a bare error line the `hint` is appended in parentheses, so the line is always
  actionable on its own; with other segments present, hints render via `--fields hints`.
- `!` marks a window ≥95% used; `[stale]` marks cached-past-TTL or error-fallback data.
- The `help:` line is contextual disclosure (AXI): parameterized next-step templates.
- Line-oriented; composes with `grep` / `head`.

### JSON schema (`--json`)

```jsonc
{
  "schemaVersion": 1,
  "checkedAt": "2026-09-23T10:15:00Z",          // ISO-8601 UTC, always Z
  "recheckAfter": "2026-09-23T10:16:00Z",       // heartbeat: now + clamp(min TTL of ok providers, 60s, 300s)
  "providers": [ ProviderResult ],              // one per enabled provider, always present
  "nextEvent": {                                 // null when no ok provider has windows
    "providerId": "claude",
    "type": "window-reset",
    "at": "2026-09-23T18:09:00Z",               // max(resetsAt, fetchedAt + ttlMs), clamped >= now+1s
    "atMs": 1789501740000                        // epoch-ms duplicate for schedulers
  }
}
```

`nextEvent.at` means **the earliest time new information can exist** (a reset we can
actually observe, given the cache), not the raw reset instant. Schedulers wake there.

### ProviderResult

```ts
type ProviderId = "claude" | "glm" | "alibaba" | "google" | "opencode" | "openrouter";

type ErrorKind =
  | "no-credentials"      // credential file/env/key absent
  | "expired-token"       // token present but past expiry (with 60s clock skew)
  | "tool-missing"        // external CLI absent (bl)
  | "rate-limited"        // 429; carries retryAfterMs
  | "forbidden"           // plan-shape signal (e.g. Zen PAYG 403 EntitlementError)
  | "not-readable-remotely" // google degrade: 403/free-tier-shaped response
  | "parse-failure"       // endpoint reachable, shape unrecognized
  | "subprocess-failed"   // bl exited non-zero
  | "timeout"             // per-provider 10s budget exceeded
  | "http-error";         // other non-2xx (carries status)

interface ProviderError {
  kind: ErrorKind;
  message: string;        // one line, redacted
  hint?: string;          // next step, e.g. "run subtrk init"
  retryAfterMs?: number;  // rate-limited only
  status?: number;        // http-error only
}

interface Window {
  kind: string;                 // "5h" | "7d" | provider-specific
  scope?: string;               // grouping, e.g. "gemini-models"
  usedPercent?: number;         // 0–100 when natively percent-based
  remainingFraction?: number;   // 0–1 when natively fraction-based
  resetsAt: string;             // ISO-8601 UTC
}

interface Credits {
  total?: number;
  remaining: number;
  unit: "credits" | "usd";
  cycleEndsAt?: string;
  source: "api" | "derived";
}

interface ProviderResult {
  id: ProviderId;
  ok: boolean;                  // true iff a probe produced fresh data; error-fallback keeps ok:false
  stale: boolean;               // served past TTL or via error-fallback
  fetchedAt: string;            // ISO
  plan?: string;                // "Claude Pro", "GLM Legacy 2 Max", …
  windows?: Window[];           // on error-fallback these are the cached values
  credits?: Credits;            // ditto
  note?: string;                // e.g. opencode's constant PAYG note
  error?: ProviderError;        // present iff ok === false
}
```

Agent rule: **branch on `error.kind`, never on `message` text.**

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Ran; per-provider errors live in the output |
| 1 | CLI/runtime failure – config unreadable, or zero providers resolvable |
| 2 | Usage error (unknown flag, bad `--provider`) |
| 3 | `--strict` and at least one provider failed |

Streams: machine-readable output and structured errors → stdout. Debug/warnings → stderr.

## Cache

File `~/.subtrk/cache.json` (via `os.homedir()` – never manual `~` expansion):

```jsonc
{ "schemaVersion": 1,
  "claude": { "data": <ProviderResult>, "fetchedAt": 1789500000, "ttlMs": 300000 } }
```

- **Reads:** fresh (age < ttl) → serve. Expired < 2×ttl and the refresh lock is held by
  another live process → serve with `stale: true` (stale-while-revalidate). Otherwise probe.
- **Lock:** existence-only file `cache.json.lock` containing `{pid, startedAt}`, created
  with exclusive create, fd closed immediately (existence is the lock), released in
  `finally`. **No stealing.** GC by any process when `process.kill(pid, 0)` says the
  holder is dead or age > 60s; ignore EPERM/ENOENT during GC. Contenders that cannot
  serve stale wait ~750ms, re-check the cache once, then probe anyway – worst case is
  one bounded duplicate probe per fan-out, never endpoint abuse.
- **Writes:** temp file + rename, up to 4 retries with 25–100ms backoff, then **silent
  give-up** – on Windows, rename over an open reader fails with EPERM (even
  between Node processes). A lost write costs one future re-probe; it is never
  an error.
- **Stale-on-error:** a failed probe serves cached data < 24h old with `stale: true`
  **and** the structured error alongside.
- **Hygiene:** corrupt JSON → treat as miss and delete. `schemaVersion` mismatch →
  discard the file. The cache stores normalized quota data only – **never secrets**.

Default TTLs (the policy – no user knobs in v0):

| Provider | TTL | Rationale |
|---|---|---|
| claude | 300 000 | hard floor: usage endpoint has UA-keyed 429 buckets |
| glm | 60 000 | generous monitor route |
| google | 60 000 | be politer than gemini-cli's own 30s |
| alibaba | 300 000 | bl subprocess is slow; don't spam |
| openrouter | 60 000 | official API, cheap |
| opencode | 0 | local presence check only – bypasses cache entirely |

## Configuration & secrets

- `~/.subtrk/config.json` – `{ "enabled": ["claude", "glm", …] }`. Absent ⇒ all enabled.
  That is the entire config in v0 (no knobs).
- `~/.subtrk/env` – dotenv format (`KEY=VALUE`, `#` comments), parsed by a ~20-line
  reader. Holds subtrk's own keys: `OPENROUTER_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`,
  optionally `OPENCODE_API_KEY`. Real process env wins over the file. Written by
  `subtrk init` (hidden-input prompts), never logged, never echoed. Created mode
  `0600` on POSIX; on Windows the profile's default ACLs apply.

**security:** plaintext API keys in `~/.subtrk/env` – any process running as this user can
read them; accepted because it is the same trust envelope as every vendor credential
file we already read (`~/.claude/.credentials.json`, `~/.zcode/cli/config.json`, …)
and the profile's per-user ACL is the boundary. Escalation path if ever needed: OS
secret store.

**security:** subtrk concentrates read access to every tracked vendor's live tokens in one binary –
the mechanical redaction layer and the secret-free cache are load-bearing, not
nice-to-have. Both have tests.

### Redaction (mechanical)

After credentials load, every rendered string – including `--json` output – is
scrubbed by replacing each loaded secret value with `***`. Config/credential objects
are never stringified wholesale. No secret ever appears in a URL query, a subprocess
argument, or a log line. `test/redaction.test.ts` asserts a fixture secret cannot
appear in any output mode.

## Provider integrations

All providers implement:

```ts
interface ProviderModule {
  id: ProviderId;
  ttlMs: number;
  probe(): Promise<ProviderResult>; // NEVER throws – errors become ProviderResult.error
}
```

Probes run under `Promise.allSettled` with a 10s per-provider timeout (AbortController
where fetch is used).

### claude – Claude Pro (personal)

- Credential: `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`, `expiresAt`
  (ms), `refreshToken`, `refreshTokenExpiresAt`. Past expiry (60s skew) with a live
  refresh token → **subtrk self-refreshes** via `POST
  https://console.anthropic.com/v1/oauth/token` `{grant_type:"refresh_token",
  refresh_token, client_id:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}` (Claude Code's
  public client), then best-effort atomic write-back of the merged credential
  (refresh rotates the refresh token – the new one must be persisted or the file
  goes stale; in-memory use continues even if write-back fails). Refresh failure →
  `expired-token`, hint `start Claude Code once so it refreshes the token, or run
  claude /login`.
- `GET https://api.anthropic.com/api/oauth/usage` with headers
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`, `User-Agent: claude-code/2.1.11`
  (non-claude-code UAs land in persistent 429 buckets).
- Parse: `five_hour.utilization` (whole percent 0–100) + `five_hour.resets_at` (ISO);
  same for `seven_day`. → windows `[{kind:"5h",usedPercent},{kind:"7d",usedPercent}]`.
- 429 → `rate-limited`. JSON without those keys → `parse-failure`.

### glm – GLM Coding Plan (Legacy 2 Max)

- Credential: `~/.zcode/cli/config.json` → `provider.zai.apiKey`; fallback env
  `ANTHROPIC_AUTH_TOKEN`. Host from `provider.zai.options.baseURL` (scheme+host only),
  default `https://api.z.ai`.
- `GET {host}/api/monitor/usage/quota/limit` with `Authorization: <key>` – **raw
  token, no Bearer prefix**.
- Parse `data.limits[]`: `TOKENS_LIMIT` entries where `unit` 3 = hours (window length
  `number`×hours, i.e. the 5h window) and `unit` 6 = weeks (weekly window).
  `percentage` = used %, `nextResetTime` = Unix **ms** → `resetsAt`. `data.level`
  → plan label. `TIME_LIMIT` entries are built-in-tool quota – ignored in v0.
- 401 → `no-credentials` (hint `check ZCode login`).

### alibaba – Model Studio Token Plan (international, credits)

Terminology per official docs: **Token Plan** is the Credits-based subscription
(个人/Personal or Team; "Subscription Plan" is not a distinct product – Token Plan
is simply where the console's *My Subscriptions* section lives). International
personal plans are **monthly-only** since 2026-09-22 (weekly removed); the plan's
inference endpoint (`token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`)
has no usage surface of its own.

- `bl usage token-plan` is **unusable as of bl 2.0.1** – its formatter drops the
  monthly fields (`per1Month*`) and prints `{}`. We use bl's raw passthrough
  instead, with fixed literal commands (Windows `.cmd` shim through the shell,
  never interpolated): `bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/{usage|subscription|quota-config} --data "{}" --output json`.
  ENOENT/9009/"not recognized" → `tool-missing`; "No console access token" /
  "session … expired" → `no-credentials`.
- Envelope: bl double-nests the zelda payload
  (`data.DataV2.data.{msg,code,data:{…}}`) – `dataOf()` unwraps both that and the
  bare zelda shape. JSON extraction is first-`{`-to-last-`}` of stdout.
- `v2/usage` → window `30d`: `per1MonthPercentage` is a **ratio** of monthly
  credits (×100 for percent), `per1MonthResetTime` is epoch ms. Legacy
  `per5Hour*`/`per1Week*` percent families still parse when present. Known gateway
  flakiness (200-Success with empty data) → retry up to 2 extra attempts.
- `v2/subscription` → `specCode` ("standard"), `remainingDays`, `status`;
  `v2/quota-config` → per-spec monthly totals (standard = 45,000).
- Credits are **derived**: `remaining = total − usedPercent/100 × total`,
  `cycleEndsAt = per1MonthResetTime`, `source: "derived"`. Secondary-call failures
  degrade to fewer fields (windows without credits), never a provider error.
- One-time auth (see D2): `bl auth login --api-key sk-sp-…` first (prevents
  the console flow from auto-creating a pay-as-you-go key), then
  `bl auth login --console --console-site international` (browser). Console
  sessions expire without auto-refresh – re-run the console step when they do.

### google – Google AI Pro (via agy, Antigravity CLI)

Google sunset consumer Gemini CLI service on 2026-06-18; consumers use the closed
-source `agy` binary. **M1.1 reads agy's token directly from Windows Credential
Manager** (target `gemini:antigravity`, generic credential): a fixed-literal
PowerShell `CredReadW` P/Invoke snippet (spawned via `execFile`, ~5s budget, win32
only) returns a plaintext JSON blob
`{token:{access_token, refresh_token, expiry}, auth_method, id_token}`. Fallback
lineages: `~/.gemini/oauth_creds.json` (legacy gemini, refresh + write-back with the
gemini client constants) and `~/.gemini/antigravity-cli/antigravity-oauth-token`
(legacy antigravity). The `implicit/*.pb` files are encrypted trajectory data –
never read.

- Quota call (verified against agy 1.2.11): `POST
  https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` with
  `Authorization: Bearer <token>`, `User-Agent: antigravity`, body **`{}`** – no
  `ideType`, no project, no `loadCodeAssist` (that recipe belongs to the legacy
  `retrieveUserQuota` endpoint). Response `groups[].displayName` → scope (e.g.
  `gemini-models`, `claude-and-gpt-models`), `buckets[].{window, remainingFraction,
  resetTime}` → windows. On 403/404, one retry against
  `daily-cloudcode-pa.googleapis.com`, then `not-readable-remotely`, hint
  `run agy /usage`.
- Keyring tokens are **never self-refreshed** – agy owns refresh and rewrites the
  same credential in place. On 401: re-read the credential once and retry; still
  401 → `expired-token`, hint `launch agy once so it refreshes its token`.
- Text mode prefixes each window with its scope when a provider has more than one
  scope (google does: two model families).

- Legacy file-lineage refresh (gemini only, when expired with 60s skew): `POST
  https://oauth2.googleapis.com/token` `{grant_type:"refresh_token", refresh_token,
  client_id, client_secret}` – the client values come from `~/.subtrk/env`
  (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTIGRAVITY_CLIENT_ID`). They are
  **public installed-app constants** (Google publishes them in gemini-cli's
  Apache-2.0 source); `subtrk init` fetches them from upstream when a legacy file
  credential exists, and no literal lives in this repo – secret scanners stay
  quiet. Missing values → `no-credentials` with the init hint. Write-back to the
  same file is temp+rename best-effort.

### opencode – Zen pay-as-you-go (signals only)

No usage or balance API exists for PAYG (decided D1). Presence check only: key from
`~/.subtrk/env`/env `OPENCODE_API_KEY`, else `~/.local/share/opencode/auth.json`
(`opencode.key`). Result: `ok: true` with constant note
`"PAYG – no usage/balance API; inference errors are the only signal"` (401
CreditsError = out of credits, 429 metadata = window limits, surface during
inference). Absent everywhere → `no-credentials`, hint `run subtrk init or opencode auth login`.
`ttlMs: 0` – bypasses the cache.

### openrouter – pay-as-you-go

- `GET https://openrouter.ai/api/v1/key` (Bearer `OPENROUTER_API_KEY`) →
  `data.usage_daily` (USD) surfaced as `note`/key line.
- If `OPENROUTER_MANAGEMENT_KEY` present: `GET /api/v1/credits` →
  `credits {remaining: total_credits − total_usage, unit:"usd", source:"api"}`.
  **Never** attempt /credits with the inference key (guaranteed 403).
- Missing key → `no-credentials`, hint `run subtrk init`.

## `subtrk init` (one-time interactive setup)

Checks, in order, printing a checklist with pass/fail per provider:
1. Claude: `~/.claude/.credentials.json` readable + unexpired → else instruct `claude /login`.
2. GLM: ZCode config key present → else instruct ZCode login.
3. Alibaba (bl 2.0.1 flow): install offer if missing → hidden prompt for the Token
   Plan API key (`sk-sp-…`, passed as a single argv element via execFile) →
   `bl auth login --api-key <key>` → console-site question (default international)
   → `bl auth login --console [--console-site international]` interactively
   (browser, stdio inherit, no timeout) → on non-zero exit, hidden AK/SK fallback →
   `bl auth login --open-api --access-key-id … --access-key-secret …` → verify with
   `bl usage token-plan --output json`; `[ok]` only when verification passes,
   `[failed]` with a scrubbed stderr line otherwise. Key order matters: the API key
   first prevents the console flow from auto-creating an ordinary pay-as-you-go key.
4. Google: agy credential found (Credential Manager target `gemini:antigravity`,
   checked via a literal `cmdkey /list:gemini:antigravity` probe) → `[ok]`; else
   print the agy install one-liner
   (`irm https://antigravity.google/cli/install.ps1 | iex`) + "launch once to log
   in (subtrk reads its Credential Manager token directly)".
5. opencode: `auth.json` or key present → else offer to store one in `~/.subtrk/env`.
6. OpenRouter: hidden-input prompts for `OPENROUTER_API_KEY` and optional
   `OPENROUTER_MANAGEMENT_KEY`, written to `~/.subtrk/env` (created if absent).

`subtrk init` never sends a secret anywhere except the owning provider's endpoint, and
never writes secrets anywhere except `~/.subtrk/env` and vendor-owned files.

## AXI conformance summary

Token-efficient default output (compact lines; TOON serializer deferred – payload is
~200 tokens, the serializer would cost more than it saves) · minimal default schema
with `--fields` · pre-computed aggregates (`nextEvent`, `recheckAfter`, per-window
percent) · definitive empty states (every enabled provider always emits a state) · structured
errors + exit codes, agent commands never prompt · content-first (bare `subtrk` = status)
· contextual `help:` line · consistent `--help` · secrets redacted by default ·
`--confirm` gating reserved for any future state-changing operation (e.g. grant
redemption, if ever un-parked).

## `subtrk serve` – local web console

One page for every enabled provider, served from the same cache the CLI reads.

- Binds **127.0.0.1 only**, on a random port (`--port N` to pin one). Startup
  prints a single URL: `http://127.0.0.1:<port>/#<token>` – the token is a
  fresh 32-byte random value per run, carried in the URL **fragment** so it
  never reaches server logs or `Referer`. The browser is not auto-opened (the
  URL contains the token, and tokens never go into argv).
- `GET /` → the static shell (`src/console.html`), served without auth (it
  contains no data) with `Content-Security-Policy: default-src 'none';
  script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'
  data:; connect-src 'self'`. The shell reads the token from the fragment and
  sends it as `Authorization: Bearer <token>` on every API call; on 401 it
  tells the user to restart `subtrk serve` and open the fresh URL.
- `GET /api/status` → the identical scrubbed StatusOutput JSON that
  `subtrk status --json` prints, refreshed through the same cache (TTLs
  honored). The Bearer compare is timing-safe; missing/wrong token → 401.
- Hardening: the Host header must be `127.0.0.1[:port]` or
  `localhost[:port]` (403 otherwise – DNS-rebinding defense); no CORS headers
  are ever emitted, so cross-site pages can neither read responses nor pass
  the preflight a custom header requires; GET-only (405 otherwise); handlers
  never throw. Ctrl-C shuts down cleanly.
- The dashboard: per-provider cards (usage bars per window with ≥80%/≥95%
  warning levels, credits, staleness, error kinds with hints), a 7-day reset
  timeline, an upcoming-resets table, an agent-view terminal panel, and
  auto-refresh at `recheckAfter`.

## Not in v0 (parked)

cedar_ember reset grants (read+redeem API exists; un-park when wanted) ·
TOON serializer · statusline/agent-skill ambient context (post-M2) ·
TTL/threshold config knobs.
