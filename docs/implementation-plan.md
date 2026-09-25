# subtrk — Implementation Guide

How the codebase is organized, the rules all code follows, and how to extend it.

## Layout

```
package.json          bin "subtrk", type module, engines >=22.18, zero dependencies
src/cli.ts            entry point: arg parsing, orchestration, rendering, exit codes
src/serve.ts          the `subtrk serve` web console backend (see docs/spec.md)
src/console.html      the console dashboard page (served at /)
src/init.ts           one-time interactive setup (the only interactive command)
src/core.ts           types, config, ~/.subtrk/env parser, TTL cache, redaction, scheduling math, collectStatus
src/providers/*.ts    one module per provider — the only code that knows endpoints
test/*.test.ts        node:test suites (fixtures only; tests never touch the network)
test/fixtures/        captured real response shapes per provider
```

## Shared module contract

Every provider implements:

```ts
export interface ProviderModule {
  id: ProviderId;
  ttlMs: number;
  probe(): Promise<ProviderResult>; // NEVER throws — errors become ProviderResult.error
}
```

Provider modules import types from `../core.ts`, export a single default module,
and keep all I/O inside `probe()` so a missing credential is an error result,
never a crash. Pure parse functions (`parseXxx`) stay separate from `probe()`
so tests can exercise them against fixtures without network access.

## Rules for all code

- **TypeScript that Node runs directly:** erasable syntax only (no enums,
  namespaces, decorators, parameter properties); imports use explicit `.ts`
  extensions; zero dependencies — stdlib only.
- **Subprocesses:** fixed literal command strings or argv arrays — never
  interpolate anything into a shell string; no user input reaches a command
  line; no secret ever in argv or URLs.
- **Paths:** always derived from `os.homedir()`; never expand `~` manually.
- **Parsing:** `JSON.parse` inside try/catch with typed degradation
  (`parse-failure`); never trust a response shape — validate field by field.
- **Secrets:** register every loaded credential value with the redaction layer
  immediately; never logged, never stringified wholesale, never written to the
  cache (normalized quota data only). `test/redaction.test.ts` enforces this.
- **HTTP:** default TLS verification (never disabled); 10s per-provider
  AbortController timeout; response bodies capped at 1 MB; 429 handling per
  the spec.
- **Failure:** per provider, fail soft with an `error.kind` + actionable
  `hint`; one provider's failure never affects another; exit codes follow the
  spec (0 ran / 1 runtime / 2 usage / 3 strict).

## Adding a provider

1. Create `src/providers/<id>.ts`: pure parsers + a default `ProviderModule`
   with its TTL (see `docs/spec.md` §Cache for guidance).
2. Register it in `src/providers/index.ts` and add the id to
   `ALL_PROVIDER_IDS` in `src/core.ts`.
3. Add fixtures captured from the real endpoint to `test/fixtures/` and parser
   tests to `test/providers.test.ts`; include a redaction path in
   `test/redaction.test.ts`.
4. If setup is needed, extend `subtrk init` with an honest per-step result line.
5. Document the integration in `docs/spec.md` §Provider integrations and add a
   row to the README provider table.

## Testing

```bash
npm test          # node --test over test/*.test.ts
```

Tests are fixture-driven and offline. Live verification of a provider is a
manual step: `subtrk status --provider <id> --fresh` and reading the output.
