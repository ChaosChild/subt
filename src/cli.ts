#!/usr/bin/env node
// cli.ts — subt entry point. `subt` / `subt status` / `subt init`.
// The providers registry lives in ./providers/index.ts (allProviders) and is
// imported lazily so tests can inject a stub registry via main()'s deps seam.
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import {
  ALL_PROVIDER_IDS,
  FRESH_FLOOR_IDS,
  SUBT_DIR,
  computeNextEvent,
  computeRecheckAfter,
  errorMessage,
  fetchProvider,
  loadConfig,
  scrub,
  scrubValue,
  type Credits,
  type ProviderId,
  type ProviderModule,
  type ProviderResult,
  type StatusOutput,
  type Window,
} from "./core.ts";
import { runInit } from "./init.ts";

export interface CliDirs {
  subt?: string; // override ~/.subt (tests)
}

export interface CliDeps {
  providers?: ProviderModule[];
  dirs?: CliDirs;
}

const STATUS_FIELDS = ["windows", "credits", "errors", "hints"] as const;
type StatusField = (typeof STATUS_FIELDS)[number];

const USAGE = `subt — remaining quota across paid AI subscriptions

usage:
  subt                  same as: subt status
  subt status [flags]   probe enabled providers, compact text
  subt init             one-time interactive setup

status flags:
  --json                machine-readable output (schemaVersion 1)
  --provider <id>       restrict to provider (repeatable)
  --fields a,b          text filter: windows,credits,errors,hints
  --fresh               bypass cache TTLs once (claude keeps its 300s floor)
  --strict              exit 3 if any provider failed
  -h, --help            this screen

exit codes: 0 ran · 1 runtime failure · 2 usage error · 3 --strict violation`;

const INIT_USAGE = `subt init — one-time interactive setup

Checks every provider, offers installs and logins where missing, and writes
new secrets to ~/.subt/env (mode 0600 on POSIX). Secrets are never echoed.

flags:
  -h, --help    this screen`;

// ---------- text rendering (spec §Text format) ----------

function clock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "??:??";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function relative(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function windowLabel(w: Window, scoped: boolean): string {
  const prefix = scoped && w.scope ? `${w.scope} ` : "";
  if (typeof w.usedPercent === "number") {
    return `${prefix}${w.kind} ${Math.round(w.usedPercent)}% (reset ${clock(w.resetsAt)})`;
  }
  if (typeof w.remainingFraction === "number") {
    return `${prefix}${w.kind} ${Math.round(w.remainingFraction * 100)}% left`;
  }
  return `${prefix}${w.kind}`;
}

function isHot(r: ProviderResult): boolean {
  return (r.windows ?? []).some(
    (w) =>
      (typeof w.usedPercent === "number" && w.usedPercent >= 95) ||
      (typeof w.remainingFraction === "number" && w.remainingFraction <= 0.05),
  );
}

function creditsLabel(c: Credits): string {
  const fmt = (n: number): string => n.toLocaleString("en-US");
  const main =
    c.unit === "usd"
      ? `$${c.remaining.toFixed(2)} left`
      : typeof c.total === "number"
        ? `credits ${fmt(c.remaining)}/${fmt(c.total)}`
        : `credits ${fmt(c.remaining)} left`;
  return c.cycleEndsAt ? `${main} · cycle ends ${c.cycleEndsAt.slice(0, 10)}` : main;
}

function renderText(
  out: StatusOutput,
  fields: Set<StatusField> | null,
  nowMs: number,
  ttlById: Map<string, number>,
): string[] {
  // Default = spec §Text format: windows, credits, error lines. Hints are an
  // extra field (--fields hints).
  const DEFAULT_FIELDS: ReadonlySet<StatusField> = new Set<StatusField>(["windows", "credits", "errors"]);
  const show = (f: StatusField): boolean => (fields ?? DEFAULT_FIELDS).has(f);
  // Providers promise one-line messages; hold that line even if stderr tails
  // leak in with newlines.
  const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  for (const r of out.providers) {
    const segs: string[] = [];
    if (show("windows") && r.windows?.length) {
      const scopes = new Set(r.windows.map((w) => w.scope).filter(Boolean));
      const scoped = scopes.size > 1;
      segs.push(r.windows.map((w) => windowLabel(w, scoped)).join(" · "));
    }
    if (show("credits") && r.credits) segs.push(creditsLabel(r.credits));
    if (r.note) segs.push(r.note);
    if (segs.length === 0 && r.ok) segs.push("ok");
    let line = `${r.id.padEnd(10)} ${segs.join(" · ")}`;
    if (!r.ok && r.error) {
      if (segs.length === 0) line = `${r.id.padEnd(10)} error: ${r.error.kind} — ${oneLine(r.error.message)}${r.error.hint ? ` (${oneLine(r.error.hint)})` : ""}`;
      else if (show("errors")) line += ` · error: ${r.error.kind} — ${oneLine(r.error.message)}`;
    }
    if (show("hints") && r.error?.hint) line += ` — hint: ${oneLine(r.error.hint)}`;
    if (r.stale) line += "  [stale]";
    if (isHot(r)) line += " !";
    lines.push(scrub(line.trimEnd()));
  }
  const next = out.nextEvent;
  if (next) {
    const provider = out.providers.find((p) => p.id === next.providerId);
    const ttl = ttlById.get(next.providerId) ?? 0;
    const win = provider?.windows?.find((w) => {
      const resetMs = Date.parse(w.resetsAt);
      if (!Number.isFinite(resetMs)) return false;
      const fetchedMs = Date.parse(provider.fetchedAt);
      const effective = Number.isFinite(fetchedMs)
        ? Math.max(resetMs, fetchedMs + ttl)
        : resetMs;
      return effective === next.atMs;
    });
    const kind = win ? `${win.kind} ` : "";
    lines.push(
      scrub(`next: ${next.providerId} ${kind}at ${clock(next.at)} (${relative(next.atMs - nowMs)})`),
    );
  }
  lines.push(scrub("help: subt status --json | subt status --provider <id> | subt init"));
  return lines;
}

// ---------- main ----------

export async function main(argv: string[], deps: CliDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: "boolean", default: false },
        provider: { type: "string", multiple: true },
        fields: { type: "string" },
        fresh: { type: "boolean", default: false },
        strict: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    console.error(`subt: ${errorMessage(err)}`);
    return 2;
  }
  const positionals = parsed.positionals;
  if (positionals.length > 1) {
    console.error(`subt: unexpected argument '${positionals[1]}' — try subt --help`);
    return 2;
  }
  const cmd = positionals[0] ?? "status"; // bare `subt` = status, never help
  const { json, provider = [], fields, fresh, strict, help } = parsed.values;
  if (help) {
    console.log(cmd === "init" ? INIT_USAGE : USAGE);
    return 0;
  }
  if (cmd === "init") {
    try {
      await runInit({ subtDir: deps.dirs?.subt });
      return 0;
    } catch (err) {
      console.error(`subt: ${errorMessage(err)}`);
      return 1;
    }
  }
  if (cmd !== "status") {
    console.error(`subt: unknown command '${cmd}' — try subt --help`);
    return 2;
  }

  let fieldSet: Set<StatusField> | null = null;
  if (fields !== undefined) {
    fieldSet = new Set();
    for (const f of fields.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!(STATUS_FIELDS as readonly string[]).includes(f)) {
        console.error(`subt: unknown field '${f}' — valid: ${STATUS_FIELDS.join(",")}`);
        return 2;
      }
      fieldSet.add(f as StatusField);
    }
  }

  let enabled: ProviderId[];
  try {
    enabled = loadConfig(deps.dirs?.subt).enabled;
  } catch (err) {
    console.error(`subt: ${errorMessage(err)}`);
    return 1;
  }

  const badProvider = provider.find((id) => !(ALL_PROVIDER_IDS as readonly string[]).includes(id));
  if (badProvider) {
    console.error(`subt: unknown provider '${badProvider}'`);
    return 2;
  }

  const registry: ProviderModule[] =
    deps.providers ?? (await import("./providers/index.ts")).allProviders;
  const requested = provider.length > 0 ? new Set<string>(provider) : null;
  const selected = registry.filter(
    (m) => enabled.includes(m.id) && (!requested || requested.has(m.id)),
  );
  if (selected.length === 0) {
    console.error("subt: no providers selected — check ~/.subt/config.json or --provider");
    return 1;
  }

  if (fresh && selected.some((m) => (FRESH_FLOOR_IDS as readonly string[]).includes(m.id))) {
    console.error("claude keeps its 300s floor");
  }

  const cachePath = join(deps.dirs?.subt ?? SUBT_DIR, "cache.json");
  const nowMs = Date.now();
  const settled = await Promise.allSettled(
    selected.map((m) =>
      fetchProvider(m, {
        cachePath,
        fresh: fresh === true && !(FRESH_FLOOR_IDS as readonly string[]).includes(m.id),
      }),
    ),
  );
  const results: ProviderResult[] = settled.map((s, i) => {
    if (s.status === "fulfilled") return s.value;
    return {
      id: selected[i].id,
      ok: false,
      stale: false,
      fetchedAt: new Date().toISOString(),
      error: { kind: "parse-failure", message: `internal error: ${errorMessage(s.reason)}` },
    };
  });

  const ttlById = new Map(selected.map((m) => [m.id, m.ttlMs] as const));
  const okTtls = selected.filter((_, i) => results[i].ok).map((m) => m.ttlMs);
  const out: StatusOutput = {
    schemaVersion: 1,
    checkedAt: new Date(nowMs).toISOString(),
    recheckAfter: computeRecheckAfter(okTtls, nowMs),
    providers: results,
    nextEvent: computeNextEvent(
      results.map((r) => ({ result: r, ttlMs: ttlById.get(r.id) ?? 0 })),
      nowMs,
    ),
  };

  if (json) console.log(JSON.stringify(scrubValue(out)));
  else for (const line of renderText(out, fieldSet, nowMs, ttlById)) console.log(line);

  return strict === true && results.some((r) => !r.ok) ? 3 : 0;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`subt: ${errorMessage(err)}`);
      process.exitCode = 1;
    },
  );
}
