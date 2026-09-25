# subt — Implementation Plan (M1)

Goal of M1: `subt status` and `subt init` working end-to-end on this machine, all six
providers implemented per `docs/spec.md`, tests green, live data where credentials
exist (claude, glm, opencode presence), clean degrade where they don't (alibaba until
`bl` is installed, google until a lineage file exists).

## Build order (dependency-shaped)

1. **Scaffold + core** — `package.json` (bin `subt`, `type: module`, engines
   `>=22.18`, zero deps) · `src/core.ts`: all types from spec §ProviderResult,
   config loader, `~/.subt/env` dotenv parser, TTL cache (read/lock/write/stale-on-error
   exactly per spec §Cache), `redact()` helper, `nextEvent`/`recheckAfter` math.
   Pure logic — fully testable without network.
2. **Simple providers** — `opencode.ts` (presence check) · `openrouter.ts` (/key,
   optional /credits). First live HTTP paths; prove the ProviderModule shape.
3. **Local-credential providers** — `claude.ts` (token read + expiry check + usage
   GET with claude-code UA) · `glm.ts` (key from ZCode config, host from baseURL,
   raw-auth GET, limits[] parse). Both are live-verifiable on this machine today.
4. **Hard providers** — `alibaba.ts` (bl subprocess, JSON extraction, windows+credits)
   · `google.ts` (file lineages, refresh+write-back, loadCodeAssist → summary,
   degrade paths).
5. **CLI + init** — `src/cli.ts` (parseArgs strict, no-args = status, text render with
   `!`/`[stale]` markers, `help:` line, `--json`, `--provider`, `--fields`, `--fresh`,
   `--strict`, exit codes 0/1/2/3) · `src/init.ts` (checklist per spec §subt init).
6. **Tests** — `test/` with fixtures from the researched response shapes:
   `core.test.ts` (cache TTL/lock/stale math, nextEvent math, env parser, redaction),
   `providers.test.ts` (all six parsers against fixtures), `redaction.test.ts`
   (fixture secret cannot appear in any output mode), `cli.test.ts` (exit codes,
   unknown flag → 2). `node --test` runner only.
7. **Live verification** — see DoD.

## Shared module contract (both builders conform to this — it is `docs/spec.md` §ProviderResult verbatim)

```ts
export interface ProviderModule {
  id: ProviderId;
  ttlMs: number;
  probe(): Promise<ProviderResult>; // NEVER throws
}
```

Provider modules import types from `../core.ts`, export a single const module, and
contain zero I/O outside `probe()`. Credential reads happen inside `probe()` so a
missing file is an error result, never a crash.

## Secure-coding rules for all code

- Subprocesses: fixed literal command strings only — never interpolate anything into a
  shell string; no user input reaches a command line; no secret ever in argv.
- Paths: all derived from `os.homedir()`; never expand `~` manually; never join
  untrusted path segments.
- Parsing: `JSON.parse` inside try/catch with typed degradation (`parse-failure`),
  never `eval`-adjacent constructs.
- Secrets: loaded values are registered with the redaction layer immediately; never
  logged, never stringified wholesale, never in URLs/argv; cache file must contain
  only normalized `ProviderResult` data.
- HTTP: default TLS verification (never disable); per-provider 10s AbortController
  timeout; 429 handling per spec; response bodies capped at 1 MB (abort beyond).

## Definition of Done (M1)

- [ ] `node --test` green in `test/`.
- [ ] `node src/cli.ts status` renders all six providers on this machine; claude and
      glm show live numbers; alibaba shows `tool-missing` (bl absent) with the install
      hint; google shows `no-credentials` with the agy hint; opencode shows the PAYG
      note; openrouter shows `no-credentials` until `subt init` is run (no keys yet).
- [ ] `node src/cli.ts status --json` validates against spec §JSON schema.
- [ ] Two consecutive `status` runs within TTL hit the cache for claude (verify via
      `fetchedAt` in `~/.subt/cache.json` not changing) — D4 honored.
- [ ] `--strict` exits 3 when a provider failed; unknown flag exits 2.
- [ ] Redaction test proves a registered secret cannot appear in text or JSON output.
- [ ] No dependency added (`npm ls` empty), no build step (`node src/cli.ts` runs
      directly).
- [ ] `docs/` and README match what shipped.

## Deferred beyond M1

`subt serve` (M2) — **security:** the local HTTP dashboard must bind 127.0.0.1 only and add
a random local auth token; an unauthenticated localhost port is readable by any local
process and probeable by any page via CSRF-ish probes. Tracked as an open security item
for M2.
